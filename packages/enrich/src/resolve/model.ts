import type { CollectionDedupDef } from "@samesake/core";
import { sanitiseIdent } from "@samesake/core";

export type LevelTest =
  | { op: "exact" }
  | { op: "gte"; value: number }
  | { op: "else" };

export interface Level {
  test: LevelTest;
  m: number;
  u: number;
  label: string;
}

export interface ChannelModel {
  channel: string;
  kind: "exactKey" | "trigram" | "cosine";
  field?: string;
  levels: Level[];
}

export interface FSModel {
  lambda: number;
  autoLink: number;
  suggest: number;
  channels: ChannelModel[];
}

/** Seed m/u defaults (NAIVE profile) chosen to reproduce baseline link decisions on exact-key / strong / non-dup cases. */
export function seedModel(cfg: CollectionDedupDef): FSModel {
  const channels: ChannelModel[] = [];
  for (const ch of cfg.channels) {
    if (ch.kind === "exactKey") {
      const field = sanitiseIdent(ch.field);
      channels.push({
        channel: field,
        kind: "exactKey",
        field,
        levels: [
          { test: { op: "exact" }, m: 0.95, u: 0.0002, label: "exact" },
          { test: { op: "else" }, m: 0.05, u: 0.9998, label: "else" },
        ],
      });
    } else if (ch.kind === "trigram") {
      const field = sanitiseIdent(ch.field);
      channels.push({
        channel: field,
        kind: "trigram",
        field,
        levels: [
          { test: { op: "gte", value: 0.9 }, m: 0.8, u: 0.01, label: "high" },
          { test: { op: "gte", value: 0.6 }, m: 0.55, u: 0.08, label: "mid" },
          { test: { op: "else" }, m: 0.1, u: 0.91, label: "else" },
        ],
      });
    } else if (ch.kind === "cosine") {
      channels.push({
        channel: "cosine",
        kind: "cosine",
        levels: [
          { test: { op: "gte", value: 0.95 }, m: 0.8, u: 0.01, label: "high" },
          { test: { op: "gte", value: 0.8 }, m: 0.55, u: 0.06, label: "mid" },
          { test: { op: "else" }, m: 0.1, u: 0.93, label: "else" },
        ],
      });
    }
  }
  // Pr thresholds (F-S scale), not the linear-blend autoLink scale.
  return {
    lambda: 0.05,
    autoLink: 0.5,
    suggest: 0.1,
    channels,
  };
}
