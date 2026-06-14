/**
 * Build a small eval subset from real LK fashion search snapshots.
 *
 * Source: a directory of `q*.json` search snapshots, each shaped as
 *   { query: string, country: string, expansions: string[], results: Result[] }
 * where each Result has { title, vendor, price_numeric, available, image, tags, ... }.
 *
 * Takes the first N results from each snapshot and emits:
 *   <out>/source/q*.json   — the trimmed snapshots (provenance for the tutorial)
 *   <out>/corpus.json      — { products, queries } consumed by eval.ts
 *
 * Each snapshot's query becomes one EvalQuery whose `relevant` set is exactly the
 * products taken from that snapshot (they were returned for that query upstream).
 *
 * Usage:
 *   LK_SNAPSHOTS_DIR=/abs/path/to/search-snapshots bun build-lk-subset.ts [--per 3]
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const SRC =
  process.env.LK_SNAPSHOTS_DIR ??
  "/Users/mithushancj/Documents/personal/project-search-web-search/research/dataset/search-snapshots";
const OUT = process.env.LK_SUBSET_OUT ?? join(import.meta.dir, "datasets", "lk-snapshot-subset");
const PER = (() => {
  const i = process.argv.indexOf("--per");
  return i >= 0 ? Number(process.argv[i + 1]) : 3;
})();

const COLOR_WORDS = ["black", "white", "red", "blue", "navy", "green", "yellow", "pink", "purple", "orange", "brown", "grey", "gray", "beige", "cream", "maroon", "gold", "silver", "khaki", "olive", "teal"];
const MATERIAL_WORDS = ["cotton", "linen", "silk", "denim", "leather", "polyester", "wool", "satin", "chiffon", "velvet", "knit", "jersey", "lace", "rayon", "viscose", "nylon", "spandex"];
const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/\b(saree|sari)\b/, "saree"],
  [/\b(dress|gown|frock)\b/, "dresses"],
  [/\b(t[-\s]?shirt|tee|tshirt)\b/, "tops"],
  [/\b(blouse|top|shirt)\b/, "tops"],
  [/\b(jacket|coat|blazer)\b/, "outerwear"],
  [/\b(legging|tight|trouser|pant|jean|short)\b/, "bottoms"],
  [/\b(skirt)\b/, "bottoms"],
  [/\b(jumpsuit|romper)\b/, "jumpsuits"],
];

function pick(words: string[], haystack: string): string[] {
  const h = haystack.toLowerCase();
  return words.filter((w) => new RegExp(`\\b${w}\\b`).test(h));
}

function guessCategory(text: string, fallbackQuery: string): string {
  const h = `${text} ${fallbackQuery}`.toLowerCase();
  for (const [re, cat] of CATEGORY_RULES) if (re.test(h)) return cat;
  return "other";
}

type Snapshot = { query: string; country?: string; expansions?: string[]; results: Record<string, unknown>[] };
type Product = { id: string; title: string; brand: string; category: string; colors: string[]; material: string; price: number; available: boolean };
type EvalQuery = { name: string; q: string; filters?: Record<string, unknown>; constraints?: Record<string, unknown>; relevant: string[]; image?: string };

const files = readdirSync(SRC)
  .filter((f) => /^q\d+\.json$/.test(f))
  .sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));

if (!files.length) {
  console.error(`No q*.json snapshots found in ${SRC}`);
  process.exit(1);
}

const products: Product[] = [];
const queries: EvalQuery[] = [];

mkdirSync(join(OUT, "source"), { recursive: true });

for (const file of files) {
  const key = basename(file, ".json");
  const snap = JSON.parse(readFileSync(join(SRC, file), "utf8")) as Snapshot;
  const taken = (snap.results ?? []).slice(0, PER);

  const relevant: string[] = [];
  taken.forEach((r, i) => {
    const id = `${key}-${i + 1}`;
    const title = String(r.title ?? "").trim();
    const tags = Array.isArray(r.tags) ? (r.tags as unknown[]).map(String).join(" ") : "";
    const text = `${title} ${tags}`;
    const price = typeof r.price_numeric === "number" ? r.price_numeric : Number(r.price) || 0;
    products.push({
      id,
      title,
      brand: String(r.vendor ?? r.source ?? "unknown").trim() || "unknown",
      category: String(r.product_type ?? "").trim().toLowerCase() || guessCategory(text, snap.query),
      colors: pick(COLOR_WORDS, text),
      material: pick(MATERIAL_WORDS, text)[0] ?? "",
      price,
      available: r.available === true,
    });
    relevant.push(id);
  });

  // Derive a price cap from "under N" phrasing (e.g. q7 "modest dress for work under 5000").
  const cap = snap.query.match(/under\s+(\d[\d,]*)/i);
  const query: EvalQuery = { name: key, q: snap.query, relevant };
  if (cap) {
    const maxPrice = Number(cap[1]!.replace(/,/g, ""));
    query.filters = { price: { $lte: maxPrice }, available: true };
    query.constraints = { maxPrice, available: true };
  } else {
    query.filters = { available: true };
    query.constraints = { available: true };
  }
  queries.push(query);

  // Trimmed snapshot for provenance.
  writeFileSync(
    join(OUT, "source", file),
    JSON.stringify({ query: snap.query, country: snap.country, expansions: snap.expansions, results: taken }, null, 2)
  );
}

writeFileSync(
  join(OUT, "corpus.json"),
  JSON.stringify(
    {
      meta: { source: "LK fashion search snapshots", perFile: PER, files: files.length },
      products,
      queries,
    },
    null,
    2
  )
);

console.log(`subset built → ${OUT}`);
console.log(`  products: ${products.length} (${PER} × ${files.length})`);
console.log(`  queries:  ${queries.length}`);
console.log(`  price-constrained queries: ${queries.filter((q) => q.constraints?.maxPrice).map((q) => q.name).join(", ") || "none"}`);
