import { describe, expect, test } from "bun:test";
import { collection, f, Channels, gates, type CollectionDef } from "@samesake/core";
import { createSearch } from "../src/index.ts";
import type { RankedRow, RetrievalPlan } from "../src/plan.ts";
import type { Embedder } from "@samesake/embed";

const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true }),
    category: f.enum(["dress", "shirt"] as const, { filterable: true }),
    available: f.boolean(),
  },
  embeddings: {
    doc: { model: "test-model", dim: 2 },
  },
  indexing: {
    surfaces: {
      fts_doc: { kind: "fts", build: ({ data }) => String(data.title ?? "") },
    },
    gate: gates.always,
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
    ],
    nlq: { enable: true },
    rankingPolicy: {
      weights: { relevance: 1, availability: 1 },
      hardAxes: ["availability"],
    },
  },
}) as CollectionDef & { name: string };
products.search!.cutoff = { strategy: "score-drop" };

function testEmbedder(calls: Array<{ text?: string; image?: unknown }>): Embedder {
  const single = async (request: { text?: string; image?: unknown }): Promise<number[]> => {
    calls.push({ text: request.text, image: request.image });
    return [0.9, 0.1];
  };
  const embedder = single as unknown as Embedder;
  embedder.many = async () => [];
  Object.defineProperty(embedder, "caps", {
    value: { image: true, interleaved: false, dims: "any", maxBatch: 16 },
  });
  return embedder;
}

describe("createSearch", () => {
  test("runs NLQ, emits a predicate plan, cuts weak evidence, and ranks hits without a database", async () => {
    const embedCalls: Array<{ text?: string; image?: unknown }> = [];
    let rerankCalls = 0;
    const plans: RetrievalPlan[] = [];
    const rows: RankedRow[] = [
      {
        id: "strong",
        data: { title: "strong dress", available: true },
        rrf_score: 0.9,
        legRanks: { fts: 1 },
        cos_sim: 0.9,
        fts_present: true,
      },
      {
        id: "medium",
        data: { title: "medium dress", available: false },
        rrf_score: 0.7,
        legRanks: {},
        cos_sim: 0.7,
        fts_present: false,
      },
      {
        id: "weak",
        data: { title: "weak result", available: true },
        rrf_score: 0.2,
        legRanks: {},
        cos_sim: 0.2,
        fts_present: false,
      },
    ];
    const retriever = async (plan: RetrievalPlan): Promise<RankedRow[]> => {
      plans.push(plan);
      return rows;
    };
    const search = createSearch({
      collection: products,
      retriever,
      generate: async () => ({ semantic_query: "dress", lexical_query: "dress" }),
      embed: testEmbedder(embedCalls),
      rerank: async ({ candidates }) => {
        rerankCalls++;
        return candidates.map((candidate) => ({ id: candidate.id, score: candidate.id === "medium" ? 1 : 0 }));
      },
    });

    const result = await search("dress", { filters: { category: "dress" }, limit: 3 });

    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]?.text).toBe("dress");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.query).toBe("dress");
    expect(plans[0]?.vectors).toEqual([{ embedding: "doc", vec: [0.9, 0.1] }]);
    expect(plans[0]?.filters).toEqual([
      { field: "category", fieldType: "enum", operator: "eq", value: "dress", source: "explicit", soft: false },
    ]);
    expect(result.cutoff_dropped).toBe(1);
    expect(result.hits.map((hit) => hit.id)).toEqual(["strong", "medium"]);
    expect(rerankCalls).toBe(1);
    expect(result.constraintTrace.items[0]?.field).toBe("category");
    expect(result.nlq_degraded).toBeUndefined();
  });

  test("works without vocab grounding", async () => {
    const plans: RetrievalPlan[] = [];
    const retriever = async (plan: RetrievalPlan): Promise<RankedRow[]> => {
      plans.push(plan);
      return [];
    };
    const search = createSearch({
      collection: products,
      retriever,
      generate: async () => ({ semantic_query: "a blue product", brand: "Acme" }),
      embed: testEmbedder([]),
    });

    await expect(search("a blue product")).resolves.toMatchObject({
      hits: [],
      relaxed: false,
      relaxedFields: [],
    });
    expect(plans[0]?.filters).toEqual([
      { field: "brand", fieldType: "text", operator: "eq", value: "Acme", source: "nlq", soft: false },
    ]);
  });

  test("searchExplain exposes per-leg ranks from the retriever", async () => {
    const retriever = async (_plan: RetrievalPlan): Promise<RankedRow[]> => [{
      id: "explained",
      data: { title: "explained dress" },
      rrf_score: 0.75,
      legRanks: { fts: 1, doc: 2, recency: 3 },
      fts_present: true,
      cos_sim: 0.88,
    }];
    const search = createSearch({
      collection: products,
      retriever,
      generate: async () => ({ semantic_query: "dress", lexical_query: "dress" }),
      embed: testEmbedder([]),
    });

    const explain = await search.searchExplain("dress");

    expect(explain.docs).toEqual([{
      id: "explained",
      fts_rank: 1,
      cosine_rank: 2,
      recency_rank: 3,
      rrf_score: 0.75,
    }]);
    expect(explain.retrievalPlan?.query).toBe("dress");
  });
});
