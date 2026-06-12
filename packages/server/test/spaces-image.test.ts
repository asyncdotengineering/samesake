import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { EmbedRequest } from "../src/types.ts";
import { collection, f, Channels, s } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { fetchImageBytes } from "../src/core/fetch-image.ts";
import { encodeImage } from "../src/core/spaces.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

function peakVector(dim: number, peak: number): number[] {
  const out = new Array(dim).fill(0);
  out[peak % dim] = 1;
  return out;
}

function multimodalStub(req: EmbedRequest): number[] {
  if (req.image?.url) {
    return peakVector(req.dim, req.image.url.includes("red") ? 0 : 1);
  }
  if (req.text) {
    return peakVector(req.dim, req.text.includes("red") ? 0 : 1);
  }
  throw new Error("stub needs text or image");
}

describe("fetchImageBytes", () => {
  test("rejects non-image content-type", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not an image", {
          headers: { "content-type": "text/plain" },
        });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/x`;
      expect(await fetchImageBytes(url)).toBeNull();
    } finally {
      server.stop();
    }
  });

  test("returns bytes for tiny image response", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(png, { headers: { "content-type": "image/png" } });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/ok.png`;
      const got = await fetchImageBytes(url);
      expect(got).not.toBeNull();
      expect(got!.mimeType).toBe("image/png");
      expect(got!.bytes.length).toBeGreaterThan(0);
    } finally {
      server.stop();
    }
  });
});

describe("encodeImage", () => {
  test("L2-normalizes like text segments", () => {
    const v = encodeImage([3, 4]);
    const norm = Math.sqrt(v[0]! ** 2 + v[1]! ** 2);
    expect(norm).toBeCloseTo(1, 5);
  });
});

const imageSpacesCollection = collection("products", {
  fields: { title: f.text({ searchable: true }) },
  spaces: {
    style: s.text({ source: "$title", model: "test-text", dim: 8 }),
    visual: s.image({ source: "$image_url", model: "test-img", dim: 8 }),
  },
  search: {
    channels: [Channels.spaces({ weight: 1 })],
    defaultSpaceWeights: { style: 1, visual: 1 },
  },
});

describeIf("image space indexing", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async (req) => multimodalStub(req),
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [imageSpacesCollection],
    });
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

  test("zero-vector on image fetch failure without batch death", async () => {
    await matcher.pushDocuments(projectSlug, "products", [
      {
        id: "bad-img",
        data: { title: "orphan", image_url: "http://127.0.0.1:1/nope.png" },
      },
      {
        id: "good",
        data: {
          title: "red shoe",
          image_url: "http://127.0.0.1:1/also-bad.png",
        },
      },
    ]);

    const { indexed } = await matcher.index(projectSlug, "products");
    expect(indexed).toBe(2);

    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{ space_vec: string | null }>(sql.raw(`
      SELECT space_vec::text AS space_vec FROM ${schemaName}.c_products WHERE id = 'bad-img'
    `));
    await close();
    expect(rows[0]?.space_vec).toBeTruthy();
  });

  test("image segment placed from stubbed embed", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(Buffer.from([0xff, 0xd8, 0xff]), {
          headers: { "content-type": "image/jpeg" },
        });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/red.jpg`;
      await matcher.pushDocuments(projectSlug, "products", [
        { id: "red-doc", data: { title: "red item", image_url: url } },
      ]);
      await matcher.index(projectSlug, "products");

      const { db, close } = createDbFromUrl(databaseUrl!);
      const rows = await db.execute<{ space_vec: string }>(sql.raw(`
        SELECT space_vec::text AS space_vec FROM ${schemaName}.c_products WHERE id = 'red-doc'
      `));
      await close();
      expect(rows[0]?.space_vec).toContain("0.");
    } finally {
      server.stop();
    }
  });
});

describeIf("image space cross-modal search", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let redUrl = "";
  let blueUrl = "";

  beforeAll(async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        return new Response(Buffer.from([0xff, 0xd8, 0xff]), {
          headers: { "content-type": "image/jpeg" },
        });
      },
    });
    redUrl = `http://127.0.0.1:${server.port}/red.jpg`;
    blueUrl = `http://127.0.0.1:${server.port}/blue.jpg`;

    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async (req) => multimodalStub(req),
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [imageSpacesCollection],
    });
    schemaName = r.schema;

    await matcher.pushDocuments(projectSlug, "products", [
      { id: "red", data: { title: "neutral", image_url: redUrl } },
      { id: "blue", data: { title: "neutral", image_url: blueUrl } },
    ]);
    await matcher.index(projectSlug, "products");
  }, 60_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("visual-space weight flip reorders results", async () => {
    const lowVisual = await matcher.search(projectSlug, "products", {
      q: "red",
      limit: 2,
      weights: { fts: 0, spaces: { style: 1, visual: 0 } },
    });
    const highVisual = await matcher.search(projectSlug, "products", {
      q: "red",
      limit: 2,
      weights: { fts: 0, spaces: { style: 0, visual: 5 } },
    });
    expect(lowVisual.hits.map((h) => h.id)).not.toEqual(highVisual.hits.map((h) => h.id));
    expect(highVisual.hits[0]!.id).toBe("red");
  });
});

const capabilityCollection = collection("products", {
  fields: { title: f.text({ searchable: true }) },
  spaces: {
    visual: s.image({ source: "$image_url", model: "text-only-embed", dim: 8 }),
  },
  search: {
    channels: [Channels.spaces({ weight: 1 })],
    defaultSpaceWeights: { visual: 1 },
  },
});

describeIf("image embed capability error", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let imageUrl = "";
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(Buffer.from([0xff, 0xd8, 0xff]), {
          headers: { "content-type": "image/jpeg" },
        });
      },
    });
    imageUrl = `http://127.0.0.1:${server.port}/x.jpg`;

    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => {
        if (!text) throw new Error("text-only embedder");
        return stubEmbed(text, dim);
      },
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [capabilityCollection],
    });
    schemaName = r.schema;

    await matcher.pushDocuments(projectSlug, "products", [
      { id: "x", data: { title: "t", image_url: imageUrl } },
    ]);
  }, 30_000);

  afterAll(async () => {
    server?.stop();
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("lazy error names missing image embed capability", async () => {
    await expect(matcher.index(projectSlug, "products")).rejects.toThrow(/s\.image space/);
    await expect(matcher.index(projectSlug, "products")).rejects.toThrow(/embedContent/);
  });
});
