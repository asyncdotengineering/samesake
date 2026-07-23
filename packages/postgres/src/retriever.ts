import type { CollectionDef, ConstraintPredicate, Scope } from "@samesake/core";
import type { RankedRow, RetrievalPlan, Retriever, RetrieverFacetRequest } from "@samesake/query";
import { embeddingEntries } from "@samesake/query";
import type { PostgresAdapter } from "./adapter.ts";
import { buildFilterSql } from "./filter-sql.ts";
import { collectionTable, embeddingColumn, ident, vectorLiteral } from "./ident.ts";
import { createFacets } from "./facets.ts";
import type { CollectionBackendOptions } from "./types.ts";

function searchableColumns(def: CollectionDef): string[] {
  return Object.entries(def.fields)
    .filter(([, field]) => field.type === "text" && field.searchable)
    .map(([name]) => ident(name));
}

function visibility(predicates: ConstraintPredicate[], scope: Scope | undefined, def: CollectionDef) {
  const compiled = buildFilterSql(predicates, def, 1);
  const clauses = compiled.where === "true" ? [] : [compiled.where];
  const params = [...compiled.params];
  for (const [field, value] of Object.entries(scope ?? {})) {
    params.push(value);
    clauses.push(`d.scope_${ident(field.replace(/^scope_/, ""))} = $${params.length}`);
  }
  return { where: clauses.length ? clauses.join(" AND ") : "true", params };
}

export class PostgresRetriever {
  readonly facets: (request: RetrieverFacetRequest) => Promise<Record<string, import("@samesake/query").FacetResult>>;
  private readonly searchable: string[];

  constructor(
    private readonly adapter: PostgresAdapter,
    private readonly options: CollectionBackendOptions
  ) {
    this.searchable = searchableColumns(options.collection);
    this.facets = createFacets(adapter, options);
  }

  async retrieve(plan: RetrievalPlan): Promise<RankedRow[]> {
    const def = this.options.collection;
    const table = this.options.table;
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const compiled = visibility(plan.filters, plan.scope ?? this.options.scope, def);
    const where = compiled.where;
    params.push(...compiled.params);
    const lexical = plan.query && plan.weights.fts > 0;
    const vectors = plan.vectors.filter((entry) => entry.vec.length > 0 && (plan.weights.aspects[entry.embedding] ?? plan.weights.cosine) > 0);
    const language = ident(def.language ?? "english", "language");
    const document = "d.fts";
    const scoreParts: string[] = [];
    const ftsRef = lexical ? add(plan.query) : null;
    if (ftsRef) scoreParts.push(`${plan.weights.fts} * ts_rank_cd(${document}, websearch_to_tsquery('${language}', unaccent(${ftsRef})))`);

    const vectorParts: Array<{ name: string; expression: string; ref: string }> = [];
    for (const vector of vectors) {
      const entries = embeddingEntries(def);
      const index = entries.findIndex(([name]) => name === vector.embedding);
      if (index < 0) continue;
      const ref = add(vectorLiteral(vector.vec));
      const expression = `(1 - (d.${embeddingColumn(vector.embedding, index)} <=> ${ref}::halfvec))`;
      vectorParts.push({ name: vector.embedding, expression, ref });
      scoreParts.push(`${plan.weights.aspects[vector.embedding] ?? plan.weights.cosine} * ${expression}`);
    }

    const score = scoreParts.length ? scoreParts.join(" + ") : "0::float";
    const select = ["d.id", "d.data", `${score}::float AS score`];
    if (lexical) select.push(`(${document} @@ websearch_to_tsquery('${language}', unaccent(${ftsRef!}))) AS fts_present`);
    else select.push("false AS fts_present");
    select.push(vectorParts.length ? `${vectorParts[0]!.expression}::float AS cos_sim` : "NULL::float AS cos_sim");
    const rows = await this.adapter.withSettings(
      vectors.length ? ["SET LOCAL hnsw.iterative_scan = 'relaxed_order'"] : [],
      `SELECT ${select.join(", ")} FROM ${table} d WHERE ${where} AND (d.pipeline_status = 'ready' OR d.pipeline_status IS NULL) ORDER BY score DESC, d.id ASC LIMIT ${add(plan.limit)}`,
      params
    );
    return rows.map((row, index) => ({
      id: String(row.id),
      data: (row.data as Record<string, unknown>) ?? {},
      rrf_score: Number(row.score ?? 0),
      legRanks: { ...(row.fts_present ? { fts: index + 1 } : {}), ...(vectorParts.length ? { [vectorParts[0]!.name]: index + 1 } : {}) },
      fts_present: Boolean(row.fts_present),
      cos_sim: row.cos_sim == null ? null : Number(row.cos_sim),
    }));
  }
}

export function pgRetriever(adapter: PostgresAdapter, options: CollectionBackendOptions): Retriever {
  const retriever = new PostgresRetriever(adapter, options);
  const fn = retriever.retrieve.bind(retriever) as Retriever;
  fn.facets = retriever.facets;
  return fn;
}
