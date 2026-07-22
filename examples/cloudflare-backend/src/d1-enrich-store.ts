import { contentHash } from "@samesake/enrich";
import type {
  DedupCandidateProvider,
  DedupFeedback,
  EnrichedRow,
  EnrichStore,
  RawRow,
} from "@samesake/enrich";
import type { DB } from "./d1.ts";
import { nextSeq } from "./d1.ts";

const DEAD_AFTER = 5;

function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 60_000);
}

function parseRaw(row: { id: string; data: string }): RawRow {
  return { id: row.id, data: JSON.parse(row.data) as Record<string, unknown> };
}

export function d1EnrichStore(db: DB, candidates?: DedupCandidateProvider): EnrichStore {
  const feedback: DedupFeedback = {
    async isDeclined(a, b) {
      const hit = db.prepare(
        `SELECT 1 FROM declined_pairs
         WHERE (a = ? AND b = ?) OR (a = ? AND b = ?) LIMIT 1`,
      ).get(a, b, b, a);
      return hit != null;
    },
    async suggestionStatus() {
      return null;
    },
  };

  return {
    async upsert(rows) {
      const select = db.prepare("SELECT content_hash FROM catalog WHERE id = ?");
      const insert = db.prepare(
        `INSERT INTO catalog (id, data, content_hash, seq, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const update = db.prepare(
        `UPDATE catalog SET data = ?, content_hash = ?, pipeline_status = 'pending',
         enriched = NULL, attempt_count = 0, next_attempt_at = 0, last_error = NULL,
         gate_reason = NULL, doc = NULL, rerank_doc = NULL, fts_src = NULL,
         fts_src_a = NULL, product_group = NULL, updated_at = ? WHERE id = ?`,
      );
      for (const row of rows) {
        const serialized = JSON.stringify(row.data);
        const hash = contentHash(row.data);
        const prior = select.get(row.id) as { content_hash: string } | null;
        if (prior?.content_hash === hash) continue;
        if (prior) update.run(serialized, hash, Date.now(), row.id);
        else insert.run(row.id, serialized, hash, nextSeq(db), Date.now());
      }
    },

    async loadDirty(limit) {
      const rows = db.prepare(
        `SELECT id, data FROM catalog
         WHERE pipeline_status = 'pending' ORDER BY seq LIMIT ?`,
      ).all(limit) as Array<{ id: string; data: string }>;
      return rows.map(parseRaw);
    },

    async writeEnriched(rows: EnrichedRow[]) {
      const update = db.prepare(
        `UPDATE catalog SET enriched = ?, pipeline_status = ?, gate_reason = ?,
         doc = ?, rerank_doc = ?, fts_src = ?, fts_src_a = ?, attempt_count = 0,
         next_attempt_at = 0, last_error = NULL, updated_at = ? WHERE id = ?`,
      );
      for (const row of rows) {
        update.run(
          JSON.stringify(row.enriched),
          row.status ?? "ready",
          row.gateReason ?? null,
          row.surfaces?.doc ?? null,
          row.surfaces?.rerank_doc ?? null,
          row.surfaces?.fts_src ?? null,
          row.surfaces?.fts_src_a ?? null,
          Date.now(),
          row.id,
        );
      }
    },

    async recordFailure(id, error) {
      const prior = db.prepare("SELECT attempt_count FROM catalog WHERE id = ?").get(id) as { attempt_count: number } | null;
      if (!prior) return;
      const attempts = prior.attempt_count + 1;
      const dead = attempts >= DEAD_AFTER;
      db.prepare(
        `UPDATE catalog SET attempt_count = ?, pipeline_status = ?, next_attempt_at = ?,
         last_error = ?, updated_at = ? WHERE id = ?`,
      ).run(
        attempts,
        dead ? "dead" : "failed",
        dead ? 0 : Date.now() + backoffMs(attempts),
        String(error),
        Date.now(),
        id,
      );
    },

    async loadRetryable(limit) {
      const rows = db.prepare(
        `SELECT id, data FROM catalog
         WHERE pipeline_status = 'failed' AND next_attempt_at <= ?
         ORDER BY seq LIMIT ?`,
      ).all(Date.now(), limit) as Array<{ id: string; data: string }>;
      return rows.map(parseRaw);
    },

    async markDead(id, reason) {
      db.prepare(
        `UPDATE catalog SET pipeline_status = 'dead', next_attempt_at = 0,
         last_error = ?, updated_at = ? WHERE id = ?`,
      ).run(reason, Date.now(), id);
    },

    async loadEnriched(limit) {
      const rows = db.prepare(
        `SELECT id, enriched, doc, rerank_doc, fts_src, fts_src_a, pipeline_status, gate_reason
         FROM catalog WHERE enriched IS NOT NULL ORDER BY seq LIMIT ?`,
      ).all(limit) as Array<{
        id: string;
        enriched: string;
        doc: string | null;
        rerank_doc: string | null;
        fts_src: string | null;
        fts_src_a: string | null;
        pipeline_status: "ready" | "quarantined";
        gate_reason: string | null;
      }>;
      return rows.map((row) => ({
        id: row.id,
        enriched: JSON.parse(row.enriched) as Record<string, unknown>,
        surfaces: {
          doc: row.doc,
          denseByEmbedding: {},
          rerank_doc: row.rerank_doc,
          fts_src: row.fts_src,
          fts_src_a: row.fts_src_a,
        },
        status: row.pipeline_status,
        gateReason: row.gate_reason,
      }));
    },

    candidates,
    feedback,
  };
}
