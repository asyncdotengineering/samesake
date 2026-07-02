import type { CollectionDef, SearchMode, SearchWeightsInput, SpaceDef } from "@samesake/core";
import type { GroundImageFn } from "../types.ts";
import type { EmbedService } from "./embed.ts";
import { fetchRemoteImageSafe } from "./fetch-image.ts";
import type { SearchFilters } from "./search-filter.ts";
import {
  assembleQueryVector,
  encodeCategorical,
  encodeImage,
  encodeNumberQuery,
  encodeRecencyQuery,
  encodeText,
  spaceSegmentDim,
} from "./spaces.ts";

export interface ChannelWeights {
  fts: number;
  cosine: number;
  recency: number;
  spaces: number;
  recencyHalfLife: number;
  recencyField: string;
  spaceSegmentWeights: Record<string, number>;
}

export interface QueryImageInput {
  url?: string;
  bytes?: Uint8Array;
  bytesBase64?: string;
  mimeType?: string;
}

export interface QuerySpaceSegments {
  segments: Array<number[] | null>;
  dims: number[];
  keys: string[];
  weights: number[];
}

function defaultSpaceWeights(def: CollectionDef): Record<string, number> {
  const declared = def.search?.defaultSpaceWeights;
  const keys = def.spaces ? Object.keys(def.spaces) : [];
  const out: Record<string, number> = {};
  for (const k of keys) {
    out[k] = declared?.[k] ?? 1;
  }
  return out;
}

// Intent mode: keyword is a tiebreaker, never a primary signal. Capped at this fraction of
// the semantic (cosine) weight so a keyword-only match can break ties among semantically
// retrieved items but cannot outrank one. Eval-backed (eval-configs-lk artifacts, LK corpus):
// at this cap, intent relevance@3 holds vs flat weights and exactness queries are preserved,
// while keyword-decoy pollution drops out.
const KEYWORD_TIEBREAK = 0.3;

/** Names of image-kind spaces — cross-modal noise when the query has no image. */
function imageSpaceNames(def: CollectionDef): string[] {
  if (!def.spaces) return [];
  return Object.entries(def.spaces)
    .filter(([, s]) => (s as SpaceDef).kind === "image")
    .map(([name]) => name);
}

export function parseSearchWeights(
  def: CollectionDef,
  override?: SearchWeightsInput,
  mode: SearchMode = "intent",
  hasImage = false
): ChannelWeights {
  const channels = def.search?.channels ?? [];
  let fts = 0;
  let cosine = 0;
  let recency = 0;
  let spaces = 0;
  let recencyHalfLife = 90;
  let recencyField = "updated_at";

  for (const ch of channels) {
    if (ch.kind === "fts") fts = ch.weight ?? 0;
    if (ch.kind === "cosine") cosine = ch.weight ?? 0;
    if (ch.kind === "recency") {
      recency = ch.weight ?? 0;
      recencyHalfLife = ch.halfLifeDays ?? 90;
      recencyField = ch.field ?? "updated_at";
    }
    if (ch.kind === "spaces") spaces = ch.weight ?? 0;
  }

  const spaceSegmentWeights = defaultSpaceWeights(def);

  // ── Mode-aware defaults (applied to the base; explicit `override` below still wins) ──
  // A text query carries no pixels, so an image space can only be filled by cross-modal
  // re-embedding of the query text — noise. Zero it unless an image is actually provided.
  if (!hasImage) {
    for (const name of imageSpaceNames(def)) spaceSegmentWeights[name] = 0;
  }
  if (mode === "similar") {
    // Keyword matching is the opposite of similarity: it surfaces word-decoys (a "black
    // cocktail dress" graphic tee for "black dress"). Semantic + visual carry similarity.
    fts = 0;
  } else {
    // intent: keep keyword only as a tiebreaker beneath semantic.
    if (cosine > 0) fts = Math.min(fts, KEYWORD_TIEBREAK * cosine);
    // Spaces (style/visual/price/category) are similarity signals; for a text intent query
    // they don't drive ranking — NLQ hard filters + semantic do. (Image intent keeps them.)
    if (!hasImage) spaces = 0;
  }

  if (override?.fts !== undefined) fts = override.fts;
  if (override?.cosine !== undefined) cosine = override.cosine;
  if (override?.recency !== undefined) recency = override.recency;

  if (override?.spaces !== undefined) {
    if (typeof override.spaces === "number") {
      spaces = override.spaces;
    } else {
      spaces = spaces > 0 ? spaces : 1;
      for (const [k, v] of Object.entries(override.spaces)) {
        if (k in spaceSegmentWeights && typeof v === "number") spaceSegmentWeights[k] = v;
      }
    }
  }

  return { fts, cosine, recency, spaces, recencyHalfLife, recencyField, spaceSegmentWeights };
}

function spaceKeys(def: CollectionDef): string[] {
  return def.spaces ? Object.keys(def.spaces) : [];
}

