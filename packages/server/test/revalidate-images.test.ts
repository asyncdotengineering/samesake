import "./load-env.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, pipeline, stage, gates } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { __setImageTransport } from "../src/core/fetch-image.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const IMAGE_URL = "https://93.184.216.34/product.jpg";

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

describeIf("test:revalidate-images", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let etagSeq = 0;

  const productsCollection = collection("products", {
    fields: {
      title: f.text({ searchable: true }),
    },
    indexing: {
      surfaces: {
        embed_doc: { kind: "dense", embedding: "doc", build: ({ data }) => String(data.title ?? "") },
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
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ dim }) => new Array(dim).fill(0.1),
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [productsCollection],
    });
    schemaName = r.schema;
  });

  afterEach(() => {
    __setImageTransport(null);
  });

  async function clearProducts() {
    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`DELETE FROM ${schemaName}.c_products`));
    await close();
  }

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  async function rowState(id: string) {
    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute(
      sql.raw(
        `SELECT indexed_at, image_etag, image_checked_at FROM ${schemaName}.c_products WHERE id = '${id}'`
      )
    );
    await close();
    return rows[0] as {
      indexed_at: string | null;
      image_etag: string | null;
      image_checked_at: string | null;
    };
  }

  test("changed ETag resets indexed_at and records validator", async () => {
    await clearProducts();
    etagSeq++;
    const priorEtag = `"etag-old-${etagSeq}"`;
    const newEtag = `"etag-new-${etagSeq}"`;

    await matcher.pushDocuments(projectSlug, "products", [
      {
        id: "rev-changed",
        data: {
          title: "Dress",
          image_url: IMAGE_URL,
          content_hash: "rev-changed-h1",
        },
      },
    ]);

    const { db: db1, close: close1 } = createDbFromUrl(databaseUrl!);
    await db1.execute(
      sql.raw(
        `UPDATE ${schemaName}.c_products SET indexed_at = now(), image_etag = '${priorEtag}' WHERE id = 'rev-changed'`
      )
    );
    await close1();

    const restore = mockTransport((_url, headers) => {
      if (headers["if-none-match"] === priorEtag) {
        return new Response(null, { status: 200, headers: { etag: newEtag } });
      }
      return new Response(null, { status: 200, headers: { etag: newEtag } });
    });

    try {
      const result = await matcher.revalidateImages(projectSlug, "products", { limit: 10 });
      expect(result.changed).toBe(1);

      const state = await rowState("rev-changed");
      expect(state.indexed_at).toBeNull();
      expect(state.image_etag).toBe(newEtag);
      expect(state.image_checked_at).not.toBeNull();
    } finally {
      restore();
    }
  }, 20000);

  test("unchanged ETag (304) leaves indexed_at intact", async () => {
    await clearProducts();
    etagSeq++;
    const stableEtag = `"etag-stable-${etagSeq}"`;

    await matcher.pushDocuments(projectSlug, "products", [
      {
        id: "rev-unchanged",
        data: {
          title: "Coat",
          image_url: IMAGE_URL,
          content_hash: "rev-unchanged-h1",
        },
      },
    ]);

    const { db: db1, close: close1 } = createDbFromUrl(databaseUrl!);
    await db1.execute(
      sql.raw(
        `UPDATE ${schemaName}.c_products SET indexed_at = now(), image_etag = '${stableEtag}' WHERE id = 'rev-unchanged'`
      )
    );
    await close1();

    const restore = mockTransport((_url, headers) => {
      if (headers["if-none-match"] === stableEtag) {
        return new Response(null, { status: 304, headers: { etag: stableEtag } });
      }
      return new Response(null, { status: 200, headers: { etag: stableEtag } });
    });

    try {
      const result = await matcher.revalidateImages(projectSlug, "products", { limit: 10 });
      expect(result.unchanged).toBeGreaterThanOrEqual(1);

      const state = await rowState("rev-unchanged");
      expect(state.indexed_at).not.toBeNull();
      expect(state.image_etag).toBe(stableEtag);
      expect(state.image_checked_at).not.toBeNull();
    } finally {
      restore();
    }
  }, 20000);

  test("no HTTP validator falls back to sha256 byte-hash", async () => {
    await clearProducts();
    const bytesA = new Uint8Array([1, 2, 3, 4]);
    const bytesB = new Uint8Array([5, 6, 7, 8]);

    await matcher.pushDocuments(projectSlug, "products", [
      {
        id: "rev-bytehash",
        data: {
          title: "Scarf",
          image_url: IMAGE_URL,
          content_hash: "rev-bytehash-h1",
        },
      },
    ]);

    const { createHash } = await import("node:crypto");
    const priorHash = `sha256:${createHash("sha256").update(bytesA).digest("hex")}`;

    const { db: db1, close: close1 } = createDbFromUrl(databaseUrl!);
    await db1.execute(
      sql.raw(
        `UPDATE ${schemaName}.c_products SET indexed_at = now(), image_etag = '${priorHash}' WHERE id = 'rev-bytehash'`
      )
    );
    await close1();

    let call = 0;
    const restore = mockTransport((_url, _headers) => {
      call++;
      if (call === 1) {
        return new Response(null, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response(bytesB, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });

    try {
      const result = await matcher.revalidateImages(projectSlug, "products", { limit: 10 });
      expect(result.changed).toBeGreaterThanOrEqual(1);

      const state = await rowState("rev-bytehash");
      expect(state.indexed_at).toBeNull();
      expect(state.image_etag?.startsWith("sha256:")).toBe(true);
      expect(state.image_etag).not.toBe(priorHash);
    } finally {
      restore();
    }
  }, 20000);
});
