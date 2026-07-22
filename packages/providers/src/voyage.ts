// Voyage AI adapters (plain fetch): embeddings + cross-encoder rerank.
import type { RerankFn } from "@samesake/server";
import {
  type ProviderOptions,
  fail,
  fetchWithRetry,
  resolveKey,
} from "./shared.ts";

const BASE = "https://api.voyageai.com/v1";
const DEFAULT_RERANK_MODEL = "rerank-2.5";

export { voyage as voyageEmbedder } from "@samesake/embed";

export function voyageReranker(opts: ProviderOptions = {}): RerankFn {
  return async ({ query, candidates, topK }) => {
    const key = resolveKey(opts, "VOYAGE_API_KEY", "voyage");
    const res = await fetchWithRetry(
      `${opts.baseUrl ?? BASE}/rerank`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: opts.model ?? DEFAULT_RERANK_MODEL,
          query,
          documents: candidates.map((c) => c.text),
          top_k: topK,
        }),
        signal: AbortSignal.timeout(30000),
      },
      opts.retries
    );
    if (!res.ok) await fail(res, "voyage rerank");
    const data = (await res.json()) as { data?: { index: number; relevance_score: number }[] };
    return (data.data ?? []).map((r) => ({
      id: candidates[r.index]!.id,
      score: Math.min(1, Math.max(0, r.relevance_score)),
    }));
  };
}
