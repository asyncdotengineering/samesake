import { getMatcher, PROJECT, COLLECTION } from "@/lib/samesake";

// samesake search runs in-process; needs the Node runtime (Postgres, drizzle).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { q?: string; category?: string };
  const q = (body.q ?? "").trim();
  if (!q) return Response.json({ hits: [] });

  // No explicit price filter: NLQ parses budgets ("under 3000") from q into a hard
  // price constraint. category stays an explicit facet from the storefront chips.
  const result = await getMatcher().search(PROJECT, COLLECTION, {
    q,
    limit: 24,
    filters: {
      available: true,
      ...(body.category ? { category: body.category } : {}),
    },
  });

  return Response.json({
    hits: result.hits.map((h) => ({
      id: h.id,
      title: h.data.title,
      brand: h.data.brand,
      category: h.data.category,
      color: h.data.color,
      price: h.data.price,
      imageUrl: h.data.image_url,
    })),
  });
}
