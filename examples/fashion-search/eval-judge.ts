import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeLlmJudge } from "@samesake/server";
import { COLLECTION, PROJECT, createFashionMatcher } from "./samesake.config.ts";
import { JUDGE_MODEL, openaiGenerate } from "./openai.ts";

const repoRoot = join(import.meta.dir, "../..");
const goldenPath = join(repoRoot, "evals/golden-queries-fashion-lk.json");
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as {
  queries: Array<{ id: string; type: string; query: string; constraints?: Record<string, unknown> }>;
};

const dryRun = !process.env.GEMINI_API_KEY || !process.env.OPENAI_API_KEY;

async function main() {
  if (dryRun) {
    console.log("GEMINI_API_KEY / OPENAI_API_KEY absent — dry-run only (type-check path verified, live eval not executed)");
    console.log(`Would evaluate ${golden.queries.length} queries against ${PROJECT}/${COLLECTION}`);
    process.exit(0);
  }

  const matcher = createFashionMatcher();
  await matcher.migrate();
  const judge = makeLlmJudge(openaiGenerate, { model: JUDGE_MODEL });

  const res = await matcher.runEval(PROJECT, COLLECTION, {
    queries: golden.queries,
    judge,
    k: 10,
    relevanceFloor: 2,
    thresholds: { ndcgAtK: 0.6, nullRate: 0.1, constraintViolationRate: 0 },
  });

  console.log(JSON.stringify(res.aggregate, null, 2));
  console.log("pass=", res.pass);
  console.log("artifact=", res.artifactPath);
  await matcher.close();
  process.exit(res.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
