import { describe, expect, test } from "bun:test";
import { collapseDuplicateProducts, filterHitsBySemanticRelevance } from "./search-relevance";

const hit = (id: string, fields: Record<string, unknown>) => ({
  id,
  score: 1,
  data: {
    title: fields.title,
    brand: fields.brand,
    image_url: fields.image_url,
    content_hash: fields.content_hash,
    description: fields.description,
  },
  ...fields,
});

// Fake generate speaking the ESCI judge contract ({ grades: [{id, esci}] }):
// candidates named in relevantIds grade Exact, the rest explicitly Irrelevant.
const judgeReturning =
  (relevantIds: string[]) =>
  async (req: { prompt: string; schema: Record<string, unknown> }) => {
    expect(req.prompt).toContain("Shopper query:");
    expect(req.schema).toMatchObject({ type: "object" });
    const ids = [...String(req.prompt).matchAll(/id: ([\w-]+)/g)].map((m) => m[1]!);
    return {
      grades: ids.map((id) => ({ id, esci: relevantIds.includes(id) ? "E" : "I" })),
    };
  };

describe("playground search relevance", () => {
  test("uses semantic judge results instead of English token overlap", async () => {
    const hits = [
      hit("red-dress", { title: "RED PUFF SLEEVE MAXI DRESS", category: "dresses", colors: ["red"] }),
      hit("alice", { title: "Alice Bodycon dress", category: "dresses", colors: ["maroon"] }),
    ];

    const filtered = await filterHitsBySemanticRelevance("vestido rojo", hits, judgeReturning(["red-dress"]));

    expect(filtered.map((h) => h.id)).toEqual(["red-dress"]);
  });

  test("returns no hits when the judge finds no genuine match", async () => {
    const hits = [
      hit("alice", { title: "Alice Bodycon dress", category: "dresses", colors: ["maroon"] }),
      hit("shirt", { title: "Formal Basic Shirt", category: "tops", occasions: ["office"] }),
    ];

    const filtered = await filterHitsBySemanticRelevance("ダイビング用ウェットスーツ", hits, judgeReturning([]));

    expect(filtered).toEqual([]);
  });

  test("keeps retrieval order from the judged candidate set", async () => {
    const hits = [
      hit("chair", { title: "Ergonomic Office Chair", category: "Furniture" }),
      hit("table", { title: "Oak Dining Table", category: "Furniture" }),
      hit("charger", { title: "USB-C Laptop Charger 65W", category: "Electronics" }),
    ];

    const filtered = await filterHitsBySemanticRelevance("office chair", hits, judgeReturning(["chair", "charger"]));

    expect(filtered.map((h) => h.id)).toEqual(["chair", "charger"]);
  });

  test("falls back to original hits if the judge is unavailable", async () => {
    const hits = [hit("headphones", { title: "Wireless Noise Cancelling Headphones" })];
    const filtered = await filterHitsBySemanticRelevance("wireless headphones", hits, async () => {
      throw new Error("judge unavailable");
    });

    expect(filtered).toEqual(hits);
  });

  test("collapses duplicate products by content hash before fallback identity", () => {
    const hits = [
      hit("q2-2", { title: "Alice Bodycon dress", brand: "avirate", content_hash: "same" }),
      hit("q7-2", { title: "Alice Bodycon dress", brand: "avirate", content_hash: "same" }),
      hit("q1-2", { title: "RED PUFF SLEEVE MAXI DRESS", brand: "other", content_hash: "red" }),
    ];

    expect(collapseDuplicateProducts(hits).map((h) => h.id)).toEqual(["q2-2", "q1-2"]);
  });
});
