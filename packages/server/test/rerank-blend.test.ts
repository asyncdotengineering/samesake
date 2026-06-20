import { describe, expect, test } from "bun:test";
import {
  blendRerankScore,
  mergeBlendedRerank,
  rerankCandidateText,
} from "../src/core/rerank.ts";
import type { SearchHit } from "../src/core/search.ts";

function hit(id: string, extra: Partial<SearchHit> = {}): SearchHit {
  return { id, score: 0.05, data: { title: `title-${id}` }, ...extra };
}

describe("rerank blend", () => {
  test("test:rerank-blend head protected: rank-1 low rerank stays above rank-5 high rerank", () => {
    const hits = ["a", "b", "c", "d", "e"].map((id) => hit(id));
    const merged = mergeBlendedRerank(hits, [
      { id: "a", score: 0.1 },
      { id: "e", score: 1.0 },
    ]);
    expect(merged.map((h) => h.id).indexOf("a")).toBeLessThan(merged.map((h) => h.id).indexOf("e"));
    expect(blendRerankScore(1, 0.1)).toBeGreaterThan(blendRerankScore(5, 1.0));
  });

  test("test:rerank-blend tail climb: deep-tail high rerank beats tail neighbour", () => {
    const hits = Array.from({ length: 16 }, (_, i) => hit(String(i + 1)));
    const merged = mergeBlendedRerank(hits, [
      { id: "15", score: 1.0 },
      { id: "16", score: 0.2 },
    ]);
    expect(merged.map((h) => h.id).indexOf("15")).toBeLessThan(merged.map((h) => h.id).indexOf("16"));
  });

  test("test:rerank-blend omitted hit keeps RRF slot", () => {
    const hits = ["a", "b", "c", "d", "e"].map((id) => hit(id));
    const merged = mergeBlendedRerank(hits, [
      { id: "a", score: 0.0 },
      { id: "e", score: 1.0 },
    ]);
    expect(merged[2]!.id).toBe("c");
  });

  test("test:rerank-doc-used prefers rerank_doc column", () => {
    expect(
      rerankCandidateText(
        hit("1", {
          title: "short title",
          rerank_doc: "verbose rerank document for cross-encoder",
        })
      )
    ).toBe("verbose rerank document for cross-encoder");
  });

  test("test:rerank-doc-used prefers enriched.rerank_doc when column absent", () => {
    expect(
      rerankCandidateText(
        hit("1", {
          title: "short title",
          data: { enriched: { rerank_doc: "from enriched json" } },
        })
      )
    ).toBe("from enriched json");
  });

  test("test:rerank-doc-used falls back to title scrape", () => {
    expect(rerankCandidateText(hit("1", { title: "fallback title" }))).toBe("fallback title");
  });
});
