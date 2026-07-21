// Tier-1 ergonomic factory — wires the shipped pure cores (enrich, clusterBatch,
// scoreEnrichment, contentHash via the store) to an EnrichStore port. The
// factory owns NO retry/backoff/dead-lettering: that state machine lives in the
// store (memoryStore here; a durable store in production). The factory only
// orchestrates load -> transform -> persist across the four lifecycle methods.
import type {
  CollectionDef,
  PipelineDef,
  IndexingDef,
  CollectionDedupDef,
  GenerateFn,
  EmbedFn,
} from "@samesake/core";
import { enrich } from "./enrich.ts";
import { clusterBatch } from "./cluster.ts";
import { scoreEnrichment } from "./eval.ts";
import type {
  AttrSpec,
  GoldRow,
  PredictedRow,
  EnrichEvalResult,
} from "./eval.ts";
import type { RawRow, DedupRow, ClusterDecision } from "./types.ts";
import type { EnrichStore, EnrichedRow } from "./store.ts";
import { memoryStore } from "./memory-store.ts";

export interface Enricher {
  upsert(rows: RawRow[]): Promise<void>;
  enrich(opts?: { limit?: number; concurrency?: number }): Promise<EnrichedRow[]>;
  resolve(opts?: { limit?: number }): Promise<ClusterDecision[]>;
  retryFailed(opts?: { limit?: number }): Promise<EnrichedRow[]>;
  evaluate(gold: GoldRow[]): Promise<EnrichEvalResult>;
}

function isPipeline(def: unknown): def is PipelineDef {
  return !!def && typeof def === "object" && Array.isArray((def as PipelineDef).stages);
}

export function createEnricher(cfg: {
  collection?: CollectionDef;
  pipeline?: PipelineDef;
  indexing?: IndexingDef;
  dedup?: CollectionDedupDef;
  evalAttributes?: AttrSpec[];
  generate: GenerateFn;
  embed?: EmbedFn;
  store?: EnrichStore;
  fewShot?: string;
  concurrency?: number;
}): Enricher {
  let pipeline: PipelineDef | undefined;
  let indexing: IndexingDef | undefined;
  let dedup: CollectionDedupDef | undefined;

  if (cfg.collection) {
    if (!isPipeline(cfg.collection.enrich)) {
      throw new Error("createEnricher: collection has no enrich pipeline");
    }
    pipeline = cfg.collection.enrich;
    indexing = cfg.collection.indexing;
    dedup = cfg.collection.dedup;
  } else {
    pipeline = cfg.pipeline;
    indexing = cfg.indexing;
  }
  if (!pipeline || !indexing) {
    throw new Error("createEnricher: provide a collection or pipeline+indexing");
  }
  dedup = dedup ?? cfg.dedup;
  const evalAttributes = cfg.evalAttributes;
  const generate = cfg.generate;
  const store = cfg.store ?? memoryStore();
  const baseConcurrency = cfg.concurrency;

  // Shared enrich-and-persist loop for both fresh (enrich) and retry (retryFailed)
  // paths. ok:true covers ready AND quarantined (a gate-quarantine is a successful
  // outcome); only ok:false (a thrown stage/surface) routes to recordFailure.
  const run = async (rows: RawRow[], concurrency: number | undefined): Promise<EnrichedRow[]> => {
    const results = await enrich(
      rows,
      { pipeline, indexing },
      { generate, fewShot: cfg.fewShot, concurrency }
    );
    const ready = results.filter((r) => r.ok).map((r) => ({
      id: r.id,
      enriched: r.enriched,
      surfaces: r.surfaces,
      status: r.status,
      gateReason: r.gateReason,
    }));
    await store.writeEnriched(ready);
    for (const f of results.filter((r) => !r.ok)) {
      await store.recordFailure(f.id, f.error ?? "enrich failed");
    }
    return ready;
  };

  return {
    async upsert(rows) {
      await store.upsert(rows);
    },
    async enrich(opts) {
      const rows = await store.loadDirty(opts?.limit ?? 1000);
      return run(rows, opts?.concurrency ?? baseConcurrency);
    },
    async resolve(opts) {
      if (!store.loadEnriched || !store.candidates) {
        throw new Error("resolve requires a store with loadEnriched + candidates");
      }
      if (!dedup) {
        throw new Error("resolve requires a dedup config (collection.dedup or cfg.dedup)");
      }
      const enriched = await store.loadEnriched(opts?.limit ?? 1000);
      const rows: DedupRow[] = enriched.map((e) => ({ id: e.id, fields: e.enriched }));
      const feedback = store.feedback ?? {
        isDeclined: async () => false,
        suggestionStatus: async () => null,
      };
      return clusterBatch(dedup, rows, store.candidates, feedback);
    },
    async retryFailed(opts) {
      const rows = await store.loadRetryable(opts?.limit ?? 1000);
      return run(rows, baseConcurrency);
    },
    async evaluate(gold) {
      if (!store.loadEnriched) {
        throw new Error("evaluate requires a store with loadEnriched");
      }
      if (!evalAttributes) {
        throw new Error("evaluate requires evalAttributes");
      }
      const enriched = await store.loadEnriched(100000);
      const predicted: PredictedRow[] = enriched.map((e) => ({ id: e.id, enriched: e.enriched }));
      return scoreEnrichment(gold, predicted, evalAttributes);
    },
  };
}
