// Cohere adapters (v2 API, plain fetch): embeddings + cross-encoder rerank.
import type { EmbedFn, RerankFn } from "@samesake/server";
import {
  type ProviderOptions,
  fail,
  fetchWithRetry,
  makeThrottle,
  resolveKey,
} from "./shared.ts";

const BASE = "https://api.cohere.com/v2";
const DEFAULT_EMBED_MODEL = "embed-v4.0";
const DEFAULT_RERANK_MODEL = "rerank-v3.5";

export function cohereEmbedder(opts: ProviderOptions = {}): EmbedFn {
  const throttle = makeThrottle(opts.minIntervalMs);
  return async ({ text, image, model, dim, inputType }) => {
    if (image) {
      throw new Error(
        "[@samesake/providers] cohere embed: image embeddings are not supported here — use a multimodal embedder (e.g. geminiEmbedder) for image spaces"
      );
    }
    await throttle();
    const key = resolveKey(opts, "COHERE_API_KEY", "cohere");
    const res = await fetchWithRetry(
      `${opts.baseUrl ?? BASE}/embed`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: model || opts.model || DEFAULT_EMBED_MODEL,
          texts: [text ?? ""],
          input_type: inputType === "query" ? "search_query" : "search_document",
          output_dimension: dim,
          embedding_types: ["float"],
        }),
      },
      opts.retries
    );
    if (!res.ok) await fail(res, "cohere embed");
    const data = (await res.json()) as { embeddings?: { float?: number[][] } };
    if (!data.embeddings?.float?.[0]) throw new Error("[@samesake/providers] cohere embed: no embedding");
    return data.embeddings.float[0];
  };
}

export function cohereReranker(opts: ProviderOptions = {}): RerankFn {
  return async ({ query, candidates, topK }) => {
    const key = resolveKey(opts, "COHERE_API_KEY", "cohere");
    const res = await fetchWithRetry(
      `${opts.baseUrl ?? BASE}/rerank`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: opts.model ?? DEFAULT_RERANK_MODEL,
          query,
          documents: candidates.map((c) => c.text),
          top_n: topK,
        }),
        signal: AbortSignal.timeout(30000),
      },
      opts.retries
    );
    if (!res.ok) await fail(res, "cohere rerank");
    const data = (await res.json()) as { results?: { index: number; relevance_score: number }[] };
    return (data.results ?? []).map((r) => ({
      id: candidates[r.index]!.id,
      score: Math.min(1, Math.max(0, r.relevance_score)),
    }));
  };
}
