import { getMatcher, PROJECT, COLLECTION } from "@/lib/samesake";

// samesake search runs in-process; needs the Node runtime (Postgres, drizzle).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    q?: string;
    image?: { url?: string };
    category?: string;
  };
  const q = (body.q ?? "").trim();
  const imageUrl = body.image?.url;
  if (!q && !imageUrl) return Response.json({ hits: [] });

  // Text queries hit FTS + text cosine + (cross-modal) the visual space; an image query
  // (find-similar / paste-URL) drives the visual space directly. NLQ parses budgets from q.
  const result = await getMatcher().search(PROJECT, COLLECTION, {
    q,
    image: imageUrl ? { url: imageUrl } : undefined,
    limit: 24,
    filters: { available: true, ...(body.category ? { category: body.category } : {}) },
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
