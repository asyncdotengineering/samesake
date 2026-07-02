import { describe, expect, test } from "bun:test";
import { collection, entity, fields, f, gates } from "../../sdk/src/index.ts";
import { makeCollectionsSchemaGen } from "../src/core/collections-schema-gen.ts";
import { makeSchemaGen } from "../src/core/schema-gen.ts";

const collections = makeCollectionsSchemaGen({ systemSchema: "public", hasPhonetic: false, projectPrefix: "project_" });
const entities = makeSchemaGen({ sys: "public", projectPrefix: "project_" });

describe("pgvector HNSW dimension validation", () => {
  test("allows valid entity and collection embedding dimensions", () => {
    const product = collection("products", {
      fields: { title: f.text({ searchable: true }) },
      indexing: {
        surfaces: {
          embed_doc: { kind: "dense", embedding: "doc", build: ({ data }) => String(data.title ?? "").trim() },
          fts_doc: { kind: "fts", build: ({ data }) => String(data.title ?? "").trim() },
        },
        gate: gates.always,
      },
      embeddings: { doc: { model: "ok", dim: 2000 } },
    });
    const customer = entity("customer", {
      fields: { name: fields.text({ required: true }) },
      scopes: ["tenantId"],
      embeddings: { name_emb: { source: "name", model: "ok", dim: 2000 } },
    });

    expect(() => collections.collectionTableDDL("project_ok", product)).not.toThrow();
    expect(() => entities.generateProjectDDL("ok", [customer])).not.toThrow();
  });

  test("rejects collection embedding dimensions over the halfvec HNSW limit before DDL", () => {
    const product = collection("products", {
      fields: { title: f.text({ searchable: true }) },
      indexing: {
        surfaces: {
          embed_doc: { kind: "dense", embedding: "doc", build: ({ data }) => String(data.title ?? "").trim() },
          fts_doc: { kind: "fts", build: ({ data }) => String(data.title ?? "").trim() },
        },
        gate: gates.always,
      },
      embeddings: { doc: { model: "too-large", dim: 4001 } },
    });

    expect(() => collections.collectionTableDDL("project_bad", product)).toThrow(/products\.embeddings\.doc/);
    expect(() => collections.collectionTableDDL("project_bad", product)).toThrow(/4001 exceeds pgvector HNSW halfvec limit of 4000/);
  });

  test("collection embeddings between 2000 and 4000 dims are allowed (halfvec)", () => {
    const product = collection("products", {
      fields: { title: f.text({ searchable: true }) },
      indexing: {
        surfaces: {
          embed_doc: { kind: "dense", embedding: "doc", build: ({ data }) => String(data.title ?? "").trim() },
          fts_doc: { kind: "fts", build: ({ data }) => String(data.title ?? "").trim() },
        },
        gate: gates.always,
      },
      embeddings: { doc: { model: "big", dim: 3072 } },
    });

    expect(() => collections.collectionTableDDL("project_ok", product)).not.toThrow();
  });

  test("rejects entity embedding dimensions over the vector HNSW limit before DDL", () => {
    const customer = entity("customer", {
      fields: { name: fields.text({ required: true }) },
      scopes: ["tenantId"],
      embeddings: { name_emb: { source: "name", model: "too-large", dim: 2001 } },
    });

    expect(() => entities.generateProjectDDL("bad", [customer])).toThrow(/customer\.embeddings\.name_emb/);
    expect(() => entities.generateProjectDDL("bad", [customer])).toThrow(/2001 exceeds pgvector HNSW vector limit of 2000/);
  });
});
