# Design: the `indexing` DSL — enrich → textualization → index contract

**Status:** chosen interface (from `/design-an-interface`, 4 candidates; "D+ synthesis" selected). Breaking redesign — samesake is alpha, no compat ([[embrace-breaking-changes]]).
**Replaces:** stringly `CollectionEmbeddingDef.source` + the `data.title` fallback (`embed-index.ts:348-349`), the manual `composeFashionEmbedDoc` step, the proposed optional `PipelineDef.compose?/gate?` hooks (rev 3), and the hardcoded apparel skip in the generic indexer (`embed-index.ts:339-345`).
**Feeds:** `rfcs/rfc-pipeline-integrity-seams.md` G2/G3/G5/REQ-11b and the migration plan in `rfcs/refactor-indexing-dsl/` (or the `/request-refactor-plan` issue).

## Principle

Every retrieval surface is a first-class **derived column with a required `build` function**, declared in one keyed map (`indexing.surfaces`) that sits beside the existing keyed maps `embeddings` and `spaces` and obeys the same grammar. The index **gate** is its required sibling. Builders and the gate are functions, so — exactly like `enrich.stages[].prompt/schema` today — they live on the in-process config, never in the DB-stored def. There is no string template, no fallback, no optional hook, and no fashion semantics in the generic indexer.

## Types (`@samesake/core`)

```ts
export interface DerivedDocContext {
  readonly data: Record<string, unknown>;       // raw catalog row
  readonly enriched: Record<string, unknown>;   // merged enrich output (gate ran first → non-null)
}

// A surface = a required text builder bound to one consumer, by KEY (not a $-string).
export type DerivedDocDef =
  | { kind: "dense";  build: (ctx: DerivedDocContext) => string; embedding: string } // → embeddings[key]
  | { kind: "rerank"; build: (ctx: DerivedDocContext) => string }                    // → the reranker
  | { kind: "fts";    build: (ctx: DerivedDocContext) => string };                   // → FTS tsvector

// Generic gate: verdict only. The indexer obeys it; it holds zero domain knowledge.
export type IndexGate = (ctx: DerivedDocContext) => { index: boolean; reason?: string };

export interface IndexingDef {
  surfaces: Record<string, DerivedDocDef>;  // REQUIRED, ≥1 entry
  gate: IndexGate;                           // REQUIRED (use `gates.always` for index-everything)
}

// Serializable def (DB / HTTP) — declarations only; carries a MANIFEST so the server can
// validate cross-refs offline without the functions present.
export interface CollectionDef {
  name?: string;
  fields: Record<string, CollectionFieldDef>;
  enrich?: PipelineDef;
  sources?: ConnectorDef[];
  embeddings?: Record<string, CollectionEmbeddingDef>;   // loses `source` — pure {model,dim,taskType}
  spaces?: Record<string, SpaceDef>;
  search?: CollectionSearchDef;
  /** Manifest mirror of `indexing` (no functions): surface keys + kinds + embedding cross-refs.
   *  Lets the server validate references when the def is loaded from the DB. */
  indexingManifest?: { surfaces: Record<string, { kind: "dense" | "rerank" | "fts"; embedding?: string }> };
}

// In-process authoring shape (what `collection()` / templates return). NOT serialized.
// `indexing` is non-optional → omitting it is a COMPILE error, not a runtime forget.
export interface AuthoredCollection extends CollectionDef {
  indexing: IndexingDef;
}
```

Key relationship: `CollectionEmbeddingDef` drops `source` and becomes pure consumer config; a `dense` surface names its `embedding` key, and `search.channels[kind:"fts"]` references an `fts` surface by key. Three keyed maps, one grammar:

| map | member | role |
|---|---|---|
| `embeddings` | `{ model, dim, taskType }` | dense **consumer** |
| `spaces` | `{ kind, … }` | structured-vector **consumer** |
| `surfaces` | `{ kind, build, embedding? }` | **text producer** feeding a consumer |

## Runtime semantics

