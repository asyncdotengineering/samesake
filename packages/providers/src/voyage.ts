// Voyage AI adapters (plain fetch): embeddings + cross-encoder rerank.
import type { EmbedFn, RerankFn } from "@samesake/server";
import {
  type ProviderOptions,
  fail,
  fetchWithRetry,
  makeThrottle,
  resolveKey,
} from "./shared.ts";

const BASE = "https://api.voyageai.com/v1";
const DEFAULT_EMBED_MODEL = "voyage-3.5";
const DEFAULT_RERANK_MODEL = "rerank-2.5";

export function voyageEmbedder(opts: ProviderOptions = {}): EmbedFn {
  const throttle = makeThrottle(opts.minIntervalMs);
  return async ({ text, image, model, dim, inputType }) => {
    if (image) {
      throw new Error(
        "[@samesake/providers] voyage embed: image embeddings are not supported here — use a multimodal embedder (e.g. geminiEmbedder) for image spaces"
      );
    }
    await throttle();
    const key = resolveKey(opts, "VOYAGE_API_KEY", "voyage");
    const res = await fetchWithRetry(
      `${opts.baseUrl ?? BASE}/embeddings`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: model || opts.model || DEFAULT_EMBED_MODEL,
          input: [text ?? ""],
          output_dimension: dim,
          ...(inputType ? { input_type: inputType } : {}),
        }),
      },
      opts.retries
    );
    if (!res.ok) await fail(res, "voyage embed");
    const data = (await res.json()) as { data?: { embedding: number[] }[] };
    if (!data.data?.[0]?.embedding) throw new Error("[@samesake/providers] voyage embed: no embedding");
    return data.data[0].embedding;
  };
}

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
