import { describe, expect, test } from "bun:test";
import type { CollectionDedupDef } from "@samesake/core";
import {
  seedModel,
  matchWeight,
  matchOne,
  clusterByComponents,
  type FSModel,
  type DedupCandidate,
} from "../src/index.ts";

const cfg: CollectionDedupDef = {
  channels: [
    { kind: "exactKey", field: "gtin" },
    { kind: "trigram", field: "title", weight: 1 },
    { kind: "cosine", weight: 1 },
  ],
  autoLink: 0.9,
  suggest: 0.6,
  offerFields: [],
};

const cand = (
  id: string,
  gtin: string | null,
  trgmTitle: number,
  cos: number | null
): DedupCandidate => ({
  id,
  group: null,
  fields: { gtin },
  trgm: { title: trgmTitle },
  cos,
});

/** FIT profile: absence/reworded treated as uninformative (trainability lever). */
function fitModel(): FSModel {
  return {
    lambda: 0.05,
    autoLink: 0.5,
    suggest: 0.1,
    channels: [
      {
        channel: "gtin",
        kind: "exactKey",
        field: "gtin",
        levels: [
          { test: { op: "exact" }, m: 0.95, u: 0.0002, label: "exact" },
          { test: { op: "else" }, m: 0.5, u: 0.5, label: "else" },
        ],
      },
      {
        channel: "title",
        kind: "trigram",
        field: "title",
        levels: [
          { test: { op: "gte", value: 0.9 }, m: 0.8, u: 0.01, label: "high" },
          { test: { op: "gte", value: 0.6 }, m: 0.55, u: 0.08, label: "mid" },
          { test: { op: "else" }, m: 0.3, u: 0.7, label: "else" },
        ],
      },
      {
        channel: "cosine",
        kind: "cosine",
        levels: [
          { test: { op: "gte", value: 0.95 }, m: 0.9, u: 0.01, label: "high" },
          { test: { op: "gte", value: 0.8 }, m: 0.55, u: 0.06, label: "mid" },
          { test: { op: "else" }, m: 0.2, u: 0.7, label: "else" },
        ],
      },
    ],
  };
}

describe("matchWeight under seedModel (NAIVE)", () => {
  const model = seedModel(cfg);

  test("exact-key pair ⇒ high Pr (link band)", () => {
    const { Pr } = matchWeight(model, { gtin: "GTIN-A" }, cand("r2", "GTIN-A", 0.3, 0.4));
    expect(Pr).toBeGreaterThan(model.autoLink);
    expect(Pr).toBeCloseTo(0.747, 2);
  });

  test("strong-all-channels pair ⇒ Pr≈1", () => {
    const { Pr } = matchWeight(model, { gtin: "GTIN-B" }, cand("r5", "GTIN-B", 0.92, 0.94));
    expect(Pr).toBeGreaterThan(0.99);
  });

  test("clear non-dup ⇒ Pr≈0", () => {
    const { Pr } = matchWeight(model, { gtin: "GTIN-G" }, cand("r11", "GTIN-H", 0.1, 0.12));
    expect(Pr).toBeLessThan(0.01);
  });

  test("semantic-dup (cos 0.97, trgm 0.20, no shared key) stays below tau under seed", () => {
    const { Pr } = matchWeight(model, { gtin: "GTIN-C" }, cand("r7", "GTIN-D", 0.2, 0.97));
    expect(Pr).toBeLessThan(model.autoLink);
  });
});

describe("matchWeight under FIT model (trainability lever)", () => {
  test("semantic-dup crosses tau under FIT while seed leaves it below", () => {
    const seed = seedModel(cfg);
    const fit = fitModel();
    const row = { gtin: "GTIN-C" };
    const c = cand("r7", "GTIN-D", 0.2, 0.97);
    const seedPr = matchWeight(seed, row, c).Pr;
    const fitPr = matchWeight(fit, row, c).Pr;
    expect(seedPr).toBeLessThan(seed.autoLink);
    expect(fitPr).toBeGreaterThanOrEqual(fit.autoLink);
    expect(fitPr).toBeCloseTo(0.67, 1);
  });
});

describe("clusterByComponents", () => {
  test("transitive trio yields one component; isolated pair its own; sub-tau none", () => {
    const nodes = ["a", "b", "c", "d", "e", "f", "g"];
    const pairs = [
      { a: "a", b: "b", Pr: 0.9 },
      { a: "b", b: "c", Pr: 0.85 },
      { a: "d", b: "e", Pr: 0.99 },
      { a: "f", b: "g", Pr: 0.2 },
    ];
    const clusters = clusterByComponents(nodes, pairs, 0.5);
    expect(clusters).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
  });

  test("output is deterministic", () => {
    const nodes = ["z", "y", "x"];
    const pairs = [
      { a: "z", b: "x", Pr: 0.8 },
      { a: "y", b: "x", Pr: 0.7 },
    ];
    const a = clusterByComponents(nodes, pairs, 0.5);
    const b = clusterByComponents([...nodes].reverse(), [...pairs].reverse(), 0.5);
    expect(a).toEqual(b);
    expect(a).toEqual([["x", "y", "z"]]);
  });
});

describe("matchOne", () => {
  test("returns candidates sorted by Pr with correct bands", () => {
    const model = seedModel(cfg);
    const cands = [
      cand("low", "GTIN-H", 0.1, 0.12),
      cand("exact", "GTIN-A", 0.3, 0.4),
      cand("strong", "GTIN-A", 0.92, 0.94),
    ];
    const ranked = matchOne(model, { gtin: "GTIN-A" }, cands);
    expect(ranked.map((r) => r.candidate.id)).toEqual(["strong", "exact", "low"]);
    expect(ranked[0]!.band).toBe("link");
    expect(ranked[1]!.band).toBe("link");
    expect(ranked[2]!.band).toBe("none");
    expect(ranked[0]!.Pr).toBeGreaterThanOrEqual(ranked[1]!.Pr);
    expect(ranked[1]!.Pr).toBeGreaterThanOrEqual(ranked[2]!.Pr);
  });
});
