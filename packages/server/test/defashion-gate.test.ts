// Regression gate for the 360-audit guardrail: the generic core must stay vertical-neutral.
// Anything fashion-specific belongs in the SDK template (@samesake/core `fashion.*`), which
// plugs in through declarative seams (CollectionSearchDef, enrich pipelines, indexing).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CORE_DIR = join(import.meta.dir, "../src/core");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("de-fashion gate", () => {
  test("no fashion symbol appears anywhere in packages/server/src/core", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(CORE_DIR)) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/fashion/i.test(lines[i]!)) {
          offenders.push(`${file.replace(CORE_DIR, "core")}:${i + 1}: ${lines[i]!.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
