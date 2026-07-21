import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const packageRoots = ["sdk", "enrich", "query", "embed", "presets"] as const;
const forbidden = ["768", "gemini", "lkr", "fashion", "postgres", "pgvector", "drizzle", "halfvec"] as const;

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

function violations(packageName: (typeof packageRoots)[number]): string[] {
  const root = join(import.meta.dir, "..", "..", packageName, "src");
  return sourceFiles(root).flatMap((path) => {
    const text = readFileSync(path, "utf8").toLowerCase();
    return forbidden.flatMap((literal) => {
      if ((literal === "fashion" && packageName === "presets") || !text.includes(literal)) return [];
      return [`${path}: ${literal}`];
    });
  });
}

describe("consumer neutrality", () => {
  test("neutral engine source contains no consumer-specific literals", () => {
    const found = packageRoots.flatMap((packageName) => violations(packageName));
    expect(found).toEqual([]);
  });
});
