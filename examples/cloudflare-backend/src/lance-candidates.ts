import { sanitiseIdent, type CollectionDef } from "@samesake/core";
import type { Table } from "@lancedb/lancedb";
import { trigramSimilarity, type DedupCandidate, type DedupCandidateProvider, type DedupRow } from "@samesake/enrich";
import type { DB } from "./d1.ts";

function vectorOf(value: unknown): number[] | null {
  if (value instanceof Float32Array || value instanceof Float64Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(Number);
  return null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0);
    normA += a[i]! * a[i]!;
  }
  for (const value of b) normB += value * value;
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function lanceCandidates(table: Table, def: CollectionDef, db: DB): DedupCandidateProvider {
  return async (row: DedupRow): Promise<DedupCandidate[]> => {
    if (!def.dedup) throw new Error(`Collection "${def.name ?? "products"}" declares no dedup config`);

    const exactFields = def.dedup.channels
      .filter((channel): channel is Extract<typeof channel, { kind: "exactKey" }> => channel.kind === "exactKey")
      .map((channel) => channel.field);
    const trgmFields = def.dedup.channels
      .filter((channel): channel is Extract<typeof channel, { kind: "trigram" }> => channel.kind === "trigram")
      .map((channel) => channel.field);
    const hasCosine = def.dedup.channels.some((channel) => channel.kind === "cosine");
    const rowSeq = db.prepare("SELECT seq FROM catalog WHERE id = ?").get(row.id) as { seq: number } | null;
    if (!rowSeq) return [];

    const candidateIds = new Set<string>();
    for (const field of exactFields) {
      const value = row.fields[sanitiseIdent(field)] ?? row.fields[field];
      if (value == null || String(value).trim() === "") continue;
      const rows = db.prepare(
        `SELECT id FROM catalog
         WHERE id <> ? AND seq < ? AND pipeline_status = 'ready' AND enriched IS NOT NULL
           AND json_extract(enriched, ?) = ?`,
      ).all(row.id, rowSeq.seq, `$.${field}`, String(value)) as Array<{ id: string }>;
      for (const candidate of rows) candidateIds.add(candidate.id);
    }
    const sourceRows = await table.query()
      .where(`id = ${sqlString(row.id)}`)
      .select(["id", "vector"])
      .limit(1)
      .toArray() as Array<Record<string, unknown>>;
    const rowVector = sourceRows.length ? vectorOf(sourceRows[0]!.vector) : null;
    if (rowVector) {
      const nearest = await table.search(rowVector)
        .where(`id <> ${sqlString(row.id)}`)
        .limit(50)
        .toArray() as Array<Record<string, unknown>>;
      for (const candidate of nearest) {
        const id = String(candidate.id);
        const prior = db.prepare("SELECT seq FROM catalog WHERE id = ?").get(id) as { seq: number } | null;
        if (prior && prior.seq < rowSeq.seq) candidateIds.add(id);
      }
    }

    const selected = ["id", "vector", ...new Set([...exactFields, ...trgmFields])];
    const candidates: DedupCandidate[] = [];
    for (const id of candidateIds) {
      const rows = await table.query()
        .where(`id = ${sqlString(id)}`)
        .select(selected)
        .limit(1)
        .toArray() as Array<Record<string, unknown>>;
      const candidate = rows[0];
      if (!candidate) continue;
      const trgm: Record<string, number> = {};
      for (const field of trgmFields) {
        const column = sanitiseIdent(field);
        const left = row.fields[column] ?? row.fields[field];
        trgm[column] = trigramSimilarity(
          left == null ? "" : String(left),
          candidate[column] == null ? "" : String(candidate[column]),
        );
      }
      const candidateVector = vectorOf(candidate.vector);
      const fields: Record<string, unknown> = {};
      for (const field of exactFields.concat(trgmFields)) {
        const column = sanitiseIdent(field);
        fields[column] = candidate[column];
      }
      candidates.push({
        id,
        group: null,
        fields,
        trgm,
        cos: hasCosine && rowVector && candidateVector ? cosine(rowVector, candidateVector) : null,
      });
    }
    return candidates;
  };
}
