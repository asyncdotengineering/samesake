import type { CollectionDef, EmbedFn, GenerateFn } from "@samesake/core";
import type { Embedder } from "@samesake/embed";
import type { EnrichStore } from "@samesake/enrich";
import type { Retriever } from "@samesake/query";
import { createEnricher, type Enricher } from "@samesake/enrich";
import { createSearch, type SearchFn } from "@samesake/query";
import { embeddingEntries } from "@samesake/query";
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

function fieldSqlType(field: CollectionDef["fields"][string]): string {
  if (field.type === "number") return "numeric";
  if (field.type === "boolean") return "boolean";
  if (field.type === "array") return "text[]";
  return "text";
}

function migrationStatements(schema: string, table: string, collection: CollectionDef): string[] {
  const scopeColumns = (collection.scopes ?? []).map((name) => `scope_${ident(name)}`);
  const fieldColumns = Object.entries(collection.fields).map(([name, field]) => `${ident(name)} ${fieldSqlType(field)}`);
  const embeddingColumns = embeddingEntries(collection)
    .map(([name, embedding], index) => embedding.evidence ? null : `${index === 0 ? "embedding" : `emb_${ident(name)}`} halfvec(${embedding.dim})`)
    .filter((value): value is string => value !== null);
  const dedupColumns = collection.dedup ? ["product_group text", "dedup_score numeric", "dedup_checked_at timestamptz"] : [];
  const columns = [
    "id text PRIMARY KEY",
    "data jsonb NOT NULL",
    "enriched jsonb",
    "content_hash text NOT NULL",
    ...scopeColumns.map((name) => `${name} text NOT NULL`),
    ...fieldColumns,
    "doc text",
    "rerank_doc text",
    "fts_src text",
    "fts_src_a text",
    `fts tsvector GENERATED ALWAYS AS (to_tsvector('${ident(collection.language ?? "english", "language")}', coalesce(fts_src_a, '') || ' ' || coalesce(fts_src, ''))) STORED`,
    ...embeddingColumns,
    ...dedupColumns,
    "gate_reason text",
    "ingested_at timestamptz NOT NULL DEFAULT now()",
    "enriched_at timestamptz",
    "indexed_at timestamptz",
    "updated_at timestamptz NOT NULL DEFAULT now()",
    "pipeline_status text NOT NULL DEFAULT 'pending'",
    "attempt_count int NOT NULL DEFAULT 0",
    "last_error text",
    "next_attempt_at timestamptz",
    "image_etag text",
    "image_checked_at timestamptz",
  ];
  const statements = [
    `CREATE SCHEMA IF NOT EXISTS ${ident(schema, "schema")}`,
    `CREATE TABLE IF NOT EXISTS ${table} (${columns.join(", ")})`,
    `CREATE INDEX IF NOT EXISTS ${ident(table.split(".").pop()!)}_fts_idx ON ${table} USING gin (fts)`,
  ];
  const vocabFields = Object.entries(collection.fields).filter(([, field]) => field.type === "text" && field.filterable);
  if (vocabFields.length) {
    const vocab = `${table}_vocab`;
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${vocab} (${scopeColumns.map((name) => `${name} text NOT NULL,`).join(" ")} field text NOT NULL, value text NOT NULL, count int NOT NULL CHECK (count > 0), PRIMARY KEY (${[...scopeColumns, "field", "value"].join(", ")}) )`,
      `CREATE INDEX IF NOT EXISTS ${ident(table.split(".").pop()!)}_vocab_value_idx ON ${vocab} (value)`,
    );
    const values = vocabFields.map(([name, field]) => `('${name.replace(/'/g, "''")}', ${ident(name)})`).join(", ");
    const group = [...scopeColumns, "v.field", "v.value"].join(", ");
    statements.push(
      `INSERT INTO ${vocab} (${[...scopeColumns, "field", "value", "count"].join(", ")}) SELECT ${scopeColumns.length ? `${scopeColumns.join(", ")}, ` : ""}v.field, v.value, count(*)::int FROM ${table} t CROSS JOIN LATERAL (VALUES ${values}) AS v(field, value) WHERE v.value IS NOT NULL AND v.value <> '' GROUP BY ${group} ON CONFLICT DO NOTHING`,
    );
  }
  return statements;
}

export function createPostgresBackend(config: {
  url: string;
  collection: CollectionDef;
  table?: string;
  schema?: string;
  scope?: Record<string, string>;
}): PostgresBackend {
  const adapter = createPostgresAdapter({ url: config.url });
  const schema = config.schema ?? "public";
  const options = backendOptions(schema, config.collection, config.table, config.scope);
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
    migrate: async () => {
      await adapter.migrate();
      for (const statement of migrationStatements(schema, options.table, options.collection)) await adapter.query(statement);
    },
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
