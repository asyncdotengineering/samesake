import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Consumer-neutrality guard. The NEUTRAL engine — @samesake/core (sdk), /enrich,
// /query — must privilege no provider, dimension, currency, domain, or store: it is
// general, and every consumer is a configuration. Provider/domain/store specifics
// legitimately live in the SPECIFIC packages, which carry a per-package allowance:
//   - @samesake/embed   → the provider-adapter package: provider names + native dims.
//   - @samesake/presets → the domain-preset package: its domain vocabulary.
//   - @samesake/postgres / @samesake/server → the store shells (audited elsewhere).
const packageRoots = ["sdk", "enrich", "query", "embed", "presets"] as const;
const forbidden = [
  "768", "gemini", "voyage", "lkr", "fashion", "postgres", "pgvector", "drizzle", "halfvec",
] as const;
const allowed: Record<string, readonly string[]> = {
  // @samesake/embed IS the provider-adapter home — naming providers + their native
  // output dimensions here is its job, not a neutrality violation.
  embed: ["768", "gemini", "voyage"],
  // @samesake/presets ships domain presets; "fashion" is its domain, not a core default.
  presets: ["fashion"],
};

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

function violations(packageName: (typeof packageRoots)[number]): string[] {
  const root = join(import.meta.dir, "..", "..", packageName, "src");
  const allow = allowed[packageName] ?? [];
  return sourceFiles(root).flatMap((path) => {
    const text = readFileSync(path, "utf8").toLowerCase();
    return forbidden.flatMap((literal) => {
      if (allow.includes(literal) || !text.includes(literal)) return [];
      return [`${path}: "${literal}"`];
    });
  });
}

describe("consumer neutrality", () => {
  test("the neutral engine (core/enrich/query) privileges no provider, dim, currency, domain, or store", () => {
    const found = packageRoots.flatMap((packageName) => violations(packageName));
    expect(found).toEqual([]);
  });
});
