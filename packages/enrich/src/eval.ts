// Enrichment-accuracy evaluation — the enrichment twin of evaluateSearch (calibrate-search.ts).
//
// Search relevance measures the DOWNSTREAM symptom; this measures the ROOT cause: did the
// enrich pipeline extract the RIGHT structured attributes? Garbage in (mis-extracted color,
// missed neckline, hallucinated occasion) → garbage ranked, and a pure search eval only sees
// the blurred result, not the cause. This scores the pipeline's `enriched.*` output against a
// human-labeled gold set with per-attribute precision / recall / F1, so any change to the enrich
// prompts, taxonomy, or confidence gate can be gated on measured extraction accuracy.
//
// The scoring core (scoreEnrichment) is pure — no DB, no LLM — so it is unit-testable and the
// same numbers reproduce offline from a fixture. The service wrapper (makeEvaluateEnrichService,
// which only reads persisted `enriched` rows and hands them to this scorer) lives in
// @samesake/server's evaluate-enrich.ts.
import { getByPath } from "@samesake/core";

export type AttrKind = "single" | "multi";

/** Describes one scorable attribute: how to read it and what counts as "no value". */
export interface AttrSpec {
  /** Attribute key, e.g. "category" or "colors". */
  name: string;
  /** single = one enum/text/boolean value; multi = an array of values. */
  kind: AttrKind;
  /** Path within the `enriched` object to read the prediction from. Defaults to `name`. */
  path?: string;
  /** Values that mean "no value" beyond ""/null/missing (e.g. "unknown"). Defaults to ["unknown"]. */
  empty?: string[];
}

/** One gold-labeled product. A label KEY that is absent means "unlabeled" → that attribute is
 * skipped for this product. A label VALUE of [] (multi) or "unknown"/"" (single) means
 * "explicitly no value" → it IS scored, so predicting a value counts as a false positive. */
export interface GoldRow {
  id: string;
  title?: string;
  labels: Record<string, string | string[] | boolean | null>;
}

/** One pipeline prediction (a row read from the collection table). */
export interface PredictedRow {
  id: string;
  enriched: Record<string, unknown> | null;
  pipeline_status?: string | null;
  gate_reason?: string | null;
}

export interface AttrMetrics {
  attribute: string;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  /** Total gold values summed across scored products (Σ|gold|) — the recall denominator context. */
  support: number;
  /** Products where this attribute was labeled AND a prediction row existed. */
  scored: number;
}

export interface ProductDiff {
  id: string;
  title?: string;
  status?: string | null;
  errors: Array<{
    attribute: string;
    gold: string[];
    predicted: string[];
    missed: string[];
    hallucinated: string[];
  }>;
}

