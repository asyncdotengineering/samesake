import type { ConstraintPredicate } from "@samesake/core";
import type { RankedRow, RetrievalPlan, Retriever } from "@samesake/query";
import type { Table } from "@lancedb/lancedb";

export const RRF_K = 60;
const CANDIDATE_POOL = 50;

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function literal(value: unknown, fieldType: string): string {
  if (fieldType === "number") return String(Number(value));
  if (fieldType === "boolean") return value ? "TRUE" : "FALSE";
  return sqlString(String(value));
}

export function buildLancePredicate(filters: ConstraintPredicate[]): string {
  const clauses: string[] = [];
  for (const predicate of filters) {
    const field = predicate.field;
    switch (predicate.operator) {
      case "eq":
        clauses.push(`${field} = ${literal(predicate.value, predicate.fieldType)}`);
        break;
      case "ne":
        clauses.push(`(${field} IS NULL OR ${field} != ${literal(predicate.value, predicate.fieldType)})`);
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte":
        clauses.push(`${field} ${predicate.operator === "gt" ? ">" : predicate.operator === "gte" ? ">=" : predicate.operator === "lt" ? "<" : "<="} ${literal(predicate.value, "number")}`);
        break;
      case "in":
      case "nin": {
        const values = (Array.isArray(predicate.value) ? predicate.value : [predicate.value])
          .map((value) => literal(value, predicate.fieldType));
        const operator = predicate.operator === "in" ? "IN" : "NOT IN";
        clauses.push(`${predicate.operator === "nin" ? `(${field} IS NULL OR ` : ""}${field} ${operator} (${values.join(", ")})${predicate.operator === "nin" ? ")" : ""}`);
        break;
      }
      case "contains":
        clauses.push(predicate.fieldType === "array"
          ? `array_contains(${field}, ${sqlString(String(predicate.value))})`
          : `${field} LIKE ${sqlString(`%${String(predicate.value)}%`)}`);
        break;
      case "exclude":
        clauses.push(`NOT array_contains(${field}, ${sqlString(String(predicate.value))})`);
        break;
      case "not":
        clauses.push(`(${field} IS NULL OR ${field} NOT LIKE ${sqlString(`%${String(predicate.value)}%`)})`);
        break;
    }
  }
  return clauses.join(" AND ");
}

function parseData(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function tokens(query: string): string[] {
  return query.toLowerCase().split(/[\s,]+/).map((token) => token.trim()).filter((token) => token.length > 1);
}

interface LegRow {
  id: string;
  data: Record<string, unknown>;
  cosine: number | null;
}

export function lanceRetriever(table: Table): Retriever {
  return async (plan: RetrievalPlan): Promise<RankedRow[]> => {
    const predicate = buildLancePredicate(plan.filters);
    const legs: Array<{ name: string; weight: number; rows: LegRow[] }> = [];

    for (const vector of plan.vectors) {
      const weight = plan.weights.aspects[vector.embedding] ?? plan.weights.cosine;
      if (!vector.vec.length || weight <= 0) continue;
      const rawQuery = table.search(vector.vec);
      let query = "distanceType" in rawQuery ? rawQuery.distanceType("cosine") : rawQuery;
      if (predicate) query = query.where(predicate);
      const rows = await query.limit(CANDIDATE_POOL).toArray() as Array<{ id: string; data: unknown; _distance?: number }>;
      legs.push({
        name: vector.embedding,
        weight,
        rows: rows.map((row) => ({
          id: String(row.id),
          data: parseData(row.data),
          cosine: row._distance == null ? null : 1 - Number(row._distance),
        })),
      });
    }

    if (plan.query && plan.weights.fts > 0) {
      const queryTokens = tokens(plan.query);
      if (queryTokens.length) {
        const lexical = queryTokens.map((token) => `fts_src LIKE ${sqlString(`%${token}%`)}`).join(" OR ");
        const where = predicate ? `(${predicate}) AND (${lexical})` : lexical;
        const rows = await table.query().where(where).select(["id", "data", "fts_src"]).toArray() as Array<{ id: string; data: unknown; fts_src?: string }>;
        const scored = rows.map((row) => {
          const text = String(row.fts_src ?? "").toLowerCase();
          return {
            id: String(row.id),
            data: parseData(row.data),
            count: queryTokens.reduce((total, token) => total + (text.includes(token) ? 1 : 0), 0),
          };
        }).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
        legs.push({ name: "fts", weight: plan.weights.fts, rows: scored.map(({ id, data }) => ({ id, data, cosine: null })) });
      }
    }

    const fused = new Map<string, { data: Record<string, unknown>; legRanks: Record<string, number>; cosine: number | null; fts: boolean }>();
    for (const leg of legs) {
      leg.rows.forEach((row, index) => {
        const rank = index + 1;
        const current = fused.get(row.id) ?? { data: row.data, legRanks: {}, cosine: null, fts: false };
        current.legRanks[leg.name] = rank;
        current.cosine = row.cosine == null ? current.cosine : Math.max(current.cosine ?? row.cosine, row.cosine);
        if (leg.name === "fts") current.fts = true;
        fused.set(row.id, current);
      });
    }

    return [...fused.entries()].map(([id, row]) => ({
      id,
      data: row.data,
      rrf_score: legs.reduce((score, leg) => {
        const rank = row.legRanks[leg.name];
        return rank == null ? score : score + leg.weight / (RRF_K + rank);
      }, 0),
      legRanks: row.legRanks,
      fts_present: row.fts,
      cos_sim: row.cosine,
    })).sort((a, b) => b.rrf_score - a.rrf_score || a.id.localeCompare(b.id)).slice(0, plan.limit);
  };
}
