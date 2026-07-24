import { contentHash, type RawRow, type EnrichedRow, type EnrichStore, type DedupCandidateProvider, type DedupFeedback } from "@samesake/enrich";
import { embeddingEntries } from "@samesake/query";
import type { PostgresAdapter } from "./adapter.ts";
import type { CollectionBackendOptions } from "./types.ts";
import { embeddingColumn, ident, vectorLiteral } from "./ident.ts";

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
    const scopeKeys = this.options.collection.scopes ?? [];
    const scopeColumns = scopeKeys.map((key) => `scope_${ident(key, "scope")}`);
    for (const row of rows) {
      const providedScope = row.scope ?? {};
      if (!scopeKeys.length && Object.keys(providedScope).length) {
        throw new Error(`collection "${this.options.collection.name ?? this.options.table}" declares no scopes`);
      }
      for (const key of Object.keys(providedScope)) {
        if (!scopeKeys.includes(key)) throw new Error(`unknown scope key "${key}"`);
      }
      const scopeValues = scopeKeys.map((key) => {
        const value = providedScope[key];
        if (value == null || value === "") throw new Error(`scope.${key} is required for this collection`);
        return value;
      });
      const columns = ["id", "data", "content_hash", "enriched_at", "pipeline_status", ...scopeColumns];
      const values = [row.id, row.data, contentHash(row.data), null, "pending", ...scopeValues];
      // `data`/`enriched` are jsonb columns; postgres.js serializes a JS object to jsonb.
      // Passing a pre-stringified JSON string here would double-encode it into a jsonb
      // string scalar (so `data->>'title'` reads null), which breaks enrich + retrieval.
      const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
      const updates = [
        "data = EXCLUDED.data",
        "content_hash = EXCLUDED.content_hash",
        "enriched_at = NULL",
        "pipeline_status = 'pending'",
        "updated_at = now()",
      ];
      const sameScope = scopeColumns.length
        ? ` WHERE ${scopeColumns.map((column) => `${this.options.table}.${column} = EXCLUDED.${column}`).join(" AND ")}`
        : "";
      const result = await this.adapter.query(
        `INSERT INTO ${this.options.table} (${columns.join(", ")}) VALUES (${placeholders})
         ON CONFLICT (id) DO UPDATE SET ${updates.join(", ")}${sameScope}
         RETURNING id`,
        values
      );
      if (scopeColumns.length && !result.length) {
        throw new Error(`row "${row.id}" belongs to a different scope`);
      }
    }
  }

  async delete(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.adapter.query(`DELETE FROM ${this.options.table} WHERE id = ANY($1::text[])`, [ids]);
  }

  async loadDirty(limit: number): Promise<RawRow[]> {
    const scopeKeys = this.options.collection.scopes ?? [];
    const scopeSelect = scopeKeys.map((key) => `scope_${ident(key, "scope")}`).join(", ");
    const rows = await this.adapter.query(
      `SELECT id, data, image_etag${scopeSelect ? `, ${scopeSelect}` : ""} FROM ${this.options.table} WHERE enriched_at IS NULL ORDER BY id LIMIT $1`,
      [limit]
    );
    return rows.map((row) => ({
      id: String(row.id),
      data: (row.data as Record<string, unknown>) ?? {},
      imageEtag: row.image_etag == null ? null : String(row.image_etag),
      ...(scopeKeys.length ? { scope: Object.fromEntries(scopeKeys.map((key) => [key, String(row[`scope_${key}`])])) } : {}),
    }));
  }

  async writeEnriched(rows: EnrichedRow[]): Promise<void> {
    const vectorEntries = embeddingEntries(this.options.collection)
      .map(([name, embedding], index) => embedding.evidence ? null : { name, column: embeddingColumn(name, index) })
      .filter((entry): entry is { name: string; column: string } => entry !== null);
    const fieldNames = Object.keys(this.options.collection.fields ?? {});
    for (const row of rows) {
      const vectors = vectorEntries.flatMap(({ name, column }) => {
        const vector = row.vectors?.[name];
        return vector ? [{ column, value: vectorLiteral(vector) }] : [];
      });
      // Build the SET clause dynamically: fixed columns, then the collection's
      // filterable field columns (projected by the enricher into row.fields), then
      // embedding vectors. Field columns are what powers filters/facets/NLQ budgets.
      const columns: string[] = ["enriched", "doc", "rerank_doc", "fts_src", "fts_src_a", "pipeline_status", "gate_reason"];
      const params: unknown[] = [
        row.enriched ?? null, row.surfaces?.doc ?? null, row.surfaces?.rerank_doc ?? null,
        row.surfaces?.fts_src ?? null, row.surfaces?.fts_src_a ?? null,
        row.status ?? "ready", row.gateReason ?? null,
      ];
      for (const name of fieldNames) {
        columns.push(ident(name));
        params.push(row.fields?.[name] ?? null);
      }
      for (const { column, value } of vectors) {
        columns.push(column);
        params.push(value);
      }
      const set = [
        ...columns.map((column, index) => `${column} = $${index + 1}`),
        "enriched_at = now()",
        "updated_at = now()",
      ].join(", ");
      params.push(row.id);
      await this.adapter.query(
        `UPDATE ${this.options.table} SET ${set} WHERE id = $${params.length}`,
        params
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
    const scopeKeys = this.options.collection.scopes ?? [];
    const scopeSelect = scopeKeys.map((key) => `scope_${ident(key, "scope")}`).join(", ");
    const rows = await this.adapter.query(
      `SELECT id, data, image_etag${scopeSelect ? `, ${scopeSelect}` : ""} FROM ${this.options.table} WHERE pipeline_status = 'failed' AND next_attempt_at <= now() ORDER BY id LIMIT $1`,
      [limit]
    );
    return rows.map((row) => ({
      id: String(row.id),
      data: (row.data as Record<string, unknown>) ?? {},
      imageEtag: row.image_etag == null ? null : String(row.image_etag),
      ...(scopeKeys.length ? { scope: Object.fromEntries(scopeKeys.map((key) => [key, String(row[`scope_${key}`])])) } : {}),
    }));
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
