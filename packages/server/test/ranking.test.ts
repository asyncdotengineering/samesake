import { describe, expect, test } from "bun:test";
import { applyRankingPolicy } from "../src/core/ranking.ts";
import type { SearchHit } from "../src/core/search.ts";

function hit(id: string, score: number, extra: Partial<SearchHit> = {}): SearchHit {
  return { id, score, data: {}, ...extra };
}

describe("ranking policy", () => {
  test("test:multiplicative-fusion irrelevant-but-available cannot outrank relevant unavailable", () => {
    const hits = [
      hit("relevant-unavail", 0.2, { available: false }),
      hit("irrelevant-avail", 0.19, { available: true }),
    ];
    const { hits: ranked } = applyRankingPolicy(hits, {
      weights: { relevance: 1, availability: 1 },
      boostAvailable: true,
      buryUnavailable: true,
      buryFactor: 0.2,
      hardAxes: ["availability"],
      softAxes: [],
    });
    expect(ranked[0]!.id).toBe("relevant-unavail");
    expect(ranked[1]!.id).toBe("irrelevant-avail");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  test("test:multiplicative-fusion drops hits below minRelevanceFloor", () => {
    const hits = [
      hit("high", 0.9, { available: true }),
      hit("mid", 0.5, { available: true }),
      hit("low", 0.1, { available: true }),
    ];
    const { hits: ranked } = applyRankingPolicy(hits, {
      minRelevanceFloor: 0.15,
      weights: { relevance: 1, availability: 0.2 },
      hardAxes: ["availability"],
      softAxes: [],
    });
    expect(ranked.map((h) => h.id)).toEqual(["high", "mid"]);
  });

  test("test:core-ranking-policy reorders by normalized boost when policy present", () => {
    const hits = [
      hit("plain", 0.2),
      hit("boosted", 0.19, { data: { margin: 1 } }),
    ];
    const { hits: ranked } = applyRankingPolicy(hits, {
      businessField: "margin",
      weights: { relevance: 1, business: 2 },
      hardAxes: [],
      softAxes: ["business"],
    });
    expect(ranked[0]!.id).toBe("boosted");
  });

  test("test:core-ranking-policy absent policy path leaves order unchanged when scores equal", () => {
    const hits = [hit("a", 0.5), hit("b", 0.5)];
    const unchanged = [...hits].sort((a, b) => b.score - a.score);
    const { hits: ranked } = applyRankingPolicy(hits, {
      weights: { relevance: 1 },
      hardAxes: [],
      softAxes: [],
    });
    expect(ranked.map((h) => h.id)).toEqual(unchanged.map((h) => h.id));
  });
});
