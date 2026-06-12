import { readFileSync } from "node:fs";
import { computeContentHash } from "./normalize.ts";

export interface JsonlFeedOpts {
  path: string;
}

export function jsonlFeedConnector(opts: JsonlFeedOpts) {
  return {
    name: `jsonl:${opts.path}`,
    async *pull() {
      const lines = readFileSync(opts.path, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        const row = JSON.parse(line) as { id?: string; data?: Record<string, unknown> };
        const id = row.id ?? (row.data?.external_id as string | undefined);
        const data = row.data ?? (row as Record<string, unknown>);
        if (!id || !data.title) continue;
        const doc = { ...data };
        if (!doc.content_hash) doc.content_hash = computeContentHash(doc);
        yield { id: String(id), data: doc };
      }
    },
  };
}

export function jsonlFeedFromLines(
  lines: Array<{ id: string; data: Record<string, unknown> }>,
  name = "jsonl:memory"
) {
  return {
    name,
    async *pull() {
      for (const row of lines) {
        const doc = { ...row.data };
        if (!doc.content_hash) doc.content_hash = computeContentHash(doc);
        yield { id: row.id, data: doc };
      }
    },
  };
}
