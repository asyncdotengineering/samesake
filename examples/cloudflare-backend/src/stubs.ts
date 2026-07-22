import type { EmbedRequest, GenerateRequest } from "@samesake/core";

export async function stubGenerate(req: GenerateRequest): Promise<unknown> {
  const query = req.prompt.match(/Query:\s*"([\s\S]*)"/)?.[1]?.trim();
  if (query) {
    return {
      semantic_query: query,
      lexical_query: query,
      ...(/\bNike\b/i.test(query) ? { brand: "Nike" } : {}),
      ...(/\bred\b/i.test(query) ? { color: "red" } : {}),
      ...(/\b(shoe|sneaker|running)\b/i.test(query) ? { category: "footwear" } : {}),
      aspects: { doc: { weight: 1 } },
    };
  }
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(req.prompt) as Record<string, unknown>;
  } catch {
    // The enrichment prompt in this example is always JSON; an empty result keeps
    // this deterministic stub conformant if a caller supplies another prompt.
  }
  const stringValue = (value: unknown): string => value == null ? "" : String(value).trim();
  return {
    title: stringValue(data.title),
    brand: stringValue(data.brand),
    color: stringValue(data.color),
    category: stringValue(data.category),
    vendor: stringValue(data.vendor),
    gtin: stringValue(data.gtin),
  };
}

function project(text: string, dim: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (let index = 0; index < text.length; index++) {
    vector[(text.charCodeAt(index) * 2_654_435_761) % dim] += 1;
  }
  let norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm > 0) for (let index = 0; index < vector.length; index++) vector[index] /= norm;
  return vector;
}

export const stubEmbed = Object.assign(
  (request: EmbedRequest): Promise<number[]> => Promise.resolve(project(request.text ?? "", request.dim)),
  {
    many: (requests: EmbedRequest[]): Promise<number[][]> =>
      Promise.resolve(requests.map((request) => project(request.text ?? "", request.dim))),
    caps: { image: false, interleaved: false, dims: "any" as const, maxBatch: 64 },
  },
);
