import { makeLlmJudge, type GenerateFn } from "@samesake/server";
import { geminiGenerator } from "@samesake/providers";

const geminiGenerate = geminiGenerator();

type PlaygroundHit = {
  id: string;
  score: number;
  data: Record<string, unknown>;
  title?: unknown;
  brand?: unknown;
  category?: unknown;
  product_type?: unknown;
  colors?: unknown;
  occasions?: unknown;
  styles?: unknown;
  material?: unknown;
  pattern?: unknown;
  fit?: unknown;
  [field: string]: unknown;
};

function toCandidate(hit: PlaygroundHit) {
  const data = { ...hit.data, ...hit };
  return {
    id: hit.id,
    text: [
      `id: ${hit.id}`,
      `title: ${String(hit.title ?? data.title ?? "")}`,
      `category: ${String(hit.category ?? data.category ?? "")}`,
      `colors: ${Array.isArray(hit.colors) ? hit.colors.join(", ") : ""}`,
    ].join(" | "),
    data,
  };
}

export async function filterHitsBySemanticRelevance<T extends PlaygroundHit>(
  query: string,
  hits: T[],
  generate: GenerateFn = geminiGenerate
): Promise<T[]> {
  const q = query.trim();
  if (!q || hits.length === 0) return hits;

  const candidates = hits.slice(0, 24).map(toCandidate);
  const judge = makeLlmJudge(generate, { version: "playground-binary-v1" });
  const graded = await judge.grade(q, candidates);
  // A judge outage (every hit marked "judge-error") must not empty the page —
  // keep the retrieval results. An actual all-irrelevant verdict has real
  // ESCI grades and still filters to zero.
  if (graded.length > 0 && graded.every((g) => g.reason === "judge-error")) return hits;
  const relevant = new Set(graded.filter((g) => g.grade >= 1).map((g) => g.id));
  return candidates.filter((c) => relevant.has(c.id)).map((c) => hits.find((h) => h.id === c.id)!);
}

function normalizeIdentity(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(normalizeIdentity).filter(Boolean).join(" ");
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function productIdentity(hit: PlaygroundHit): string {
  const data = hit.data ?? {};
  const explicit = data.content_hash ?? data.variant_group ?? hit.content_hash ?? hit.variant_group;
  if (explicit != null && String(explicit).trim()) return `explicit:${String(explicit).trim()}`;
  return normalizeIdentity([hit.title ?? data.title, hit.brand ?? data.brand, data.image_url ?? data.imageUrl]);
}

export function collapseDuplicateProducts<T extends PlaygroundHit>(hits: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const hit of hits) {
    const key = productIdentity(hit);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(hit);
  }
  return out;
}
