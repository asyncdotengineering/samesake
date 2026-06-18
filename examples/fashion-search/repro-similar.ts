/**
 * Repro: does "similar" mean genuine visual + semantic similarity, or keyword matching?
 *
 * Controlled corpus + the SAME RRF fusion the fashion config uses
 * (Channels.fts({fields:["title"]}, w=1) + Channels.cosine({embedding:"doc"}, w=1)),
 * NLQ OFF so hard filters can't mask ranking. Real gemini-embedding-2 text vectors.
 *
 * Corpus is rigged to separate MEANING from WORDS for an evening-dress query:
 *   - TRUE-SIMILAR: black, flowy evening/cocktail dresses, described with SYNONYMS that
 *     avoid the literal tokens black/cocktail/dress/flowy (ink/jet/onyx, gown/number/slip,
 *     gala/soiree/after-dark). Only genuine meaning can retrieve them.
 *   - KEYWORD-DECOYS: a t-shirt and a pyjama set that are NOT evening dresses but whose
 *     title+text are stuffed with the literal words "black cocktail dress" / "flowy".
 *   - distractors: unrelated apparel.
 *
 * For each query we probe three weightings and print per-leg ranks from /explain, plus a
 * "w" flag = does the doc's indexed text literally contain a query token. The disease shows
 * up as decoys (w=yes, wrong look) outranking true-similar items (w=no, right look).
 *   default   fts=1 cosine=1   (what the app ships)
 *   semantic  fts=0 cosine=1   (genuine similarity only)
 *   keyword   fts=1 cosine=0   (pure FTS)
 *
 * Run:  bun --env-file=../../.env repro-similar.ts
 */
import { collection, f, Channels } from "@samesake/core";
import { createMatcher } from "@samesake/server";
import { geminiEmbed, geminiGenerate } from "./gemini.ts";

const SLUG = process.env.REPRO_PROJECT ?? "repro_similar";
const COLLECTION = "products";
const QUERIES = ["flowy black cocktail dress", "black dress", "cocktail dress"];

type Kind = "similar" | "decoy" | "distractor";
type Doc = { id: string; kind: Kind; title: string; description: string };

const CORPUS: Doc[] = [
  // TRUE-SIMILAR — black flowy evening dresses; SYNONYMS only, no literal query tokens.
  { id: "sim-1", kind: "similar", title: "Midnight Slip Gown",
    description: "An ink-dark bias-cut satin floor-length number with whisper-thin straps that pours over the body; made for galas and after-dark soirees." },
  { id: "sim-2", kind: "similar", title: "Onyx Evening Drape",
    description: "A charcoal fluid chiffon piece that ripples with every step, cut for upscale night receptions and gala dinners." },
  { id: "sim-3", kind: "similar", title: "Eclipse Satin Maxi",
    description: "A jet floor-skimming satin silhouette with a softly draped open back for formal nights out." },
  { id: "sim-4", kind: "similar", title: "Raven Bias Gown",
    description: "A deep raven-toned liquid-satin column that skims and sways; spaghetti straps, cut for black-tie evenings." },

  // KEYWORD-DECOYS — literal words, wrong garment / wrong look.
  { id: "decoy-1", kind: "decoy", title: "Black Cocktail Dress Graphic Tee",
    description: "A relaxed cotton crew-neck t-shirt printed with the slogan 'black cocktail dress'; everyday casual streetwear." },
  { id: "decoy-2", kind: "decoy", title: "Flowy Cocktail Dress Pyjama Set",
    description: "A soft flannel pyjama set with a cute flowy cocktail dress cartoon print; loungewear for sleeping in." },

  // DISTRACTORS — unrelated apparel.
  { id: "dist-1", kind: "distractor", title: "Stonewash Straight Jeans",
    description: "Classic mid-rise straight-leg denim jeans in a light stonewash, five-pocket everyday casual." },
  { id: "dist-2", kind: "distractor", title: "Canvas Court Sneakers",
    description: "White low-top canvas sneakers with a rubber sole for casual everyday wear." },
  { id: "dist-3", kind: "distractor", title: "Camel Wool Blazer",
    description: "A tailored single-breasted camel wool blazer with notch lapels for the office." },
  { id: "dist-4", kind: "distractor", title: "Sunflower Cotton Sundress",
    description: "A bright yellow floral cotton sundress with thin straps for sunny casual days." },
  { id: "dist-5", kind: "distractor", title: "Charcoal Ribbed Knit Cardigan",
    description: "A cosy charcoal ribbed knit cardigan with a relaxed fit for layering." },
  { id: "dist-6", kind: "distractor", title: "Linen Wide-Leg Trousers",
    description: "Breathable beige linen wide-leg trousers with a high waist for warm-weather workdays." },
  { id: "dist-7", kind: "distractor", title: "Navy Cable Sweater",
    description: "A chunky navy cable-knit crew sweater in lambswool for cold days." },
  { id: "dist-8", kind: "distractor", title: "Quilted Puffer Jacket",
    description: "A black water-resistant quilted puffer jacket with a stand collar for winter." },
];

