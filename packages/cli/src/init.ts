// `samesake init [dir]` — scaffold a runnable search project: catalog config,
// docker-compose Postgres (pgvector + contrib extensions), a ~20-line HTTP
// server, a seeded sample catalog, and .env. Zero-to-first-search with no
// LLM key: the starter embedder is a deterministic local hash.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const CONFIG_TS = `// samesake.config.ts — declare your catalog; samesake compiles it into a
// Postgres + pgvector hybrid-search layer.
// Docs: https://github.com/asyncdotengineering/samesake
import { collection, f, Channels } from "@samesake/core";

export const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true, facet: true }),
    category: f.text({ filterable: true, facet: true }),
    color: f.text({ filterable: true, facet: true }),
    price: f.number({ filterable: true, facet: "range" }),
    available: f.boolean({ filterable: true }),
  },
  embeddings: {
    // \`source\` is the text that gets embedded. The starter embedder is a
    // deterministic local hash (no API key) — when you swap in a real model
    // (src/matcher.ts), set \`dim\` to that model's dimension and re-run seed.
    doc: { source: "$title $brand $color $category", model: "local-hash", dim: 256 },
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title", "brand", "color"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
    ],
    combiner: "rrf",
  },
});
`;

const LOCAL_EMBED_TS = `// Deterministic local embedder: token + character-trigram hashing into a
// fixed-dim bag-of-features vector. Zero setup, zero cost — good enough to
// demo hybrid search on the seed catalog. Swap for a real embedding model
// before tuning relevance (see src/matcher.ts).
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function localHashEmbed(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const tok of tokens) {
    v[hash(tok) % dim]! += 1;
    for (let i = 0; i + 3 <= tok.length; i++) v[hash(tok.slice(i, i + 3)) % dim]! += 0.25;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
`;

const MATCHER_TS = `import { createMatcher } from "@samesake/server";
import { localHashEmbed } from "./local-embed.ts";

export const PROJECT = "shop";

export function makeMatcher() {
  const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "SAMESAKE_DATABASE_URL is not set — is .env present? (bun loads it automatically)"
    );
  }
  return createMatcher({
    databaseUrl,
    apiKey: process.env.SAMESAKE_API_KEY ?? "dev-only-key",
    // BYO models: when you're ready to tune relevance, swap localHashEmbed for
    // a real model — e.g. \`embed: geminiEmbedder()\` from @samesake/providers —
    // and update \`dim\` in samesake.config.ts to the model's dimension.
    embed: async ({ text, dim }) => localHashEmbed(text ?? "", dim),
    // System DDL runs where it's called for (seed script, server boot) —
    // ad-hoc scripts like scripts/search.ts skip it entirely.
    migrate: "manual",
  });
}
`;

const INDEX_TS = `// HTTP entry — serves the full /v1 API (search, ingest, facets, explain, …).
import { makeMatcher, PROJECT } from "./matcher.ts";

const matcher = makeMatcher();
await matcher.migrate();

