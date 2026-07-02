import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("StorageAdapter boundary", () => {
  test("core services do not reach through drizzle to recover the postgres client", () => {
    const allowed = new Set([
      "packages/server/src/core/db-utils.ts",
      "packages/server/src/core/facets.ts",
    ]);
    const files = [
      "packages/server/src/core/agent-tools.ts",
      "packages/server/src/core/calibrate.ts",
      "packages/server/src/core/embed-index.ts",
      "packages/server/src/core/embed.ts",
      "packages/server/src/core/enrich-pipeline.ts",
      "packages/server/src/core/explain.ts",
      "packages/server/src/core/shop-search.ts",
      "packages/server/src/core/catalog-sync.ts",
      "packages/server/src/core/ingest.ts",
      "packages/server/src/core/match.ts",
      "packages/server/src/core/pipeline-failure.ts",
      "packages/server/src/core/projects.ts",
      "packages/server/src/core/retry.ts",
      "packages/server/src/core/revalidate-images.ts",
      "packages/server/src/core/review.ts",
      "packages/server/src/core/search.ts",
      "packages/server/src/core/upsert.ts",
      "packages/server/src/core/variants.ts",
      ...allowed,
    ];

    const offenders = files
      .filter((file) => !allowed.has(file))
      .flatMap((file) => {
        const source = read(file);
        return source.includes("getPgClient(") || source.includes("getPgClient }")
          ? [file]
          : [];
      });

    expect(offenders).toEqual([]);
  });
});
