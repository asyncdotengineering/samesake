import postgres from "postgres";
import { composeFashionEmbedDoc } from "@samesake/core";
import { COLLECTION } from "./samesake";

export type ExtractedAttrs = {
  id: string;
  title: string;
  imageUrl: string;
  category: string | null;
  gender: string | null;
  colors: string[];
  occasions: string[];
  styles: string[];
  material: string | null;
};

// Read back what the enrich pipeline extracted for the given ids — used by the upload route to
// show the user the LLM-derived attributes (the pipeline proof).
export async function readExtractedAttrs(schemaName: string, ids: string[]): Promise<ExtractedAttrs[]> {
  if (!ids.length) return [];
  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
  try {
    const rows = await sql.unsafe<{ id: string; data: unknown; enriched: unknown }[]>(
      `SELECT id, data, enriched FROM ${schemaName}.c_${COLLECTION} WHERE id = ANY($1::text[])`,
      [ids]
    );
    return rows.map((r) => {
      const data = (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown>;
      const e = (r.enriched == null ? {} : typeof r.enriched === "string" ? JSON.parse(r.enriched) : r.enriched) as Record<string, unknown>;
      return {
        id: r.id,
        title: String(data.title ?? ""),
        imageUrl: String(data.image_url ?? ""),
        category: (e.category as string) ?? null,
        gender: (e.gender as string) ?? null,
        colors: Array.isArray(e.colors) ? (e.colors as string[]) : [],
        occasions: Array.isArray(e.occasions) ? (e.occasions as string[]) : [],
        styles: Array.isArray(e.styles) ? (e.styles as string[]) : [],
        material: (e.material as string) ?? null,
      };
    });
  } finally {
    await sql.end();
  }
}

// After enrich, compose the rich search document from the extracted attributes and write it to
// enriched.embed_doc — which the collection's doc embedding reads ($enriched.embed_doc). Non-apparel
// rows are skipped (they don't get extracted attributes). Returns how many docs were (re)composed.
export async function composeEmbedDocs(schemaName: string): Promise<number> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
  try {
    const table = `${schemaName}.c_${COLLECTION}`;
    const rows = await sql.unsafe<{ id: string; data: unknown; enriched: unknown }[]>(
      `SELECT id, data, enriched FROM ${table} WHERE enriched_at IS NOT NULL`
    );
    let composed = 0;
    for (const r of rows) {
      const data = (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown>;
      const enriched = (r.enriched == null
        ? null
        : typeof r.enriched === "string"
          ? JSON.parse(r.enriched)
          : r.enriched) as Record<string, unknown> | null;
      if (!enriched || enriched.is_apparel_product === false || enriched.category === "other") continue;
      const next = { ...enriched, embed_doc: composeFashionEmbedDoc({ title: String(data.title ?? "") }, enriched) };
      await sql.unsafe(`UPDATE ${table} SET enriched = $1::jsonb, enriched_at = now() WHERE id = $2`, [
        JSON.stringify(next),
        r.id,
      ]);
      composed++;
    }
    return composed;
  } finally {
    await sql.end();
  }
}
