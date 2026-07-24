import type { DedupCandidate, DedupCandidateProvider, DedupRow } from "@samesake/enrich";
import type { PostgresAdapter } from "./adapter.ts";
import type { CollectionBackendOptions } from "./types.ts";
import { ident, vectorLiteral } from "./ident.ts";

export function pgCandidates(adapter: PostgresAdapter, options: CollectionBackendOptions): DedupCandidateProvider {
  return async (row: DedupRow): Promise<DedupCandidate[]> => {
    const dedup = options.collection.dedup;
    if (!dedup) throw new Error(`Collection "${options.collection.name ?? options.table}" declares no dedup config`);
    const params: unknown[] = [row.id];
    const ref = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const scope = Object.entries(row.scope ?? options.scope ?? {});
    const scopeSql = (alias: string) => scope.map(([field, value]) => ` AND ${alias}.${ident(`scope_${field.replace(/^scope_/, "")}`)} = ${ref(value)}`).join("");
    const probes: string[] = [];
    const exactFields = new Set<string>();
    const trigramFields = new Set<string>();
    for (const channel of dedup.channels) {
      if (channel.kind === "exactKey") {
        const field = ident(channel.field);
        const value = row.fields[channel.field] ?? row.fields[field];
        if (value == null || String(value).trim() === "") continue;
        exactFields.add(channel.field);
        const valueRef = ref(String(value));
        probes.push(`SELECT id FROM ${options.table} d WHERE d.${field} = ${valueRef} AND d.${field} <> '' AND d.id <> $1${scopeSql("d")}`);
      } else if (channel.kind === "trigram") {
        const field = ident(channel.field);
        const value = row.fields[channel.field] ?? row.fields[field];
        if (value == null || String(value).trim() === "") continue;
        trigramFields.add(channel.field);
        const valueRef = ref(String(value));
        probes.push(`SELECT id FROM ${options.table} d WHERE d.id <> $1 AND d.${field} % ${valueRef}${scopeSql("d")} ORDER BY similarity(d.${field}, ${valueRef}) DESC LIMIT 20`);
      }
    }
    const cosine = dedup.channels.find((channel): channel is Extract<typeof channel, { kind: "cosine" }> => channel.kind === "cosine");
    const vector = row.embedding?.length ? vectorLiteral(row.embedding) : null;
    if (cosine && vector) {
      const vectorRef = ref(vector);
      probes.push(`SELECT id FROM ${options.table} d WHERE d.id <> $1 AND d.embedding IS NOT NULL${scopeSql("d")} ORDER BY d.embedding <=> ${vectorRef}::halfvec LIMIT 20`);
    }
    if (!probes.length) return [];

    const fieldSelect = [...new Set([...exactFields, ...trigramFields])].map((field) => `d.${ident(field)}`).join(", ");
    const trigramSelect = [...trigramFields].map((field) => `similarity(d.${ident(field)}, ${ref(String(row.fields[field]))})::float AS trgm_${ident(field)}`).join(", ");
    const cosineSelect = cosine && vector ? `(1 - (d.embedding <=> ${ref(vector)}::halfvec))::float AS _cos` : "NULL::float AS _cos";
    const groupField = ident(dedup.groupField ?? "product_group");
    const fields = ["d.id", `d.${groupField} AS _group`, fieldSelect, trigramSelect, cosineSelect].filter(Boolean).join(", ");
    const rows = await adapter.query(
      `WITH probe AS (${probes.map((probe) => `(${probe})`).join(" UNION ")}) SELECT ${fields} FROM ${options.table} d JOIN probe USING (id) WHERE d.pipeline_status = 'ready'`,
      params
    );
    return rows.map((candidate) => ({
      id: String(candidate.id),
      group: candidate._group == null ? null : String(candidate._group),
      fields: Object.fromEntries([...exactFields, ...trigramFields].map((field) => [field, candidate[field]])),
      trgm: Object.fromEntries([...trigramFields].map((field) => [`${field}`, Number(candidate[`trgm_${field}`] ?? 0)])),
      cos: candidate._cos == null ? null : Number(candidate._cos),
    }));
  };
}
