import type { CollectionDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import { sanitiseIdent } from "./schema-gen.ts";

export type VocabCandidates = Record<string, Array<{ value: string; count: number }>>;

export type VocabLookup = { available: boolean; candidates: VocabCandidates };

export interface GroundedValueDecision {
  parsed: string;
  mapped?: string;
  action: "kept" | "mapped" | "dropped";
}

export function openVocabFieldNames(def: CollectionDef): string[] {
  return Object.entries(def.fields)
    .filter(([, field]) => field.type === "text" && field.filterable)
    .map(([name]) => name);
}

function missingVocabTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown };
  return record.code === "42P01" && typeof record.message === "string" && /_vocab/.test(record.message);
}

function normaliseQuery(q: string): string {
  return q.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function queryBigrams(q: string): string[] {
  const tokens = normaliseQuery(q).split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

function scopeWhere(scopeCols: Record<string, string>, start: number): { sql: string; params: string[] } {
  const entries = Object.entries(scopeCols);
  return {
    sql: entries.map(([column], index) => `${column} = $${start + index}`).join(" AND "),
    params: entries.map(([, value]) => value),
  };
}

function vocabTable(schema: string, collection: string): string {
  return `${sanitiseIdent(schema)}.c_${sanitiseIdent(collection)}_vocab`;
}

export async function vocabCandidates(
  ctx: MatcherCtx,
  schema: string,
  collection: string,
  def: CollectionDef,
  q: string,
  scopeCols: Record<string, string>
): Promise<VocabLookup> {
  const fields = openVocabFieldNames(def);
  if (fields.length === 0 || !q.trim()) return { available: true, candidates: {} };

  const table = vocabTable(schema, collection);
  const terms = [normaliseQuery(q), ...queryBigrams(q)];
  const scoreExpr = `GREATEST(${terms.map((_, index) => `similarity(lower(value), lower($${index + 1}))`).join(", ")})`;
  const scope = scopeWhere(scopeCols, terms.length + 1);
  const fieldQueries = fields.map((field) => {
    const fieldLiteral = field.replace(/'/g, "''");
    const scopeSql = scope.sql ? ` AND ${scope.sql}` : "";
    return `SELECT '${fieldLiteral}'::text AS field, value, count, ${scoreExpr} AS similarity_score
            FROM ${table}
            WHERE field = '${fieldLiteral}' AND ${scoreExpr} > 0.25${scopeSql}`;
  });
  const query = `WITH scored AS (
    ${fieldQueries.join("\n    UNION ALL\n    ")}
  ), ranked AS (
    SELECT field, value, count, similarity_score,
           ROW_NUMBER() OVER (PARTITION BY field ORDER BY similarity_score DESC, count DESC, value ASC) AS rn
    FROM scored
  )
  SELECT field, value, count FROM ranked WHERE rn <= 8 ORDER BY field, similarity_score DESC, count DESC, value ASC`;

  try {
    const rows = await ctx.storage.client("vocab candidates").unsafe(query, [...terms, ...scope.params]);
    const candidates: VocabCandidates = {};
    for (const row of rows) {
      const field = String(row.field);
      (candidates[field] ??= []).push({ value: String(row.value), count: Number(row.count) });
    }
    return { available: true, candidates };
  } catch (error) {
    if (missingVocabTable(error)) return { available: false, candidates: {} };
    throw error;
  }
}

export async function groundVocabValues(
  ctx: MatcherCtx,
  schema: string,
  collection: string,
  values: Record<string, string[]>,
  scopeCols: Record<string, string>
): Promise<{ available: boolean; decisions: Record<string, GroundedValueDecision[]> }> {
  const entries = Object.entries(values).flatMap(([field, fieldValues]) =>
    fieldValues.map((parsed) => ({ field, parsed }))
  );
  if (entries.length === 0) return { available: true, decisions: {} };

  const table = vocabTable(schema, collection);
  const valueParams = entries.flatMap(({ field, parsed }) => [field, parsed]);
  const valuesSql = entries
    .map((_, index) => `($${index * 2 + 1}::text, $${index * 2 + 2}::text)`)
    .join(", ");
  const scope = scopeWhere(scopeCols, valueParams.length + 1);
  const scopeSql = scope.sql ? ` AND ${scope.sql}` : "";
  const query = `WITH inputs(field, parsed) AS (VALUES ${valuesSql})
    SELECT i.field, i.parsed, nearest.value AS matched_value, nearest.similarity_score
    FROM inputs i
    LEFT JOIN LATERAL (
      SELECT value, similarity(lower(value), lower(i.parsed)) AS similarity_score
      FROM ${table}
      WHERE field = i.field${scopeSql}
      ORDER BY (lower(value) = lower(i.parsed)) DESC, similarity_score DESC, value ASC
      LIMIT 1
    ) nearest ON TRUE`;

  try {
    const rows = await ctx.storage.client("vocab grounding").unsafe(query, [...valueParams, ...scope.params]);
    const decisions: Record<string, GroundedValueDecision[]> = {};
    for (const row of rows) {
      const field = String(row.field);
      const parsed = String(row.parsed);
      const matched = typeof row.matched_value === "string" ? row.matched_value : null;
      const similarity = Number(row.similarity_score ?? 0);
      const exact = matched !== null && matched.toLowerCase() === parsed.toLowerCase();
      const decision: GroundedValueDecision = exact
        ? { parsed, ...(matched !== parsed ? { mapped: matched } : {}), action: "kept" }
        : matched !== null && similarity >= 0.4
          ? { parsed, mapped: matched, action: "mapped" }
          : { parsed, action: "dropped" };
      (decisions[field] ??= []).push(decision);
    }
    return { available: true, decisions };
  } catch (error) {
    if (missingVocabTable(error)) return { available: false, decisions: {} };
    throw error;
  }
}