export interface EnrichEvalResult {
  attributes: AttrMetrics[];
  overall: {
    microPrecision: number;
    microRecall: number;
    microF1: number;
    macroF1: number;
  };
  coverage: {
    gold: number;
    /** Gold products for which a prediction row was found. */
    matched: number;
    /** Matched rows that actually carried an `enriched` object. */
    withEnriched: number;
    /** Gold products with no prediction row at all (data gap, not scored). */
    missing: number;
    /** Prediction-row count by pipeline_status among matched rows. */
    byStatus: Record<string, number>;
  };
  diffs: ProductDiff[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Normalize any label/prediction value to a lowercased Set of non-empty tokens. */
function toSet(value: unknown, empty: Set<string>): Set<string> {
  const push = (out: Set<string>, raw: unknown) => {
    if (raw === null || raw === undefined) return;
    const s = String(raw).trim().toLowerCase();
    if (s === "" || empty.has(s)) return;
    out.add(s);
  };
  const out = new Set<string>();
  if (Array.isArray(value)) {
    for (const v of value) push(out, v);
  } else {
    push(out, value);
  }
  return out;
}

function prf(tp: number, fp: number, fn: number): { precision: number; recall: number; f1: number } {
  // No predictions and no gold for a slot is a vacuous success, not a failure.
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/**
 * Pure scorer. Compares each gold row against its prediction row (matched by id) across the
 * given attribute specs and returns per-attribute + overall precision/recall/F1, coverage, and
 * per-product diffs. Deterministic; no I/O.
 */
export function scoreEnrichment(
  gold: GoldRow[],
  predicted: PredictedRow[],
  attributes: AttrSpec[]
): EnrichEvalResult {
  const byId = new Map(predicted.map((p) => [p.id, p]));
  const acc = new Map<string, { tp: number; fp: number; fn: number; support: number; scored: number }>();
  for (const a of attributes) acc.set(a.name, { tp: 0, fp: 0, fn: 0, support: 0, scored: 0 });

  const coverage = { gold: gold.length, matched: 0, withEnriched: 0, missing: 0, byStatus: {} as Record<string, number> };
  const diffs: ProductDiff[] = [];

  for (const g of gold) {
    const pred = byId.get(g.id);
    if (!pred) {
      coverage.missing++;
      continue;
    }
    coverage.matched++;
    const status = pred.pipeline_status ?? "unknown";
    coverage.byStatus[status] = (coverage.byStatus[status] ?? 0) + 1;
    if (pred.enriched) coverage.withEnriched++;

    const productErrors: ProductDiff["errors"] = [];

    for (const spec of attributes) {
      if (!(spec.name in g.labels)) continue; // unlabeled → skip this attribute for this product
      const empty = new Set((spec.empty ?? ["unknown"]).map((s) => s.toLowerCase()));
      const goldSet = toSet(g.labels[spec.name], empty);
      const predRaw = pred.enriched ? getByPath(pred.enriched, spec.path ?? spec.name) : undefined;
      const predSet = toSet(predRaw, empty);

      let tp = 0;
      let fp = 0;
      let fn = 0;
      for (const v of predSet) (goldSet.has(v) ? tp++ : fp++);
      for (const v of goldSet) if (!predSet.has(v)) fn++;

      const bucket = acc.get(spec.name)!;
      bucket.tp += tp;
      bucket.fp += fp;
      bucket.fn += fn;
      bucket.support += goldSet.size;
      bucket.scored++;

      if (fp > 0 || fn > 0) {
        const goldArr = [...goldSet];
        const predArr = [...predSet];
        productErrors.push({
          attribute: spec.name,
          gold: goldArr,
          predicted: predArr,
          missed: goldArr.filter((v) => !predSet.has(v)),
          hallucinated: predArr.filter((v) => !goldSet.has(v)),
        });
      }
    }

    if (productErrors.length) {
      diffs.push({ id: g.id, title: g.title, status: pred.pipeline_status ?? null, errors: productErrors });
    }
  }

  const attrMetrics: AttrMetrics[] = attributes.map((a) => {
    const b = acc.get(a.name)!;
    const { precision, recall, f1 } = prf(b.tp, b.fp, b.fn);
    return {
      attribute: a.name,
      tp: b.tp,
      fp: b.fp,
      fn: b.fn,
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
      support: b.support,
      scored: b.scored,
    };
  });

  const totals = attrMetrics.reduce((s, a) => ({ tp: s.tp + a.tp, fp: s.fp + a.fp, fn: s.fn + a.fn }), { tp: 0, fp: 0, fn: 0 });
  const micro = prf(totals.tp, totals.fp, totals.fn);
  const scoredAttrs = attrMetrics.filter((a) => a.scored > 0);
  const macroF1 = scoredAttrs.length ? scoredAttrs.reduce((s, a) => s + a.f1, 0) / scoredAttrs.length : 0;

  return {
    attributes: attrMetrics,
    overall: {
      microPrecision: round(micro.precision),
      microRecall: round(micro.recall),
      microF1: round(micro.f1),
      macroF1: round(macroF1),
    },
    coverage,
    diffs,
  };
}
