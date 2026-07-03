import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels } from "@samesake/core";
import type { CollectionDedupDef } from "@samesake/core";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { scoreBest, type DedupCandidate } from "../src/core/dedup.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function hashEmbed(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) v[hash(tok) % dim]! += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

// ── Pure scoring unit tests (no DB) ──────────────────────────────────────
describe("dedup scoreBest (unit)", () => {
  const cand = (over: Partial<DedupCandidate> = {}): DedupCandidate => ({
    id: "c",
    group: null,
    fields: {},
    trgm: {},
    cos: null,
    ...over,
  });

  test("weighted sum normalized by total weight", () => {
    const cfg: CollectionDedupDef = {
      channels: [
        { kind: "trigram", field: "title", weight: 1 },
        { kind: "cosine", weight: 1 },
      ],
      autoLink: 0.9,
      offerFields: [],
    };
    const best = scoreBest(cfg, {}, [cand({ trgm: { title: 0.8 }, cos: 0.6 })]);
    expect(best!.score).toBeCloseTo(0.7, 6);
  });

  test("unequal weights normalize correctly", () => {
    const cfg: CollectionDedupDef = {
      channels: [
        { kind: "trigram", field: "title", weight: 3 },
        { kind: "cosine", weight: 1 },
      ],
      autoLink: 0.9,
      offerFields: [],
    };
    const best = scoreBest(cfg, {}, [cand({ trgm: { title: 1 }, cos: 0 })]);
    expect(best!.score).toBeCloseTo(0.75, 6);
  });

  test("exactKey equality short-circuits to 1.0 regardless of weak channels", () => {
    const cfg: CollectionDedupDef = {
      channels: [
        { kind: "exactKey", field: "mpn" },
        { kind: "trigram", field: "title", weight: 1 },
      ],
      autoLink: 0.9,
      offerFields: [],
    };
    const best = scoreBest(cfg, { mpn: "SKU-1" }, [cand({ fields: { mpn: "SKU-1" }, trgm: { title: 0 } })]);
    expect(best!.score).toBe(1.0);
  });

  test("empty / null exactKey value never matches", () => {
    const cfg: CollectionDedupDef = {
      channels: [
        { kind: "exactKey", field: "mpn" },
        { kind: "trigram", field: "title", weight: 1 },
      ],
      autoLink: 0.9,
      offerFields: [],
    };
    expect(scoreBest(cfg, { mpn: "" }, [cand({ fields: { mpn: "" }, trgm: { title: 0.2 } })])!.score).toBeCloseTo(
      0.2,
      6
    );
    expect(
      scoreBest(cfg, { mpn: null }, [cand({ fields: { mpn: null }, trgm: { title: 0.2 } })])!.score
    ).toBeCloseTo(0.2, 6);
  });

  test("picks the highest-scoring candidate; null on empty", () => {
    const cfg: CollectionDedupDef = {
      channels: [{ kind: "cosine", weight: 1 }],
      autoLink: 0.9,
      offerFields: [],
    };
    const best = scoreBest(cfg, {}, [cand({ id: "a", cos: 0.3 }), cand({ id: "b", cos: 0.9 })]);
    expect(best!.cand.id).toBe("b");
    expect(best!.score).toBeCloseTo(0.9, 6);
    expect(scoreBest(cfg, {}, [])).toBeNull();
  });
});

// ── Integration: clustering ──────────────────────────────────────────────
function makeListings(scopes?: string[]) {
  return collection("listings", {
    ...(scopes ? { scopes } : {}),
    fields: {
      title: f.text({ searchable: true }),
      mpn: f.text({ filterable: true }),
      vendor: f.text({ filterable: true }),
      price: f.number({ filterable: true }),
    },
    embeddings: { doc: { source: "$title", model: "stub", dim: 64 } },
    search: {
      channels: [Channels.fts({ fields: ["title"], weight: 1 }), Channels.cosine({ embedding: "doc", weight: 1 })],
      combiner: "rrf",
    },
    dedup: {
      channels: [
        { kind: "exactKey", field: "mpn" },
        { kind: "trigram", field: "title", weight: 1 },
        { kind: "cosine", weight: 1 },
      ],
      autoLink: 0.7,
      suggest: 0.4,
      offerFields: ["vendor", "price"],
    },
  });
}

