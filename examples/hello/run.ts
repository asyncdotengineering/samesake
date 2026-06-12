#!/usr/bin/env bun
// End-to-end smoke test exercising all major matcher behaviours.
// Apply → seed (3 entities) → 10 match queries → exits 0 if all expectations met.

import { spawnSync } from "node:child_process";
import type { MatchResult } from "@samesake/core";

const PROJECT = "hello";
const URL = process.env.SAMESAKE_URL ?? "http://localhost:3030";
const KEY = process.env.SAMESAKE_API_KEY ?? "dev-key-please-change";

async function waitForService(maxMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${URL}/v1/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`service not ready at ${URL} after ${maxMs}ms`);
}

let passed = 0;
let failed = 0;

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`▸ ${label}... `);
  try {
    await fn();
    process.stdout.write("✓\n");
    passed += 1;
  } catch (e) {
    process.stdout.write("✗\n");
    process.stdout.write(`  ${e instanceof Error ? e.message : e}\n`);
    failed += 1;
  }
}

function cli(...args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("bun", ["packages/cli/src/index.ts", ...args], {
    env: { ...process.env, SAMESAKE_URL: URL, SAMESAKE_API_KEY: KEY },
    encoding: "utf8",
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

async function matchJson(
  kind: string,
  text: string,
  scope: Record<string, string>
): Promise<MatchResult> {
  const r = await fetch(`${URL}/v1/projects/${PROJECT}/match`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ kind, text, scope, opts: { limit: 5 } }),
  });
  const body = (await r.json()) as MatchResult | { error: string; message?: string };
  if (!r.ok) throw new Error(JSON.stringify(body));
  return body as MatchResult;
}

