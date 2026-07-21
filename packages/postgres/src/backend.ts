import type { CollectionDef, EmbedFn, GenerateFn } from "@samesake/core";
import type { Embedder } from "@samesake/embed";
import type { EnrichStore } from "@samesake/enrich";
import type { Retriever } from "@samesake/query";
import { createEnricher, type Enricher } from "@samesake/enrich";
import { createSearch, type SearchFn } from "@samesake/query";
import { PostgresAdapter, createPostgresAdapter } from "./adapter.ts";
import { pgCandidates } from "./candidates.ts";
import { PostgresEnrichStore } from "./enrich-store.ts";
import { collectionTable, ident } from "./ident.ts";
import { createFacets } from "./facets.ts";
import { pgRetriever } from "./retriever.ts";
import { pgVocab } from "./vocab.ts";
import type { CollectionBackendOptions, PostgresBackend, SamesakeBundle, SamesakeConfig, SamesakePreset } from "./types.ts";

function collectionFromPreset(preset?: SamesakePreset): CollectionDef | undefined {
  return preset?.collection;
}

function asEmbedder(embed: Embedder | EmbedFn): Embedder {
  if ("many" in embed && typeof embed.many === "function" && "caps" in embed) return embed;
  const single = embed as EmbedFn;
  const compatible = single as Embedder;
  compatible.many = async (requests) => Promise.all(requests.map((request) => single(request)));
  Object.defineProperty(compatible, "caps", {
    value: Object.freeze({ image: true, interleaved: false, dims: "any" as const, maxBatch: 1 }),
    enumerable: true,
  });
  return compatible;
}

function missingGenerate(): GenerateFn {
  return async () => {
    throw new Error("@samesake/postgres: models.generate is required for NLQ or enrichment");
  };
}

function backendOptions(
  schema: string,
  collection: CollectionDef,
  table: string | undefined,
  scope?: Record<string, string>
): CollectionBackendOptions {
  const name = collection.name;
  if (!table && !name) throw new Error("@samesake/postgres: collection.name or table is required");
  return {
    collection,
    table: table ?? collectionTable(schema, name!),
    scope,
  };
}

export function createPostgresBackend(config: {
  url: string;
  collection: CollectionDef;
  table?: string;
  schema?: string;
  scope?: Record<string, string>;
}): PostgresBackend {
  const adapter = createPostgresAdapter({ url: config.url });
  const options = backendOptions(config.schema ?? "public", config.collection, config.table, config.scope);
  const candidates = pgCandidates(adapter, options);
  const enrichStore = new PostgresEnrichStore(adapter, options, candidates);
  const facets = createFacets(adapter, options);
  return {
    adapter,
    retriever: pgRetriever(adapter, options),
    enrichStore,
    candidates,
    vocab: pgVocab(adapter, options),
    facets,
    migrate: () => adapter.migrate(),
    close: () => adapter.close(),
  };
}

function unconfiguredEnricher(): Enricher {
  const fail = async () => {
    throw new Error("@samesake/postgres: a collection with an enrich pipeline is required");
  };
  return {
    upsert: fail,
    enrich: fail,
    resolve: fail,
    retryFailed: fail,
    evaluate: fail,
  };
}

export function samesake(config: SamesakeConfig): SamesakeBundle {
  const collection = config.collection ?? collectionFromPreset(config.preset);
  if (!collection) throw new Error("@samesake/postgres: provide a collection or preset.collection");
  const schema = ident(config.schema ?? "public", "schema");
  const backend = createPostgresBackend({
    url: config.url,
    collection,
    table: config.table ?? config.preset?.table,
    schema,
    scope: config.preset?.scope,
  });
  const embed = asEmbedder(config.models.embed);
  const generate = config.models.generate ?? missingGenerate();
  const enrich = collection.enrich && collection.indexing
    ? createEnricher({
        collection,
        generate,
        embed,
        store: backend.enrichStore,
        concurrency: config.preset?.concurrency,
      })
    : unconfiguredEnricher();
  const search = createSearch({
    collection,
    retriever: backend.retriever,
    generate,
    embed,
    vocab: backend.vocab,
    rerank: config.rerank,
  });
  const migrate = () => backend.migrate();
  if (config.migrate === "eager") void migrate();
  return {
    enrich,
    resolve: enrich.resolve,
    search,
    migrate,
    close: () => backend.close(),
  };
}
