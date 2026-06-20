import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { cacheOrJudge, makeFileJudgeCache } from "../src/core/eval/cache.ts";
import { makeLlmJudge } from "../src/core/eval/judge.ts";
import type { GenerateFn } from "../src/types.ts";

describe("eval cache", () => {
  test("test:eval-cache re-run issues zero new generate calls", async () => {
    let calls = 0;
    const generate: GenerateFn = async () => {
      calls += 1;
      return {
        grades: [{ id: "a", grade: 2, facets: { color: 2 }, reason: "match" }],
      };
    };

    const dir = await mkdtemp(join(tmpdir(), "eval-cache-"));
    try {
      const cache = makeFileJudgeCache(dir);
      const judge = makeLlmJudge(generate, { version: "cache-v1" });
      const candidates = [
        { id: "a", text: "id: a | title: Red Dress", data: { title: "Red Dress" } },
      ];

      await cacheOrJudge(judge, "red dress", candidates, cache);
      expect(calls).toBe(1);

      await cacheOrJudge(judge, "red dress", candidates, cache);
      expect(calls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