describeIf("dedup clustering (integration)", () => {
  const projectSlug = `d_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  const listings = makeListings();

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "dedup-test-key",
      migrate: "eager",
      embed: async ({ text, dim }) => hashEmbed(text ?? "", dim),
    });
    await matcher.migrate();
    const applied = await matcher.apply(projectSlug, { entities: [], collections: [listings] });
    schemaName = applied.schema;

    // Three vendors list the same physical product (equal mpn, messy titles);
    // a genuinely different product carries a different mpn + disjoint tokens.
    await matcher.pushDocuments(projectSlug, "listings", [
      { id: "a", data: { title: "Silicone Case iPhone 15 Black", mpn: "SC-IP15-BLK", vendor: "AStore", price: 12 } },
      { id: "b", data: { title: "iPhone 15 Silicone Case - Black", mpn: "SC-IP15-BLK", vendor: "BShop", price: 10 } },
      { id: "c", data: { title: "Black Silicone Case for iPhone 15", mpn: "SC-IP15-BLK", vendor: "CMart", price: 15 } },
      { id: "d", data: { title: "Wireless Earbuds Pro White", mpn: "WEB-PRO-WHT", vendor: "AStore", price: 80 } },
    ]);
    const { indexed } = await matcher.index(projectSlug, "listings");
    expect(indexed).toBe(4);
  }, 120000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    await matcher.close();
  });

  test("apply created cluster columns + suggestions table (DDL)", async () => {
    const { db, close } = createDbFromUrl(databaseUrl!);
    try {
      const cols = (await db.execute(
        sql.raw(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = '${schemaName}' AND table_name = 'c_listings'
             AND column_name IN ('product_group','dedup_score','dedup_checked_at')`
        )
      )) as unknown as Array<Record<string, unknown>>;
      const names = new Set((cols as Array<{ column_name: string }>).map((r) => r.column_name));
      expect(names.has("product_group")).toBe(true);
      expect(names.has("dedup_score")).toBe(true);
      expect(names.has("dedup_checked_at")).toBe(true);

      const tbl = (await db.execute(
        sql.raw(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = '${schemaName}' AND table_name = 'c_listings_dedup_suggestions'`
        )
      )) as unknown as Array<Record<string, unknown>>;
      expect(tbl.length).toBe(1);
    } finally {
      await close();
    }
  });

  test("3 vendors of the same product cluster into one; distinct product stays separate", async () => {
    const res = await matcher.dedup(projectSlug, "listings");
    expect(res.processed).toBeGreaterThan(0);

    const { clusters } = await matcher.dedupClusters(projectSlug, "listings", { minMembers: 2 });
    expect(clusters.length).toBe(1);
    const members = new Set(clusters[0]!.members.map((m) => String(m.id)));
    expect(members).toEqual(new Set(["a", "b", "c"]));
    // the distinct product founded its own single-member cluster (not in a >=2 cluster)
    expect(members.has("d")).toBe(false);
  });

  test("re-running dedup with no new rows is a no-op", async () => {
    const res = await matcher.dedup(projectSlug, "listings");
    expect(res.processed).toBe(0);
    const { clusters } = await matcher.dedupClusters(projectSlug, "listings", { minMembers: 2 });
    expect(clusters.length).toBe(1);
    expect(new Set(clusters[0]!.members.map((m) => String(m.id)))).toEqual(new Set(["a", "b", "c"]));
  });

  test("search collapses the cluster to one hit carrying offers (declared fields only)", async () => {
    const res = await matcher.search(projectSlug, "listings", { q: "Silicone Case iPhone 15 Black", limit: 10 });
    // one physical product → one hit
    expect(res.hits.length).toBe(1);
    const hit = res.hits[0]!;
    expect(hit.offers).toBeDefined();
    expect(hit.offers!.length).toBe(3);
    expect(new Set(hit.offers!.map((o) => String(o.id)))).toEqual(new Set(["a", "b", "c"]));
    // offers carry ONLY id + declared offerFields (vendor, price) — never raw data / mpn
    for (const o of hit.offers!) {
      expect(Object.keys(o).sort()).toEqual(["id", "price", "vendor"]);
    }
  });

  test("quarantined member drops out of offers", async () => {
    const { db, close } = createDbFromUrl(databaseUrl!);
    try {
      await db.execute(sql.raw(`UPDATE ${schemaName}.c_listings SET pipeline_status='quarantined' WHERE id='c'`));
      const res = await matcher.search(projectSlug, "listings", { q: "Silicone Case iPhone 15 Black", limit: 10 });
      const hit = res.hits[0]!;
      expect(hit.offers!.length).toBe(2);
      expect(new Set(hit.offers!.map((o) => String(o.id)))).toEqual(new Set(["a", "b"]));
    } finally {
      // restore so later assertions see the full cluster
      await db.execute(sql.raw(`UPDATE ${schemaName}.c_listings SET pipeline_status='ready' WHERE id='c'`));
      await close();
    }
  });

  test("offers:false skips attachment", async () => {
    const res = await matcher.search(projectSlug, "listings", {
      q: "Silicone Case iPhone 15 Black",
      limit: 10,
      offers: false,
    });
    expect(res.hits[0]!.offers).toBeUndefined();
  });
});

// ── Integration: suggest → confirm → split lifecycle + decline memory ──────
function makeReviewListings() {
  return collection("rlistings", {
    fields: {
      title: f.text({ searchable: true }),
      vendor: f.text({ filterable: true }),
    },
    embeddings: { doc: { source: "$title", model: "stub", dim: 64 } },
    search: {
      channels: [Channels.fts({ fields: ["title"], weight: 1 }), Channels.cosine({ embedding: "doc", weight: 1 })],
      combiner: "rrf",
    },
    dedup: {
      // cosine-only: two docs sharing exactly half their (distinct) tokens → cosine 0.5,
      // which lands in [suggest=0.4, autoLink=0.9) — a suggestion, never an auto-link.
      channels: [{ kind: "cosine", weight: 1 }],
      autoLink: 0.9,
      suggest: 0.4,
      offerFields: ["vendor"],
    },
  });
}

describeIf("dedup review lifecycle (integration)", () => {
  const projectSlug = `r_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  // The declined direction, discovered from the first run's suggestions.
  let pairId = "";
  let pairGroup = "";

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "dedup-review-key",
      migrate: "eager",
      embed: async ({ text, dim }) => hashEmbed(text ?? "", dim),
    });
    await matcher.migrate();
    const applied = await matcher.apply(projectSlug, { entities: [], collections: [makeReviewListings()] });
    schemaName = applied.schema;
    await matcher.pushDocuments(projectSlug, "rlistings", [
      { id: "x", data: { title: "alpha bravo charlie delta", vendor: "XV" } },
      { id: "y", data: { title: "alpha bravo echo foxtrot", vendor: "YV" } },
      { id: "z", data: { title: "zulu yankee xray whiskey", vendor: "ZV" } },
    ]);
    const { indexed } = await matcher.index(projectSlug, "rlistings");
    expect(indexed).toBe(3);
  }, 120000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    await matcher.close();
  });

  test("a suggest-band pair is queued, not auto-linked", async () => {
    const run = await matcher.dedup(projectSlug, "rlistings");
    expect(run.autoLinked).toBe(0); // 0.5 < autoLink 0.9
    expect(run.suggested).toBeGreaterThanOrEqual(1);

    const { suggestions } = await matcher.dedupSuggestions(projectSlug, "rlistings");
    const s = suggestions.find((s) => new Set([s.id, s.candidateGroup]).size === 2 && ["x", "y"].includes(s.id));
    expect(s).toBeDefined();
    pairId = s!.id;
    pairGroup = s!.candidateGroup;
    // suggested rows still found their own cluster → no >=2 cluster yet
    const { clusters } = await matcher.dedupClusters(projectSlug, "rlistings", { minMembers: 2 });
    expect(clusters.length).toBe(0);
  });

  test("confirmGroup merges the pair (search returns one hit)", async () => {
    await matcher.confirmGroup(projectSlug, "rlistings", { id: pairId, group: pairGroup });
    const res = await matcher.search(projectSlug, "rlistings", { q: "alpha bravo", limit: 10 });
    expect(res.hits.length).toBe(1);
    expect(res.hits[0]!.offers!.length).toBe(2);
  });

  test("splitGroup evicts the row into a fresh cluster", async () => {
    const s = await matcher.splitGroup(projectSlug, "rlistings", { id: pairId });
    expect(s.group).toBe(pairId);
    const res = await matcher.search(projectSlug, "rlistings", { q: "alpha bravo", limit: 10 });
    expect(res.hits.length).toBe(2); // x and y are separate again
  });

  test("decline memory survives a rebuild: the split pair is not re-linked or re-suggested", async () => {
    await matcher.dedup(projectSlug, "rlistings", { rebuild: true });
    const { suggestions } = await matcher.dedupSuggestions(projectSlug, "rlistings");
    // the declined direction must NOT reappear
    expect(suggestions.some((s) => s.id === pairId && s.candidateGroup === pairGroup)).toBe(false);
    // and the pair must not have been auto-merged
    const { clusters } = await matcher.dedupClusters(projectSlug, "rlistings", { minMembers: 2 });
    expect(clusters.length).toBe(0);
  });
});

