/**
 * Repro: "similar" = GENUINE VISUAL + semantic similarity, not keyword/text matching.
 *
 * Controlled corpus of real fashion product images. One item is a striped SHIRT whose
 * title/description are deliberately stuffed with the word "dress" — a text-contamination
 * decoy. Then:
 *   A) TEXT query "dress" (mode=intent)  → the shirt-decoy ranks high on text/semantic,
 *      because its words say "dress" even though it is a shirt.
 *   B) IMAGE query = a held-out DRESS photo (mode=similar, auto)  → ranks the real dresses by
 *      actual look via the visual space (keyword + text cosine off); the shirt-decoy and the
 *      jacket/tee fall to the bottom. Per-item visual cosine is printed from /explain.
 *
 * This is the part no amount of text reweighting can fix: only a visual signal tells a
 * sloganed shirt apart from an evening dress.
 *
 * Run:  bun --env-file=../../.env repro-visual.ts
 */
import { collection, f, s, Channels } from "@samesake/core";
import { createMatcher } from "@samesake/server";
import { geminiEmbed, geminiGenerate } from "./gemini.ts";

const SLUG = process.env.REPRO_VISUAL_PROJECT ?? "repro_visual";
const COLLECTION = "products";

type Kind = "dress" | "decoy-shirt" | "distractor";
type Doc = { id: string; kind: Kind; title: string; description: string; image_url: string };

const CORPUS: Doc[] = [
  { id: "dress-bodycon", kind: "dress", title: "Alice Bodycon Dress",
    description: "A fitted bodycon dress for evenings out.",
    image_url: "https://www.aviratefashion.com/cdn/shop/files/HI_RES_-_AVIRATE-330.jpg?v=1756891093&width=800" },
  { id: "dress-redshift", kind: "dress", title: "Red Mirage Shift Dress",
    description: "A red shift dress with a relaxed drape.",
    image_url: "https://cdn.shopify.com/s/files/1/0020/1732/9251/files/CopyofPRO_3097.jpg?v=1774424761" },
  { id: "dress-beach", kind: "dress", title: "Rainbow Bliss Beach Strap Dress",
    description: "A breezy strappy beach dress in bright colours.",
    image_url: "https://kiaandkel.com/cdn/shop/files/5_36aa4bc1-d405-48e8-9cea-196ae3240a34.jpg?v=1778174372&width=800" },
  { id: "dress-princess", kind: "dress", title: "Princess Line Dress with Belt",
    description: "A belted princess-line dress with a flared skirt.",
    image_url: "https://cdn.shopify.com/s/files/1/0596/9798/7764/files/DSC3261.jpg?v=1774671146" },

  // Text-contamination decoy: a DENIM JACKET (visually nothing like a dress), but its words
  // scream "dress". Text search elevates it; a visual signal must bury it.
  { id: "decoy-denim", kind: "decoy-shirt", title: "Dress-Code Denim Jacket — Cocktail Dress Layer",
    description: "The perfect dress companion: a cocktail dress layer for your dress code. Dress it up or dress it down — a little black dress essential.",
    image_url: "https://cdn.shopify.com/s/files/1/0596/9798/7764/files/DSC8027.jpg?v=1765950251" },

  // Distractors: clearly not dresses (by look), plain text.
  { id: "dist-shirt", kind: "distractor", title: "Heritage Linen Stripe Shirt",
    description: "A short-sleeve striped linen shirt.",
    image_url: "https://cdn.shopify.com/s/files/1/0808/6280/6293/files/11449_3.jpg?v=1778154930" },
  { id: "dist-tee", kind: "distractor", title: "Embossed Oversized T-Shirt",
    description: "A men's oversized cotton t-shirt.",
    image_url: "https://edgecasual.com/cdn/shop/files/53672.png?v=1771226424&width=800" },
];

// Held-out DRESS image used as the visual query (not in the corpus).
const QUERY_IMAGE = "https://cdn.shopify.com/s/files/1/0812/8108/9757/files/DSC07499-copy-2.jpg?v=1771412601"; // "RED PUFF SLEEVE MAXI DRESS"

