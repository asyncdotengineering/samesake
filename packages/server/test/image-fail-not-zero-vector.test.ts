import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels } from "../../sdk/src/index.ts";
import { minimalIndexing } from "./fixtures.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { __setImageTransport } from "../src/core/fetch-image.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

function peakVector(dim: number, peak: number): number[] {
  const out = new Array(dim).fill(0);
  out[peak % dim] = 1;
  return out;
}

function mockFetchFail() {
  __setImageTransport(async () => {
    throw new Error("network_error");
  });
  return () => __setImageTransport(null);
}

const imageAspectCollection = collection("products", {
  fields: { title: f.text({ searchable: true }) },
  indexing: minimalIndexing,
  embeddings: {
    visual: { kind: "image", source: "$image_url", model: "test-img", dim: 8 },
  },
  search: {
    channels: [Channels.cosine({ embedding: "visual", weight: 1 })],
  },
});

describeIf("test:image-fail-not-zero-vector (REQ-18b/M5)", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let restoreFetch: (() => void) | null = null;

  beforeAll(async () => {
    restoreFetch = mockFetchFail();
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async (req) => {
        if (req.image) return peakVector(req.dim, 0);
        return peakVector(req.dim, 1);
      },
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [imageAspectCollection],
    });
    schemaName = r.schema;
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

  test("image fetch failure marks row failed without indexing a zero visual segment", async () => {
    await matcher.pushDocuments(projectSlug, "products", [
      {
        id: "bad-img",
        data: { title: "orphan", image_url: "https://example.com/nope.png" },
      },
    ]);

    const { indexed } = await matcher.index(projectSlug, "products");
    expect(indexed).toBe(0);

    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{
      pipeline_status: string;
      indexed_at: string | null;
      last_error: string | null;
      embedding: string | null;
    }>(sql.raw(`
      SELECT pipeline_status, indexed_at, last_error, embedding::text AS embedding
      FROM ${schemaName}.c_products WHERE id = 'bad-img'
    `));
    await close();

    expect(rows.length).toBe(1);
    expect(rows[0]!.pipeline_status).toBe("failed");
    expect(rows[0]!.indexed_at).toBeNull();
    expect(rows[0]!.last_error).toMatch(/image fetch failed/i);
    expect(rows[0]!.embedding).toBeNull();
  });
});
