/**
 * Multi-turn search on the FULL LK snapshot catalog (~500 real products), to personally judge
 * whether the new modes/NLQ/filters/visual-similar give positive hits across a conversation.
 *
 * A chat client maintains conversation state (accumulated query text + hard filters). Each turn
 * issues one matcher.search(); the last turn of each conversation is a visual "more like this".
 *
 * Catalog: deduped, capped per query to bound image-embed cost. doc(text) + visual(image) spaces.
 *
 * Run:  DATASET=/abs/path/to/search-snapshots bun --env-file=../../.env multiturn-search.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collection, f, s, Channels } from "@samesake/core";
import { createMatcher } from "@samesake/server";
import { geminiEmbed, geminiGenerate } from "./gemini.ts";

const SLUG = process.env.MT_PROJECT ?? "mt_catalog";
const COLL = "catalog";
const DATASET = process.env.DATASET ?? "/Users/mithushancj/Documents/personal/project-search-web-search/research/dataset/search-snapshots";
const PER_QUERY = Number(process.env.MT_PER_QUERY ?? 8); // cap per source query to bound image embeds

type Raw = { title?: string; price_numeric?: number; price?: string; image?: string; url?: string; vendor?: string; source?: string; available?: boolean; tags?: string[]; product_type?: string };

function loadCatalog(): { id: string; data: Record<string, unknown> }[] {
  const files = readdirSync(DATASET).filter((f) => /^q\d+\.json$/.test(f));
  const seen = new Set<string>();
  const docs: { id: string; data: Record<string, unknown> }[] = [];
  for (const file of files) {
    const snap = JSON.parse(readFileSync(join(DATASET, file), "utf8")) as { results?: Raw[] };
    let n = 0;
    for (const r of snap.results ?? []) {
      if (n >= PER_QUERY) break;
      const title = (r.title ?? "").trim();
      const img = r.image ?? "";
      if (!title || !img || img.includes("paykoko")) continue; // need a real product image
      const key = (r.url ?? r.handle ?? title).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      n++;
      docs.push({
        id: key.replace(/[^a-z0-9]+/g, "_").slice(0, 80) + "_" + docs.length,
        data: {
          title,
          vendor: r.vendor ?? r.source ?? "",
          price: typeof r.price_numeric === "number" ? r.price_numeric : Number(r.price) || 0,
          available: r.available !== false,
          image_url: img,
          tags: Array.isArray(r.tags) ? r.tags.join(" ") : "",
          url: r.url ?? null,
        },
      });
    }
  }
  return docs;
}

const catalog = collection(COLL, {
  fields: {
    title: f.text({ searchable: true }),
    vendor: f.text({ filterable: true }),
    price: f.number({ filterable: true, budget: true }),
    available: f.boolean({ filterable: true }),
    image_url: f.text(),
    tags: f.text(),
  },
  embeddings: { doc: { source: "$title $vendor $tags", model: "gemini-embedding-2", dim: 1536, taskType: "RETRIEVAL_DOCUMENT" } },
  spaces: { visual: s.image({ source: "$image_url", model: "gemini-embedding-2", dim: 768, taskType: "RETRIEVAL_DOCUMENT" }) },
  search: {
    channels: [Channels.fts({ fields: ["title"], weight: 1 }), Channels.cosine({ embedding: "doc", weight: 1 }), Channels.spaces({ weight: 1 })],
    combiner: "rrf",
    defaultSpaceWeights: { visual: 2 },
  },
});

type Turn = { say: string; q?: string; filters?: Record<string, unknown>; mode?: "intent" | "similar"; imageFromTop?: boolean };
type Conversation = { name: string; turns: Turn[] };

const CONVERSATIONS: Conversation[] = [
  {
    name: "A — refine then look-alike",
    turns: [
      { say: '"red dress"', q: "red dress" },
      { say: 'narrow: under LKR 5000', q: "red dress", filters: { price: { $lte: 5000 }, available: true } },
      { say: 'shift intent: for a wedding', q: "red dress for a wedding", filters: { price: { $lte: 5000 }, available: true } },
      { say: 'more like the top result (visual)', imageFromTop: true },
    ],
  },
  {
    name: "B — exact intent then similar",
    turns: [
      { say: '"linen shirt men"', q: "linen shirt men", mode: "intent" },
      { say: 'similar look (text)', q: "linen shirt men", mode: "similar" },
      { say: 'more like the top result (visual)', imageFromTop: true },
    ],
  },
  {
    name: "C — vague intent",
    turns: [
      { say: '"something comfortable for a beach wedding"', q: "something comfortable for a beach wedding" },
      { say: 'add budget under 8000', q: "something comfortable for a beach wedding", filters: { price: { $lte: 8000 }, available: true } },
    ],
  },
];

async function main() {
  if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY) throw new Error("DATABASE_URL and GEMINI_API_KEY required");
  const matcher = createMatcher({
    databaseUrl: process.env.DATABASE_URL, apiKey: process.env.GEMINI_API_KEY,
    migrate: "eager", embed: geminiEmbed, generate: geminiGenerate,
  });
  await matcher.migrate();
  await matcher.apply(SLUG, { entities: [], collections: [catalog] });

  const docs = loadCatalog();
  console.log(`catalog: ${docs.length} products (capped ${PER_QUERY}/query, deduped, with images)`);
  await matcher.pushDocuments(SLUG, COLL, docs);
  let indexed = 0;
  while (true) { const r = await matcher.index(SLUG, COLL, { limit: 50 }); indexed += r.indexed; if (r.indexed === 0) break; }
  console.log(`indexed ${indexed} (doc text + visual image embeddings)\n`);

  const byId = new Map(docs.map((d) => [d.id, d.data] as const));
  for (const conv of CONVERSATIONS) {
    console.log(`\n════════════ CONVERSATION ${conv.name} ════════════`);
    let lastTopImage: string | undefined;
    for (const t of conv.turns) {
      const opts: Record<string, unknown> = { limit: 5 };
      if (t.imageFromTop) {
        if (!lastTopImage) { console.log(`  · ${t.say}: (no prior top image)`); continue; }
        opts.image = { url: lastTopImage };
      } else {
        opts.q = t.q;
        if (t.mode) opts.mode = t.mode;
        if (t.filters) opts.filters = t.filters;
      }
      const res = await matcher.search(SLUG, COLL, opts);
      const hdr = t.imageFromTop ? `🖼  ${t.say}` : `💬 ${t.say}${t.mode ? `  [mode=${t.mode}]` : ""}${t.filters ? "  [+filter]" : ""}`;
      console.log(`\n  ${hdr}`);
      res.hits.forEach((h, i) => {
        const d = byId.get(h.id) ?? (h.data as Record<string, unknown>);
        console.log(`    ${i + 1}. ${String(d.title).slice(0, 48).padEnd(48)} LKR ${String(d.price).padStart(6)}  (${String(d.vendor).slice(0, 16)})`);
      });
      if (!t.imageFromTop && res.hits[0]) lastTopImage = String((byId.get(res.hits[0].id) ?? {}).image_url ?? "");
    }
  }
  await matcher.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
