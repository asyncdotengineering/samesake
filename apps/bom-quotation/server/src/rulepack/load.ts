import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { RulePackSchema, type RulePack } from "./schema.ts";

const PACK_DIR = join(import.meta.dir, "../../../data/rule-packs");

/** Load + validate a bundled pack by name (e.g. "electrical-mep"). */
export function loadPackFromYaml(name: string): RulePack {
  return RulePackSchema.parse(parseYaml(readFileSync(join(PACK_DIR, `${name}.yaml`), "utf8")));
}

/** Validate a pack already deserialized (e.g. JSON from the DB). Throws on invalid. */
export function parsePack(obj: unknown): RulePack {
  return RulePackSchema.parse(obj);
}

let cached: RulePack | null = null;
/** The bundled default pack (electrical-mep), validated + cached. */
export function defaultPack(): RulePack {
  if (!cached) cached = loadPackFromYaml("electrical-mep");
  return cached;
}

/** The pack the pipeline runs with: BOM_RULEPACK names a bundled pack, else the default. */
export function activePack(): RulePack {
  const name = process.env.BOM_RULEPACK;
  return name ? loadPackFromYaml(name) : defaultPack();
}
