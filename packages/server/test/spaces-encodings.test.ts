import { describe, expect, test } from "bun:test";
import { collection, f, s } from "../../sdk/src/index.ts";
import {
  assembleDocVector,
  assembleQueryVector,
  cosine,
  encodeCategorical,
  encodeNumber,
  encodeRecency,
  encodeText,
  l2Normalize,
  splitVector,
  totalSpaceDims,
} from "../src/core/spaces.ts";

describe("spaces encodings", () => {
  test("encodeNumber ramp produces expected shape at t=0.5 dims=8", () => {
    const mid = encodeNumber(50, { min: 0, max: 100, dims: 8, scale: "linear" });
    expect(mid.length).toBe(8);
    expect(mid[3]).toBeGreaterThan(mid[2]!);
    expect(mid[3]).toBeGreaterThan(mid[1]!);
    expect(mid[3]! / mid[2]!).toBeCloseTo(3, 1);
    const norm = Math.sqrt(mid.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  test("encodeRecency decays with age", () => {
    const fresh = encodeRecency(0, { halfLifeDays: 60, dims: 8 });
    const stale = encodeRecency(120, { halfLifeDays: 60, dims: 8 });
    const freshPeak = Math.max(...fresh);
    const stalePeak = Math.max(...stale);
    expect(freshPeak).toBeGreaterThan(stalePeak);
  });

  test("encodeCategorical one-hot and hash paths", () => {
    const oneHot = encodeCategorical("a", { values: ["a", "b", "c"], dims: 8 });
    expect(oneHot[0]).toBeCloseTo(1, 5);
    const unknown = encodeCategorical("z", { values: ["a", "b"], dims: 4 });
    expect(unknown.every((x) => x === 0)).toBe(true);
    const hashed = encodeCategorical("electronics", { dims: 32 });
    const norm = Math.sqrt(hashed.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  test("assembleDocVector has unit length when all segments present", () => {
    const dims = [4, 4];
    const segments = [
      encodeNumber(10, { min: 0, max: 100, dims: 4, scale: "linear" }),
      encodeCategorical("x", { values: ["x", "y"], dims: 4 }),
    ];
    const doc = assembleDocVector(segments, dims);
    const norm = Math.sqrt(doc.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  test("normalization law: weighted cosine ordering matches hand computation", () => {
    const dims = [3, 3];
    const d1 = l2Normalize([1, 0, 0]);
    const d2 = l2Normalize([0, 1, 0]);
    const q1 = l2Normalize([1, 0.5, 0]);
    const q2 = l2Normalize([0, 1, 0.5]);

    const docA = assembleDocVector([d1, d2], dims);
    const docB = assembleDocVector([d2, d1], dims);

    const weightsLow = [1, 0.1];
    const weightsHigh = [0.1, 1];

    const queryLow = assembleQueryVector([q1, q2], weightsLow, dims);
    const queryHigh = assembleQueryVector([q1, q2], weightsHigh, dims);

    const cosALow = cosine(docA, queryLow);
    const cosBLow = cosine(docB, queryLow);
    const cosAHigh = cosine(docA, queryHigh);
    const cosBHigh = cosine(docB, queryHigh);

    const handALow =
      weightsLow[0]! * cosine(d1, q1) + weightsLow[1]! * cosine(d2, q2);
    const handBLow =
      weightsLow[0]! * cosine(d2, q1) + weightsLow[1]! * cosine(d1, q2);
    const sqrtN = Math.sqrt(2);
    const qLowNorm = Math.sqrt(weightsLow[0]! ** 2 + weightsLow[1]! ** 2);
    expect(cosALow).toBeCloseTo(handALow / (sqrtN * qLowNorm), 4);
    expect(cosBLow).toBeCloseTo(handBLow / (sqrtN * qLowNorm), 4);
    expect(cosAHigh > cosBHigh).toBe(cosALow > cosBLow);

    const segsA = splitVector(docA, dims);
    const segsB = splitVector(docB, dims);
    const contribA = segsA[0]!.reduce((s, x, i) => s + x * queryLow[i]!, 0);
    const contribB = segsB[1]!.reduce((s, x, i) => s + x * queryLow[i + 3]!, 0);
    expect(contribA).toBeGreaterThan(contribB);
  });

  test("encodeText passthrough normalizes", () => {
    const v = encodeText([3, 4]);
    expect(Math.sqrt(v[0]! ** 2 + v[1]! ** 2)).toBeCloseTo(1, 5);
  });

  test("collection() rejects Σdims > 2000", () => {
    expect(() =>
      collection("big", {
        fields: { x: f.text() },
        spaces: {
          a: s.number({ field: "x", mode: "max", dims: 1001, min: 0, max: 1 }),
          b: s.number({ field: "x", mode: "max", dims: 1000, min: 0, max: 1 }),
        },
      })
    ).toThrow(/pgvector HNSW limit/);
    expect(totalSpaceDims({ a: s.number({ field: "x", mode: "max", dims: 8, min: 0, max: 1 }) })).toBe(8);
  });
});
