import type {
  CollectionDef,
  CollectionEmbeddingDef,
  GroundImageFn,
  SearchMode,
  SearchWeightsInput,
} from "@samesake/core";
import type { EmbedService, QueryFetchImage } from "./deps.ts";
import { shouldSkipNlq, type NlqParseResult } from "./nlq.ts";
import { embeddingEntries } from "./aspects.ts";

export interface ChannelWeights {
  fts: number;
  cosine: number;
  recency: number;
  recencyHalfLife: number;
  recencyField: string;
  aspects: Record<string, number>;
}

export interface QueryImageInput {
  url?: string;
  bytes?: Uint8Array;
  bytesBase64?: string;
  mimeType?: string;
}

export interface AspectPlan {
  name: string;
  embedding: CollectionEmbeddingDef;
  queryVector: number[] | null;
  weight: number;
}

const KEYWORD_TIEBREAK = 0.3;

export function parseSearchWeights(
  def: CollectionDef,
  override?: SearchWeightsInput,
  mode: SearchMode = "intent",
  _hasImage = false
): ChannelWeights {
  const channels = def.search?.channels ?? [];
  let fts = 0;
  let recency = 0;
  let recencyHalfLife = 90;
  let recencyField = "updated_at";
  const aspects: Record<string, number> = {};

  for (const ch of channels) {
    if (ch.kind === "fts") fts = ch.weight ?? 0;
    if (ch.kind === "cosine" && ch.embedding) aspects[ch.embedding] = ch.weight ?? 0;
    if (ch.kind === "recency") {
      recency = ch.weight ?? 0;
      recencyHalfLife = ch.halfLifeDays ?? 90;
      recencyField = ch.field ?? "updated_at";
    }
  }

  const firstAspect = embeddingEntries(def)[0]?.[0];
  let cosine = firstAspect ? aspects[firstAspect] ?? 0 : 0;
  if (mode === "similar") {
    fts = 0;
  } else if (cosine > 0) {
    fts = Math.min(fts, KEYWORD_TIEBREAK * cosine);
  }
  // C9 gate verdict (2026-07-18, artifacts evals/runs/*aspects-*): non-primary aspect legs
  // are OFF by default for text intent queries — across the gate run and two calibration
  // runs they diluted the doc+fts core (style 2.075→1.65-1.83, overall 1.916→1.81-1.86)
  // despite query-aware routing. They still serve `similar`/image-query mode fully, and a
  // per-query `weights.aspects` override (below) re-enables them for experiments — the same
  // mode rule + override escape the spaces leg had. Facets-only intent retest is the
  // recorded follow-up hypothesis (use-case +0.18, negation +0.30 were real gains).
  if (mode === "intent" && !_hasImage) {
    for (const name of Object.keys(aspects)) {
      if (name !== firstAspect) aspects[name] = 0;
    }
  }

  if (override?.fts !== undefined) fts = override.fts;
  if (override?.cosine !== undefined) {
    cosine = override.cosine;
    if (firstAspect) aspects[firstAspect] = override.cosine;
  }
  if (override?.recency !== undefined) recency = override.recency;
  if (override?.aspects !== undefined) {
    if (typeof override.aspects === "number") {
      for (const name of Object.keys(aspects)) aspects[name] = override.aspects;
      cosine = firstAspect ? aspects[firstAspect] ?? 0 : 0;
    } else {
      for (const [name, weight] of Object.entries(override.aspects)) {
        if (name in aspects && typeof weight === "number") aspects[name] = weight;
      }
      cosine = firstAspect ? aspects[firstAspect] ?? 0 : 0;
    }
  }

  return { fts, cosine, recency, recencyHalfLife, recencyField, aspects };
}

function decodeImageBytes(bytesBase64?: string): Uint8Array | undefined {
  if (!bytesBase64) return undefined;
  return Uint8Array.from(Buffer.from(bytesBase64, "base64"));
}

