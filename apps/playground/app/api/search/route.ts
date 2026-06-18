import { getMatcher, PROJECT, COLLECTION } from "@/lib/samesake";

// samesake search runs in-process; needs the Node runtime (Postgres, drizzle).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    q?: string;
    image?: { url?: string };
  };
  const q = (body.q ?? "").trim();
  const imageUrl = body.image?.url;
  if (!q && !imageUrl) return Response.json({ hits: [] });

  // Text queries hit FTS + text cosine + (cross-modal) the visual space; an image query
  // (find-similar / paste-URL) drives the visual space directly. NLQ parses budgets from q.
  // Attributes (category/colors/...) are derived by the enrich pipeline and live on the hit
  // fields (enriched.*), not the raw doc data.
  const result = await getMatcher().search(PROJECT, COLLECTION, {
    q,
    image: imageUrl ? { url: imageUrl } : undefined,
    limit: 24,
    filters: { available: true },
  });

  const str = (v: unknown) => (v == null ? "" : String(v));
  return Response.json({
    hits: result.hits.map((h) => {
      const hit = h as Record<string, unknown> & { id: string; data: Record<string, unknown> };
      const colors = hit.colors;
      return {
        id: hit.id,
        title: str(hit.title ?? hit.data.title),
        brand: str(hit.brand ?? hit.data.brand),
        category: str(hit.category),
        color: Array.isArray(colors) ? colors.join(", ") : str(colors),
        price: Number(hit.price ?? hit.data.price ?? 0),
        imageUrl: str(hit.image_url ?? hit.data.image_url),
      };
    }),
  });
}
