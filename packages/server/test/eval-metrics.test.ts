import { describe, expect, test } from "bun:test";
import {
  constraintViolations,
  hitAtK,
  mrr,
  ndcgAtK,
  nullRate,
} from "../src/core/eval/metrics.ts";

describe("eval metrics", () => {
  test("test:eval-metrics", () => {
    expect(ndcgAtK([2, 1, 0], 3)).toBeCloseTo(1, 5);

    const imperfect = ndcgAtK([0, 2, 1], 3);
    const dcg = 0 + (2 ** 2 - 1) / Math.log2(3) + (2 ** 1 - 1) / Math.log2(4);
    const idcg = (2 ** 2 - 1) / Math.log2(2) + (2 ** 1 - 1) / Math.log2(3) + (2 ** 0 - 1) / Math.log2(4);
    expect(imperfect).toBeCloseTo(dcg / idcg, 5);

    expect(mrr([0, 1, 2], 1)).toBe(0.5);
    expect(mrr([0, 0, 2], 1)).toBe(1 / 3);
    expect(mrr([0, 0, 0], 1)).toBe(0);

    expect(hitAtK([0, 1, 2], 1, 3)).toBe(1);
    expect(hitAtK([0, 0, 0], 1, 3)).toBe(0);
    expect(hitAtK([2], 2, 1)).toBe(1);
    expect(hitAtK([1], 2, 1)).toBe(0);

    expect(nullRate([true, false, true])).toBeCloseTo(2 / 3);
    expect(nullRate([])).toBe(0);

    const hit = (id: string, data: Record<string, unknown>) => ({ id, value: (f: string) => data[f] });
    const violations = constraintViolations(
      [
        hit("a", { price: 4000, colors: ["red"], gender: "women", category: "dresses" }),
        hit("b", { price: 6000, colors: ["blue"], gender: "women", category: "dresses" }),
      ],
      { price: { $lte: 5000 }, colors: { $exclude: ["blue"] }, gender: "women", category: "dresses" }
    );
    expect(violations).toBe(1);
  });
});
