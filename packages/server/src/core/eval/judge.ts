import type { GenerateFn } from "../../types.ts";

export interface FacetGrades {
  category?: 0 | 1 | 2;
  color?: 0 | 1 | 2;
  occasion?: 0 | 1 | 2;
  gender?: 0 | 1 | 2;
  style?: 0 | 1 | 2;
  material?: 0 | 1 | 2;
}

export interface JudgedHit {
  id: string;
  grade: 0 | 1 | 2;
  facets: FacetGrades;
  reason: string;
}

export interface JudgeCandidate {
  id: string;
  text: string;
  data: Record<string, unknown>;
}

export interface RelevanceJudge {
  version: string;
  grade(query: string, candidates: JudgeCandidate[]): Promise<JudgedHit[]>;
}

function text(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(", ");
  return String(value).trim();
}

export function candidateSummary(data: Record<string, unknown>, id: string): string {
  return [
    `id: ${id}`,
    `title: ${text(data.title)}`,
    `brand: ${text(data.brand)}`,
    `price: ${text(data.price)}`,
    `category: ${text(data.category)}`,
    `type: ${text(data.product_type)}`,
    `colors: ${text(data.colors)}`,
    `occasions: ${text(data.occasions)}`,
    `styles: ${text(data.styles)}`,
    `material: ${text(data.material)}`,
    `pattern: ${text(data.pattern)}`,
    `fit: ${text(data.fit)}`,
    `description: ${text(data.description).slice(0, 240)}`,
  ]
    .filter((line) => !line.endsWith(": "))
    .join(" | ");
}

export const FASHION_JUDGE_SYSTEM =
  "You are a strict multilingual commerce search relevance judge. Score each candidate 0 (irrelevant), 1 (moderately relevant), or 2 (highly relevant). " +
  "Match meaning, synonyms, and translations; do not require keyword overlap. " +
  "Treat explicit shopper attributes such as product type, color, material, size, and use case as required constraints. " +
  "If a candidate clearly has a conflicting attribute, score it 0. " +
  "For normalized color fields, require the exact requested base color; neighboring shades are not matches unless the requested color is also present. " +
  "Also score per-facet relevance (category, color, occasion, gender, style, material) as 0|1|2 and give a short reason.";

const judgeSchema = {
  type: "object",
  properties: {
    grades: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          grade: { type: "number", enum: [0, 1, 2] },
          facets: {
            type: "object",
            properties: {
              category: { type: "number", enum: [0, 1, 2] },
              color: { type: "number", enum: [0, 1, 2] },
              occasion: { type: "number", enum: [0, 1, 2] },
              gender: { type: "number", enum: [0, 1, 2] },
              style: { type: "number", enum: [0, 1, 2] },
              material: { type: "number", enum: [0, 1, 2] },
            },
            additionalProperties: false,
          },
          reason: { type: "string" },
        },
        required: ["id", "grade", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["grades"],
  additionalProperties: false,
};

const BATCH_SIZE = 10;

function renderCandidates(query: string, candidates: JudgeCandidate[]): string {
  return [
    `Shopper query: ${query}`,
    "Candidate products:",
    ...candidates.map((c, i) => `${i + 1}. ${c.text}`),
    "Return a grade 0|1|2 per candidate with facet sub-grades and a short reason. Keep the original candidate order.",
  ].join("\n");
}

function asGrade(value: unknown): 0 | 1 | 2 {
  const n = Number(value);
  if (n === 2) return 2;
  if (n === 1) return 1;
  return 0;
}

function asFacetGrades(raw: unknown): FacetGrades {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const out: FacetGrades = {};
  for (const key of ["category", "color", "occasion", "gender", "style", "material"] as const) {
    if (o[key] != null) out[key] = asGrade(o[key]);
  }
  return out;
}

function zeroHits(candidates: JudgeCandidate[], reason: string): JudgedHit[] {
  return candidates.map((c) => ({
    id: c.id,
    grade: 0,
    facets: {},
    reason,
  }));
}

function parseJudgeOutput(out: unknown, candidates: JudgeCandidate[]): JudgedHit[] {
  const grades = (out as { grades?: unknown })?.grades;
  if (!Array.isArray(grades)) return zeroHits(candidates, "judge-error");

  const byId = new Map<string, JudgedHit>();
  for (const row of grades) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = String(r.id ?? "");
    if (!id) continue;
    byId.set(id, {
      id,
      grade: asGrade(r.grade),
      facets: asFacetGrades(r.facets),
      reason: String(r.reason ?? "").slice(0, 240),
    });
  }

  return candidates.map(
    (c) =>
      byId.get(c.id) ?? {
        id: c.id,
        grade: 0 as const,
        facets: {},
        reason: "judge-error",
      }
  );
}

export function makeLlmJudge(
  generate: GenerateFn,
  opts: { model?: string; version?: string; batchSize?: number; onError?: (msg: string) => void } = {}
): RelevanceJudge {
  const version = opts.version ?? "fashion-judge-v1";
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const log = opts.onError ?? ((msg: string) => console.warn(msg));

  async function gradeBatch(query: string, candidates: JudgeCandidate[]): Promise<JudgedHit[]> {
    if (candidates.length === 0) return [];
    try {
      const out = await generate({
        model: opts.model,
        system: FASHION_JUDGE_SYSTEM,
        prompt: renderCandidates(query, candidates),
        schema: judgeSchema,
      });
      return parseJudgeOutput(out, candidates);
    } catch (e) {
      log(`judge batch failed: ${e instanceof Error ? e.message : String(e)}`);
      return zeroHits(candidates, "judge-error");
    }
  }

  return {
    version,
    async grade(query, candidates) {
      const q = query.trim();
      if (!q || candidates.length === 0) return [];
      const out: JudgedHit[] = [];
      for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        out.push(...(await gradeBatch(q, batch)));
      }
      return out;
    },
  };
}