1. **Persist at enrich time.** `enrichOne` runs the inference stages, then evaluates `indexing.gate(ctx)` and every `surfaces[].build(ctx)`, and persists the result: `pipeline_status` from the gate (`ready`/`quarantined` + `reason`), and the built surface texts into columns (e.g. `doc`/`rerank_doc`/`fts_src`). "Enrich's output **is** the indexable document," on disk — so re-index (e.g. an embedder swap) never re-runs domain logic. (C's insight folded into D.)
2. **Index consumes typed surfaces.** `indexCollection` selects `pipeline_status='ready'` rows and, per `dense` surface, embeds its built text into `embeddings[embedding]`'s vector column; `fts` text feeds the tsvector; `rerank_doc` is already stored. No `$enriched.*` resolution, no title fallback.
3. **Empty build = explicit skip.** If a required `build` returns `""`, the row is quarantined with `reason:"empty:<surface>"` — never silently substituted.
4. **Gate is generic.** The indexer reads `{index, reason}`; the fashion *predicate* (non-apparel, `category==="other"`, confidence floor + `uncertain_fields` + cross-signal, RFC REQ-7) lives in `fashion.indexing().gate`.

## Fashion template

```ts
export function fashionIndexing(opts: { titleKey?: string } = {}): IndexingDef {
  const titleKey = opts.titleKey ?? "title";
  return {
    surfaces: {
      embed_doc:  { kind: "dense", embedding: "doc",
        // graded/compositional ONLY — NO category/gender/color/material/brand (filter-not-embed, REQ-11b)
        build: ({ data, enriched }) => composeFashionEmbedDoc({ title: String(data[titleKey] ?? "") }, enriched) },
      rerank_doc: { kind: "rerank",
        build: ({ data, enriched }) => composeFashionRerankDoc({ title: String(data[titleKey] ?? "") }, enriched) },
      fts_doc:    { kind: "fts",
        build: ({ data, enriched }) => [data[titleKey], enriched.product_type, enriched.raw_color,
                                        ...(enriched.styles as string[] ?? [])].filter(Boolean).join(" ") },
    },
    gate: ({ enriched }) => {
      if (enriched.is_apparel_product === false) return { index: false, reason: "non-apparel" };
      if (enriched.category === "other")          return { index: false, reason: "category-other" };
      if (Number(enriched.confidence ?? 1) < FASHION_CONFIDENCE_FLOOR) return { index: false, reason: "low-confidence" };
      if (intersects(asArray(enriched.uncertain_fields), ["category","gender","colors"])) return { index: false, reason: "uncertain-load-bearing" };
      if (!crossSignalAgrees({ data, enriched })) return { index: false, reason: "cross-signal-disagree" };
      return { index: true };
    },
  };
}
// fashion.indexing replaces the removed fashion.composeEmbedDoc / fashion.embedDocSource / FASHION_EMBED_DOC_SOURCE.
```

## What breaks (alpha — intended)
- `CollectionEmbeddingDef.source`, `TextSpaceDef.source` (text) **removed**; image space `source` → `imagePath` (rename for clarity). `"$enriched.embed_doc"` strings deleted everywhere.
- `resolveEmbedTemplate` + the `$`-token engine **deleted** for the doc path (kept only if `spaces` image/text paths still need `path` resolution — evaluate during refactor).
- `composeFashionEmbedDoc` becomes an internal builder; `fashion.composeEmbedDoc`/`embedDocSource`/`FASHION_EMBED_DOC_SOURCE` **removed** from the public surface, replaced by `fashion.indexing`.
- `CollectionDef.indexing` (authoring) **required** → every config + the 6 example scripts + playground fail to compile until they declare it. This is the point: it surfaces every collection that relied on the title fallback.
- Hardcoded apparel skip in `embed-index.ts:339-345` **deleted**; behavior moves to `fashion.indexing().gate`. Re-index required.
- DB-loaded defs (no functions) cannot index — same constraint already enforced for `enrich` (`enrich-pipeline.ts:173-180`); error message generalizes to `indexing`.

## Why this shape (vs the other three candidates)
- vs **B (single `project()`):** keeps per-surface override (tweak one builder without rewriting all) and lives on the def (one home) rather than a by-name registry on the matcher.
- vs **C (pipeline materializer):** smaller blast radius (doesn't redesign `StageDef`/`PipelineDef` or force `enrich` on no-LLM collections) while still adopting C's persist-at-enrich semantics.
- vs **A (closed `surfaces` union):** open keyed map (`Record<string,…>`) is extensible and matches `embeddings`/`spaces`; the manifest gives the same offline-validation A wanted.
