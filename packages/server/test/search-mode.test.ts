import { describe, expect, test } from "bun:test";
import { collection, f, s, Channels } from "@samesake/core";
import { denseAndFtsIndexingByTitle, ftsIndexingByTitle } from "./fixtures.ts";
import { parseSearchWeights } from "../src/core/search-query.ts";

const def = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    price: f.number({ filterable: true }),
  },
  indexing: denseAndFtsIndexingByTitle,
  embeddings: { doc: { model: "m", dim: 8 } },
  spaces: {
    style: s.text({ source: "$title", model: "m", dim: 8 }),
    visual: s.image({ source: "$image_url", model: "m", dim: 8 }),
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
      Channels.spaces({ weight: 1 }),
    ],
    combiner: "rrf",
    defaultSpaceWeights: { style: 1, visual: 0.5 },
  },
});

describe("parseSearchWeights — mode-aware weighting", () => {
  test("intent + text: keyword capped to tiebreaker (0.3·cosine), spaces leg off", () => {
    const w = parseSearchWeights(def, undefined, "intent", false);
    expect(w.fts).toBe(0.3);
    expect(w.cosine).toBe(1);
    expect(w.spaces).toBe(0);
  });

  test("similar + text: keyword off, semantic leads, image space zeroed", () => {
    const w = parseSearchWeights(def, undefined, "similar", false);
    expect(w.fts).toBe(0);
    expect(w.cosine).toBe(1);
    expect(w.spaceSegmentWeights.style).toBe(1);
    expect(w.spaceSegmentWeights.visual).toBe(0); // no image query → cross-modal noise zeroed
  });

  test("similar + image: keyword off, visual space kept", () => {
    const w = parseSearchWeights(def, undefined, "similar", true);
    expect(w.fts).toBe(0);
    expect(w.spaceSegmentWeights.visual).toBe(0.5);
  });

  test("intent + image: spaces leg kept, keyword still a tiebreaker", () => {
    const w = parseSearchWeights(def, undefined, "intent", true);
    expect(w.spaces).toBe(1);
    expect(w.fts).toBe(0.3);
    expect(w.spaceSegmentWeights.visual).toBe(0.5);
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
