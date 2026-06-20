import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JudgedHit, JudgeCandidate, RelevanceJudge } from "./judge.ts";

export function judgeCacheKey(judgeVersion: string, query: string, text: string): string {
  return createHash("sha1").update(`${judgeVersion}|${query}|${text}`).digest("hex");
}

type CacheEntry = JudgedHit & { judgeVersion: string };

export interface JudgeCache {
  get(key: string): Promise<JudgedHit | undefined>;
  set(key: string, hit: JudgedHit, judgeVersion: string): Promise<void>;
  flush(): Promise<void>;
}

export function makeMemoryJudgeCache(): JudgeCache {
  const store = new Map<string, CacheEntry>();
  return {
    get(key) {
      return Promise.resolve(store.get(key));
    },
    async set(key, hit, judgeVersion) {
      store.set(key, { ...hit, judgeVersion });
    },
    async flush() {},
  };
}

export function makeFileJudgeCache(dir: string): JudgeCache {
  const path = join(dir, "grades.json");
  let loaded: Record<string, CacheEntry> | null = null;

  async function load(): Promise<Record<string, CacheEntry>> {
    if (loaded) return loaded;
    try {
      const raw = await readFile(path, "utf8");
      loaded = JSON.parse(raw) as Record<string, CacheEntry>;
    } catch {
      loaded = {};
    }
    return loaded!;
  }

  return {
    async get(key) {
      const data = await load();
      return data[key];
    },
    async set(key, hit, judgeVersion) {
      const data = await load();
      data[key] = { ...hit, judgeVersion };
      await mkdir(dir, { recursive: true });
      await writeFile(path, JSON.stringify(data));
      loaded = data;
    },
    async flush() {
      loaded = null;
    },
  };
}

export async function cacheOrJudge(
  judge: RelevanceJudge,
  query: string,
  candidates: JudgeCandidate[],
  cache: JudgeCache
): Promise<JudgedHit[]> {
  const hits: JudgedHit[] = new Array(candidates.length);
  const misses: JudgeCandidate[] = [];
  const missIndexes: number[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const key = judgeCacheKey(judge.version, query, c.text);
    const cached = await cache.get(key);
    if (cached && cached.id === c.id) {
      hits[i] = {
        id: cached.id,
        grade: cached.grade,
        facets: cached.facets,
        reason: cached.reason,
      };
    } else {
      misses.push(c);
      missIndexes.push(i);
    }
  }

  if (misses.length === 0) return hits;

  const fresh = await judge.grade(query, misses);
  for (let j = 0; j < misses.length; j++) {
    const c = misses[j]!;
    const graded = fresh[j] ?? { id: c.id, grade: 0 as const, facets: {}, reason: "judge-error" };
    const key = judgeCacheKey(judge.version, query, c.text);
    await cache.set(key, graded, judge.version);
    hits[missIndexes[j]!] = graded;
  }

  return hits;
}
