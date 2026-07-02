import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { calibrateJudge } from "../src/core/eval/calibrate.ts";
import { makeLlmJudge } from "../src/core/eval/judge.ts";
import type { GenerateFn } from "../src/types.ts";

const labels = [
  { query: "red dress", id: "a", grade: 2 as const },
  { query: "red dress", id: "b", grade: 0 as const },
  { query: "blue jeans", id: "c", grade: 2 as const },
  { query: "blue jeans", id: "d", grade: 1 as const },
  { query: "linen shirt", id: "e", grade: 1 as const },
];

describe("eval calibrate", () => {
  test("test:eval-calibrate reports F1 and kappa", async () => {
    const generate: GenerateFn = async ({ prompt }) => {
      const ids = [...prompt.matchAll(/id: ([a-z])/g)].map((m) => m[1]);
      const byGrade = ["I", "C", "S", "E"] as const;
      const grades = ids.map((id) => {
        const human = labels.find((l) => l.id === id);
        return { id, esci: byGrade[human?.grade ?? 0], reason: "stub" };
      });
      return { grades };
    };

    const judge = makeLlmJudge(generate, { version: "cal-v1" });
    const result = await calibrateJudge(judge, labels, { minLabels: 5 });
    expect(result.n).toBe(5);
    expect(result.f1).toBe(1);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.kappa).toBe(1);
  });

  test("test:eval-calibrate throws under min labels", async () => {
    const judge = makeLlmJudge(async () => ({ grades: [] }));
    await expect(calibrateJudge(judge, labels.slice(0, 2), { minLabels: 5 })).rejects.toThrow(
      "insufficient calibration set"
    );
  });
});
