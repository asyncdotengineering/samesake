// Dual-form embedder factories.
//
// Each factory returns one object that is simultaneously:
//   - callable as a single-request EmbedFn — routes to the provider's
//     SINGLE-content endpoint (lowest latency; the search query path);
//   - exposing `.many(reqs)` — routes to the provider's BATCH endpoint and
//     auto-chunks to caps.maxBatch (throughput; the ingest path);
//   - exposing `.caps` — an immutable, capability-honest descriptor.
//
// `model` and `dim` are ALWAYS caller-supplied per request (EmbedRequest
// requires both); the factory `dim`/`taskType` options are fallbacks for
// direct, outside-the-matcher use only. No consumer number (e.g. 768) appears
// as a default anywhere here.
import type { EmbedRequest } from "@samesake/core";
import type { Embedder, EmbedderCaps } from "./types.ts";
import {
  assertDim,
  fail,
  imageNotSupported,
  imageToInlineData,
  resolveKey,
} from "./shared.ts";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const VOYAGE_BASE = "https://api.voyageai.com/v1";

interface GeminiOpts {
  dim?: number;
  taskType?: string;
}
interface VoyageOpts {
  dim?: number;
}

type GeminiPart = {
  text?: string;
  inline_data?: { mime_type: string; data: string };
};
type GeminiBatchEntry = {
  model: string;
  content: { parts: GeminiPart[] };
  outputDimensionality?: number;
  taskType?: string;
};

