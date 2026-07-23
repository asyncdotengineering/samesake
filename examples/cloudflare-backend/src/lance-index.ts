import { getByPath, type CollectionDef } from "@samesake/core";
import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import type { ClusterDecision } from "@samesake/enrich";
import type { DB } from "./d1.ts";

interface CatalogRow {
  id: string;
  data: string;
  enriched: string;
  doc: string | null;
  fts_src: string | null;
  vectors: string | null;
  product_group: string | null;
}

function fieldValue(
  name: string,
  def: CollectionDef["fields"][string],
  data: Record<string, unknown>,
  enriched: Record<string, unknown>
): unknown {
  const path = def.path ?? name;
  const source = path.startsWith("enriched.") ? enriched : data;
  const sourcePath = path.startsWith("enriched.") ? path.slice("enriched.".length) : path;
  const value = getByPath(source, sourcePath);
  if (value == null || value === "") return null;
  if (def.type === "number") return Number(value);
  if (def.type === "boolean") return Boolean(value);
  if (def.type === "array") return Array.isArray(value) ? value.join("\u0001") : String(value);
  return String(value);
}

export interface LanceConnection { db: Connection }

export async function openLance(uri: string): Promise<LanceConnection> {
  return { db: await lancedb.connect(uri) };
}

export async function indexEnriched(
  db: DB,
  lance: LanceConnection,
  def: CollectionDef,
  tableName: string
): Promise<{ table: Table; count: number }> {
  const rows = db.prepare(
    `SELECT id, data, enriched, vectors, doc, fts_src, product_group
     FROM catalog WHERE pipeline_status = 'ready' AND enriched IS NOT NULL ORDER BY seq`
  ).all() as CatalogRow[];
  if (!rows.length) throw new Error("indexEnriched: no ready rows");
  const primary = Object.entries(def.embeddings ?? {})[0];
  if (!primary) throw new Error("indexEnriched: collection declares no embedding");
  const [embeddingName] = primary;
  const lanceRows: Array<Record<string, unknown>> = [];
  const vocab = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const data = JSON.parse(row.data) as Record<string, unknown>;
    const enriched = JSON.parse(row.enriched) as Record<string, unknown>;
    const merged = { ...data, ...enriched, id: row.id };
    const doc = row.doc ?? "";
    const vector = row.vectors
      ? (JSON.parse(row.vectors) as Record<string, number[]>)[embeddingName]
      : undefined;
    if (!vector) throw new Error(`indexEnriched: row "${row.id}" has no vector for "${embeddingName}"`);
    const lanceRow: Record<string, unknown> = {
      id: row.id,
      vector,
      fts_src: (row.fts_src ?? "").toLowerCase(),
      data: JSON.stringify(merged),
      product_group: row.product_group ?? "",
    };
    for (const [name, field] of Object.entries(def.fields)) {
      lanceRow[name] = fieldValue(name, field, data, enriched);
      if (field.filterable) {
        const value = lanceRow[name];
        if (value != null && String(value).trim()) {
          const values = vocab.get(name) ?? new Map<string, number>();
          values.set(String(value), (values.get(String(value)) ?? 0) + 1);
          vocab.set(name, values);
        }
      }
    }
    lanceRows.push(lanceRow);
  }

  const table = await lance.db.createTable(tableName, lanceRows, { mode: "overwrite" });
  db.exec("DELETE FROM vocab");
  const statement = db.prepare("INSERT INTO vocab(field, value, count) VALUES (?, ?, ?)");
  for (const [field, values] of vocab) {
    for (const [value, count] of values) statement.run(field, value, count);
  }
  return { table, count: lanceRows.length };
}

export function persistGroups(db: DB, decisions: ClusterDecision[]): void {
  const statement = db.prepare("UPDATE catalog SET product_group = ?, updated_at = ? WHERE id = ?");
  for (const decision of decisions) {
    if (decision.outcome === "found" || decision.outcome === "link") statement.run(decision.group, Date.now(), decision.rowId);
  }
}
