import { readFileSync } from "node:fs";
import { normalizeShopify } from "./normalize.ts";

export const SHOPIFY_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

export interface ShopifyFeedOpts {
  domain: string;
  currency?: string;
  maxPages?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function shopifyFeedConnector(opts: ShopifyFeedOpts) {
  const store = { domain: opts.domain, currency: opts.currency };
  const maxPages = opts.maxPages ?? 8;
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return {
    name: `shopify:${opts.domain}`,
    async *pull(pullOpts?: { maxPages?: number }) {
      const pages = pullOpts?.maxPages ?? maxPages;
      for (let page = 1; page <= pages; page++) {
        const url = `https://${store.domain}/products.json?limit=250&page=${page}`;
        const res = await fetchFn(url, {
          headers: { "User-Agent": SHOPIFY_UA },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) break;
        const data = (await res.json()) as { products?: Record<string, unknown>[] };
        const batch = data.products ?? [];
        if (!batch.length) break;
        for (const item of batch) {
          const normalized = normalizeShopify(item, store);
          if (!normalized) continue;
          yield { id: String(item.id), data: normalized as unknown as Record<string, unknown> };
        }
        if (batch.length < 250) break;
      }
    },
  };
}

export function shopifyFeedFromJson(
  json: { products: Record<string, unknown>[] },
  store: { domain: string; currency?: string }
) {
  const s = { domain: store.domain, currency: store.currency };
  return {
    name: `shopify:${store.domain}`,
    async *pull() {
      for (const item of json.products) {
        const normalized = normalizeShopify(item, s);
        if (!normalized) continue;
        yield { id: String(item.id), data: normalized as unknown as Record<string, unknown> };
      }
    },
  };
}

export function shopifyFeedFromFile(path: string, store: { domain: string; currency?: string }) {
  const json = JSON.parse(readFileSync(path, "utf8")) as { products: Record<string, unknown>[] };
  return shopifyFeedFromJson(json, store);
}
