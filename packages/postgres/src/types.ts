import type { CollectionDef, EmbedFn, GenerateFn, GroundImageFn, RerankFn, Scope } from "@samesake/core";
import type { Embedder } from "@samesake/embed";
import type { Enricher, EnrichStore } from "@samesake/enrich";
import type { FacetResult, Retriever, SearchFn, VocabProvider } from "@samesake/query";
import type { PostgresAdapter } from "./adapter.ts";

export interface PostgresAdapterOptions {
  url: string;
  maxConnections?: number;
}

export interface CollectionBackendOptions {
  collection: CollectionDef;
  table: string;
  scope?: Scope;
}

export interface PostgresBackend {
  adapter: PostgresAdapter;
  retriever: Retriever;
  enrichStore: EnrichStore;
  candidates: NonNullable<EnrichStore["candidates"]>;
  vocab: VocabProvider;
  facets: (request: {
    fields: string[];
    filters: import("@samesake/query").RetrievalPlan["filters"];
    scope?: Scope;
  }) => Promise<Record<string, FacetResult>>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface SamesakePreset {
  collection?: CollectionDef;
  table?: string;
  scope?: Scope;
  concurrency?: number;
}

export interface SamesakeConfig {
  url: string;
  preset?: SamesakePreset;
  collection?: CollectionDef;
  table?: string;
  models: {
    embed: Embedder | EmbedFn;
    generate?: GenerateFn;
  };
  parse?: (request: unknown) => Promise<unknown>;
  rerank?: RerankFn;
  groundImage?: GroundImageFn;
  apiKey?: string;
  schema?: string;
  projectPrefix?: string;
  migrate?: "lazy" | "eager" | "manual";
}

export interface SamesakeBundle {
  enrich: Enricher;
  resolve: Enricher["resolve"];
  search: SearchFn;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface SearchBackendOptions extends CollectionBackendOptions {
  schema?: string;
  projectPrefix?: string;
}
