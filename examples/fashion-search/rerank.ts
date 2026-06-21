/**
 * BYO cross-encoder reranker recipes. samesake's `rerank?: RerankFn` is provider-
 * agnostic, so you wire the reranker that fits your runtime:
 *
 *   - Node / Bun / container  → onnxReranker()      (local ONNX via transformers.js)
 *   - Cloudflare Workers      → workersAiReranker()  (Workers AI binding)
 *
 * A cross-encoder scores (query, document) directly — the strongest relevance
 * signal available (see the calibration benchmark: it rejected 100% of no-match
 * queries vs the cosine floor's 92%). Native ONNX (onnxruntime-node) does NOT run
 * on Cloudflare Workers, which is why the Workers path uses Workers AI instead.
 *
 * Wire it into your collection's search config:
 *   import { onnxReranker } from "./rerank.ts";
 *   createMatcher({ ..., rerank: onnxReranker() })
 */
import { AutoTokenizer, AutoModelForSequenceClassification } from "@huggingface/transformers";
import type { RerankFn } from "@samesake/server";

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Local ONNX cross-encoder (Node / Bun / container). Lazily loads the model once. */
export function onnxReranker(model = "mixedbread-ai/mxbai-rerank-xsmall-v1"): RerankFn {
  let tok: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
  let ce: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>> | null = null;
  const load = async () => {
    if (ce) return;
    tok = await AutoTokenizer.from_pretrained(model);
    ce = await AutoModelForSequenceClassification.from_pretrained(model, { dtype: "q8" });
  };
  return async ({ query, candidates }) => {
    await load();
    const out: { id: string; score: number }[] = [];
    for (const c of candidates) {
      const inputs = tok!(query, { text_pair: c.text, padding: true, truncation: true });
      const { logits } = await ce!(inputs);
      out.push({ id: c.id, score: sigmoid(Number(logits.data[0])) });
    }
    return out;
  };
}

/** Cloudflare Workers AI reranker (Workers runtime). Pass the `env.AI` binding. */
export function workersAiReranker(
  ai: { run: (model: string, opts: unknown) => Promise<{ response?: { id: number; score: number }[] }> },
  model = "@cf/baai/bge-reranker-base"
): RerankFn {
  return async ({ query, candidates }) => {
    const res = await ai.run(model, { query, contexts: candidates.map((c) => ({ text: c.text })) });
    return (res.response ?? []).map((r) => ({ id: candidates[r.id]!.id, score: r.score }));
  };
}
