import { entity, fields, Scorers } from "@samesake/core";

export const contact = entity("contact", {
  fields: {
    name: fields.text({ required: true }),
    phone: fields.text({ optional: true }),
  },
  scopes: ["tenantId"],
  embeddings: {
    name_emb: { source: "name", model: "gemini-embedding-001", dim: 768 },
  },
  phonetic: {
    name_phon: { source: "name" },
  },
  scoring: {
    channels: [
      Scorers.phoneExact({ field: "phone", weight: 1.0 }),
      Scorers.cosine({ embedding: "name_emb", weight: 0.6 }),
      Scorers.trigram({ field: "name", weight: 0.25 }),
      Scorers.aliasHit({ weight: 0.4 }),
      Scorers.phoneticEq({ phonetic: "name_phon", weight: 0.2 }),
    ],
  },
});