// ── Tenancy wall: clusters must never span scopes ─────────────────────────
describeIf("dedup cross-scope isolation", () => {
  const projectSlug = `s_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "dedup-scope-key",
      migrate: "eager",
      embed: async ({ text, dim }) => hashEmbed(text ?? "", dim),
    });
    await matcher.migrate();
    const applied = await matcher.apply(projectSlug, {
      entities: [],
      collections: [makeListings(["tenant_id"])],
    });
    schemaName = applied.schema;
    // Adversarial: two tenants carry BYTE-IDENTICAL listings (same titles, same mpn) —
    // only the scope separates them. They must NEVER cluster together.
    const rows = (t: string) => [
      { id: `${t}a`, scope: { tenant_id: t }, data: { title: "Silicone Case iPhone 15 Black", mpn: "SC-IP15-BLK", vendor: "AStore", price: 12 } },
      { id: `${t}b`, scope: { tenant_id: t }, data: { title: "iPhone 15 Silicone Case - Black", mpn: "SC-IP15-BLK", vendor: "BShop", price: 10 } },
      { id: `${t}c`, scope: { tenant_id: t }, data: { title: "Black Silicone Case for iPhone 15", mpn: "SC-IP15-BLK", vendor: "CMart", price: 15 } },
    ];
    await matcher.pushDocuments(projectSlug, "listings", [...rows("v1"), ...rows("v2")]);
    const { indexed } = await matcher.index(projectSlug, "listings");
    expect(indexed).toBe(6);
  }, 120000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    await matcher.close();
  });

  test("identical listings in two scopes form two clusters, never one", async () => {
    await matcher.dedup(projectSlug, "listings");

    const v1 = await matcher.dedupClusters(projectSlug, "listings", { scope: { tenant_id: "v1" }, minMembers: 2 });
    const v2 = await matcher.dedupClusters(projectSlug, "listings", { scope: { tenant_id: "v2" }, minMembers: 2 });
    expect(v1.clusters.length).toBe(1);
    expect(v2.clusters.length).toBe(1);
    expect(new Set(v1.clusters[0]!.members.map((m) => String(m.id)))).toEqual(new Set(["v1a", "v1b", "v1c"]));
    expect(new Set(v2.clusters[0]!.members.map((m) => String(m.id)))).toEqual(new Set(["v2a", "v2b", "v2c"]));
    // the two cluster ids are distinct — no shared leader across scopes
    expect(v1.clusters[0]!.group).not.toBe(v2.clusters[0]!.group);

    // hard proof at the row level: no product_group holds rows from both scopes
    const { db, close } = createDbFromUrl(databaseUrl!);
    try {
      const rows = (await db.execute(
        sql.raw(
          `SELECT product_group, count(DISTINCT scope_tenant_id) AS scopes
           FROM ${schemaName}.c_listings WHERE product_group IS NOT NULL GROUP BY product_group`
        )
      )) as unknown as Array<{ scopes: number | string }>;
      for (const r of rows) expect(Number(r.scopes)).toBe(1);
    } finally {
      await close();
    }
  });

  test("dedupClusters without scope on a scoped collection is rejected", async () => {
    await expect(matcher.dedupClusters(projectSlug, "listings", {})).rejects.toThrow(/requires scope\.tenant_id/);
  });
});

// ── HTTP surface: run → suggestions → confirm → clusters → split ───────────
describeIf("dedup HTTP routes", () => {
  const projectSlug = `h_${Math.random().toString(36).slice(2, 10)}`;
  const KEY = "dedup-http-key";
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  const base = `http://localhost/v1/projects/${projectSlug}/collections/rlistings`;
  const auth = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: KEY,
      migrate: "eager",
      embed: async ({ text, dim }) => hashEmbed(text ?? "", dim),
    });
    await matcher.migrate();
    const applied = await matcher.apply(projectSlug, { entities: [], collections: [makeReviewListings()] });
    schemaName = applied.schema;
    await matcher.pushDocuments(projectSlug, "rlistings", [
      { id: "p", data: { title: "alpha bravo charlie delta", vendor: "PV" } },
      { id: "q", data: { title: "alpha bravo echo foxtrot", vendor: "QV" } },
    ]);
    await matcher.index(projectSlug, "rlistings");
  }, 120000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    await matcher.close();
  });

  test("routes require auth", async () => {
    const res = await matcher.fetch(new Request(`${base}/dedup`, { method: "POST" }));
    expect(res.ok).toBe(false);
  });

  test("run → suggestions → confirm → clusters → split over HTTP", async () => {
    const run = await matcher.fetch(new Request(`${base}/dedup`, { method: "POST", headers: auth, body: "{}" }));
    expect(run.ok).toBe(true);

    const sugRes = await matcher.fetch(new Request(`${base}/dedup/suggestions`, { headers: auth }));
    const { suggestions } = (await sugRes.json()) as {
      suggestions: Array<{ id: string; candidateGroup: string; score: number }>;
    };
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    const s = suggestions[0]!;

    const confirm = await matcher.fetch(
      new Request(`${base}/dedup/confirm`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ id: s.id, group: s.candidateGroup }),
      })
    );
    expect(confirm.ok).toBe(true);

    const clRes = await matcher.fetch(new Request(`${base}/dedup/clusters?minMembers=2`, { headers: auth }));
    const { clusters } = (await clRes.json()) as { clusters: Array<{ group: string; members: unknown[] }> };
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.members.length).toBe(2);

    const split = await matcher.fetch(
      new Request(`${base}/dedup/split`, { method: "POST", headers: auth, body: JSON.stringify({ id: s.id }) })
    );
    expect(split.ok).toBe(true);
    const { group } = (await split.json()) as { group: string };
    expect(group).toBe(s.id);
  });
});

