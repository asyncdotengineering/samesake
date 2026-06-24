// Deterministic test for the match gate — no samesake, no DB. We stub matchLine (the candidate
// source) so gateLine runs against fixed candidates, and use REAL catalog codes so the hard-spec
// gate (specsByCode, from catalog.json) sees their actual specs. This pins the safety property:
// a 32A line never auto-matches a 40A part, plus the confidence→status buckets.
import { mock, describe, test, expect } from "bun:test";
import type { MatchCandidate, NormalizedBomLine } from "../../shared/types.ts";

let candidates: MatchCandidate[] = [];
mock.module("../src/catalog.ts", () => ({ matchLine: async () => candidates }));

const { gateLine } = await import("../src/pipeline/match.ts");
const { loadPackFromYaml } = await import("../src/rulepack/load.ts");

const pack = loadPackFromYaml("electrical-mep"); // autoLink 0.55, suggest 0.38; hard specs incl. ratingA, poles
const cand = (code: string, confidence: number): MatchCandidate => ({
  code, description: code, brand: "Schneider", confidence, listPrice: 780, unit: "nos",
});
const line = (specs: NormalizedBomLine["specs"]): NormalizedBomLine => ({
  lineNo: 1, description: "", source: "xlsx", normalized: "MCB", qty: 1, unit: "nos",
  unitFactor: 1, category: "breaker", specs, notes: [],
});

describe("gateLine — spec gate + confidence buckets (stubbed matcher)", () => {
  test("compatible spec + high confidence → matched", async () => {
    candidates = [cand("SCH-MCB-32-SP-C", 0.9)];
    const r = await gateLine({} as never, line({ ratingA: 32, poles: "SP" }), pack);
    expect(r.status).toBe("matched");
    expect(r.chosen?.code).toBe("SCH-MCB-32-SP-C");
  });

  test("a 32A line never auto-matches a 40A part (hard-spec gate)", async () => {
    candidates = [cand("SCH-MCB-40-DP-C", 0.95)]; // 40A DP — incompatible with the 32A SP line
    const r = await gateLine({} as never, line({ ratingA: 32, poles: "SP" }), pack);
    expect(r.status).not.toBe("matched");
    expect(r.chosen).toBeNull();
  });

  test("confidence between suggest and autoLink → review", async () => {
    candidates = [cand("SCH-MCB-32-SP-C", 0.45)];
    expect((await gateLine({} as never, line({ ratingA: 32, poles: "SP" }), pack)).status).toBe("review");
  });

  test("confidence below suggest → unmatched", async () => {
    candidates = [cand("SCH-MCB-32-SP-C", 0.2)];
    expect((await gateLine({} as never, line({ ratingA: 32, poles: "SP" }), pack)).status).toBe("unmatched");
  });
});
