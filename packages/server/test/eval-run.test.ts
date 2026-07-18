import "./load-env.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { constraintViolations } from "../src/core/eval/metrics.ts";
import { JUDGE_PROMPT_HASH, makeLlmJudge } from "../src/core/eval/judge.ts";
import { stubEmbed, testProductsCollection } from "./fixtures.ts";
import type { GenerateFn } from "../src/types.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

describeIf("eval run", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let artifactDir = "";
  let cacheDir = "";

  const stubJudgeGenerate: GenerateFn = async ({ prompt }) => {
    const ids = [...prompt.matchAll(/^(\d+)\. id: ([^|]+)/gm)].map((m) => m[2]!.trim());
    return {
      grades: ids.map((id, i) => ({
        id,
        esci: i === 0 ? "E" : "S",
        reason: "stub",
      })),
    };
  };

  beforeAll(async () => {
    artifactDir = await mkdtemp(join(tmpdir(), "eval-artifacts-"));
    cacheDir = await mkdtemp(join(tmpdir(), "eval-cache-run-"));
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: stubJudgeGenerate,
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, { entities: [], collections: [testProductsCollection] });
    schemaName = r.schema;

    await matcher.indexDocuments(projectSlug, "products", [
      {
        id: "dress-red",
        data: { title: "red summer dress", description: "light cotton" },
        doc: "red summer dress",
        embedding: stubEmbed("red summer dress", 8),
        fields: {
          title: "red summer dress",
          brand: "luna",
          price: 4500,
          category: "dresses",
          colors: ["red"],
          tag: "dress",
          available: true,
        },
      },
      {
        id: "dress-blue",
        data: { title: "blue office dress", description: "linen blend" },
        doc: "blue office dress",
        embedding: stubEmbed("blue office dress", 8),
        fields: {
          title: "blue office dress",
          brand: "aster",
          price: 8000,
          category: "dresses",
          colors: ["blue"],
          tag: "dress",
          available: true,
        },
      },
      {
        id: "jeans-black",
        data: { title: "black denim jeans", description: "straight fit" },
        doc: "black denim jeans",
        embedding: stubEmbed("black denim jeans", 8),
        fields: {
          title: "black denim jeans",
          brand: "north",
          price: 6200,
          category: "bottoms",
          colors: ["black"],
          tag: "pants",
          available: true,
        },
      },
    ]);

    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`UPDATE ${schemaName}.c_products SET fts_src = title`));
    await close();
  });

  afterAll(async () => {
    if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("test:eval-run end-to-end writes artifact and evaluates thresholds", { timeout: 20_000 }, async () => {
    // REQ-3 and REQ-9 intentionally add cold parsing and progressive probe/retry work.
    const judge = makeLlmJudge(stubJudgeGenerate, { version: "run-v1" });
    const queries = [
      { id: "q1", type: "keyword", query: "red dress" },
      { id: "q2", type: "price", query: "dress under 5000", constraints: { price: { $lte: 5000 } } },
      { id: "q3", type: "broad", query: "jeans" },
    ];

    const loose = await matcher.runEval(projectSlug, "products", {
      queries,
      judge,
      k: 3,
      relevanceFloor: 1,
      thresholds: { hitAtK: 0.5 },
      artifactDir,
      cacheDir,
      timestamp: "test-run-loose",
    });
    expect(loose.pass).toBe(true);
    expect(loose.perQuery).toHaveLength(3);
    expect(loose.aggregate.byType.keyword?.hitAtK).toBe(1);
    const raw = await readFile(loose.artifactPath, "utf8");
    expect(JSON.parse(raw).judgeVersion).toBe(`run-v1@${JUDGE_PROMPT_HASH}`);

    const strict = await matcher.runEval(projectSlug, "products", {
      queries,
      judge,
      k: 3,
      thresholds: { ndcgAtK: 1.01, hitAtK: 1.01 },
      artifactDir,
      cacheDir,
      timestamp: "test-run-strict",
    });
    expect(strict.pass).toBe(false);
    expect(strict.failedThresholds.length).toBeGreaterThan(0);
  });

  test("test:eval-constraint-objective counts price violations without judge", () => {
    const hit = (id: string, data: Record<string, unknown>) => ({ id, value: (f: string) => data[f] });
    const violations = constraintViolations(
      [hit("a", { price: 8000, category: "dresses" }), hit("b", { price: 4000, category: "dresses" })],
      { price: { $lte: 5000 } }
    );
    expect(violations).toBe(1);
  });

  test("test:eval-gate-blocks-regression fails when thresholds are too high", async () => {
    const judge = makeLlmJudge(stubJudgeGenerate, { version: "gate-v1" });
    const res = await matcher.runEval(projectSlug, "products", {
      queries: [{ id: "q1", type: "keyword", query: "red dress" }],
      judge,
      k: 2,
      thresholds: { mrr: 1.01 },
      artifactDir,
      cacheDir,
      timestamp: "test-gate",
    });
    expect(res.pass).toBe(false);
  });
});
