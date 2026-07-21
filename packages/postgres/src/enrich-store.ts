import type { RawRow, EnrichedRow, EnrichStore, DedupCandidateProvider, DedupFeedback } from "@samesake/enrich";
import type { CollectionDef, Scope } from "@samesake/core";
import type { PostgresAdapter } from "./adapter.ts";
import type { CollectionBackendOptions } from "./types.ts";

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export class PostgresEnrichStore implements EnrichStore {
  readonly candidates?: DedupCandidateProvider;
  readonly feedback?: DedupFeedback;

  constructor(
    private readonly adapter: PostgresAdapter,
    private readonly options: CollectionBackendOptions,
    candidates?: DedupCandidateProvider
  ) {
    this.candidates = candidates;
    // Human decline/confirm memory for resolve() — same suggestions table + symmetric
    // decline check as packages/server/src/core/dedup.ts's isDeclined/suggestionStatus.
    const suggestionsTable = `${options.table}_dedup_suggestions`;
    this.feedback = {
      isDeclined: async (a, b) => {
        const rows = await adapter.query(
          `SELECT 1 FROM ${suggestionsTable} WHERE status = 'declined'
           AND ((row_id = $1 AND candidate_group = $2) OR (row_id = $2 AND candidate_group = $1)) LIMIT 1`,
          [a, b]
        );
        return rows.length > 0;
      },
      suggestionStatus: async (rowId, group) => {
        const rows = await adapter.query(
          `SELECT status FROM ${suggestionsTable} WHERE row_id = $1 AND candidate_group = $2 LIMIT 1`,
          [rowId, group]
        );
        return rows.length ? String(rows[0]!.status) : null;
      },
    };
  }

  async upsert(rows: RawRow[]): Promise<void> {
    for (const row of rows) {
      await this.adapter.query(
        `INSERT INTO ${this.options.table} (id, data, enriched_at, pipeline_status) VALUES ($1, $2::jsonb, NULL, NULL) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, enriched_at = NULL, pipeline_status = NULL, updated_at = now()`,
        [row.id, json(row.data)]
      );
    }
  }

  async loadDirty(limit: number): Promise<RawRow[]> {
    const rows = await this.adapter.query(
      `SELECT id, data, image_etag FROM ${this.options.table} WHERE enriched_at IS NULL ORDER BY id LIMIT $1`,
      [limit]
    );
    return rows.map((row) => ({ id: String(row.id), data: (row.data as Record<string, unknown>) ?? {}, imageEtag: row.image_etag == null ? null : String(row.image_etag) }));
  }

  async writeEnriched(rows: EnrichedRow[]): Promise<void> {
    for (const row of rows) {
      await this.adapter.query(
        `UPDATE ${this.options.table}
         SET enriched = $1::jsonb, enriched_at = now(),
             doc = $2, rerank_doc = $3, fts_src = $4, fts_src_a = $5,
             pipeline_status = $6, gate_reason = $7, updated_at = now()
         WHERE id = $8`,
        [json(row.enriched), row.surfaces?.doc ?? null, row.surfaces?.rerank_doc ?? null,
          row.surfaces?.fts_src ?? null, row.surfaces?.fts_src_a ?? null,
          row.status ?? "ready", row.gateReason ?? null, row.id]
      );
    }
  }

  async recordFailure(id: string, error: unknown): Promise<void> {
    await this.adapter.query(
      `UPDATE ${this.options.table} SET attempt_count = attempt_count + 1, last_error = $1, pipeline_status = 'failed', next_attempt_at = now() + make_interval(secs => LEAST(3600, power(2, LEAST(attempt_count, 12))::int)), updated_at = now() WHERE id = $2`,
      [String(error), id]
    );
  }

  async loadRetryable(limit: number): Promise<RawRow[]> {
    const rows = await this.adapter.query(
      `SELECT id, data, image_etag FROM ${this.options.table} WHERE pipeline_status = 'failed' AND next_attempt_at <= now() ORDER BY id LIMIT $1`,
      [limit]
    );
    return rows.map((row) => ({ id: String(row.id), data: (row.data as Record<string, unknown>) ?? {}, imageEtag: row.image_etag == null ? null : String(row.image_etag) }));
  }

  async markDead(id: string, reason: string): Promise<void> {
    await this.adapter.query(
      `UPDATE ${this.options.table} SET pipeline_status = 'dead', last_error = $1, updated_at = now() WHERE id = $2 AND pipeline_status = 'failed'`,
      [reason, id]
    );
  }

  async loadEnriched(limit: number): Promise<EnrichedRow[]> {
    const rows = await this.adapter.query(
      `SELECT id, enriched FROM ${this.options.table} WHERE enriched IS NOT NULL ORDER BY id LIMIT $1`,
      [limit]
    );
    return rows.map((row) => ({ id: String(row.id), enriched: (row.enriched as Record<string, unknown>) ?? {} }));
  }
}
