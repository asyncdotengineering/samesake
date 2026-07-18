import { collection, f, Channels } from "../src/index.ts";

collection("bad", {
  fields: { title: f.text() },
  embeddings: {
    doc: { source: "$title", model: "m", dim: 8 },
  },
  search: {
    channels: [
      // @ts-expect-error embedding "nope" is not declared on this collection
      Channels.cosine({ embedding: "nope", weight: 1 }),
    ],
  },
});

collection("bad-aspect", {
  fields: { title: f.text() },
  embeddings: {
    doc: { source: "$title", model: "m", dim: 8 },
    visual: { model: "m", dim: 8, kind: "image" },
  },
  search: {
    channels: [
      // @ts-expect-error embedding "nope" is not declared on this collection
      Channels.cosine({ embedding: "nope", weight: 1 }),
    ],
  },
});
