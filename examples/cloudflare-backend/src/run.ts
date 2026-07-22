import { createEnricher, type ClusterDecision, type DedupCandidate, type DedupRow, type EnrichedRow } from "@samesake/enrich";
import { createSearch, type SearchResult } from "@samesake/query";
import type { Table } from "@lancedb/lancedb";
import { CATALOG, products } from "./collection.ts";
import { createSchema, openDb } from "./d1.ts";
import { d1EnrichStore } from "./d1-enrich-store.ts";
import { d1Vocab } from "./d1-vocab.ts";
import { lanceCandidates } from "./lance-candidates.ts";
import { indexEnriched, openLance, persistGroups } from "./lance-index.ts";
import { lanceRetriever } from "./lance-retriever.ts";
import { stubEmbed, stubGenerate } from "./stubs.ts";

export interface HarnessResult {
  enriched: EnrichedRow[];
  decisions: ClusterDecision[];
  page: SearchResult;
  evidencePath?: string;
}

function assertNoDatabaseUrl(): void {
  if (process.env.SAMESAKE_DATABASE_URL) throw new Error("SAMESAKE_DATABASE_URL must be unset for this local harness");
}

export async function runHarness(options: { writeEvidence?: boolean } = {}): Promise<HarnessResult> {
  assertNoDatabaseUrl();
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/samesake-cloudflare-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${root}`;
  const db = openDb(`${root}/d1.sqlite`);
  createSchema(db);
  const lance = await openLance(`${root}/lance`);
  const tableName = "offers";

  try {
    let table: Table | undefined;
    const candidates = async (row: DedupRow): Promise<DedupCandidate[]> => {
      if (!table) throw new Error("Lance table is not indexed");
      return lanceCandidates(table, products, db)(row);
    };
    const store = d1EnrichStore(db, candidates);
    const enricher = createEnricher({ collection: products, generate: stubGenerate, embed: stubEmbed, store });
    await enricher.upsert(CATALOG);
    const enriched = await enricher.enrich();
    const indexed = await indexEnriched(db, lance, products, stubEmbed, tableName);
    table = indexed.table;
    if (indexed.count !== CATALOG.length) throw new Error(`indexed ${indexed.count} rows; expected ${CATALOG.length}`);

    const decisions = await enricher.resolve();
    persistGroups(db, decisions);

    const search = createSearch({
      collection: products,
      retriever: lanceRetriever(table),
      generate: stubGenerate,
      embed: stubEmbed,
      vocab: d1Vocab(db),
    });
    const query = "Nike red running shoes";
    const page = await search(query, { limit: 5 });
    if (!page.hits.length) throw new Error(`search for "${query}" returned no hits`);

    const evidence = {
      backend: "bun:sqlite (D1 shape) + embedded LanceDB",
      database_url: process.env.SAMESAKE_DATABASE_URL ?? null,
      enriched: enriched.slice(0, 2).map((row) => ({ id: row.id, enriched: row.enriched })),
      resolve: decisions,
      search: { query, hits: page.hits.map((hit) => ({ id: hit.id, score: hit.score })) },
    };
    const evidencePath = options.writeEvidence === false ? undefined : `${import.meta.dir}/../evidence.json`;
    if (evidencePath) {
      await Bun.write(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(JSON.stringify(evidence, null, 2));
    }
    return { enriched, decisions, page, evidencePath };
  } finally {
    db.close();
  }
}

if (import.meta.main) await runHarness();
