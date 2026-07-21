import type {
  CollectionCutoffDef,
  CollectionDef,
  GenerateFn,
  RerankFn,
  Scope,
  SearchMode,
} from "@samesake/core";
import type { Embedder } from "@samesake/embed";
import type { EmbedService, ParseNlqDeps } from "./deps.ts";
import {
  buildQueryAspectImageVectors,
  parseSearchWeights,
  resolveAspectPlans,
} from "./search-query.ts";
import {
  mergeFilters,
  parseNlq,
  shouldSkipNlq,
  type NlqParseResult,
} from "./nlq.ts";
import { normalizeFiltersToConstraintPredicates, type SearchFilters } from "./filters.ts";
import { openVocabFieldNames, type VocabCandidates } from "./vocab.ts";
import type { Retriever, VocabProvider } from "./ports.ts";
import type { RankedRow } from "./plan.ts";
import type { SearchHit, SearchOpts, SearchResult } from "./types.ts";
import { applyCutoff, type CutoffEvidence } from "./cutoff.ts";
import { applyRankingPolicy } from "./ranking.ts";
import { buildConstraintTrace } from "./constraint-trace.ts";
import { mergeBlendedRerank, rerankCandidateText } from "./rerank.ts";

export type SearchCallOpts = Omit<SearchOpts, "q">;

export interface SearchConfig {
  preset?: string;
  collection?: CollectionDef;
  retriever: Retriever;
  generate: GenerateFn;
  embed: Embedder;
  vocab?: VocabProvider;
  rerank?: RerankFn;
  cutoff?: CollectionCutoffDef;
  facets?: boolean;
}

export type SearchFn = (q: string, opts?: SearchCallOpts) => Promise<SearchResult>;

interface LoadedVocab {
  candidates: VocabCandidates;
  values: Record<string, string[]>;
}

type GroundingDecision = {
  parsed: string;
  mapped?: string;
  action: "kept" | "mapped" | "dropped";
};

async function loadVocab(
  def: CollectionDef,
  provider: VocabProvider,
  scope: Scope | undefined
): Promise<LoadedVocab | undefined> {
  const fields = openVocabFieldNames(def);
  if (!fields.length) return { candidates: {}, values: {} };
  try {
    const entries = await Promise.all(
      fields.map(async (field) => [field, await provider(field, scope)] as const)
    );
    return {
      values: Object.fromEntries(entries),
      candidates: Object.fromEntries(
        entries.map(([field, values]) => [field, values.map((value) => ({ value, count: 1 }))])
      ),
    };
  } catch {
    return undefined;
  }
}

function groundingFor(loaded: LoadedVocab): NonNullable<ParseNlqDeps["groundVocab"]> {
  return async (_schema, _collection, values) => {
    const decisions: Record<string, GroundingDecision[]> = {};
    for (const [field, parsedValues] of Object.entries(values)) {
      const available = loaded.values[field] ?? [];
      const byLower = new Map(available.map((value) => [value.toLowerCase(), value]));
      decisions[field] = parsedValues.map((parsed) => {
        const mapped = byLower.get(parsed.toLowerCase());
        if (!mapped) return { parsed, action: "dropped" };
        return mapped === parsed
          ? { parsed, action: "kept" }
          : { parsed, mapped, action: "mapped" };
      });
    }
    return { available: true, decisions };
  };
}

function predicatesFor(
  def: CollectionDef,
  nlq: NlqParseResult,
  explicit: SearchFilters,
  merged: SearchFilters
) {
  return Object.entries(merged).flatMap(([field, value]) => {
    const source = Object.hasOwn(explicit, field)
      ? "explicit"
      : Object.hasOwn(nlq.deterministicFilters, field)
        ? "deterministic"
        : "nlq";
    return normalizeFiltersToConstraintPredicates({ [field]: value }, def, source);
  });
}

function hitFromRow(row: RankedRow): SearchHit {
  const data = { ...row.data };
  return { ...data, id: row.id, score: row.rrf_score, data };
}

function evidenceFor(row: RankedRow, hit: SearchHit, cutoff: CollectionCutoffDef | undefined): CutoffEvidence {
  const ftsPresent = row.fts_present === true || row.legRanks?.fts !== undefined;
  const value = cutoff?.field ? hit[cutoff.field] ?? hit.data[cutoff.field] : undefined;
  return { ftsPresent, cos: row.cos_sim ?? null, value };
}

function rerankImage(image: SearchCallOpts["image"]): { url?: string; bytes?: Uint8Array; mimeType?: string } | undefined {
  if (!image) return undefined;
  return { url: image.url, bytes: image.bytes, mimeType: image.mimeType };
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 20;
  return Math.max(1, Math.floor(value));
}

function boundedOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(200, Math.max(0, Math.floor(value)));
}

export function createSearch(config: SearchConfig): SearchFn {
  if (!config.collection) {
    if (config.preset) {
      throw new Error(`createSearch: preset "${config.preset}" must be composed into a CollectionDef before use`);
    }
    throw new Error("createSearch: provide a collection");
  }

  const def = config.collection;
  const embedService: EmbedService = {
    embedQuery: config.embed,
    embedMany: config.embed.many,
  };
  return async (q, opts = {}) => {
    const started = Date.now();
    const query = q.trim();
    if (!query && !opts.image) throw new Error("search requires a non-empty q or image");

    const scope = opts.scope as Scope | undefined;
    const loadedVocab = config.vocab ? await loadVocab(def, config.vocab, scope) : undefined;
    const nlq = await parseNlq(
      def,
      query,
      { generate: config.generate, groundVocab: loadedVocab ? groundingFor(loadedVocab) : undefined },
      loadedVocab
        ? {
            candidates: { available: true, candidates: loadedVocab.candidates },
            schema: def.name ?? "collection",
            collection: def.name ?? "collection",
            scopeCols: {},
          }
        : undefined
    );
    const explicitFilters = opts.filters ?? {};
    const merged = mergeFilters(nlq.filters, explicitFilters);
    const hasImage = !!opts.image;
    const mode: SearchMode = opts.mode ?? (hasImage ? "similar" : "intent");
    const weights = parseSearchWeights(def, opts.weights, mode, hasImage);
    const imageVectors = await buildQueryAspectImageVectors(def, opts.image, embedService);
    const semanticText = nlq.parsed.semantic_query || query || "image query";
    const aspectPlans = await resolveAspectPlans(
      def,
      weights: {
        fts: weights.fts,
        cosine: weights.cosine,
        recency: weights.recency,
        aspects: weights.aspects,
      },
      nlq,
      semanticText,
      query,
      mode,
      hasImage,
      imageVectors,
      embedService
    );
    const offset = boundedOffset(opts.offset);
    const limit = boundedLimit(opts.limit);
    const plan = {
      query: (nlq.parsed.lexical_query?.trim() || query) || null,
      vectors: aspectPlans.flatMap((aspect) =>
        aspect.queryVector ? [{ embedding: aspect.name, vec: aspect.queryVector }] : []
      ),
      filters: predicatesFor(def, nlq, explicitFilters, merged),
      weights,
      ...(scope ? { scope } : {}),
      limit: limit + offset,
    };
    const ranked = await config.retriever(plan);
    const initialHits = ranked.map(hitFromRow);
    const cutoffDef = config.cutoff ?? def.search?.cutoff;
    const evidence = ranked.map((row, index) => evidenceFor(row, initialHits[index]!, cutoffDef));
    const cutoff = Object.keys(nlq.filters).length === 0
      ? applyCutoff(initialHits, evidence, cutoffDef)
      : { hits: initialHits, dropped: 0 };
    let hits = cutoff.hits;

    if (def.search?.rankingPolicy && hits.length) {
      hits = applyRankingPolicy(hits, def.search.rankingPolicy).hits;
    }

    if (config.rerank && opts.rerank !== false && hits.length > 1) {
      try {
        const ordered = await config.rerank({
          query,
          image: rerankImage(opts.image),
          candidates: hits.map((hit) => ({
            id: hit.id,
            text: rerankCandidateText(hit),
            data: hit.data,
            score: hit.score,
          })),
          topK: Math.min(limit + offset, hits.length),
        });
        hits = mergeBlendedRerank(hits, ordered);
      } catch {
        hits = hits;
      }
    }

    const facets = config.facets && opts.facets?.length && config.retriever.facets
      ? await config.retriever.facets({ fields: opts.facets, filters: plan.filters, scope })
      : undefined;
    const result: SearchResult = {
      hits: hits.slice(offset, offset + limit),
      constraintTrace: buildConstraintTrace(def, {
        semanticQuery: semanticText,
        derivedFilters: nlq.filters,
        deterministicFilters: nlq.deterministicFilters,
        explicitFilters,
        appliedFilters: merged,
        groundedValues: nlq.groundedValues,
        excludedTerms: nlq.excludeTerms,
        budgetHints: nlq.budgetHints,
      }),
      relaxed: false,
      relaxedFields: [],
      took_ms: Date.now() - started,
      total_candidates: ranked.length,
      ...(cutoff.dropped > 0 ? { cutoff_dropped: cutoff.dropped } : {}),
      ...(facets ? { facets } : {}),
    };
    if (!shouldSkipNlq(def, query)) {
      result.parsed = nlq.parsed;
      if (nlq.degraded) result.nlq_degraded = true;
    }
    return result;
  };
}
