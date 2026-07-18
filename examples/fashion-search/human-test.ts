// Human A/B/C harness for the aspects verdict: side-by-side baseline vs aspects-on vs
// facets-only on the live corpus, with product images — the visual judgment the text-only
// LLM judge structurally cannot make. Run: bun --env-file=../../.env human-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLLECTION, PROJECT, createFashionMatcher, productsCollection } from "./samesake.config.ts";

const PORT = Number(process.env.PORT ?? 8791);
const matcher = createFashionMatcher();
await matcher.migrate();
await matcher.apply(PROJECT, { entities: [], collections: [productsCollection] });

const CONFIGS: Record<string, { label: string; weights?: Record<string, unknown> }> = {
  baseline: { label: "Baseline (doc + fts)" },
  aspects: { label: "Aspects on (visual .5 / facets .3)", weights: { aspects: { visual: 0.5, facets: 0.3 } } },
  facets: { label: "Facets only (.3)", weights: { aspects: { facets: 0.3 } } },
};

function mapHit(hit: Record<string, unknown>, breakdown?: Record<string, unknown>) {
  const data = hit.data as Record<string, unknown>;
  return {
    id: hit.id,
    title: String(hit.title ?? data.title ?? ""),
    image: data.image_url ?? null,
    url: data.url ?? null,
    price: hit.price != null ? Number(hit.price) : data.price != null ? Number(data.price) : null,
    store: hit.store_domain ?? data.store_domain ?? null,
    legs: breakdown ?? null,
  };
}

async function runConfig(key: string, q: string | undefined, image: string | undefined, limit: number) {
  const cfg = CONFIGS[key]!;
  const t0 = Date.now();
  const opts: Record<string, unknown> = { limit };
  if (q) opts.q = q;
  if (image) opts.image = { url: image };
  if (cfg.weights) opts.weights = cfg.weights;
  const [res, explain] = await Promise.all([
    matcher.shopSearch(PROJECT, COLLECTION, opts as never),
    matcher.searchExplain(PROJECT, COLLECTION, opts as never).catch(() => null),
  ]);
  const byId = new Map(
    ((explain?.docs ?? []) as Array<Record<string, unknown>>).map((d) => [
      d.id,
      { fts: d.fts_rank, ...(d.aspect_ranks as Record<string, { rank: number | null }> | undefined ?? {}) },
    ])
  );
  return {
    key,
    label: cfg.label,
    took_ms: Date.now() - t0,
    relaxed: (res as Record<string, unknown>).relaxed ?? false,
    trace: (res as Record<string, unknown>).constraintTrace ?? null,
    parsed: (res as Record<string, unknown>).parsed ?? null,
    hits: ((res as { hits: Array<Record<string, unknown>> }).hits ?? []).map((h) =>
      mapHit(h, byId.get(h.id) as Record<string, unknown> | undefined)
    ),
  };
}

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response(readFileSync(join(import.meta.dir, "human-test.html"), "utf8"), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? undefined;
      const image = url.searchParams.get("image") ?? undefined;
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 8), 20);
      if (!q && !image) return Response.json({ error: "q or image required" }, { status: 400 });
      try {
        const configs = image && !q ? ["aspects"] : Object.keys(CONFIGS);
        const columns = await Promise.all(configs.map((key) => runConfig(key, q, image, limit)));
        return Response.json({ q: q ?? null, image: image ?? null, columns });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[human-test] http://localhost:${PORT} — corpus ${PROJECT}/${COLLECTION}`);
