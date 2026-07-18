import { describe, expect, test } from "bun:test";
import { collection, f, Channels } from "@samesake/core";
import { denseAndFtsIndexingByTitle, ftsIndexingByTitle } from "./fixtures.ts";
import { parseSearchWeights } from "../src/core/search-query.ts";

const def = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    price: f.number({ filterable: true }),
  },
  indexing: denseAndFtsIndexingByTitle,
  embeddings: {
    doc: { model: "m", dim: 8 },
    visual: { kind: "image", model: "m", dim: 8 },
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
      Channels.cosine({ embedding: "visual", weight: 0.5 }),
    ],
    combiner: "rrf",
  },
});

describe("parseSearchWeights — mode-aware weighting", () => {
  test("intent + text: keyword capped to tiebreaker (0.3·cosine)", () => {
    const w = parseSearchWeights(def, undefined, "intent", false);
    expect(w.fts).toBe(0.3);
    expect(w.cosine).toBe(1);
    // Non-primary aspects OFF for text intent by default (C9 gate verdict 2026-07-18);
    // per-query weights.aspects override re-enables.
    expect(w.aspects).toEqual({ doc: 1, visual: 0 });
  });

  test("similar + text: keyword off and all aspects stay enabled", () => {
    const w = parseSearchWeights(def, undefined, "similar", false);
    expect(w.fts).toBe(0);
    expect(w.cosine).toBe(1);
    expect(w.aspects).toEqual({ doc: 1, visual: 0.5 });
  });

  test("similar + image: keyword off and all configured aspect weights stay available", () => {
    const w = parseSearchWeights(def, undefined, "similar", true);
    expect(w.fts).toBe(0);
    expect(w.aspects).toEqual({ doc: 1, visual: 0.5 });
  });

  test("intent + image: keyword remains a tiebreaker", () => {
    const w = parseSearchWeights(def, undefined, "intent", true);
    expect(w.fts).toBe(0.3);
    expect(w.aspects.visual).toBe(0.5);
  });

  test("explicit per-query weights override the mode defaults", () => {
    const w = parseSearchWeights(def, { fts: 1 }, "similar", false);
    expect(w.fts).toBe(1);
  });

  test("default mode is intent (back-compat call shape)", () => {
    const w = parseSearchWeights(def, undefined);
    expect(w.fts).toBe(0.3);
  });

  test("keyword-only collection (no embeddings) keeps fts in intent — nothing else to rank by", () => {
    const ftsOnly = collection("p", {
      fields: { title: f.text({ searchable: true }) },
      indexing: ftsIndexingByTitle,
      search: { channels: [Channels.fts({ fields: ["title"], weight: 1 })], combiner: "rrf" },
    });
    const w = parseSearchWeights(ftsOnly, undefined, "intent", false);
    expect(w.fts).toBe(1); // cosine == 0, so no cap applied
  });
});
