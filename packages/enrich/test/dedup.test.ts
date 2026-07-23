import { describe, expect, test } from "bun:test";
import type { CollectionDedupDef } from "@samesake/core";
import {
  scoreCandidate,
  clusterBatch,
  type DedupCandidate,
  type DedupRow,
  type ClusterDecision,
  type DedupCandidateProvider,
  type DedupFeedback,
} from "../src/index.ts";

const cand = (over: Partial<DedupCandidate> = {}): DedupCandidate => ({
  id: "c",
  group: null,
  fields: {},
  trgm: {},
  cos: null,
  ...over,
});

describe("scoreCandidate (golden)", () => {
  test("exactKey equality short-circuits to 1.0 regardless of weak channels", () => {
    const cfg: CollectionDedupDef = {
      channels: [
        { kind: "exactKey", field: "sku" },
        { kind: "cosine", weight: 1 },
      ],
      autoLink: 0.9,
      offerFields: [],
    };
    expect(scoreCandidate(cfg, { sku: "S1" }, cand({ fields: { sku: "S1" }, cos: 0.0 }))).toBe(1.0);
  });

  test("cosine-only channel: cand.cos=0.6, weight 1 → 0.6", () => {
    const cfg: CollectionDedupDef = {
      channels: [{ kind: "cosine", weight: 1 }],
      autoLink: 0.9,
      offerFields: [],
    };
    expect(scoreCandidate(cfg, {}, cand({ cos: 0.6 }))).toBeCloseTo(0.6, 6);
  });
});

describe("clusterBatch (golden fixture)", () => {
  const cfg: CollectionDedupDef = {
    channels: [
      { kind: "exactKey", field: "sku" },
      { kind: "cosine", weight: 1 },
    ],
    autoLink: 0.9,
    suggest: 0.5,
    offerFields: [],
  };

  // In-memory provider: returns the candidate list keyed by row id.
  const CANDS: Record<string, DedupCandidate[]> = {
    A: [],
    B: [{ id: "A", group: null, fields: { sku: "S1" }, trgm: {}, cos: null }], // exactKey S1===S1 -> 1.0
    E: [{ id: "X", group: "GX", fields: { sku: "zz" }, trgm: {}, cos: 0.6 }], // cosine 0.6 -> suggest
    F: [{ id: "Y", group: "GY", fields: { sku: "zz" }, trgm: {}, cos: 0.3 }], // 0.3 -> found
    G: [{ id: "A", group: "A", fields: { sku: "S1" }, trgm: {}, cos: null }], // 1.0 but DECLINED -> found
  };

  const rows: DedupRow[] = [
    { id: "A", fields: { sku: "S1" } },
    { id: "B", fields: { sku: "S1" } },
    { id: "E", fields: { sku: "SE" } },
    { id: "F", fields: { sku: "SF" } },
    { id: "G", fields: { sku: "S1" } },
  ];

  const candidates: DedupCandidateProvider = async (row) => CANDS[row.id] ?? [];
  const feedback: DedupFeedback = {
    isDeclined: async (a, b) => a === "G" && b === "A",
    suggestionStatus: async () => null,
  };

  test("reproduces the exact autoLink/suggest/found decision sequence", async () => {
    const decisions = await clusterBatch(cfg, rows, candidates, feedback);
    const expected: ClusterDecision[] = [
      { rowId: "A", outcome: "found", group: "A", score: null },
      { rowId: "B", outcome: "link", group: "A", score: 1 },
      { rowId: "E", outcome: "suggest", group: "GX", score: 0.6 },
      { rowId: "F", outcome: "found", group: "F", score: 0.3 },
      { rowId: "G", outcome: "found", group: "G", score: 1 },
    ];
    expect(decisions).toEqual(expected);
  });

  test("emits exactly one decision per input row, in order", async () => {
    const decisions = await clusterBatch(cfg, rows, candidates, feedback);
    expect(decisions.map((d) => d.rowId)).toEqual(["A", "B", "E", "F", "G"]);
  });
});
