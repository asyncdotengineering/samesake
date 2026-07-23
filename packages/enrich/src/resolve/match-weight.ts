import type { DedupCandidate } from "../types.ts";
import type { ChannelModel, FSModel, Level } from "./model.ts";

function signal(ch: ChannelModel, rowFields: Record<string, unknown>, cand: DedupCandidate): number | boolean {
  if (ch.kind === "exactKey") {
    const field = ch.field ?? ch.channel;
    const rv = rowFields[field];
    if (rv == null || String(rv).trim() === "") return false;
    const cv = cand.fields[field];
    return cv != null && String(rv) === String(cv);
  }
  if (ch.kind === "trigram") {
    const field = ch.field ?? ch.channel;
    return cand.trgm[field] ?? 0;
  }
  return cand.cos ?? 0;
}

function levelPasses(level: Level, sig: number | boolean): boolean {
  const t = level.test;
  if (t.op === "else") return true;
  if (t.op === "exact") return sig === true;
  return typeof sig === "number" && sig >= t.value;
}

function pickLevel(ch: ChannelModel, rowFields: Record<string, unknown>, cand: DedupCandidate): Level {
  const sig = signal(ch, rowFields, cand);
  for (const level of ch.levels) {
    if (levelPasses(level, sig)) return level;
  }
  return ch.levels[ch.levels.length - 1]!;
}

/** Pure Fellegi-Sunter match weight: M = log2(λ/(1−λ)) + Σ log2(m/u); Pr = 2^M/(1+2^M). */
export function matchWeight(
  model: FSModel,
  rowFields: Record<string, unknown>,
  cand: DedupCandidate
): { M: number; Pr: number } {
  let M = Math.log2(model.lambda / (1 - model.lambda));
  for (const ch of model.channels) {
    const level = pickLevel(ch, rowFields, cand);
    M += Math.log2(level.m / level.u);
  }
  const Pr = 2 ** M / (1 + 2 ** M);
  return { M, Pr };
}
