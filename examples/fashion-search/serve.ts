import { COLLECTION, PROJECT, createFashionMatcher, ensureProject } from "./samesake.config.ts";

const PORT = Number(process.env.PORT ?? 8788);

function domainFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function mapHit(hit: Record<string, unknown>) {
  const data = hit.data as Record<string, unknown>;
  const enriched = (hit.enriched ?? data.enriched ?? {}) as Record<string, unknown>;
  const priceNum =
    hit.price != null
      ? Number(hit.price)
      : data.price != null
        ? Number(data.price)
        : null;
  const source =
    (hit.store_domain as string | undefined) ??
    (data.store_domain as string | undefined) ??
    domainFromUrl(data.url as string | undefined);

  return {
    title: String(hit.title ?? data.title ?? ""),
    url: data.url ?? null,
    price: priceNum != null ? priceNum.toFixed(2) : null,
    price_numeric: priceNum,
    currency: "LKR",
    image: data.image_url ?? null,
    description: String(hit.doc ?? enriched.embed_doc ?? enriched.search_document ?? ""),
    source,
    vendor: data.vendor ?? null,
    product_type: hit.product_type ?? enriched.product_type ?? null,
    category: hit.category ?? enriched.category ?? null,
    attrs: {
      colors: hit.colors ?? enriched.colors ?? [],
      occasions: hit.occasions ?? enriched.occasions ?? [],
      styles: hit.styles ?? enriched.styles ?? [],
      pattern: hit.pattern ?? enriched.pattern ?? null,
      material: hit.material ?? enriched.material ?? null,
      fit: hit.fit ?? enriched.fit ?? null,
      gender: hit.gender ?? enriched.gender ?? null,
    },
    available: hit.available ?? data.available ?? null,
    score: hit.score ?? null,
  };
}

async function main() {
  const matcher = createFashionMatcher();
  await ensureProject(matcher);

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/search/v2" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const limit = Number(url.searchParams.get("limit") ?? 20);
        if (!q.trim()) {
          return Response.json({ error: "q required" }, { status: 400 });
        }
        const result = await matcher.search(PROJECT, COLLECTION, { q, limit });
        return Response.json({
          query: q,
          engine: "samesake-fashion-parity",
          parsed: result.parsed,
          nlq_degraded: result.nlq_degraded,
          relaxed_soft_filters: result.relaxed,
          took_ms: result.took_ms,
          results: result.hits.map((h) => mapHit(h as unknown as Record<string, unknown>)),
        });
      }
      return matcher.fetch(req);
    },
  });

  console.log(`fashion parity server on http://localhost:${server.port}`);
  console.log(`eval: cd ../project-search-web-search && node scripts/eval-search.js --target v2 --base http://localhost:${server.port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
