import "./load-env.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, pipeline, stage, gates } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { __setImageTransport } from "../src/core/fetch-image.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const IMAGE_URL = "https://93.184.216.34/look.jpg";

function mockTransport(handler: (url: string, headers: Record<string, string>) => Response) {
  __setImageTransport(async ({ url, headers, method }) => {
    const res = handler(url.href, headers);
    const hdrs: Record<string, string | undefined> = {};
    res.headers.forEach((v, k) => {
      hdrs[k] = v;
    });
    const buf = method === "HEAD" ? new Uint8Array() : new Uint8Array(await res.arrayBuffer());
    async function* body() {
      if (buf.byteLength) yield buf;
    }
    return { status: res.status, headers: hdrs, body: body() };
  });
  return () => __setImageTransport(null);
}

describeIf("test:revalidate-restains-enrich", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let generateCalls = 0;

  const imageEnrichCollection = collection("products", {
    fields: {
      title: f.text({ searchable: true }),
    },
    enrich: pipeline(
      stage("vision", {
        images: (ctx) => (ctx.data.image_url ? [String(ctx.data.image_url)] : []),
        prompt: (ctx) => `describe ${ctx.data.title}`,
        schema: () => ({ type: "object", properties: { color: { type: "string" } } }),
        model: "vision",
      })
    ),
    indexing: {
      surfaces: {
        embed_doc: {
          kind: "dense",
          embedding: "doc",
          build: ({ data, enriched }) => `${data.title} ${enriched.color ?? ""}`.trim(),
        },
        fts_doc: { kind: "fts", build: ({ data }) => String(data.title ?? "") },
      },
      gate: gates.always,
    },
    embeddings: {
      doc: { model: "test-embed", dim: 8 },
    },
    search: {
      channels: [Channels.fts({ fields: ["title"], weight: 1 })],
    },
  });

  beforeAll(async () => {
    const { db: cacheDb, close: cacheClose } = createDbFromUrl(databaseUrl!);
    await cacheDb.execute(sql.raw(`DELETE FROM samesake_stage_cache`));
    await cacheClose();

    generateCalls = 0;
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async () => {
        generateCalls++;
        return { color: "red" };
      },
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [imageEnrichCollection],
    });
    schemaName = r.schema;

    const restore = mockTransport(() =>
      new Response(new Uint8Array([9, 9, 9]), {
        status: 200,
        headers: { "content-type": "image/png", etag: '"etag-initial"' },
      })
    );
    try {
      await matcher.pushDocuments(projectSlug, "products", [
        {
          id: "img1",
          data: {
            title: "Red Dress",
            image_url: IMAGE_URL,
            content_hash: "img1-h1",
          },
        },
      ]);
      await matcher.enrich(projectSlug, "products");
      expect(generateCalls).toBe(1);
    } finally {
      restore();
    }
  });

  afterEach(() => {
    __setImageTransport(null);
  });

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("re-enrich after image change misses URL-keyed stage cache", async () => {
    const { db: db1, close: close1 } = createDbFromUrl(databaseUrl!);
    await db1.execute(
      sql.raw(
        `UPDATE ${schemaName}.c_products SET indexed_at = now(), image_etag = '"etag-initial"' WHERE id = 'img1'`
      )
    );
    await close1();

    const priorEtag = '"etag-initial"';
    const newEtag = '"etag-changed"';
    const restore = mockTransport((_url, headers) => {
      if (headers["if-none-match"] === priorEtag) {
        return new Response(null, { status: 200, headers: { etag: newEtag } });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png", etag: newEtag },
      });
    });

    try {
      generateCalls = 0;
      const rev = await matcher.revalidateImages(projectSlug, "products");
      expect(rev.changed).toBe(1);

      const r = await matcher.enrich(projectSlug, "products");
      expect(r.enriched).toBe(1);
      expect(generateCalls).toBe(1);
    } finally {
      restore();
    }
  }, 30000);
});
