import { describe, expect, test } from "bun:test";
import type { IndexingDef, PipelineDef } from "@samesake/core";
import {
  enrich,
  enrichRow,
  deriveSurfaces,
  stageCacheKey,
  type EnrichConfig,
  type EnrichDeps,
  type RawRow,
} from "../src/index.ts";

const denseSurface = (build: (c: { data: Record<string, unknown>; enriched: Record<string, unknown> }) => string) =>
  ({ kind: "dense" as const, embedding: "default", build });

describe("enrich — pure transform", () => {
  test("(a) enrich([row], cfg, deps) returns one result with merged stage output, no DB", async () => {
    const cfg: EnrichConfig = {
      pipeline: {
        stages: [
          { name: "color", prompt: () => "what color?", schema: () => ({ type: "object" }) },
        ],
      },
      indexing: {
        surfaces: { doc: denseSurface((c) => String(c.enriched.color ?? "")) },
        gate: (c) => ({ index: Boolean(c.enriched.color) }),
      },
    };
    const rows: RawRow[] = [{ id: "r1", data: { title: "Shirt" } }];
    const deps: EnrichDeps = { generate: async () => ({ color: "red" }) };

    const res = await enrich(rows, cfg, deps);

    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe("r1");
    expect(res[0]!.ok).toBe(true);
    expect(res[0]!.enriched.color).toBe("red");
    expect((res[0]!.enriched._stages as Record<string, unknown>).color).toEqual({ color: "red" });
    expect(res[0]!.status).toBe("ready");
    expect(res[0]!.surfaces.doc).toBe("red");
    expect(res[0]!.surfaces.denseByEmbedding.default).toBe("red");
  });

  test("(a-ord) enrich preserves order across multiple rows", async () => {
    const cfg: EnrichConfig = {
      pipeline: { stages: [{ name: "n", prompt: () => "p", schema: () => ({ type: "object" }) }] },
      indexing: { surfaces: { doc: denseSurface((c) => String(c.enriched.n ?? "")) }, gate: () => ({ index: true }) },
    };
    const deps: EnrichDeps = {
      generate: async () => ({ n: "v" }),
    };
    const rows: RawRow[] = Array.from({ length: 20 }, (_, k) => ({ id: `r${k}`, data: {} }));
    const res = await enrich(rows, cfg, deps);
    expect(res.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  test("(b) deriveSurfaces parity — ready path full shape", () => {
    const indexing: IndexingDef = {
      surfaces: { doc: denseSurface(() => "Red Shirt") },
      gate: () => ({ index: true }),
    };
    const out = deriveSurfaces(indexing, { data: {}, enriched: { title: "Red Shirt" } });
    expect(out).toEqual({
      doc: "Red Shirt",
      denseByEmbedding: { default: "Red Shirt" },
      rerank_doc: null,
      fts_src: null,
      fts_src_a: null,
      pipeline_status: "ready",
      gate_reason: null,
    });
  });

  test("(b) deriveSurfaces parity — gate rejects", () => {
    const indexing: IndexingDef = {
      surfaces: { doc: denseSurface(() => "Red Shirt") },
      gate: () => ({ index: false, reason: "no-title" }),
    };
    const out = deriveSurfaces(indexing, { data: {}, enriched: {} });
    expect(out.pipeline_status).toBe("quarantined");
    expect(out.gate_reason).toBe("no-title");
    expect(out.doc).toBe("Red Shirt");
  });

  test("(b) deriveSurfaces parity — empty surface short-circuits", () => {
    const indexing: IndexingDef = {
      surfaces: { doc: denseSurface(() => "") },
      gate: () => ({ index: true }),
    };
    const out = deriveSurfaces(indexing, { data: {}, enriched: {} });
    expect(out.pipeline_status).toBe("quarantined");
    expect(out.gate_reason).toBe("empty:doc");
  });

  test("(b) deriveSurfaces parity — fts weight A/B + rerank routing", () => {
    const indexing: IndexingDef = {
      surfaces: {
        a: { kind: "fts", weight: "A", build: () => "alpha" },
        b: { kind: "fts", build: () => "beta" },
        r: { kind: "rerank", build: () => "rerank-text" },
      },
      gate: () => ({ index: true }),
    };
    const out = deriveSurfaces(indexing, { data: {}, enriched: {} });
    expect(out.fts_src_a).toBe("alpha");
    expect(out.fts_src).toBe("beta");
    expect(out.rerank_doc).toBe("rerank-text");
    expect(out.pipeline_status).toBe("ready");
  });

  test("(c) a generate that throws skips the stage — row still ok, stage absent from _stages", async () => {
    const cfg: EnrichConfig = {
      pipeline: {
        stages: [{ name: "throws", prompt: () => "p", schema: () => ({ type: "object" }) }],
      },
      indexing: {
        surfaces: { doc: denseSurface((c) => String(c.data.title ?? "")) },
        gate: (c) => ({ index: Boolean(c.data.title) }),
      },
    };
    const row: RawRow = { id: "r1", data: { title: "Shirt" } };
    let errored: unknown = null;
    const deps: EnrichDeps = {
      generate: async () => { throw new Error("boom"); },
      onError: (_r, e) => { errored = e; },
    };

    const res = await enrichRow(row, cfg, deps);

    expect(res.ok).toBe(true);
    expect(res.status).toBe("ready");
    expect(res.enriched._stages).toBeUndefined();
    expect(errored).toBeInstanceOf(Error);
    expect((errored as Error).message).toBe("boom");
  });

  test("(c') surface-derivation throw yields ok:false quarantined, surfaces empty", async () => {
    const cfg: EnrichConfig = {
      pipeline: { stages: [{ name: "s", prompt: () => "p", schema: () => ({ type: "object" }) }] },
      indexing: {
        surfaces: { doc: { kind: "dense", embedding: "default", build: () => { throw new Error("build-failed"); } } },
        gate: () => ({ index: true }),
      },
    };
    const row: RawRow = { id: "r1", data: {} };
    let errored = false;
    const res = await enrichRow(row, cfg, { generate: async () => ({ x: 1 }), onError: () => { errored = true; } });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("quarantined");
    expect(res.error).toContain("build-failed");
    expect(res.surfaces.doc).toBeNull();
    expect(errored).toBe(true);
  });

  test("stageCacheKey is byte-identical to the server formula", async () => {
    const key = stageCacheKey("color", "gemini-1.5", "what color?", ["http://x/a.png"], ["etag1"], { type: "object" });
    const urlMaterial = "http://x/a.png@etag1";
    const material = `what color?|${urlMaterial}|${JSON.stringify({ type: "object" })}`;
    const crypto = await import("node:crypto");
    const expectHash = crypto.createHash("sha1").update(material).digest("hex");
    expect(key).toBe(`stage:color:gemini-1.5:${expectHash}`);
  });

  test("(a-conc) 50 rows with a delayed stub preserve INPUT order despite completion order", async () => {
    const cfg: EnrichConfig = {
      pipeline: { stages: [{ name: "n", prompt: () => "p", schema: () => ({ type: "object" }) }] },
      indexing: { surfaces: { doc: denseSurface((c) => String(c.enriched.n ?? "")) }, gate: () => ({ index: true }) },
    };
    // Later rows resolve FIRST (delay shrinks with index), so completion order is the
    // reverse of input order — the pool must still return results indexed by input position.
    const deps: EnrichDeps = {
      concurrency: 8,
      generate: async (req) => {
        const i = Number((req.prompt.match(/\d+$/) ?? ["0"])[0]);
        await new Promise((r) => setTimeout(r, (50 - i) % 13));
        return { n: i };
      },
    };
    const rows: RawRow[] = Array.from({ length: 50 }, (_, k) => ({ id: `r${k}`, data: {} }));
    const cfgIdx: EnrichConfig = {
      pipeline: { stages: [{ name: "n", prompt: (c) => `row ${(c.data as { i: number }).i}`, schema: () => ({ type: "object" }) }] },
      indexing: cfg.indexing,
    };
    const rowsIdx: RawRow[] = rows.map((r, k) => ({ id: r.id, data: { i: k } }));
    const res = await enrich(rowsIdx, cfgIdx, deps);
    expect(res.map((r) => r.id)).toEqual(rowsIdx.map((r) => r.id));
    expect(res.every((r, k) => (r.enriched.n as number) === k)).toBe(true);
  });

  test("the pure core CANNOT reach a database — no db dependency, runs on stubs alone", async () => {
    // The whole point of the extraction: the moat is exercised with no DB, no network.
    // Structural proof (env-independent): @samesake/enrich declares no database
    // dependency, so it physically cannot open a connection.
    const { default: pkg } = await import("../package.json");
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps.some((d) => /postgres|drizzle|pg|lancedb|sqlite|mysql|mongo/i.test(d))).toBe(false);
    // Behavioural proof: the core runs to a result with only stub closures — no store, no handle.
    const cfg: EnrichConfig = {
      pipeline: { stages: [{ name: "n", prompt: () => "p", schema: () => ({ type: "object" }) }] },
      indexing: { surfaces: { doc: denseSurface(() => "doc") }, gate: () => ({ index: true }) },
    };
    const out = await enrichRow({ id: "x", data: {} }, cfg, { generate: async () => ({ n: 1 }) });
    expect(out.ok).toBe(true);
  });
});
