import { createHash } from "node:crypto";
import type { GenerateFn } from "../../types.ts";

/** ESCI relevance classes (Amazon shopping-queries taxonomy). Substitute is a soft positive. */
export type EsciLabel = "E" | "S" | "C" | "I";

/** Numeric gain per ESCI class — Exact=3, Substitute=2 (soft positive), Complement=1, Irrelevant=0. */
export const ESCI_GAIN: Record<EsciLabel, 0 | 1 | 2 | 3> = { E: 3, S: 2, C: 1, I: 0 };

/** The relevance floor at which a hit counts as a (soft) positive: Substitute or better. */
export const ESCI_SOFT_POSITIVE_FLOOR = 2;

export interface JudgedHit {
  id: string;
  /** ESCI gain: 3=Exact, 2=Substitute, 1=Complement, 0=Irrelevant. */
  grade: 0 | 1 | 2 | 3;
  esci: EsciLabel;
  reason: string;
}

export interface JudgeCandidate {
  id: string;
  text: string;
  data: Record<string, unknown>;
}

export interface RelevanceJudge {
  version: string;
  /** Model identifier the judge runs on — used to enforce enrich/judge family separation. */
  model?: string;
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

export const ESCI_JUDGE_SYSTEM =
  "You are a strict multilingual e-commerce search relevance judge. Classify each candidate against the shopper's query as exactly one of:\n" +
  "E (Exact): the product satisfies every explicit constraint in the query (type, attributes such as color/material/size/use case, and any price bound shown). Match meaning, synonyms, and translations — keyword overlap is not required.\n" +
  "S (Substitute): not an exact match but a reasonable alternative the shopper would plausibly accept for the same need (e.g. a slightly different style or neighboring product type serving the same purpose).\n" +
  "C (Complement): not what was asked for, but typically bought or worn together with it (an accessory or companion item).\n" +
  "I (Irrelevant): fails the query's intent or clearly conflicts with an explicit attribute. A candidate with a conflicting required attribute (wrong base color, wrong gender, over an explicit price bound) is I, not S.\n" +
  "For normalized color fields, require the exact requested base color; neighboring shades are not matches unless the requested color is also present. Give a short reason per candidate.";

/** Stable content hash of the judge rubric — changing the prompt changes the version, invalidating cached grades. */
export const JUDGE_PROMPT_HASH = createHash("sha256").update(ESCI_JUDGE_SYSTEM).digest("hex").slice(0, 8);

/** Compose a judge version pinned to the rubric content, e.g. "esci-v1@1a2b3c4d". */
export function judgeVersion(tag = "esci-v1"): string {
  return `${tag}@${JUDGE_PROMPT_HASH}`;
}

/**
 * Model family for enrich/judge separation. Returns null for unrecognized ids (semantic
 * tokens like "classify" or self-hosted names) — unknown families are skipped, not rejected.
 */
export function modelFamily(model: string | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase().replace(/^.*\//, "");
  if (/^(gemini|gemma|palm|bison)/.test(m)) return "google";
  if (/^(gpt|o[1-9]|chatgpt|davinci|text-embedding)/.test(m)) return "openai";
  if (/^claude/.test(m)) return "anthropic";
  if (/^(voyage|rerank-)/.test(m)) return "voyage";
  if (/^(command|embed-english|embed-multilingual|cohere)/.test(m)) return "cohere";
  if (/^(mistral|ministral|mixtral|codestral)/.test(m)) return "mistral";
  if (/^llama/.test(m)) return "meta";
  if (/^qwen/.test(m)) return "alibaba";
  if (/^deepseek/.test(m)) return "deepseek";
  if (/^grok/.test(m)) return "xai";
  if (/^(nova|titan)/.test(m)) return "amazon";
  return null;
}

/**
 * Throw when the judge model shares a family with any enrich stage model — a same-family
 * judge flatters its own LLM-written documents (self-preference bias), so the eval would lie.
 */
export function assertJudgeFamilySeparation(
  judgeModel: string | undefined,
  enrichModels: Array<string | undefined>
): void {
  const judgeFamily = modelFamily(judgeModel);
  const enrichFamilies = enrichModels.map(modelFamily).filter((f): f is string => f !== null);
  if (enrichFamilies.length === 0) return;
  if (!judgeFamily) {
    throw new Error(
      `eval judge model ${judgeModel ? `"${judgeModel}" has an unrecognized family` : "is not declared"} while the collection enriches with ${[...new Set(enrichFamilies)].join(", ")} models. ` +
        "Declare a judge model from a different family (e.g. judge with gpt-4.1-mini when enriching with gemini) — a same-family judge flatters its own enrichment output."
    );
  }
  if (enrichFamilies.includes(judgeFamily)) {
    throw new Error(
      `eval judge model "${judgeModel}" is the same model family (${judgeFamily}) as the collection's enrich pipeline. ` +
        "Judging your own enrichment output inflates grades (self-preference bias); use a judge from a different family."
    );
  }
}

const judgeSchema = {
  type: "object",
  properties: {
    grades: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          esci: { type: "string", enum: ["E", "S", "C", "I"] },
          reason: { type: "string" },
        },
        required: ["id", "esci", "reason"],
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
    "Return one ESCI class (E|S|C|I) per candidate with a short reason. Keep the original candidate order.",
  ].join("\n");
}

function asEsci(value: unknown): EsciLabel {
  const v = String(value ?? "").trim().toUpperCase();
  return v === "E" || v === "S" || v === "C" ? (v as EsciLabel) : "I";
}

function zeroHits(candidates: JudgeCandidate[], reason: string): JudgedHit[] {
  return candidates.map((c) => ({
    id: c.id,
    grade: 0,
    esci: "I" as const,
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
    const esci = asEsci(r.esci);
    byId.set(id, {
      id,
      esci,
      grade: ESCI_GAIN[esci],
      reason: String(r.reason ?? "").slice(0, 240),
    });
  }

  return candidates.map(
    (c) =>
      byId.get(c.id) ?? {
        id: c.id,
        grade: 0 as const,
        esci: "I" as const,
        reason: "judge-error",
      }
  );
}

export function makeLlmJudge(
  generate: GenerateFn,
  opts: { model?: string; version?: string; batchSize?: number; onError?: (msg: string) => void } = {}
): RelevanceJudge {
  const version = judgeVersion(opts.version);
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const log = opts.onError ?? ((msg: string) => console.warn(msg));

  async function gradeBatch(query: string, candidates: JudgeCandidate[]): Promise<JudgedHit[]> {
    if (candidates.length === 0) return [];
    try {
      const out = await generate({
        model: opts.model,
        system: ESCI_JUDGE_SYSTEM,
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
    model: opts.model,
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
