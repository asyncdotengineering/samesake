import type { CollectionDef, ConnectorDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import type { ProjectsService } from "./projects.ts";
import { computeContentHash } from "../connectors/normalize.ts";
import { connectorFromDef, type PullConnector } from "../connectors/index.ts";
import { searchResultCache } from "./search-cache.ts";
import { collectionTableName } from "./db-utils.ts";

export interface IngestDocument {
  id: string;
  data: Record<string, unknown>;
}

export interface IngestResult {
  upserted: number;
  connectors: string[];
}

export function makeIngestService(ctx: MatcherCtx, projectsService: ProjectsService) {
  async function upsertDocuments(
    projectSlug: string,
    collectionName: string,
    docs: IngestDocument[]
  ): Promise<{ upserted: number }> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await projectsService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const table = collectionTableName(project.schema_name, collectionName);
    let upserted = 0;

    for (const doc of docs) {
      const data = { ...doc.data };
      const contentHash =
        (data.content_hash as string | undefined) ?? computeContentHash(data);
      data.content_hash = contentHash;

      await ctx.storage.client("ingest").unsafe(
        `INSERT INTO ${table} (id, data, content_hash, ingested_at, updated_at)
         VALUES ($1, $2::jsonb, $3, now(), now())
         ON CONFLICT (id) DO UPDATE SET
           data = EXCLUDED.data,
           content_hash = EXCLUDED.content_hash,
           updated_at = CASE
             WHEN ${table}.content_hash <> EXCLUDED.content_hash THEN now()
             ELSE ${table}.updated_at
           END,
           enriched_at = CASE
             WHEN ${table}.content_hash <> EXCLUDED.content_hash THEN NULL
             ELSE ${table}.enriched_at
           END,
           indexed_at = CASE
             WHEN ${table}.content_hash <> EXCLUDED.content_hash THEN NULL
             ELSE ${table}.indexed_at
           END,
           enriched = CASE
             WHEN ${table}.content_hash <> EXCLUDED.content_hash THEN NULL
             ELSE ${table}.enriched
           END`,
        [doc.id, JSON.stringify(data), contentHash]
      );
      upserted++;
    }

    if (upserted > 0) {
      searchResultCache.invalidateProjectCollection(projectSlug, collectionName);
    }

    return { upserted };
  }

  async function removeDocuments(
    projectSlug: string,
    collectionName: string,
    ids: string[]
  ): Promise<{ removed: number }> {
    if (ids.length === 0) return { removed: 0 };
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await projectsService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const table = collectionTableName(project.schema_name, collectionName);
    const result = await ctx.storage.client("ingest").unsafe(
      `DELETE FROM ${table} WHERE id = ANY($1)`,
      [ids]
    );
    const removed = (result as { count?: number }).count ?? 0;

    if (removed > 0) {
      searchResultCache.invalidateProjectCollection(projectSlug, collectionName);
    }
    return { removed };
  }

  async function pullFromConnectors(
    projectSlug: string,
    collectionName: string,
    connectors: PullConnector[]
  ): Promise<{ upserted: number; connectors: string[] }> {
    const seen = new Set<string>();
    const batch: IngestDocument[] = [];

    for (const connector of connectors) {
      for await (const row of connector.pull()) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        batch.push(row);
      }
    }

    const r = await upsertDocuments(projectSlug, collectionName, batch);
    return { ...r, connectors: connectors.map((c) => c.name) };
  }

  async function ingestCollection(
    projectSlug: string,
    collectionName: string,
    opts?: { connectors?: PullConnector[] }
  ): Promise<IngestResult> {
    return ctx.jobs.run(
      `ingest:${projectSlug}:${collectionName}`,
      { projectSlug, collectionName },
      () => runIngestCollection(projectSlug, collectionName, opts)
    );
  }

  async function runIngestCollection(
    projectSlug: string,
    collectionName: string,
    opts?: { connectors?: PullConnector[] }
  ): Promise<IngestResult> {
    const def = await projectsService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const connectorDefs = def.sources ?? [];
    const connectors =
      opts?.connectors ??
      connectorDefs.map((d: ConnectorDef) =>
        connectorFromDef(d, { timeoutMs: ctx.policy.connector.timeoutMs })
      );

    if (!connectors.length) {
      throw new Error(
        `collection "${collectionName}" has no sources configured. Add sources: [...] to the collection config or pass connectors to ingest().`
      );
    }

    return pullFromConnectors(projectSlug, collectionName, connectors);
  }

  return { upsertDocuments, removeDocuments, ingestCollection, pullFromConnectors };
}

export type IngestService = ReturnType<typeof makeIngestService>;
