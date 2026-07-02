// Reproducible seed — loads the committed, pre-embedded catalog (data/seed.sql.gz) instead of
// fetching from Hugging Face and re-embedding every row. apply() builds the schema; the dump
// restores products + brands WITH their gemini-embedding-2 vectors + indexed state, so the demo
// is runnable with no HF download and zero embedding calls. Requires `psql` on PATH.
import { execSync } from "node:child_process";
import { join } from "node:path";
import { getMatcher, PROJECT, SCHEMA, products, brands } from "./samesake.ts";

const db = process.env.SAMESAKE_DATABASE_URL;
if (!db) throw new Error("SAMESAKE_DATABASE_URL required");

const dump = join(import.meta.dir, "../data/seed.sql.gz");

const m = getMatcher();
await m.migrate();
await m.apply(PROJECT, { collections: [products, brands] });
await m.close();

console.log("[seed:sql] loading pre-embedded catalog from data/seed.sql.gz (no HF / no Gemini calls)…");
execSync(`psql "${db}" -v ON_ERROR_STOP=1 -c "TRUNCATE ${SCHEMA}.c_products, ${SCHEMA}.c_brands"`, { stdio: "inherit" });
execSync(`gunzip -c "${dump}" | psql "${db}" -v ON_ERROR_STOP=1`, { stdio: "inherit", shell: "/bin/bash" });
console.log("[seed:sql] done — products + brands loaded with embeddings. Run `bun run demo`.");