// ── Decline durability (autoLink band) + leader split ─────────────────────
// Regression for the review's Blocker 1 (directional decline re-merges on rebuild) and
// Major 2 (splitting a cluster leader was a silent no-op that recorded no decline).
describeIf("dedup split decline durability", () => {
  const projectSlug = `sd_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let conn: ReturnType<typeof createDbFromUrl>;

  beforeAll(async () => {
    conn = createDbFromUrl(databaseUrl!);
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "dedup-split-key",
      migrate: "eager",
      embed: async ({ text, dim }) => hashEmbed(text ?? "", dim),
    });
    await matcher.migrate();
    const applied = await matcher.apply(projectSlug, { entities: [], collections: [makeListings()] });
    schemaName = applied.schema;
    await matcher.pushDocuments(projectSlug, "listings", [
      // a 2-vendor pair (auto-links on equal mpn) — the Blocker-1 repro
      { id: "p1", data: { title: "Widget A", mpn: "PAIR-1", vendor: "V1", price: 5 } },
      { id: "p2", data: { title: "Widget A alt", mpn: "PAIR-1", vendor: "V2", price: 6 } },
      // a 3-vendor cluster (auto-links on equal mpn) — the leader-split repro
      { id: "t1", data: { title: "Gadget B", mpn: "TRIO-1", vendor: "V1", price: 9 } },
      { id: "t2", data: { title: "Gadget B alt", mpn: "TRIO-1", vendor: "V2", price: 8 } },
      { id: "t3", data: { title: "Gadget B variant", mpn: "TRIO-1", vendor: "V3", price: 7 } },
    ]);
    const { indexed } = await matcher.index(projectSlug, "listings");
    expect(indexed).toBe(5);
    await matcher.dedup(projectSlug, "listings");
  }, 120000);

  afterAll(async () => {
    if (schemaName) {
      await conn.db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
    }
    await conn.close();
    await matcher.close();
  });

  async function groupOf(id: string): Promise<string | null> {
    const rows = (await conn.db.execute(
      sql.raw(`SELECT product_group FROM ${schemaName}.c_listings WHERE id='${id}'`)
    )) as unknown as Array<{ product_group: string | null }>;
    return rows[0]?.product_group ?? null;
  }

  test("BLOCKER-1: a split auto-link pair is NOT re-merged on rebuild (either direction)", async () => {
    // p1,p2 auto-linked into one cluster
    expect(await groupOf("p1")).toBe(await groupOf("p2"));
    // split p1 out and record the decline
    await matcher.splitGroup(projectSlug, "listings", { id: "p1" });
    expect(await groupOf("p1")).not.toBe(await groupOf("p2"));
    // rebuild re-clusters from scratch — the decline must hold regardless of leader order
    await matcher.dedup(projectSlug, "listings", { rebuild: true });
    expect(await groupOf("p1")).not.toBe(await groupOf("p2"));
  }, 30000);

  test("MAJOR-2: splitting the cluster LEADER separates it and the decline survives rebuild", async () => {
    const { clusters } = await matcher.dedupClusters(projectSlug, "listings", { minMembers: 2 });
    const trio = clusters.find((c) => c.members.some((m) => String(m.id).startsWith("t")))!;
    const leader = trio.group; // group value == the leader row's id
    expect(["t1", "t2", "t3"]).toContain(leader);

    // split the leader — it must actually leave the cluster (not a no-op)
    await matcher.splitGroup(projectSlug, "listings", { id: leader });
    const leaderGroupAfter = await groupOf(leader);
    const others = ["t1", "t2", "t3"].filter((x) => x !== leader);
    const othersGroup = await groupOf(others[0]!);
    expect(await groupOf(others[1]!)).toBe(othersGroup); // the two remaining stay together
    expect(leaderGroupAfter).not.toBe(othersGroup); // the leader is separated

    // rebuild: the ex-leader must not re-merge with ANY former co-member
    await matcher.dedup(projectSlug, "listings", { rebuild: true });
    const lg = await groupOf(leader);
    expect(lg).not.toBe(await groupOf(others[0]!));
    expect(lg).not.toBe(await groupOf(others[1]!));
  }, 30000);
});