const port = Number(process.env.PORT ?? 3030);
Bun.serve({ port, fetch: matcher.app.fetch });
console.log(\`samesake matcher listening on http://localhost:\${port}\`);
console.log(\`try:
  curl -H "Authorization: Bearer \${process.env.SAMESAKE_API_KEY}" \\\\
    "http://localhost:\${port}/v1/projects/\${PROJECT}/collections/products/search?q=red+running+shoes&limit=5"\`);
`;

const SEED_TS = `// Seed the sample catalog: apply schema → push documents → build the index →
// smoke search. Idempotent; re-run freely (e.g. after changing the config).
import { readFileSync } from "node:fs";
import { products } from "../samesake.config.ts";
import { makeMatcher, PROJECT } from "../src/matcher.ts";

const t0 = performance.now();
const matcher = makeMatcher();
await matcher.migrate();
await matcher.apply(PROJECT, { entities: [], collections: [products] });

const items = JSON.parse(
  readFileSync(new URL("../seed/products.json", import.meta.url), "utf8")
) as Array<{ id: string } & Record<string, unknown>>;
await matcher.pushDocuments(
  PROJECT,
  "products",
  items.map(({ id, ...data }) => ({ id, data }))
);
const { indexed } = await matcher.index(PROJECT, "products");

const smoke = await matcher.search(PROJECT, "products", { q: "red running shoes", limit: 3 });
await matcher.close();

console.log(
  \`seeded \${items.length} products (\${indexed} newly indexed) in \${((performance.now() - t0) / 1000).toFixed(1)}s\`
);
console.log(\`smoke search "red running shoes" → \${smoke.hits.map((h) => \`"\${h.title}"\`).join(", ")}\`);
`;

const SEARCH_TS = `// Ad-hoc search from the terminal: bun run search "red shoes"
import { makeMatcher, PROJECT } from "../src/matcher.ts";

const q = process.argv.slice(2).join(" ").trim();
if (!q) {
  console.error('usage: bun run search "your query"');
  process.exit(1);
}

const matcher = makeMatcher();
const res = await matcher.search(PROJECT, "products", { q, limit: 10 });
await matcher.close();

if (res.hits.length === 0) {
  console.log("(no results)");
} else {
  for (const h of res.hits) {
    console.log(
      \`\${h.score.toFixed(3)}  \${String(h.title).padEnd(44)} \${String(h.brand).padEnd(12)} $\${h.price}\`
    );
  }
}
`;

const DOCKER_COMPOSE = `services:
  postgres:
    # pgvector 0.8 on Postgres 16. pg_trgm / unaccent / fuzzystrmatch ship in
    # the image's contrib; samesake's migrate() creates all four extensions.
    image: pgvector/pgvector:0.8.0-pg16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: samesake
    ports:
      - "54321:5432"
    volumes:
      - samesake-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      timeout: 2s
      retries: 30

volumes:
  samesake-pgdata:
`;

const GITIGNORE = `node_modules/
.env
`;

// A small, deliberately varied catalog: enough overlap for hybrid search to
// show ranking behavior (colors, brands, categories, price spread).
const SEED_PRODUCTS = [
  { id: "p01", title: "red running shoes", brand: "stride", category: "shoes", color: "red", price: 89, available: true },
  { id: "p02", title: "blue trail running shoes", brand: "stride", category: "shoes", color: "blue", price: 119, available: true },
  { id: "p03", title: "white leather sneakers", brand: "cobble", category: "shoes", color: "white", price: 75, available: true },
  { id: "p04", title: "black chelsea boots", brand: "cobble", category: "shoes", color: "black", price: 140, available: false },
  { id: "p05", title: "red canvas slip-ons", brand: "harbor", category: "shoes", color: "red", price: 45, available: true },
  { id: "p06", title: "navy linen blazer", brand: "atelier", category: "apparel", color: "navy", price: 210, available: true },
  { id: "p07", title: "black wedding guest dress", brand: "atelier", category: "apparel", color: "black", price: 189, available: true },
  { id: "p08", title: "green summer midi dress", brand: "meadow", category: "apparel", color: "green", price: 95, available: true },
  { id: "p09", title: "white cotton oxford shirt", brand: "meadow", category: "apparel", color: "white", price: 60, available: true },
  { id: "p10", title: "grey merino wool sweater", brand: "atelier", category: "apparel", color: "grey", price: 130, available: true },
  { id: "p11", title: "blue slim-fit jeans", brand: "harbor", category: "apparel", color: "blue", price: 85, available: true },
  { id: "p12", title: "red rain jacket", brand: "summit", category: "apparel", color: "red", price: 150, available: true },
  { id: "p13", title: "black leather belt", brand: "cobble", category: "accessories", color: "black", price: 35, available: true },
  { id: "p14", title: "brown leather wallet", brand: "cobble", category: "accessories", color: "brown", price: 48, available: true },
  { id: "p15", title: "canvas weekender bag", brand: "harbor", category: "accessories", color: "beige", price: 110, available: true },
  { id: "p16", title: "silver analog watch", brand: "meridian", category: "accessories", color: "silver", price: 240, available: true },
  { id: "p17", title: "polarized aviator sunglasses", brand: "meridian", category: "accessories", color: "gold", price: 95, available: true },
  { id: "p18", title: "red wool scarf", brand: "meadow", category: "accessories", color: "red", price: 40, available: true },
  { id: "p19", title: "insulated steel water bottle", brand: "summit", category: "outdoors", color: "green", price: 30, available: true },
  { id: "p20", title: "two-person camping tent", brand: "summit", category: "outdoors", color: "orange", price: 320, available: true },
  { id: "p21", title: "down puffer vest", brand: "summit", category: "outdoors", color: "black", price: 160, available: true },
  { id: "p22", title: "yoga mat with carry strap", brand: "stride", category: "fitness", color: "purple", price: 38, available: true },
  { id: "p23", title: "adjustable dumbbell set", brand: "stride", category: "fitness", color: "black", price: 199, available: false },
  { id: "p24", title: "running socks three pack", brand: "stride", category: "fitness", color: "white", price: 18, available: true },
];

const PKG_JSON = (name: string): string =>
  JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: {
        "db:up": "docker compose up -d --wait",
        "db:down": "docker compose down",
        seed: "bun scripts/seed.ts",
        search: "bun scripts/search.ts",
        dev: "bun --watch src/index.ts",
      },
      dependencies: {
        "@samesake/core": "^3.0.0",
        "@samesake/server": "^3.0.0",
      },
    },
    null,
    2
  ) + "\n";

