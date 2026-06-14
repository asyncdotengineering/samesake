import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { EmbedRequest } from "../src/types.ts";
import { collection, f, Channels, s } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { fetchRemoteImageSafe, __setImageTransport } from "../src/core/fetch-image.ts";
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

function mockFetch(responseFor: (url: string) => Response) {
  __setImageTransport(async ({ url }) => {
    const res = responseFor(url.href);
    const headers: Record<string, string | undefined> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    async function* body() {
      if (buf.byteLength) yield buf;
    }
    return { status: res.status, headers, body: body() };
  });
  return () => __setImageTransport(null);
}

const publicResolve = async () => ["93.184.216.34"];

describe("fetchRemoteImageSafe", () => {
  test("rejects non-http schemes", async () => {
    const got = await fetchRemoteImageSafe("file:///etc/passwd");
    expect(got).toEqual({ ok: false, reason: "invalid_url", finalUrl: "file:///etc/passwd" });
  });

  test("rejects localhost, loopback, private, link-local, and metadata destinations", async () => {
    for (const url of [
      "http://localhost/x.png",
      "http://127.0.0.1/x.png",
      "http://10.0.0.2/x.png",
      "http://192.168.1.10/x.png",
      "http://172.16.0.4/x.png",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      const got = await fetchRemoteImageSafe(url);
      expect(got.ok).toBe(false);
      if (!got.ok) expect(got.reason).toBe("blocked_destination");
    }
  });

  test("rejects non-image content-type", async () => {
    const restore = mockFetch(() =>
      new Response("not an image", {
        headers: { "content-type": "text/plain" },
      })
    );
    try {
      const got = await fetchRemoteImageSafe("https://example.com/x", {
        resolveHostname: publicResolve,
      });
      expect(got.ok).toBe(false);
      if (!got.ok) expect(got.reason).toBe("unsupported_content_type");
    } finally {
      restore();
    }
  });

  test("rejects oversized responses before unbounded buffering", async () => {
    const restore = mockFetch(() =>
      new Response("x", {
        headers: { "content-type": "image/png", "content-length": "10" },
      })
    );
    try {
      const got = await fetchRemoteImageSafe("https://example.com/huge.png", {
        maxBytes: 4,
        resolveHostname: publicResolve,
      });
      expect(got.ok).toBe(false);
      if (!got.ok) expect(got.reason).toBe("too_large");
    } finally {
      restore();
    }
  });

  test("rejects redirect to private destination", async () => {
    const restore = mockFetch(() =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private.png" },
      })
    );
    try {
      const got = await fetchRemoteImageSafe("https://example.com/redirect.png", {
        resolveHostname: publicResolve,
      });
      expect(got.ok).toBe(false);
      if (!got.ok) expect(got.reason).toBe("blocked_destination");
    } finally {
      restore();
    }
  });

  test("returns bytes for tiny public image response", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    const restore = mockFetch(() => new Response(png, { headers: { "content-type": "image/png" } }));
    try {
      const got = await fetchRemoteImageSafe("https://example.com/ok.png", {
        resolveHostname: publicResolve,
      });
      expect(got.ok).toBe(true);
      if (got.ok) {
        expect(got.contentType).toBe("image/png");
        expect(got.bytes.length).toBeGreaterThan(0);
      }
    } finally {
      restore();
    }
  });

  test("pins the validated IP for the connection (no second resolution)", async () => {
    let seenPins: string[] = [];
    const got = await fetchRemoteImageSafe("https://cdn.example.com/ok.png", {
      resolveHostname: async () => ["93.184.216.34"],
      transport: async ({ pinnedIps }) => {
        seenPins = pinnedIps;
        async function* body() {
          yield new Uint8Array([1, 2, 3]);
        }
        return { status: 200, headers: { "content-type": "image/png" }, body: body() };
      },
    });
    expect(got.ok).toBe(true);
    expect(seenPins).toEqual(["93.184.216.34"]);
  });

  test("blocks NAT64-embedded metadata address before connecting", async () => {
    const got = await fetchRemoteImageSafe("https://evil.example/x.png", {
      resolveHostname: async () => ["64:ff9b::a9fe:a9fe"], // 169.254.169.254
      transport: async () => {
        throw new Error("transport must not be reached for a blocked destination");
      },
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("blocked_destination");
  });

  test("blocks hex-form IPv4-mapped loopback", async () => {
    const got = await fetchRemoteImageSafe("https://evil.example/x.png", {
      resolveHostname: async () => ["::ffff:7f00:1"], // 127.0.0.1
      transport: async () => {
        throw new Error("transport must not be reached for a blocked destination");
      },
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("blocked_destination");
  });

  test("accepts image/avif", async () => {
    const got = await fetchRemoteImageSafe("https://cdn.example.com/x.avif", {
      resolveHostname: async () => ["93.184.216.34"],
      transport: async () => {
        async function* body() {
          yield new Uint8Array([1, 2, 3]);
        }
        return { status: 200, headers: { "content-type": "image/avif" }, body: body() };
      },
    });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.contentType).toBe("image/avif");
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
    const restore = mockFetch(() =>
      new Response(Buffer.from([0xff, 0xd8, 0xff]), {
        headers: { "content-type": "image/jpeg" },
      })
    );
    try {
      const url = "https://example.com/red.jpg";
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
      restore();
    }
  });
});

describeIf("image space cross-modal search", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  const redUrl = "https://example.com/red.jpg";
  const blueUrl = "https://example.com/blue.jpg";
  let restoreFetch: (() => void) | null = null;

  beforeAll(async () => {
    restoreFetch = mockFetch(() =>
      new Response(Buffer.from([0xff, 0xd8, 0xff]), {
        headers: { "content-type": "image/jpeg" },
      })
    );

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
    restoreFetch?.();
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
  const imageUrl = "https://example.com/x.jpg";
  let restoreFetch: (() => void) | null = null;

  beforeAll(async () => {
    restoreFetch = mockFetch(() =>
      new Response(Buffer.from([0xff, 0xd8, 0xff]), {
        headers: { "content-type": "image/jpeg" },
      })
    );

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
    restoreFetch?.();
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
