// The canonical shape of a samesake domain preset. A preset is a shippable bundle of the
// generic config objects (@samesake/core's PipelineDef / IndexingDef / CollectionDedupDef /
// CollectionFieldDef), pre-populated for one domain. The engine consumes generic config and
// hardcodes no domain content; a preset hands it the domain-specific content.
//
// These types live here, not in @samesake/core, because they are PRESET vocabulary (a layer on
// top of the core primitives), and because the wider canonical-API migration of AttrSpec /
// FieldSpec into core is a separate task. Presets depends only on core; it must not reach the
// server, so the eval-target type is defined locally and kept structurally identical to
// @samesake/server's AttrSpec (see packages/server/src/core/evaluate-enrich.ts).
import type {
  CollectionDedupDef,
  CollectionFieldDef,
  IndexingDef,
  PipelineDef,
  SchemaInput,
} from "@samesake/core";

/** Catalog schema returned by a preset's `fields`. A map of declared collection fields. */
export type FieldSpec = Record<string, CollectionFieldDef>;

/**
 * One scorable attribute for enrichment-accuracy eval. Structurally identical to
 * @samesake/server's AttrSpec so `matcher.evaluateEnrichment` consumes preset output directly.
 */
export interface AttrSpec {
  /** Attribute key, e.g. "category" or "colors". */
  name: string;
  /** single = one enum/text/boolean value; multi = an array of values. */
  kind: "single" | "multi";
  /** Path within the `enriched` object to read the prediction from. Defaults to `name`. */
  path?: string;
  /** Values that mean "no value" beyond ""/null/missing (e.g. "unknown"). Defaults to ["unknown"]. */
  empty?: string[];
}

/** Search-side query-understanding defaults carried by a preset's optional `nlq`. */
export interface NlqPreset {
  instructions?: string;
  schema?: () => SchemaInput;
}

/**
 * A predefined, overridable enrichment + indexing bundle for one domain.
 *
 * `fields`, `enrich`, `indexing`, and `dedup` are `opts`-taking functions so the consumer can
 * supply model/dimension/data-key parameters at composition time; a preset supplies sensible
 * defaults when `opts` is omitted and MUST honor any consumer-supplied value (contract §3.5:
 * a preset never mandates a model, provider, or dimension). The `opts` shape is intentionally
 * left open at this seam; each concrete preset narrows it (the canonical-API PRD fixes the
 * field-level schema later). Method syntax keeps assignment bivariant so concrete presets can
 * take narrower, typed option objects than the seam-level `object`.
 */
export interface EnrichPreset {
  /** Stable, unique, lowercase identifier (e.g. "fashion", "products"). */
  name: string;
  /** Catalog schema the engine persists and searches over. */
  fields(opts?: object): FieldSpec;
  /** Extraction pipeline: ordered stages + prompts mapping raw data into the schema. */
  enrich(opts?: object): PipelineDef;
  /** Indexing surfaces (embed / rerank / fts) + promotion gate. */
  indexing(opts?: object): IndexingDef;
  /** Optional cross-vendor entity-resolution config (marketplace case). */
  dedup?(opts?: object): CollectionDedupDef;
  /** Ground-truth attribute targets `scoreEnrichment` evaluates accuracy against. */
  evalAttributes(): AttrSpec[];
  /** Optional search-side query-understanding defaults. */
  nlq?: NlqPreset;
}
