import type { CollectionDef, ConnectorDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import type { ProjectsService } from "./projects.ts";
import { computeContentHash } from "../connectors/normalize.ts";
import { connectorFromDef, type PullConnector } from "../connectors/index.ts";
import { searchResultCache } from "./search-cache.ts";
import { collectionTableName } from "./db-utils.ts";
import { resolveScope } from "./scope.ts";

export interface IngestDocument {
  id: string;
  /** Required (all declared keys) when the collection declares `scopes`. */
  scope?: Record<string, string>;
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
      const scopeCols = resolveScope(def, collectionName, doc.scope, `push (doc "${doc.id}")`);
      const data = { ...doc.data };
      const contentHash =
        (data.content_hash as string | undefined) ?? computeContentHash(data);
      data.content_hash = contentHash;

      await ctx.storage.upsertDocument(table, doc.id, JSON.stringify(data), contentHash, scopeCols);
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
    ids: string[],
    scope?: Record<string, string>
  ): Promise<{ removed: number }> {
    if (ids.length === 0) return { removed: 0 };
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await projectsService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const scopeCols = resolveScope(def, collectionName, scope, "removeDocuments");
    const table = collectionTableName(project.schema_name, collectionName);
    const removed = await ctx.storage.deleteDocuments(table, ids, scopeCols);

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
        batch.push(connector.scope ? { ...row, scope: connector.scope } : row);
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
    return runIngestCollection(projectSlug, collectionName, opts);
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