export async function buildQuerySpaceVector(
  def: CollectionDef,
  queryEmbedding: number[] | null,
  imageVectors: Record<string, number[]>,
  filters: SearchFilters,
  segmentWeights: Record<string, number>,
  embedService: EmbedService,
  semanticText: string
): Promise<number[] | null> {
  const built = await buildQuerySpaceSegments(
    def,
    queryEmbedding,
    imageVectors,
    filters,
    segmentWeights,
    embedService,
    semanticText
  );
  if (!built) return null;
  return assembleQueryVector(built.segments, built.weights, built.dims);
}

export async function buildQuerySpaceSegments(
  def: CollectionDef,
  queryEmbedding: number[] | null,
  imageVectors: Record<string, number[]>,
  filters: SearchFilters,
  segmentWeights: Record<string, number>,
  embedService: EmbedService,
  semanticText: string
): Promise<QuerySpaceSegments | null> {
  const keys = spaceKeys(def);
  if (!keys.length) return null;

  const segments: Array<number[] | null> = [];
  const dims: number[] = [];
  const weights: number[] = [];

  for (const name of keys) {
    const sdef = def.spaces![name] as SpaceDef;
    dims.push(spaceSegmentDim(sdef));
    weights.push(segmentWeights[name] ?? 1);

    if (sdef.kind === "text") {
      try {
        const vec = await embedService.embedQuery({
          text: semanticText,
          model: sdef.model,
          dim: sdef.dim,
          taskType: sdef.taskType ?? "RETRIEVAL_QUERY",
          inputType: "query",
        });
        segments.push(encodeText(vec));
      } catch {
        segments.push(null);
      }
      continue;
    }
    if (sdef.kind === "image") {
      const imageVector = imageVectors[name];
      if (imageVector && imageVector.length === sdef.dim) {
        segments.push(encodeImage(imageVector));
        continue;
      }
      try {
        const vec = await embedService.embedQuery({
          text: semanticText,
          model: sdef.model,
          dim: sdef.dim,
          taskType: sdef.taskType ?? "RETRIEVAL_QUERY",
          inputType: "query",
        });
        segments.push(encodeImage(vec));
      } catch {
        segments.push(null);
      }
      continue;
    }
    if (sdef.kind === "number") {
      const target =
        typeof filters[sdef.field] === "number"
          ? (filters[sdef.field] as number)
          : typeof filters[sdef.field] === "object" &&
              filters[sdef.field] !== null &&
              "$eq" in (filters[sdef.field] as object)
            ? Number((filters[sdef.field] as { $eq: number }).$eq)
            : null;
      segments.push(encodeNumberQuery(target, sdef));
      continue;
    }
    if (sdef.kind === "recency") {
      segments.push(encodeRecencyQuery(sdef));
      continue;
    }
    if (sdef.kind === "categorical") {
      const raw = filters[sdef.field];
      const cat =
        typeof raw === "string"
          ? raw
          : typeof raw === "object" && raw !== null && "$eq" in raw
            ? String((raw as { $eq: string }).$eq)
            : null;
      segments.push(encodeCategorical(cat, sdef));
      continue;
    }
    segments.push(null);
  }

  return { segments, dims, keys, weights };
}

function decodeImageBytes(bytesBase64?: string): Uint8Array | undefined {
  if (!bytesBase64) return undefined;
  return Uint8Array.from(Buffer.from(bytesBase64, "base64"));
}

export async function buildQueryImageVectors(
  def: CollectionDef,
  image: QueryImageInput | undefined,
  embedService: EmbedService,
  groundImage?: GroundImageFn
): Promise<Record<string, number[]>> {
  if (!image) return {};
  const out: Record<string, number[]> = {};
  let bytes = image.bytes ?? decodeImageBytes(image.bytesBase64);
  let mimeType = image.mimeType;
  let url = image.url;

  if (image.url) {
    const fetched = await fetchRemoteImageSafe(image.url);
    if (!fetched.ok) {
      throw new Error(`image query fetch failed: ${fetched.reason}`);
    }
    bytes = fetched.bytes;
    mimeType = fetched.contentType;
  }

  if (!image.url && !bytes?.length) {
    throw new Error("image query requires url, bytes, or bytesBase64");
  }

  // Visual grounding: crop the salient product region before embedding. On success the
  // grounded bytes replace the input and the url is dropped so the embed fn can't refetch.
  if (groundImage && bytes?.length) {
    const grounded = await groundImage({ url, bytes, mimeType });
    if (grounded) {
      bytes = grounded.bytes;
      mimeType = grounded.mimeType;
      url = undefined;
    }
  }

  for (const [name, sdef] of Object.entries(def.spaces ?? {})) {
    if (sdef.kind !== "image") continue;
    const vec = await embedService.embedQuery({
      image: {
        url,
        bytes,
        mimeType,
      },
      model: sdef.model,
      dim: sdef.dim,
      taskType: sdef.taskType ?? "RETRIEVAL_QUERY",
      inputType: "query",
    });
    out[name] = vec;
  }
  return out;
}
