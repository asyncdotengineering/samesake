import type { ConnectorDef } from "@samesake/core";
import { shopifyFeedConnector } from "./shopify.ts";
import { wooStoreFeedConnector } from "./woocommerce.ts";
import { jsonlFeedConnector } from "./jsonl.ts";

export type PullConnector = {
  name: string;
  pull: (opts?: Record<string, unknown>) => AsyncIterable<{ id: string; data: Record<string, unknown> }>;
};

export function connectorFromDef(
  def: ConnectorDef,
  opts?: { timeoutMs?: number }
): PullConnector {
  switch (def.kind) {
    case "shopify":
      return shopifyFeedConnector({
        domain: String(def.options.domain),
        currency: def.options.currency as string | undefined,
        maxPages: def.options.maxPages as number | undefined,
        timeoutMs: opts?.timeoutMs,
      });
    case "woocommerce":
      return wooStoreFeedConnector({
        domain: String(def.options.domain),
        currency: def.options.currency as string | undefined,
        maxPages: def.options.maxPages as number | undefined,
        timeoutMs: opts?.timeoutMs,
      });
    case "jsonl":
      return jsonlFeedConnector({ path: String(def.options.path) });
    default:
      throw new Error(`unsupported connector kind: ${(def as ConnectorDef).kind}`);
  }
}

export * from "./normalize.ts";
export * from "./shopify.ts";
export * from "./woocommerce.ts";
export * from "./jsonl.ts";