export async function buildQueryAspectImageVectors(
  def: CollectionDef,
  image: QueryImageInput | undefined,
  embedService: EmbedService,
  fetchImage: QueryFetchImage,
  groundImage?: GroundImageFn
): Promise<Record<string, number[]>> {
  if (!image) return {};
  let bytes = image.bytes ?? decodeImageBytes(image.bytesBase64);
  let mimeType = image.mimeType;
  let url = image.url;

  if (image.url) {
    const fetched = await fetchImage(image.url);
    if (!fetched.ok) throw new Error(`image query fetch failed: ${fetched.reason}`);
    bytes = fetched.bytes;
    mimeType = fetched.contentType;
  }
  if (!image.url && !bytes?.length) throw new Error("image query requires url, bytes, or bytesBase64");

  if (groundImage && bytes?.length) {
    const grounded = await groundImage({ url, bytes, mimeType });
    if (grounded) {
      bytes = grounded.bytes;
      mimeType = grounded.mimeType;
      url = undefined;
    }
  }

  const out: Record<string, number[]> = {};
  for (const [name, embedding] of embeddingEntries(def)) {
    if (embedding.kind !== "image") continue;
    out[name] = await embedService.embedQuery({
      image: { url, bytes, mimeType },
      model: embedding.model,
      dim: embedding.dim,
      taskType: embedding.taskType ?? "RETRIEVAL_QUERY",
      inputType: "query",
    });
  }
  return out;
}

function routeMap(nlq: NlqParseResult): Record<string, { subQuery?: string; weight: number }> {
  const raw = nlq.parsed.aspects;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, { subQuery?: string; weight: number }> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const weight = typeof record.weight === "number" && Number.isFinite(record.weight)
      ? Math.max(0, Math.min(1, record.weight))
      : 0;
    const subQuery = typeof record.subQuery === "string" && record.subQuery.trim()
      ? record.subQuery.trim()
      : undefined;
    out[name] = { subQuery, weight };
  }
  return out;
}

function queryTextForAspect(
  embedding: CollectionEmbeddingDef,
  semanticText: string,
  imageVector: number[] | undefined,
  embedService: EmbedService
): Promise<number[]> {
  if (imageVector) return Promise.resolve(imageVector);
  return embedService.embedQuery({
    text: semanticText,
    model: embedding.model,
    dim: embedding.dim,
    taskType: embedding.taskType ?? "RETRIEVAL_QUERY",
    inputType: "query",
  });
}

export async function resolveAspectPlans(
  def: CollectionDef,
  weights: ChannelWeights,
  nlq: NlqParseResult,
  semanticText: string,
  q: string,
  mode: SearchMode,
  hasImage: boolean,
  imageVectors: Record<string, number[]>,
  embedService: EmbedService
): Promise<AspectPlan[]> {
  const entries = embeddingEntries(def);
  if (!entries.length) return [];
  const routes = routeMap(nlq);
  const routed = Object.keys(routes).length > 0;
  const skipToFirst = mode === "intent" && (nlq.degraded || shouldSkipNlq(def, q));
  const plans: AspectPlan[] = [];

  for (const [index, [name, embedding]] of entries.entries()) {
    const configuredWeight = weights.aspects[name] ?? 0;
    if (configuredWeight <= 0) continue;

    let weight = configuredWeight;
    let text = semanticText;
    const route = routes[name];
    if (mode === "intent" && !hasImage) {
      if (skipToFirst) {
        if (index !== 0) continue;
      } else if (routed) {
        if (route) {
          if (route.weight <= 0) continue;
          weight *= route.weight;
          text = route.subQuery ?? semanticText;
        } else if (index !== 0) {
          // Unrouted non-primary aspects stay off (the V02g noise fix). The primary
          // aspect is the retrieval workhorse: it never silently drops out just because
          // the router omitted it (C9 run 1 measured −0.11 overall from exactly that).
          // An explicit route with weight 0 still zeroes it deliberately.
          continue;
        }
      }
    } else if (mode === "intent" && routed && route) {
      if (route.weight <= 0) continue;
      weight *= route.weight;
      text = route.subQuery ?? semanticText;
    }
    if (weight <= 0) continue;

    try {
      const queryVector = await queryTextForAspect(embedding, text, imageVectors[name], embedService);
      plans.push({ name, embedding, queryVector, weight });
    } catch {
      plans.push({ name, embedding, queryVector: null, weight });
    }
  }
  return plans;
}
