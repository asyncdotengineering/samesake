import { describe, expect, test } from "bun:test";
import { JUDGE_PROMPT_HASH, judgeVersion, makeLlmJudge, modelFamily, assertJudgeFamilySeparation } from "../src/core/eval/judge.ts";
import type { GenerateFn } from "../src/types.ts";

const candidate = (id: string, title: string) => ({
  id,
  text: `id: ${id} | title: ${title} | category: dresses | colors: red`,
  data: { title, category: "dresses", colors: ["red"] },
});

describe("eval judge", () => {
  test("test:eval-judge returns ESCI-graded labels", async () => {
    const generate: GenerateFn = async () => ({
      grades: [
        { id: "red-dress", esci: "E", reason: "exact match" },
        { id: "maroon-dress", esci: "S", reason: "close substitute" },
        { id: "red-belt", esci: "C", reason: "complement" },
        { id: "blue-dress", esci: "I", reason: "wrong color" },
      ],
    });

    const judge = makeLlmJudge(generate, { version: "test-v1" });
    const graded = await judge.grade("red dress", [
      candidate("red-dress", "Red Maxi Dress"),
      candidate("maroon-dress", "Maroon Maxi Dress"),
      candidate("red-belt", "Red Belt"),
      candidate("blue-dress", "Blue Linen Dress"),
    ]);

    expect(judge.version).toBe(`test-v1@${JUDGE_PROMPT_HASH}`);
    expect(graded).toEqual([
      { id: "red-dress", grade: 3, esci: "E", reason: "exact match" },
      { id: "maroon-dress", grade: 2, esci: "S", reason: "close substitute" },
      { id: "red-belt", grade: 1, esci: "C", reason: "complement" },
      { id: "blue-dress", grade: 0, esci: "I", reason: "wrong color" },
    ]);
  });

  test("test:eval-judge version is pinned to the rubric content", () => {
    expect(judgeVersion()).toBe(`esci-v1@${JUDGE_PROMPT_HASH}`);
    expect(JUDGE_PROMPT_HASH).toMatch(/^[0-9a-f]{8}$/);
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
        { id: "a", grade: 0, esci: "I", reason: "judge-error" },
      ]);
    }
  });

  test("test:model-family recognizes provider families", () => {
    expect(modelFamily("gemini-3.1-flash-lite")).toBe("google");
    expect(modelFamily("gpt-4.1-mini")).toBe("openai");
    expect(modelFamily("claude-sonnet-5")).toBe("anthropic");
    expect(modelFamily("classify")).toBeNull();
    expect(modelFamily(undefined)).toBeNull();
  });

  test("test:judge-family-separation rejects same-family enrich+judge", () => {
    expect(() =>
      assertJudgeFamilySeparation("gemini-2.5-pro", ["gemini-3.1-flash-lite"])
    ).toThrow(/same model family/);
    expect(() =>
      assertJudgeFamilySeparation(undefined, ["gemini-3.1-flash-lite"])
    ).toThrow(/not declared/);
    // Cross-family passes; unknown enrich tokens are skipped.
    assertJudgeFamilySeparation("gpt-4.1-mini", ["gemini-3.1-flash-lite"]);
    assertJudgeFamilySeparation(undefined, ["classify", "extract"]);
  });
});
