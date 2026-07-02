import postgres from "postgres";
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

export async function readExtractedAttrs(schemaName: string, ids: string[]): Promise<ExtractedAttrs[]> {
  if (!ids.length) return [];
  const sql = postgres(process.env.SAMESAKE_DATABASE_URL!, { max: 2 });
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
