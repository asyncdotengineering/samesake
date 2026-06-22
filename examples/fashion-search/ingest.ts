import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  shopifyFeedFromJson,
  wooFeedFromJson,
  type PullConnector,
} from "@samesake/server";
import {
  COLLECTION,
  PROJECT,
  createFashionMatcher,
  ensureProject,
} from "./samesake.config.ts";

const RAW_DIR_ENV = process.env.FASHION_DATASET_DIR;
if (!RAW_DIR_ENV) {
  console.error("FASHION_DATASET_DIR is required — path to raw Shopify/Woo JSON snapshots");
  process.exit(1);
}
const RAW_DIR: string = RAW_DIR_ENV;

function snapshotConnectors(): PullConnector[] {
  const byStore = new Map<
    string,
    { domain: string; platform: "shopify" | "woocommerce"; items: Record<string, unknown>[] }
  >();

  for (const file of readdirSync(RAW_DIR).filter((f) => f.endsWith(".json"))) {
    const m = file.match(/^(.+)_(shopify|woo)_p\d+\.json$/);
    if (!m) continue;
    const [, domain, plat] = m;
    const platform = plat === "woo" ? "woocommerce" : "shopify";
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(resolve(RAW_DIR, file), "utf8"));
    } catch {
      continue;
    }
    const items = Array.isArray(data)
      ? (data as Record<string, unknown>[])
      : ((data as { products?: Record<string, unknown>[] }).products ?? []);
    if (!items.length) continue;
    const key = `${domain}|${platform}`;
    if (!byStore.has(key)) byStore.set(key, { domain: domain!, platform, items: [] });
    byStore.get(key)!.items.push(...items);
  }

  const connectors: PullConnector[] = [];
  for (const feed of byStore.values()) {
    const seen = new Set<string>();
    const unique = feed.items.filter((it) => {
      const id = String(it.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    const base =
      feed.platform === "shopify"
        ? shopifyFeedFromJson({ products: unique }, { domain: feed.domain, currency: "LKR" })
        : wooFeedFromJson(unique, { domain: feed.domain, currency: "LKR" });

    connectors.push({
      name: `${feed.platform}:${feed.domain}:snapshot`,
      async *pull() {
        for await (const row of base.pull()) {
          yield {
            id: `${feed.domain}:${row.id}`,
            data: {
              ...row.data,
              store_domain: feed.domain,
              external_id: row.id,
            },
          };
        }
      },
    });
  }
  return connectors;
}

export async function runIngest(matcher: ReturnType<typeof createFashionMatcher>) {
  const connectors = snapshotConnectors();
  console.log(`${connectors.length} store feeds from ${RAW_DIR}`);
  const batch: Array<{ id: string; data: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  let upserted = 0;

  for (const connector of connectors) {
    for await (const row of connector.pull()) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      batch.push(row);
      if (batch.length >= 50) {
        const r = await matcher.pushDocuments(PROJECT, COLLECTION, batch.splice(0, 50));
        upserted += r.upserted;
        if (upserted % 500 === 0) console.log(`ingested ${upserted}...`);
      }
    }
  }
  if (batch.length) {
    const r = await matcher.pushDocuments(PROJECT, COLLECTION, batch);
    upserted += r.upserted;
  }
  console.log(`ingested ${upserted} products`);
  return upserted;
}

async function main() {
  const matcher = createFashionMatcher();
  await ensureProject(matcher);
  await runIngest(matcher);
  await matcher.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
