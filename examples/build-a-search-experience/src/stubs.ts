// Deterministic model closures so the example runs with no API key. In production
// you pass real model functions (Gemini/OpenAI/etc.); the pipeline is identical.
import type { EmbedRequest, GenerateRequest } from "@samesake/core";

// A tiny deterministic "embedding": hash chars into `dim` buckets, L2-normalize.
// Meaning-quality is irrelevant to this example — the budget exclusion is a hard
// filter, not a similarity score — so a stub keeps the run reproducible.
function project(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 2_654_435_761) % dim] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export const stubEmbed = async ({ text, dim }: EmbedRequest): Promise<number[]> =>
  project(text ?? "", dim);

// Stands in for the NLQ model. parseNlq sends a prompt containing the shopper's
// query; we extract it, strip the price phrase into `semantic_query`, and surface
// an explicit `max_price` when the query says "under <n>" — exactly the structured
// shape the real model would return (see packages/query/src/nlq.ts).
export async function stubGenerate(req: GenerateRequest): Promise<unknown> {
  const prompt = req.prompt ?? "";
  const q = prompt.match(/Query:\s*"([\s\S]*?)"/)?.[1]?.trim() ?? prompt;
  const under = q.match(/under\s+([\d,]+)/i);
  const maxPrice = under ? Number(under[1]!.replace(/,/g, "")) : undefined;
  const semantic = q.replace(/under\s+[\d,]+/i, "").trim() || q;
  return {
    semantic_query: semantic,
    lexical_query: semantic,
    ...(maxPrice != null ? { max_price: maxPrice } : {}),
  };
}
