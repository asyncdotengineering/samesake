import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeShopify, normalizeWoo } from "../src/connectors/normalize.ts";
import { shopifyFeedFromJson } from "../src/connectors/shopify.ts";
import { wooFeedFromJson } from "../src/connectors/woocommerce.ts";

const fixturesDir = resolve(import.meta.dir, "fixtures");

describe("connectors", () => {
  test("Shopify normalizes string tags into array", () => {
    const raw = JSON.parse(
      readFileSync(resolve(fixturesDir, "aviratefashion_shopify_p1.json"), "utf8")
    ) as { products: Record<string, unknown>[] };
    const item = raw.products[0]!;
    expect(typeof item.tags).toBe("object");
    expect(Array.isArray(item.tags)).toBe(true);

    const normalized = normalizeShopify(item, {
      domain: "aviratefashion.com",
      currency: "LKR",
    });
    expect(normalized).not.toBeNull();
    expect(Array.isArray(normalized!.raw_tags)).toBe(true);
    expect(normalized!.raw_tags.length).toBeGreaterThan(0);
    expect(normalized!.price).toBe(7280);
  });

  test("Shopify connector yields normalized docs from fixture", async () => {
    const raw = JSON.parse(
      readFileSync(resolve(fixturesDir, "aviratefashion_shopify_p1.json"), "utf8")
    ) as { products: Record<string, unknown>[] };
    const connector = shopifyFeedFromJson(raw, {
      domain: "aviratefashion.com",
      currency: "LKR",
    });
    const rows = [];
    for await (const row of connector.pull()) rows.push(row);
    expect(rows.length).toBe(5);
    expect(rows[0]!.data.title).toBeTruthy();
    expect(rows[0]!.data.content_hash).toBeTruthy();
  });

  test("Woo normalizes minor-unit price 562000 -> 5620.00", () => {
    const items = JSON.parse(
      readFileSync(resolve(fixturesDir, "clotho_woo_p1.json"), "utf8")
    ) as Record<string, unknown>[];
    const item = items.find((i) => i.id === 18956)!;
    const normalized = normalizeWoo(item, { domain: "clotho.lk", currency: "LKR" });
    expect(normalized).not.toBeNull();
    expect(normalized!.price).toBe(5620);
  });

  test("Woo connector yields normalized docs from fixture", async () => {
    const items = JSON.parse(
      readFileSync(resolve(fixturesDir, "clotho_woo_p1.json"), "utf8")
    ) as Record<string, unknown>[];
    const connector = wooFeedFromJson(items, { domain: "clotho.lk", currency: "LKR" });
    const rows = [];
    for await (const row of connector.pull()) rows.push(row);
    expect(rows.length).toBe(5);
    const priced = rows.find((r) => r.id === "18956");
    expect(priced?.data.price).toBe(5620);
  });
});
