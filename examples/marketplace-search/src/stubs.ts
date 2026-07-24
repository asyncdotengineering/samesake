// Deterministic model closures — no API key needed. In production these call a real
// LLM (extraction) and embedding model; the pipeline shape is identical.
import type { GenerateRequest, EmbedRequest } from "@samesake/core";

function project(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) v[i % dim]! += text.charCodeAt(i) * 0.001;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export const stubEmbed = async ({ text, dim }: EmbedRequest): Promise<number[]> => project(text ?? "", dim);

// Two prompt shapes: an NLQ query prompt (returns semantic/attributes) and the
// enrichment prompt (JSON of the row's data → echoed canonical attributes).
export const stubGenerate = async (req: GenerateRequest): Promise<unknown> => {
  const q = req.prompt.match(/Query:\s*"([\s\S]*?)"/)?.[1];
  if (q) return { semantic_query: q, lexical_query: q, ...(/red/i.test(q) ? { color: "red" } : {}) };
  try {
    const d = JSON.parse(req.prompt) as Record<string, unknown>;
    return { title: d.title, brand: d.brand, color: d.color, gtin: d.gtin, vendor: d.vendor };
  } catch {
    return {};
  }
};
