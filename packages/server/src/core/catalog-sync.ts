// Incremental catalog sync: apply upstream product events (Shopify-style webhooks or any
// PIM feed) to a collection without a full re-ingest. Deletes route through the same
// removeDocuments path as the public API; upserts merge into the raw doc and refresh the
// declared filter columns inline.
import type { CollectionDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import type { ProjectsService } from "./projects.ts";
import type { IngestService } from "./ingest.ts";
import { collectionTableName, getByPath } from "./db-utils.ts";
import { sanitiseIdent } from "./schema-gen.ts";

export interface CatalogSyncEvent {
  type:
    | "product.upsert"
    | "product.delete"
    | "variant.upsert"
    | "inventory.update"
    | "price.update"
    | "image.update";
  id: string;
  data?: Record<string, unknown>;
  changes?: Record<string, unknown>;
}

export function makeCatalogSyncService(
  ctx: MatcherCtx,
  projectsService: ProjectsService,
  ingestService: IngestService
) {
  async function syncCatalogEvent(
    projectSlug: string,
    collectionName: string,
    event: CatalogSyncEvent
  ): Promise<{ synced: boolean; action: "upserted" | "deleted"; needsReindex: boolean }> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def: CollectionDef | null = await projectsService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);
    const table = collectionTableName(project.schema_name, collectionName);

    if (event.type === "product.delete") {
      await ingestService.removeDocuments(projectSlug, collectionName, [event.id]);
      return { synced: true, action: "deleted", needsReindex: false };
    }

    const rows = await ctx.storage.client("catalog-sync").unsafe(
      `SELECT data FROM ${table} WHERE id = $1 LIMIT 1`,
      [event.id]
    );
    const existing = (rows[0]?.data ?? {}) as Record<string, unknown>;
    const data = { ...existing, ...(event.data ?? {}), ...(event.changes ?? {}) };
    await ingestService.upsertDocuments(projectSlug, collectionName, [{ id: event.id, data }]);
    const setFragments: string[] = [];
    const params: unknown[] = [event.id];
    for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
      const path = fieldDef.path ?? fieldName;
      if (path.startsWith("enriched.")) continue;
      const value = getByPath(data, path);
      if (value === undefined) continue;
      params.push(value);
      setFragments.push(`${sanitiseIdent(fieldName)} = $${params.length}`);
    }
    if (setFragments.length) {
      await ctx.storage.client("catalog-sync").unsafe(
        `UPDATE ${table} SET ${setFragments.join(", ")} WHERE id = $1`,
        params
      );
    }
    const needsReindex = ["product.upsert", "variant.upsert", "image.update"].includes(event.type);
    return { synced: true, action: "upserted", needsReindex };
  }

  return { syncCatalogEvent };
}

export type CatalogSyncService = ReturnType<typeof makeCatalogSyncService>;
