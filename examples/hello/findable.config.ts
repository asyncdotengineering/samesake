import { entity, fields, Scorers } from "@samesake/core";

export const customer = entity("customer", {
  fields: {
    name: fields.text({ required: true }),
    phone: fields.text({ optional: true }),
  },
  scopes: ["tenantId"],
  embeddings: {
    name_emb: { source: "name", model: "gemini-embedding-001", dim: 768 },
  },
  phonetic: {
    name_phon: { source: "name", algorithm: "indic-soundex" },
  },
  scoring: {
    channels: [
      Scorers.phoneExact({ field: "phone", weight: 1.0 }),
      Scorers.cosine({ embedding: "name_emb", weight: 0.6 }),
      Scorers.trigram({ field: "name", weight: 0.25, latinOnlyPartial: true }),
      Scorers.aliasHit({ weight: 0.4 }),
      Scorers.phoneticEq({ phonetic: "name_phon", weight: 0.2 }),
    ],
  },
});

export const asset = entity("asset", {
  fields: {
    name: fields.text({ required: true }),
    units: fields.text({ optional: true }),
  },
  scopes: ["tenantId"],
  parse: {
    model: "gemini-2.5-flash-lite",
    cacheTtl: "90d",
  },
  embeddings: {
    item_emb: {
      source: "$item_canonical $variant",
      model: "gemini-embedding-001",
      dim: 768,
    },
    full_emb: {
      source: "name",
      model: "gemini-embedding-001",
      dim: 768,
    },
  },
  scoring: {
    channels: [
      Scorers.internalCodeExact({ field: "parsed.internal_code", shortCircuit: true }),
      Scorers.sizeUnitGate({ value: "parsed.size_value", unit: "parsed.size_unit" }),
      Scorers.brandGate({ field: "parsed.brand_normalised", matchBoost: 1.3, mismatchFactor: 0.2 }),
      Scorers.cosine({ embedding: "item_emb", weight: 0.65 }),
      Scorers.cosine({ embedding: "full_emb", weight: 0.30 }),
      Scorers.trigram({ field: "name", weight: 0.20 }),
      Scorers.aliasHit({ weight: 0.40 }),
    ],
  },
});

export const supplier = entity("supplier", {
  fields: {
    name: fields.text({ required: true }),
    phone: fields.text({ optional: true }),
  },
  scopes: ["tenantId"],
  embeddings: {
    name_emb: { source: "name", model: "gemini-embedding-001", dim: 768 },
  },
  phonetic: {
    name_phon: { source: "name", algorithm: "indic-soundex" },
  },
  scoring: {
    channels: [
      Scorers.phoneExact({ field: "phone", weight: 1.0 }),
      Scorers.cosine({ embedding: "name_emb", weight: 0.6 }),
      Scorers.trigram({ field: "name", weight: 0.25, latinOnlyPartial: true }),
      Scorers.aliasHit({ weight: 0.4 }),
      Scorers.phoneticEq({ phonetic: "name_phon", weight: 0.2 }),
    ],
  },
});
