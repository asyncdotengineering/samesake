import { describe, expect, test } from "bun:test";
import { evalFormula } from "../src/rulepack/formula.ts";

describe("formula evaluator (safe, no eval)", () => {
  test("arithmetic + precedence + attributes", () => {
    expect(evalFormula("80 + csaMm2 * cores", { csaMm2: 2.5, cores: 3 })).toBe(87.5);
    expect(evalFormula("(80 + csaMm2) * cores", { csaMm2: 2.5, cores: 3 })).toBe(247.5);
    expect(evalFormula("600 + ratingA * 5", { ratingA: 32 })).toBe(760);
    expect(evalFormula("-10 + 5", {})).toBe(-5);
  });
  test("missing attribute is a clear error", () => {
    expect(() => evalFormula("csaMm2 * 2", {})).toThrow(/csaMm2/);
  });
  test("rejects anything that isn't whitelisted arithmetic", () => {
    expect(() => evalFormula("process.exit(1)", {})).toThrow();
    expect(() => evalFormula("1 ; 2", {})).toThrow();
    expect(() => evalFormula("2 ** 8", {})).toThrow();
  });
});