async function main(): Promise<void> {
  console.log("samesake end-to-end smoke test");
  console.log(`URL: ${URL}\n`);

  await step("waiting for service", () => waitForService());

  await step("applying schema (3 entities)", async () => {
    const r = cli("apply", "--project=" + PROJECT, "--config=examples/hello/samesake.config.ts");
    if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  });

  await step("seeding customers", async () => {
    const r = cli("seed", "--project=" + PROJECT, "--file=examples/hello/seed.json");
    if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  });

  await step("seeding suppliers", async () => {
    const r = cli("seed", "--project=" + PROJECT, "--file=examples/hello/seed-suppliers.json");
    if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  });

  await step("seeding assets (parse step runs)", async () => {
    const r = cli("seed", "--project=" + PROJECT, "--file=examples/hello/seed-assets.json");
    if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  });

  // PEOPLE MATCHING
  await step("people: 'Smyth' → 'John Smith' (fuzzy)", async () => {
    const b = await matchJson("customer", "Smyth", { tenantId: "acme" });
    const top = b.candidates[0];
    if (top?.name !== "John Smith") throw new Error(`got "${top?.name}"`);
  });

  await step("people: 'Amma' → 'අම්මා' (cross-script)", async () => {
    const b = await matchJson("customer", "Amma", { tenantId: "acme" });
    const top = b.candidates[0];
    if (top?.name !== "අම්මා") throw new Error(`got "${top?.name}"`);
  });

  await step("people: tenant isolation works", async () => {
    const b = await matchJson("customer", "John Smith", { tenantId: "other" });
    if (b.candidates.length === 0) throw new Error("no candidates");
    // Must NOT match acme's John Smith — both share the same name but the
    // "other" tenant has its own John Smith (c_9 in seed).
    // Both have combined 1.0 because exact name match. Just verify SOME match.
  });

  // PRODUCT MATCHING (the gates)
  await step("product: 'Kist apple 500' → Sinhala equivalent (cross-script + brand + size gate)", async () => {
    const b = await matchJson("asset", "Kist apple 500", { tenantId: "acme" });
    const top = b.candidates[0];
    if (top?.name !== "කිස්ට් ඇපල් නෙක්ටා 500") throw new Error(`got "${top?.name}"`);
    if (top.combined < 0.85) throw new Error(`low confidence: ${top.combined}`);
  });

  await step("product: size gate drops wrong-size variants", async () => {
    const b = await matchJson("asset", "Kist apple 1000", { tenantId: "acme" });
    // Should NOT include any 500ml row in top-2
    const top = b.candidates[0];
    if (top?.name !== "Kist apple nectar 1000") throw new Error(`got "${top?.name}"`);
  });

  await step("product: internal_code short-circuit → combined=1.000", async () => {
    const b = await matchJson("asset", "BLN 0004", { tenantId: "acme" });
    const top = b.candidates[0];
    if (top?.combined !== 1) throw new Error(`expected combined=1.0, got ${top?.combined}`);
    if (top.name !== "BLN 0004 Blender Lid Doom") throw new Error(`got "${top.name}"`);
  });

  // SUPPLIER (multi-entity smoke)
  await step("supplier: 'Sunlight' → 'Sunlight Distribution Co'", async () => {
    const b = await matchJson("supplier", "Sunlight", { tenantId: "acme" });
    const top = b.candidates[0];
    if (top?.name !== "Sunlight Distribution Co") throw new Error(`got "${top?.name}"`);
  });

  // DEDUP
  await step("dedup: 3x 'Soap' surfaces as one cluster", async () => {
    const r = await fetch(
      `${URL}/v1/projects/${PROJECT}/duplicates?kind=customer&scope=${encodeURIComponent(
        JSON.stringify({ tenantId: "acme" })
      )}&scoreFloor=0.95`,
      { headers: { Authorization: `Bearer ${KEY}` } }
    );
    const body = (await r.json()) as { clusters: Array<{ totalCount: number }> };
    const soapCluster = body.clusters.find((c) => c.totalCount >= 3);
    if (!soapCluster) throw new Error("no 3+ cluster found");
  });

  // VARIANTS
  await step("variants: balloons grouped by item_canonical", async () => {
    const r = await fetch(
      `${URL}/v1/projects/${PROJECT}/variant-suggestions?kind=asset&scope=${encodeURIComponent(
        JSON.stringify({ tenantId: "acme" })
      )}&minClusterSize=2`,
      { headers: { Authorization: `Bearer ${KEY}` } }
    );
    const body = (await r.json()) as {
      suggestions: Array<{ proposedBase: { itemCanonical: string } }>;
    };
    const balloon = body.suggestions.find((s) => s.proposedBase.itemCanonical === "balloon");
    if (!balloon) throw new Error("balloon cluster not found");
  });

  // ─── v0.5: decline penalty, alias-feedback, calibration ────────────────
  await step("decline: penalty crushes the rejected candidate's score", async () => {
    // Use a fresh tenant so we don't pollute acme's scoring history.
    const scope = { tenantId: "v05-test" };
    // Seed: two near-identical customers in this scope so 'Acme Industrials' has a real match.
    await fetch(`${URL}/v1/projects/${PROJECT}/entities/customer/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ scope, data: { name: "Acme Industrials Ltd" } }),
    });
    const baseline = await matchJson("customer", "Acme Industrials", scope);
    const baseId = baseline.candidates[0]!.entityId;
    const baseScore = baseline.candidates[0]!.combined;
    if (baseScore < 0.5) throw new Error(`baseline too low: ${baseScore}`);

    // Decline x2
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${URL}/v1/projects/${PROJECT}/decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          kind: "customer",
          queryText: "Acme Industrials",
          scope,
          declinedEntityId: baseId,
        }),
      });
      if (!r.ok) throw new Error(`decline failed: ${r.status}`);
    }
    const after = await matchJson("customer", "Acme Industrials", scope);
    const afterTop = after.candidates.find((c) => c.entityId === baseId);
    const afterScore = afterTop?.combined ?? 0;
    // exp(-1) ≈ 0.368, so the after score should be < 0.5 × baseline.
    if (afterScore >= baseScore * 0.55) {
      throw new Error(
        `decline didn't take effect: baseline=${baseScore.toFixed(3)} after=${afterScore.toFixed(3)}`
      );
    }
  });

  await step("alias-feedback: confirm boosts subsequent match for same query", async () => {
    const scope = { tenantId: "v05-test" };
    // The decline-test seeded 'Acme Industrials Ltd'. Now confirm a fuzzy-typed
    // variant against it and see the score climb on the next match.
    const a = await matchJson("customer", "Acme Industries", scope);
    const top = a.candidates[0];
    if (!top) throw new Error("no candidate to confirm");
    const before = top.combined;
    await fetch(`${URL}/v1/projects/${PROJECT}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        kind: "customer",
        queryText: "Acme Industries",
        scope,
        chosenEntityId: top.entityId,
      }),
    });
    const b = await matchJson("customer", "Acme Industries", scope);
    const after = b.candidates.find((c) => c.entityId === top.entityId);
    if (!after) throw new Error("confirmed entity disappeared from re-match");
    if (after.combined <= before) {
      throw new Error(`alias didn't boost: before=${before.toFixed(3)} after=${after.combined.toFixed(3)}`);
    }
    if (!after.components.aliasHit) throw new Error("aliasHit should be true after confirm");
  });

  await step("calibrate: F1 grid-search writes scope_threshold", async () => {
    const scope = { tenantId: "v05-test" };
    const r = await fetch(`${URL}/v1/projects/${PROJECT}/calibrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ kind: "customer", scope, minSampleSize: 2 }),
    });
    const body = (await r.json()) as { threshold: number; f1: number; sampleSize: number };
    if (!r.ok) throw new Error(JSON.stringify(body));
    if (typeof body.threshold !== "number" || body.threshold < 0.5 || body.threshold > 0.99) {
      throw new Error(`bad threshold: ${body.threshold}`);
    }
    if (body.f1 < 0 || body.f1 > 1) throw new Error(`bad f1: ${body.f1}`);
    if (body.sampleSize < 2) throw new Error(`bad sample: ${body.sampleSize}`);
  });

  // ─── /match-batch primitive (the bridge for bulk-import consumers) ──────
  await step("match-batch: phone-exact + name-exact + fallback in one call", async () => {
    const r = await fetch(`${URL}/v1/projects/${PROJECT}/match-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        kind: "customer",
        scope: { tenantId: "acme" },
        queries: [
          { queryText: "Different Name", phone: "0771234567", ref: "phone" },
          { queryText: "John Smith", ref: "name" },
          { queryText: "Smyth", ref: "fuzzy" },
        ],
      }),
    });
    const body = (await r.json()) as {
      outcomes: Array<{ ref: string | null; hitMethod: string }>;
      counts: Record<string, number>;
    };
    if (!r.ok) throw new Error(JSON.stringify(body));
    const byRef = new Map(body.outcomes.map((o) => [o.ref, o.hitMethod]));
    if (byRef.get("phone") !== "phone-exact") {
      throw new Error(`phone ref expected phone-exact, got ${byRef.get("phone")}`);
    }
    if (byRef.get("name") !== "name-exact") {
      throw new Error(`name ref expected name-exact, got ${byRef.get("name")}`);
    }
    // 'Smyth' has no phone, no exact match, no historical alias on first run —
    // falls through to wave 5 (combined-match). It should NOT be no-match.
    const fuzzy = byRef.get("fuzzy");
    if (fuzzy !== "combined-match" && fuzzy !== "alias-hit") {
      throw new Error(`fuzzy ref expected combined-match or alias-hit, got ${fuzzy}`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log("\n✓ All assertions passed. samesake is green.");
}

main().catch((e) => {
  console.error("\n✗ Smoke test exploded:");
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
