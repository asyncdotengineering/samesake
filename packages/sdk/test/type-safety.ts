import { collection, f, Channels, s } from "../src/index.ts";

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

collection("bad-spaces", {
  fields: { title: f.text(), price: f.number() },
  spaces: {
    style: s.text({ source: "$title", model: "m", dim: 8 }),
    price: s.number({ field: "price", mode: "max", dims: 8, min: 0, max: 100 }),
  },
  search: {
    channels: [Channels.spaces({ weight: 1 })],
    // @ts-expect-error space "nope" is not declared on this collection
    defaultSpaceWeights: { style: 1, nope: 1 },
  },
});

collection("bad-image-space", {
  fields: { title: f.text() },
  spaces: {
    visual: s.image({ source: "$image_url", model: "m", dim: 8 }),
  },
  search: {
    channels: [Channels.spaces({ weight: 1 })],
    // @ts-expect-error space "nope" is not declared on this collection
    defaultSpaceWeights: { visual: 1, nope: 1 },
  },
});