/** Weld the single + batch closures and the (frozen) caps onto one callable object. */
function makeEmbedder(
  single: (req: EmbedRequest) => Promise<number[]>,
  many: (reqs: EmbedRequest[]) => Promise<number[][]>,
  caps: EmbedderCaps,
): Embedder {
  const fn = single as Embedder;
  fn.many = many;
  Object.defineProperty(fn, "caps", {
    value: Object.freeze(caps),
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return fn;
}

/** Capability-honesty gate: throw (never silently coerce) when caps.image is false. */
function rejectImageIfUnsupported(
  req: EmbedRequest,
  caps: EmbedderCaps,
  provider: string,
): void {
  if (req.image && !caps.image) throw imageNotSupported(provider);
}

// ── Gemini (multimodal reference) ───────────────────────────────────────

async function geminiPart(req: EmbedRequest): Promise<GeminiPart> {
  if (req.image && (req.image.bytes || req.image.url)) {
    const { b64, mimeType } = await imageToInlineData(req.image);
    return { inline_data: { mime_type: mimeType, data: b64 } };
  }
  return { text: req.text ?? "" };
}

async function geminiSingle(req: EmbedRequest, opts: GeminiOpts): Promise<number[]> {
  const dim = req.dim ?? opts.dim;
  const taskType = req.taskType ?? opts.taskType;
  const part = await geminiPart(req);
  const res = await fetch(`${GEMINI_BASE}/models/${req.model}:embedContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": resolveKey("GEMINI_API_KEY", "gemini"),
    },
    body: JSON.stringify({
      model: `models/${req.model}`,
      content: { parts: [part] },
      ...(dim !== undefined ? { outputDimensionality: dim } : {}),
      ...(taskType ? { taskType } : {}),
    }),
  });
  if (!res.ok) await fail(res, "gemini embed");
  const data = (await res.json()) as { embedding?: { values?: number[] } };
  const vec = data.embedding?.values;
  if (!vec) throw new Error("[@samesake/embed] gemini embed: response had no embedding.values");
  assertDim(vec, dim, "gemini");
  return vec;
}

async function geminiBatch(slice: EmbedRequest[], opts: GeminiOpts): Promise<number[][]> {
  const requests: GeminiBatchEntry[] = [];
  for (const r of slice) {
    const dim = r.dim ?? opts.dim;
    const taskType = r.taskType ?? opts.taskType;
    const part = await geminiPart(r);
    requests.push({
      model: `models/${r.model}`,
      content: { parts: [part] },
      ...(dim !== undefined ? { outputDimensionality: dim } : {}),
      ...(taskType ? { taskType } : {}),
    });
  }
  const res = await fetch(
    `${GEMINI_BASE}/models/${slice[0].model}:batchEmbedContents`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": resolveKey("GEMINI_API_KEY", "gemini"),
      },
      body: JSON.stringify({ requests }),
    },
  );
  if (!res.ok) await fail(res, "gemini batch embed");
  const data = (await res.json()) as { embeddings?: { values?: number[] }[] };
  const all = data.embeddings;
  if (!Array.isArray(all)) {
    throw new Error("[@samesake/embed] gemini batch: response had no embeddings array");
  }
  return slice.map((r, i) => {
    const vec = all[i]?.values;
    if (!vec) {
      throw new Error(`[@samesake/embed] gemini batch: missing vector at index ${i}`);
    }
    assertDim(vec, r.dim ?? opts.dim, "gemini");
    return vec;
  });
}

async function geminiMany(
  reqs: EmbedRequest[],
  opts: GeminiOpts,
  caps: EmbedderCaps,
): Promise<number[][]> {
  if (reqs.length === 0) return [];
  const maxBatch = caps.maxBatch;
  const out: number[][] = [];
  for (let i = 0; i < reqs.length; i += maxBatch) {
    const chunk = await geminiBatch(reqs.slice(i, i + maxBatch), opts);
    for (const v of chunk) out.push(v);
  }
  return out;
}

// ── Voyage (text-only — the capability-honesty / neutrality proof) ──────

async function voyageSingle(req: EmbedRequest, opts: VoyageOpts): Promise<number[]> {
  const dim = req.dim ?? opts.dim;
  const res = await fetch(`${VOYAGE_BASE}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resolveKey("VOYAGE_API_KEY", "voyage")}`,
    },
    body: JSON.stringify({
      model: req.model,
      input: [req.text ?? ""],
      ...(dim !== undefined ? { output_dimension: dim } : {}),
      ...(req.inputType ? { input_type: req.inputType } : {}),
    }),
  });
  if (!res.ok) await fail(res, "voyage embed");
  const data = (await res.json()) as { data?: { embedding?: number[] }[] };
  const vec = data.data?.[0]?.embedding;
  if (!vec) {
    throw new Error("[@samesake/embed] voyage embed: response had no data[0].embedding");
  }
  assertDim(vec, dim, "voyage");
  return vec;
}

async function voyageBatch(slice: EmbedRequest[], opts: VoyageOpts): Promise<number[][]> {
  // Voyage's /embeddings endpoint is natively batched: one call takes an input
  // array and returns one embedding per entry, in order. output_dimension /
  // input_type are call-level (a batch targets one vector space).
  const first = slice[0];
  const dim = first.dim ?? opts.dim;
  const res = await fetch(`${VOYAGE_BASE}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resolveKey("VOYAGE_API_KEY", "voyage")}`,
    },
    body: JSON.stringify({
      model: first.model,
      input: slice.map((r) => r.text ?? ""),
      ...(dim !== undefined ? { output_dimension: dim } : {}),
      ...(first.inputType ? { input_type: first.inputType } : {}),
    }),
  });
  if (!res.ok) await fail(res, "voyage batch embed");
  const data = (await res.json()) as { data?: { embedding?: number[] }[] };
  const all = data.data;
  if (!Array.isArray(all)) {
    throw new Error("[@samesake/embed] voyage batch: response had no data array");
  }
  return slice.map((r, i) => {
    const vec = all[i]?.embedding;
    if (!vec) {
      throw new Error(`[@samesake/embed] voyage batch: missing embedding at index ${i}`);
    }
    assertDim(vec, r.dim ?? opts.dim, "voyage");
    return vec;
  });
}

async function voyageMany(
  reqs: EmbedRequest[],
  opts: VoyageOpts,
  caps: EmbedderCaps,
): Promise<number[][]> {
  if (reqs.length === 0) return [];
  const maxBatch = caps.maxBatch;
  const out: number[][] = [];
  for (let i = 0; i < reqs.length; i += maxBatch) {
    const chunk = await voyageBatch(reqs.slice(i, i + maxBatch), opts);
    for (const v of chunk) out.push(v);
  }
  return out;
}

// ── Factories ───────────────────────────────────────────────────────────

/**
 * Google Gemini — the multimodal reference. gemini-embedding-2 lands text and
 * images in one space, so a text query is directly comparable to a product
 * image. Default dim is provider-native (never a consumer number like 768).
 */
export function gemini(opts: GeminiOpts = {}): Embedder {
  const caps: EmbedderCaps = {
    image: true,
    interleaved: true,
    dims: "any",
    maxBatch: 100, // :batchEmbedContents documented ceiling
  };
  const single = async (req: EmbedRequest): Promise<number[]> => {
    rejectImageIfUnsupported(req, caps, "gemini");
    return geminiSingle(req, opts);
  };
  const many = async (reqs: EmbedRequest[]): Promise<number[][]> => {
    for (const r of reqs) rejectImageIfUnsupported(r, caps, "gemini");
    return geminiMany(reqs, opts, caps);
  };
  return makeEmbedder(single, many, caps);
}

/**
 * Voyage AI — the provider-neutrality proof. Text-only: declares caps.image =
 * false and throws (never silently embeds empty text) when handed an image.
 */
export function voyage(opts: VoyageOpts = {}): Embedder {
  const caps: EmbedderCaps = {
    image: false,
    interleaved: false,
    dims: "any",
    maxBatch: 128, // /embeddings per-call input ceiling
  };
  const single = async (req: EmbedRequest): Promise<number[]> => {
    rejectImageIfUnsupported(req, caps, "voyage");
    return voyageSingle(req, opts);
  };
  const many = async (reqs: EmbedRequest[]): Promise<number[][]> => {
    for (const r of reqs) rejectImageIfUnsupported(r, caps, "voyage");
    return voyageMany(reqs, opts, caps);
  };
  return makeEmbedder(single, many, caps);
}
