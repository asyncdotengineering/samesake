import { describe, expect, test } from "bun:test";
import { makeLlmJudge } from "../src/core/eval/judge.ts";
import type { GenerateFn } from "../src/types.ts";

const candidate = (id: string, title: string) => ({
  id,
  text: `id: ${id} | title: ${title} | category: dresses | colors: red`,
  data: { title, category: "dresses", colors: ["red"] },
});

describe("eval judge", () => {
  test("test:eval-judge returns graded labels with facets", async () => {
    const generate: GenerateFn = async () => ({
      grades: [
        {
          id: "red-dress",
          grade: 2,
          facets: { category: 2, color: 2 },
          reason: "exact match",
        },
        {
          id: "blue-dress",
          grade: 0,
          facets: { color: 0 },
          reason: "wrong color",
        },
      ],
    });

    const judge = makeLlmJudge(generate, { version: "test-v1" });
    const graded = await judge.grade("red dress", [
      candidate("red-dress", "Red Maxi Dress"),
      candidate("blue-dress", "Blue Linen Dress"),
    ]);

    expect(judge.version).toBe("test-v1");
    expect(graded).toEqual([
      { id: "red-dress", grade: 2, facets: { category: 2, color: 2 }, reason: "exact match" },
      { id: "blue-dress", grade: 0, facets: { color: 0 }, reason: "wrong color" },
    ]);
  });

  test("test:eval-judge-error grades zero without throwing", async () => {
    const throwing: GenerateFn = async () => {
      throw new Error("judge unavailable");
    };
    const garbage: GenerateFn = async () => ({ notGrades: true });

    for (const generate of [throwing, garbage]) {
      const judge = makeLlmJudge(generate);
      const graded = await judge.grade("red dress", [candidate("a", "Red Dress")]);
      expect(graded).toEqual([
        { id: "a", grade: 0, facets: {}, reason: "judge-error" },
      ]);
    }
  });
});