const reproCollection = collection(COLLECTION, {
  fields: {
    title: f.text({ searchable: true }),
    description: f.text(),
    kind: f.text({ filterable: true }),
  },
  embeddings: {
    doc: {
      source: "$title. $description",
      model: "gemini-embedding-2",
      dim: 1536,
      taskType: "RETRIEVAL_DOCUMENT",
    },
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
    ],
    combiner: "rrf",
    // NLQ deliberately omitted — isolate the fusion, no hard filters.
  },
});

const byId = new Map(CORPUS.map((d) => [d.id, d] as const));
const STOP = new Set(["a", "the", "in", "for", "of", "and"]);

function queryTokens(q: string): string[] {
  return q.toLowerCase().split(/\W+/).filter((t) => t && !STOP.has(t));
}
// does the doc's indexed text (title + description) literally contain any query token?
function wordHit(doc: Doc, q: string): boolean {
  const text = `${doc.title} ${doc.description}`.toLowerCase();
  return queryTokens(q).some((t) => text.includes(t));
}

async function main() {
  if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY) {
    throw new Error("DATABASE_URL and GEMINI_API_KEY required");
  }
  const matcher = createMatcher({
    databaseUrl: process.env.DATABASE_URL,
    apiKey: process.env.GEMINI_API_KEY,
    migrate: "eager",
    embed: geminiEmbed,
    generate: geminiGenerate,
  });

  await matcher.migrate();
  await matcher.apply(SLUG, { entities: [], collections: [reproCollection] });
  await matcher.pushDocuments(
    SLUG,
    COLLECTION,
    CORPUS.map((d) => ({ id: d.id, data: { title: d.title, description: d.description, kind: d.kind } }))
  );

  let indexed = 0;
  while (true) {
    const r = await matcher.index(SLUG, COLLECTION, { limit: 100 });
    indexed += r.indexed;
    if (r.indexed === 0) break;
  }
  console.log(`indexed ${indexed} / ${CORPUS.length} products`);

  const configs: Array<{ name: string; opts: Record<string, unknown> }> = [
    { name: "OLD default (flat fts=1,cos=1)", opts: { weights: { fts: 1, cosine: 1 } } },
    { name: "NEW intent  (mode=intent)", opts: { mode: "intent" } },
    { name: "NEW similar (mode=similar)", opts: { mode: "similar" } },
  ];

  for (const q of QUERIES) {
    console.log(`\n══════════════════ QUERY: "${q}" ══════════════════`);
    for (const cfg of configs) {
      const ex = await matcher.searchExplain(SLUG, COLLECTION, { q, ...cfg.opts, limit: 6 });
      const top5kinds = ex.docs.slice(0, 5).map((d) => byId.get(d.id)?.kind);
      const decoyInTop5 = top5kinds.filter((k) => k === "decoy").length;
      const simInTop3 = ex.docs.slice(0, 3).filter((d) => byId.get(d.id)?.kind === "similar").length;
      console.log(
        `\n  ── ${cfg.name}   true-similar@3=${simInTop3}/3   decoys@5=${decoyInTop5}`
      );
      if (ex.docs.length === 0) {
        console.log("     (no results — FTS matched nothing and cosine is off)");
        continue;
      }
      console.log("     rank id        kind        w   fts  cos   rrf      title");
      ex.docs.forEach((d, i) => {
        const doc = byId.get(d.id)!;
        const fr = d.fts_rank == null ? " - " : String(d.fts_rank).padStart(3);
        const cr = d.cosine_rank == null ? " - " : String(d.cosine_rank).padStart(3);
        const w = wordHit(doc, q) ? "Y" : "·";
        console.log(
          `     ${String(i + 1).padStart(2)}.  ${d.id.padEnd(9)} ${doc.kind.padEnd(10)}  ${w}  ${fr}  ${cr}   ${d.rrf_score.toFixed(4)}   ${doc.title}`
        );
      });
    }
  }

  await matcher.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
