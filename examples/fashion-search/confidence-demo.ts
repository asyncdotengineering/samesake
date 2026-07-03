/**
 * Prototype: confidence + abstain layer over the spike catalog.
 *
 * Demonstrates handling relevance/confidence and OOD ("don't return a dress for
 * 'gaming laptop'"). Combines techniques verified across the ecosystem:
 *   - calibrated [0,1] confidence, NOT raw RRF        (ES min_score / LangChain relevance-fn lesson)
 *   - semantic floor on raw cosine                    (pgvector / Qdrant score_threshold)
 *   - top1-vs-top2 margin (knee/autocut-lite)         (Weaviate autocut)
 *   - PRE-retrieval facet validation (structural OOD) (commerce-specific; strongest signal)
 *   - two-layer abstain: empty + explicit flag        (LlamaIndex "Empty Response")
 *
 * Run:
 *   GEMINI_API_KEY=... bun confidence-demo.ts
 */
import { sql } from "drizzle-orm";
import { createDbFromUrl, createMatcher } from "@samesake/server";
import { geminiEmbed, geminiGenerate } from "./gemini.ts";
import { COLLECTION, PROJECT } from "./samesake.config.ts";

const LOCAL = "postgresql://mithushancj@localhost:5432/samesake_spike";
const TBL = `project_fashionparity.c_${COLLECTION}`;

// HEURISTIC thresholds from the OOD demo (in-dist 0.44–0.52, OOD 0.33–0.40).
// In production these MUST be calibrated on the labeled gold set (Cohere method:
// score ~40 representative + borderline queries, set the cutoff from that distribution).
const TAU_FLOOR = 0.42; // raw cosine sim below this ⇒ nothing semantically close
const BAND_LO = 0.33;
const BAND_HI = 0.55;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

const QUERIES = [
  "floral dress for a wedding",
  "white top for the office",
  "men's leather hiking boots",
  "gaming laptop with RTX 4090",
  "fresh organic bananas 1kg",
];

async function main() {
  const { db, close } = createDbFromUrl(LOCAL);
  const matcher = createMatcher({
    databaseUrl: LOCAL,
    apiKey: process.env.GEMINI_API_KEY!,
    migrate: "manual",
    embed: geminiEmbed,
    generate: geminiGenerate,
  });

  // Catalog facet vocabulary (the structural-OOD reference set).
  const catRows = await db.execute<{ v: string }>(sql.raw(`SELECT DISTINCT enriched->>'category' AS v FROM ${TBL} WHERE enriched->>'category' IS NOT NULL`));
  const genRows = await db.execute<{ v: string }>(sql.raw(`SELECT DISTINCT enriched->>'gender' AS v FROM ${TBL} WHERE enriched->>'gender' IS NOT NULL`));
  const categories = new Set(catRows.map((r) => r.v));
  const genders = new Set(genRows.map((r) => r.v));
  console.log(`catalog facets → categories={${[...categories].join(", ")}}  genders={${[...genders].join(", ")}}\n`);

  for (const q of QUERIES) {
    const emb = (await geminiEmbed({ text: q, dim: 1536, taskType: "RETRIEVAL_QUERY" } as never)) as number[];
    const lit = `[${emb.join(",")}]`;
    const cos = await db.execute<{ title: string; sim: number }>(
      sql.raw(`SELECT data->>'title' AS title, 1 - (embedding <=> '${lit}'::vector) AS sim
               FROM ${TBL} WHERE embedding IS NOT NULL ORDER BY embedding <=> '${lit}'::vector LIMIT 3`)
    );
    const sim1 = Number(cos[0].sim);
    const sim2 = cos[1] ? Number(cos[1].sim) : 0;
    const margin = sim1 - sim2;

    // What the raw retriever WOULD serve (to show what we're preventing).
    const res = await matcher.search(PROJECT, COLLECTION, { q, limit: 1 });
    const parsed = (res.parsed ?? {}) as Record<string, unknown>;

    // (1) Structural OOD — pre-retrieval facet validation.
    const reasons: string[] = [];
    let structOod = false;
    const pCat = parsed.category as string | undefined;
    const pGen = parsed.gender as string | undefined;
    if (pCat && !categories.has(pCat)) { structOod = true; reasons.push(`parsed category="${pCat}" not in catalog`); }
    if (pGen && !genders.has(pGen)) { structOod = true; reasons.push(`parsed gender="${pGen}" not in catalog`); }

    // (2) Semantic floor + (3) margin → calibrated confidence.
    let confidence = clamp01((sim1 - BAND_LO) / (BAND_HI - BAND_LO));
    if (sim1 < TAU_FLOOR) reasons.push(`top-1 cosine ${sim1.toFixed(3)} < floor ${TAU_FLOOR}`);
    if (margin < 0.02) reasons.push(`flat distribution (top1−top2=${margin.toFixed(3)}) — retriever guessing`);
    if (structOod) confidence = Math.min(confidence, 0.15);

    // (4) Two-layer abstain.
    const abstain = sim1 < TAU_FLOOR || structOod;

    console.log(`💬 "${q}"`);
    console.log(`   parsed: ${JSON.stringify(parsed)}`);
    console.log(`   top-1 cosine=${sim1.toFixed(3)}  margin=${margin.toFixed(3)}  confidence=${confidence.toFixed(2)}`);
    if (abstain) {
      console.log(`   → ABSTAIN (no_confident_match). raw retriever WOULD have returned: "${String((res.hits[0]?.data as Record<string, unknown>)?.title ?? "—").slice(0, 40)}"`);
      console.log(`     reasons: ${reasons.join("; ")}`);
    } else {
      console.log(`   → RESULTS (confident). top hit: "${String((res.hits[0]?.data as Record<string, unknown>)?.title ?? "—").slice(0, 40)}"`);
    }
    console.log("");
  }

  await matcher.close();
  await close();
}

main().catch((e) => { console.error(e); process.exit(1); });
