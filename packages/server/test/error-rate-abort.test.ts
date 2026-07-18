import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, gates, pipeline, stage } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { __setImageTransport } from "../src/core/fetch-image.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const enrichCollection = collection("products", {
  fields: { title: f.text({ searchable: true }) },
  enrich: pipeline(
    stage("summarize", {
      prompt: ({ data }) => `Summarize ${data.title}`,
      schema: () => ({ type: "object", properties: { summary: { type: "string" } } }),
    })
  ),
  indexing: {
    surfaces: {
      embed_doc: {
        kind: "dense",
        embedding: "doc",
        build: ({ data }) => {
          if (String(data.title ?? "").startsWith("bad")) {
            throw new Error("surface build failed");
          }
          return String(data.title ?? "").trim();
        },
      },
      fts_doc: { kind: "fts", build: ({ data }) => String(data.title ?? "").trim() },
    },
    gate: gates.always,
  },
  embeddings: { doc: { model: "test-embed", dim: 8 } },
  search: { channels: [Channels.fts({ fields: ["title"], weight: 1 })] },
});

describeIf("test:error-rate-abort (REQ-18)", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async () => ({ summary: "ok" }),
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, { entities: [], collections: [enrichCollection] });
    schemaName = r.schema;
  }, 30_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("throws when failure rate exceeds threshold after minSamples", async () => {
    const docs = Array.from({ length: 12 }, (_, i) => ({
      id: `f${i}`,
      data: { title: `bad-${i}`, content_hash: `f${i}` },
    }));
    await matcher.pushDocuments(projectSlug, "products", docs);

    await expect(
      matcher.enrich(projectSlug, "products", { maxErrorRate: 0.5, minSamples: 10, concurrency: 1 })
    ).rejects.toThrow(/failure rate/i);
  }, 30_000);

  test("completes when failures stay under threshold", async () => {
    const okMatcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async () => ({ summary: "ok" }),
    });
    await okMatcher.migrate();
    const slug = `t_${Math.random().toString(36).slice(2, 10)}`;
    const r = await okMatcher.apply(slug, { entities: [], collections: [enrichCollection] });

    await okMatcher.pushDocuments(slug, "products", [
      { id: "ok1", data: { title: "One", content_hash: "ok1" } },
      { id: "ok2", data: { title: "Two", content_hash: "ok2" } },
    ]);

    const result = await okMatcher.enrich(slug, "products", {
      maxErrorRate: 0.5,
      minSamples: 10,
      concurrency: 1,
    });
    expect(result.enriched).toBe(2);
    expect(result.failed).toBe(0);

    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${r.schema} CASCADE`));
    await close();
    await okMatcher.close();
  });
});

describeIf("test:error-rate-abort index path (REQ-18)", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let restoreFetch: (() => void) | null = null;

  const imageIndexCollection = collection("products", {
    fields: { title: f.text({ searchable: true }) },
    indexing: {
      surfaces: {},
      gate: gates.always,
    },
    embeddings: {
      visual: { kind: "image", source: "$image_url", model: "test-img", dim: 8 },
    },
    search: { channels: [Channels.cosine({ embedding: "visual", weight: 1 })] },
  });

  beforeAll(async () => {
    restoreFetch = mockFetchFail();
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async (req) => {
        if (req.image) return new Array(req.dim).fill(0).map((_, i) => (i === 0 ? 1 : 0));
        throw new Error("text embed unexpected");
      },
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, { entities: [], collections: [imageIndexCollection] });
    schemaName = r.schema;

    const docs = Array.from({ length: 12 }, (_, i) => ({
      id: `ix${i}`,
      data: { title: `Doc ${i}`, image_url: `https://example.com/${i}.jpg`, content_hash: `ix${i}` },
    }));
    await matcher.pushDocuments(projectSlug, "products", docs);

    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`
      UPDATE ${schemaName}.c_products
      SET enriched_at = now(), pipeline_status = 'ready'
      WHERE id LIKE 'ix%'
    `));
    await close();
  }, 30_000);

  afterAll(async () => {
    restoreFetch?.();
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("index run throws when per-row failures exceed threshold", async () => {
    await expect(
      matcher.index(projectSlug, "products", { maxErrorRate: 0.5, minSamples: 10 })
    ).rejects.toThrow(/failure rate/i);
  });
});

function mockFetchFail() {
  __setImageTransport(async () => {
    throw new Error("network_error");
  });
  return () => __setImageTransport(null);
}
