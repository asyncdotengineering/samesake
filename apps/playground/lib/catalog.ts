import postgres from "postgres";

export type Product = {
  id: string;
  title: string;
  brand: string;
  category: string;
  color: string;
  material: string;
  price: number;
  imageUrl: string;
};

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) _sql = postgres(process.env.DATABASE_URL!, { max: 3 });
  return _sql;
}

// Browse: read the live Porulle catalog (active products) for the storefront grid.
// (REST equivalent: GET /api/catalog/entities?status=active&include=attributes,pricing.)
export async function listProducts(): Promise<Product[]> {
  const sql = db();
  const rows = await sql<
    { id: string; title: string | null; metadata: Record<string, unknown> | null; price: number | null }[]
  >`
    SELECT e.id, a.title, e.metadata,
      (SELECT amount FROM prices p WHERE p.entity_id = e.id AND p.variant_id IS NULL LIMIT 1) AS price
    FROM sellable_entities e
    LEFT JOIN sellable_attributes a ON a.entity_id = e.id AND a.locale = 'en'
    WHERE e.status = 'active'
    ORDER BY a.title
  `;
  const cfRows = await sql<{ entity_id: string; field_name: string; text_value: string | null }[]>`
    SELECT entity_id, field_name, text_value FROM sellable_custom_fields
  `;
  const cf = new Map<string, Record<string, string>>();
  for (const r of cfRows) {
    const m = cf.get(r.entity_id) ?? {};
    m[r.field_name] = r.text_value ?? "";
    cf.set(r.entity_id, m);
  }
  return rows.map((r) => {
    const f = cf.get(r.id) ?? {};
    return {
      id: r.id,
      title: r.title ?? "",
      brand: String(r.metadata?.brand ?? "unknown"),
      category: f.category || "other",
      color: f.color || "",
      material: f.material || "",
      price: r.price ?? 0,
      imageUrl: f.imageUrl || "",
    };
  });
}
