import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("collection() compile-time safety", () => {
  test("@ts-expect-error catches undeclared embedding reference", () => {
    const sdkRoot = join(import.meta.dir, "..");
    const r = spawnSync("bunx", ["tsc", "--noEmit", "-p", "tsconfig.json"], {
      cwd: sdkRoot,
      encoding: "utf8",
    });
    if (r.status !== 0) {
      console.error(r.stdout, r.stderr);
    }
    expect(r.status).toBe(0);
  });
});
