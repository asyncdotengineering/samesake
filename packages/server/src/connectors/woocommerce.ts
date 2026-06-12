import { readFileSync } from "node:fs";
import { normalizeWoo } from "./normalize.ts";
import { SHOPIFY_UA } from "./shopify.ts";

export interface WooFeedOpts {
  domain: string;
  currency?: string;
  maxPages?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function wooStoreFeedConnector(opts: WooFeedOpts) {
  const store = { domain: opts.domain, currency: opts.currency ?? "LKR" };
  const maxPages = opts.maxPages ?? 8;
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return {
    name: `woo:${opts.domain}`,
    async *pull(pullOpts?: { maxPages?: number }) {
      const pages = pullOpts?.maxPages ?? maxPages;
      for (let page = 1; page <= pages; page++) {
        const url = `https://${store.domain}/wp-json/wc/store/v1/products?per_page=100&page=${page}`;
        const res = await fetchFn(url, {
          headers: { "User-Agent": SHOPIFY_UA },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) break;
        const batch = (await res.json()) as Record<string, unknown>[];
        if (!Array.isArray(batch) || !batch.length) break;
        for (const item of batch) {
          const normalized = normalizeWoo(item, store);
          if (!normalized) continue;
          yield { id: String(item.id), data: normalized as unknown as Record<string, unknown> };
        }
        if (batch.length < 100) break;
      }
    },
  };
}

export function wooFeedFromJson(
  items: Record<string, unknown>[],
  store: { domain: string; currency?: string }
) {
  const s = { domain: store.domain, currency: store.currency ?? "LKR" };
  return {
    name: `woo:${store.domain}`,
    async *pull() {
      for (const item of items) {
        const normalized = normalizeWoo(item, s);
        if (!normalized) continue;
        yield { id: String(item.id), data: normalized as unknown as Record<string, unknown> };
      }
    },
  };
}

export function wooFeedFromFile(path: string, store: { domain: string; currency?: string }) {
  const items = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[];
  return wooFeedFromJson(items, store);
}
