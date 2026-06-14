import type { CollectionDef, EntityDef, ProjectConfig } from "@samesake/core";
import { isCollectionDef, isEntityDef } from "@samesake/core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface LoadedProjectConfig {
  configPath: string;
  project: ProjectConfig;
  entities: EntityDef[];
  collections: CollectionDef[];
}

function fail(msg: string): never {
  console.error(`samesake: ${msg}`);
  process.exit(1);
}

function collectDefinition(
  value: unknown,
  entities: EntityDef[],
  collections: CollectionDef[],
  seen: Set<unknown>
): void {
  if (seen.has(value)) return;
  if (isEntityDef(value)) {
    seen.add(value);
    entities.push(value);
    return;
  }
  if (isCollectionDef(value)) {
    seen.add(value);
    collections.push(value);
  }
}

export async function loadProjectConfig(configPath: string): Promise<LoadedProjectConfig> {
  const abs = resolve(configPath);
  if (!existsSync(abs)) fail(`config not found: ${abs}`);
  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (e) {
    fail(`could not import config ${abs}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const entities: EntityDef[] = [];
  const collections: CollectionDef[] = [];
  const seen = new Set<unknown>();
  const explicit = (mod.default ?? mod.config ?? mod.project) as Partial<ProjectConfig> | undefined;
  if (explicit && typeof explicit === "object") {
    for (const value of explicit.entities ?? []) collectDefinition(value, entities, collections, seen);
    for (const value of explicit.collections ?? []) collectDefinition(value, entities, collections, seen);
  }
  for (const v of Object.values(mod) as unknown[]) {
    if (v === explicit) continue;
    collectDefinition(v, entities, collections, seen);
  }
  if (entities.length === 0 && collections.length === 0) {
    fail(`config ${abs} must export at least one entity or collection`);
  }
  return { configPath: abs, project: { entities, collections }, entities, collections };
}
