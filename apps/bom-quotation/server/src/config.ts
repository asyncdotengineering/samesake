import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Company, CatalogPart } from "../../shared/types.ts";

const ROOT = join(import.meta.dir, "../..");
const REPO_ROOT = join(ROOT, "../..");

/** Load SAMESAKE_DATABASE_URL + GEMINI_API_KEY from the repo-root .env if not already set. */
export function loadEnv(): void {
  if (process.env.SAMESAKE_DATABASE_URL && process.env.GEMINI_API_KEY) return;
  try {
    const env = readFileSync(join(REPO_ROOT, ".env"), "utf8");
    for (const line of env.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (k === "SAMESAKE_DATABASE_URL" || k === "GEMINI_API_KEY") process.env[k] ??= v;
    }
  } catch {
    /* no .env — rely on the ambient environment */
  }
}

function load<T>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, "data", rel), "utf8")) as T;
}

export const company = (): Company => load<Company>("company.json");
export const catalog = (): CatalogPart[] => load<CatalogPart[]>("catalog.json");

/** Fixed project + scope for this single-tenant deployment. Swap per company. */
export const PROJECT = "voltline";
export const SCOPE = { company: "voltline" } as const;
export const ENTITY_KIND = "part";