const reproCollection = collection(COLLECTION, {
  fields: {
    title: f.text({ searchable: true }),
    description: f.text(),
    image_url: f.text(),
    kind: f.text({ filterable: true }),
  },
  embeddings: {
    doc: { source: "$title. $description", model: "gemini-embedding-2", dim: 1536, taskType: "RETRIEVAL_DOCUMENT" },
  },
  spaces: {
    visual: s.image({ source: "$image_url", model: "gemini-embedding-2", dim: 768, taskType: "RETRIEVAL_DOCUMENT" }),
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
      Channels.spaces({ weight: 1 }),
    ],
    combiner: "rrf",
    defaultSpaceWeights: { visual: 2 },
  },
});

const byId = new Map(CORPUS.map((d) => [d.id, d] as const));

function printDocs(docs: Array<{ id: string; fts_rank: number | null; cosine_rank: number | null; spaces_rank: number | null; rrf_score: number; space_cosines?: Record<string, number> }>) {
  console.log("     rank id              kind          fts  cos  vis-cos   rrf      title");
  docs.forEach((d, i) => {
    const doc = byId.get(d.id)!;
    const fr = d.fts_rank == null ? " - " : String(d.fts_rank).padStart(3);
    const cr = d.cosine_rank == null ? " - " : String(d.cosine_rank).padStart(3);
    const vc = d.space_cosines?.visual != null ? d.space_cosines.visual.toFixed(3) : "  -  ";
    console.log(`     ${String(i + 1).padStart(2)}.  ${d.id.padEnd(14)}  ${doc.kind.padEnd(12)}  ${fr}  ${cr}   ${vc}   ${d.rrf_score.toFixed(4)}   ${doc.title}`);
  });
}

async function main() {
  if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY) throw new Error("DATABASE_URL and GEMINI_API_KEY required");
  const matcher = createMatcher({
    databaseUrl: process.env.DATABASE_URL,
    apiKey: process.env.GEMINI_API_KEY,
    migrate: "eager",
    embed: geminiEmbed,
    generate: geminiGenerate,
  });

  await matcher.migrate();
  await matcher.apply(SLUG, { entities: [], collections: [reproCollection] });
  await matcher.pushDocuments(SLUG, COLLECTION,
    CORPUS.map((d) => ({ id: d.id, data: { title: d.title, description: d.description, image_url: d.image_url, kind: d.kind } })));

  let indexed = 0;
  while (true) {
    const r = await matcher.index(SLUG, COLLECTION, { limit: 100 });
    indexed += r.indexed;
    if (r.indexed === 0) break;
  }
  console.log(`indexed ${indexed} / ${CORPUS.length} products (doc text + visual image embeddings)`);

  console.log(`\n══ A) TEXT query "dress"  (mode=intent — what a text search does) ══`);
  const a = await matcher.searchExplain(SLUG, COLLECTION, { q: "dress", mode: "intent", limit: 7 });
  const aDecoyRank = a.docs.findIndex((d) => byId.get(d.id)?.kind === "decoy-shirt") + 1;
  console.log(`   shirt-decoy rank: #${aDecoyRank}  (its text is stuffed with "dress")`);
  printDocs(a.docs);

  console.log(`\n══ B) IMAGE query = held-out dress photo  (mode=similar, auto) ══`);
  const b = await matcher.searchExplain(SLUG, COLLECTION, { q: "", image: { url: QUERY_IMAGE }, limit: 7 });
  const topKinds = b.docs.slice(0, 4).map((d) => byId.get(d.id)?.kind);
  const dressesInTop4 = topKinds.filter((k) => k === "dress").length;
  const bDecoyRank = b.docs.findIndex((d) => byId.get(d.id)?.kind === "decoy-shirt") + 1;
  console.log(`   dresses in top-4: ${dressesInTop4}/4   shirt-decoy rank: #${bDecoyRank}  (visual sees it is a shirt)`);
  printDocs(b.docs);

  await matcher.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
