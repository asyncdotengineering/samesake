import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Product = {
  id: string;
  title: string;
  brand: string;
  category: string;
  colors: string[];
  material: string;
  price: number;
  available: boolean;
};

type EvalQuery = {
  name: string;
  q: string;
  filters?: Record<string, unknown>;
  constraints?: {
    maxPrice?: number;
    requiredColors?: string[];
    excludedColors?: string[];
    available?: boolean;
  };
  relevant: string[];
  image?: string;
};

const brands = ["Luna", "Aster", "North", "Muse"];
const colors = ["red", "blue", "black", "green", "white"];
const materials = ["cotton", "linen", "denim", "polyester"];
const categories = ["dresses", "tops", "bottoms"];

function productId(parts: string[]): string {
  return parts.join("-").replace(/[^a-z0-9-]+/g, "-");
}

function buildProducts(): Product[] {
  const products: Product[] = [];
  for (const category of categories) {
    for (const color of colors) {
      for (const material of materials) {
        const brand = brands[(products.length + color.length + material.length) % brands.length]!;
        const noun = category === "bottoms" ? "jeans" : category === "tops" ? "shirt" : "dress";
        const price = 35 + color.length * 7 + material.length * 5 + category.length * 3;
        products.push({
          id: productId([color, material, noun]),
          title: `${color} ${material} ${noun}`,
          brand,
          category,
          colors: [color],
          material,
          price,
          available: !(color === "white" && material === "polyester"),
        });
      }
    }
  }
  return products;
}

function findRelevant(products: Product[], predicate: (p: Product) => boolean): string[] {
  return products.filter(predicate).map((p) => p.id).slice(0, 5);
}

function buildQueries(products: Product[]): EvalQuery[] {
  const queries: EvalQuery[] = [];
  for (const color of colors) {
    const relevant = findRelevant(products, (p) => p.colors.includes(color) && p.available);
    queries.push({
      name: `available-${color}`,
      q: `${color} fashion available`,
      filters: { colors: [color], available: true },
      constraints: { requiredColors: [color], available: true },
      relevant,
    });
  }

  for (const material of materials) {
    const relevant = findRelevant(products, (p) => p.material === material && p.price <= 95 && p.available);
    queries.push({
      name: `${material}-under-95`,
      q: `${material} under 95`,
      filters: { material, price: { $lte: 95 }, available: true },
      constraints: { maxPrice: 95, available: true },
      relevant,
    });
  }

  for (const category of categories) {
    const relevant = findRelevant(products, (p) => p.category === category && !p.colors.includes("blue") && p.available);
    queries.push({
      name: `${category}-not-blue`,
      q: `${category} not blue`,
      filters: { category, colors: { $nin: ["blue"] }, available: true },
      constraints: { excludedColors: ["blue"], available: true },
      relevant,
    });
  }

  return queries.filter((q) => q.relevant.length > 0);
}

async function main() {
  const outDir = process.env.SYNTHETIC_CORPUS_DIR ?? ".samesake/synthetic-fashion-corpus";
  const products = buildProducts();
  const queries = buildQueries(products);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "corpus.json"), JSON.stringify({ products, queries }, null, 2));
  await writeFile(
    join(outDir, "README.md"),
    [
      "# Synthetic Fashion Search Corpus",
      "",
      "Deterministic local corpus for exercising hard commerce constraints without provider calls.",
      "",
      `- Products: ${products.length}`,
      `- Queries: ${queries.length}`,
      "- Constraints: availability, max price, required color, excluded color",
      "",
      "Run:",
      "",
      "```bash",
      `FASHION_DATASET_DIR=${outDir} bun eval.ts`,
      "```",
      "",
    ].join("\n")
  );
  console.log(`Wrote ${products.length} products and ${queries.length} queries to ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