const ENV_FILE = (): string =>
  `SAMESAKE_DATABASE_URL=postgres://postgres:postgres@localhost:54321/samesake
SAMESAKE_API_KEY=${randomBytes(24).toString("hex")}
`;

const README = (name: string): string => `# ${name}

A [samesake](https://github.com/asyncdotengineering/samesake) search project —
catalog declared in TypeScript, compiled into a Postgres + pgvector hybrid-search layer.

## Zero to first search

\`\`\`bash
bun run db:up                       # 1. Postgres 16 + pgvector via Docker (port 54321)
bun install                         # 2. dependencies
bun run seed                        # 3. apply schema, push 24 products, build the index
bun run search "red running shoes"  # 4. first search
\`\`\`

Serve the HTTP API:

\`\`\`bash
bun run dev   # http://localhost:3030 — full /v1 API (search, ingest, facets, explain, …)
\`\`\`

## What's here

| File | Purpose |
|---|---|
| \`samesake.config.ts\` | Your catalog: fields, embeddings, search channels |
| \`src/matcher.ts\` | The matcher factory — BYO embed/generate models plug in here |
| \`src/local-embed.ts\` | Starter embedder (deterministic hash — no API key needed) |
| \`src/index.ts\` | HTTP server over the matcher |
| \`scripts/seed.ts\` / \`scripts/search.ts\` | Seed the sample catalog / search from the terminal |
| \`docker-compose.yml\` | Postgres with all required extensions |

## Next steps

- **Real embeddings**: swap \`localHashEmbed\` in \`src/matcher.ts\` for a real model —
  \`@samesake/providers\` ships one-liner adapters (\`geminiEmbedder()\`, \`openaiEmbedder()\`, …) —
  and set \`dim\` in \`samesake.config.ts\` to the model's dimension, then \`bun run seed\`.
- **NLQ + enrichment**: wire \`generate: geminiGenerator()\` into \`createMatcher\` to turn
  "red shoes under 50" into hard filters and to enrich raw listings at index time.
- **Your data**: replace \`seed/products.json\` and the fields in \`samesake.config.ts\`.
`;

function write(dir: string, rel: string, content: string, force: boolean): void {
  const path = join(dir, rel);
  if (existsSync(path) && !force) {
    throw new Error(`${path} already exists — pass --force to overwrite`);
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  console.log(`  ✓ ${rel}`);
}

export function scaffoldProject(dirArg: string | undefined, force: boolean): void {
  const dir = resolve(dirArg ?? "samesake-app");
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  mkdirSync(dir, { recursive: true });
  console.log(`Scaffolding samesake project in ${dir}`);

  write(dir, "package.json", PKG_JSON(name), force);
  write(dir, "docker-compose.yml", DOCKER_COMPOSE, force);
  write(dir, ".env", ENV_FILE(), force);
  write(dir, ".gitignore", GITIGNORE, force);
  write(dir, "samesake.config.ts", CONFIG_TS, force);
  write(dir, "src/matcher.ts", MATCHER_TS, force);
  write(dir, "src/local-embed.ts", LOCAL_EMBED_TS, force);
  write(dir, "src/index.ts", INDEX_TS, force);
  write(dir, "scripts/seed.ts", SEED_TS, force);
  write(dir, "scripts/search.ts", SEARCH_TS, force);
  write(dir, "seed/products.json", JSON.stringify(SEED_PRODUCTS, null, 2) + "\n", force);
  write(dir, "README.md", README(name), force);

  console.log(`
Done. First search:

  cd ${dirArg ?? "samesake-app"}
  bun run db:up                       # Postgres 16 + pgvector (Docker)
  bun install
  bun run seed
  bun run search "red running shoes"
`);
}
