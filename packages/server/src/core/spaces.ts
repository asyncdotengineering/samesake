import type {
  CategoricalSpaceDef,
  NumberSpaceDef,
  RecencySpaceDef,
  SpaceDef,
  TextSpaceDef,
} from "@samesake/core";

export function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return vec.slice();
  return vec.map((x) => x / norm);
}

function rampEncode(t: number, dims: number): number[] {
  const peak = Math.max(0, Math.min(1, t)) * (dims - 1);
  const raw = new Array<number>(dims).fill(0);
  for (let i = 0; i < dims; i++) {
    raw[i] = Math.max(0, 1 - Math.abs(i - peak) / 2);
  }
  return l2Normalize(raw);
}

function clamp01(x: number, min: number, max: number, scale: "linear" | "log"): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const clamped = Math.max(lo, Math.min(hi, x));
  if (hi === lo) return 0.5;
  if (scale === "log") {
    const num = Math.log(clamped - lo + 1);
    const den = Math.log(hi - lo + 1);
    return den === 0 ? 0.5 : num / den;
  }
  return (clamped - lo) / (hi - lo);
}

export function encodeText(vec: number[]): number[] {
  return l2Normalize(vec);
}

export function encodeImage(vec: number[]): number[] {
  return l2Normalize(vec);
}

export function encodeNumber(
  x: number | null | undefined,
  opts: Pick<NumberSpaceDef, "min" | "max" | "scale" | "dims">
): number[] {
  if (x == null || Number.isNaN(Number(x))) {
    return new Array(opts.dims).fill(0);
  }
  const t = clamp01(Number(x), opts.min, opts.max, opts.scale ?? "linear");
  return rampEncode(t, opts.dims);
}

export function encodeNumberQuery(
  target: number | null | undefined,
  opts: Pick<NumberSpaceDef, "min" | "max" | "scale" | "dims" | "mode">
): number[] {
  if (opts.mode === "max") return rampEncode(1, opts.dims);
  if (opts.mode === "min") return rampEncode(0, opts.dims);
  return encodeNumber(target, opts);
}

export function encodeRecency(
  ageDays: number | null | undefined,
  opts: Pick<RecencySpaceDef, "halfLifeDays" | "dims">
): number[] {
  if (ageDays == null || Number.isNaN(ageDays) || ageDays < 0) {
    return new Array(opts.dims).fill(0);
  }
  const v = Math.exp((-Math.LN2 * ageDays) / opts.halfLifeDays);
  return rampEncode(v, opts.dims);
}

export function encodeRecencyQuery(opts: Pick<RecencySpaceDef, "dims">): number[] {
  return rampEncode(1, opts.dims);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function encodeCategorical(
  value: string | null | undefined,
  opts: Pick<CategoricalSpaceDef, "values" | "dims">
): number[] {
  if (value == null || value === "") {
    return new Array(opts.dims).fill(0);
  }
  const values = opts.values;
  if (values && values.length > 0 && values.length <= opts.dims) {
    const idx = values.indexOf(value);
    if (idx < 0) return new Array(opts.dims).fill(0);
    const raw = new Array(opts.dims).fill(0);
    raw[idx] = 1;
    return l2Normalize(raw);
  }
  const bucket = fnv1a(value) % opts.dims;
  const raw = new Array(opts.dims).fill(0);
  raw[bucket] = 1;
  return l2Normalize(raw);
}

export function totalSpaceDims(spaces: Record<string, SpaceDef>): number {
  let sum = 0;
  for (const def of Object.values(spaces)) {
    if (def.kind === "text" || def.kind === "image") sum += def.dim;
    else sum += def.dims;
  }
  return sum;
}

export function spaceSegmentDim(def: SpaceDef): number {
  return def.kind === "text" || def.kind === "image" ? def.dim : def.dims;
}

export function assembleDocVector(
  segments: Array<number[] | null>,
  dims: number[]
): number[] {
  const n = segments.length;
  if (n === 0) return [];
  const sqrtN = Math.sqrt(n);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = dims[i]!;
    const seg = segments[i];
    if (!seg || seg.length !== d) {
      out.push(...new Array(d).fill(0));
      continue;
    }
    const scaled = l2Normalize(seg).map((x) => x / sqrtN);
    out.push(...scaled);
  }
  return out;
}

export function assembleQueryVector(
  segments: Array<number[] | null>,
  weights: number[],
  dims: number[]
): number[] {
  const raw: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const d = dims[i]!;
    const w = weights[i] ?? 1;
    const seg = segments[i];
    if (!seg || seg.length !== d) {
      raw.push(...new Array(d).fill(0));
      continue;
    }
    const normed = l2Normalize(seg);
    raw.push(...normed.map((x) => x * w));
  }
  return l2Normalize(raw);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function splitVector(vec: number[], dims: number[]): number[][] {
  const out: number[][] = [];
  let offset = 0;
  for (const d of dims) {
    out.push(vec.slice(offset, offset + d));
    offset += d;
  }
  return out;
}

export function weightedSegmentCosines(
  docVec: number[],
  querySegments: Array<number[] | null>,
  queryWeights: number[],
  dims: number[]
): number[] {
  const docSegs = splitVector(docVec, dims);
  const n = dims.length;
  const sqrtN = Math.sqrt(n);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const dSeg = docSegs[i]!;
    const qSeg = querySegments[i];
    if (!qSeg) {
      out.push(0);
      continue;
    }
    const dNorm = l2Normalize(dSeg.map((x) => x * sqrtN));
    out.push(cosine(dNorm, l2Normalize(qSeg)) * (queryWeights[i] ?? 1));
  }
  return out;
}

export type TextSpaceDefRuntime = TextSpaceDef;
export type NumberSpaceDefRuntime = NumberSpaceDef;
export type RecencySpaceDefRuntime = RecencySpaceDef;
export type CategoricalSpaceDefRuntime = CategoricalSpaceDef;
