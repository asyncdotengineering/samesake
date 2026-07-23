// Pure per-candidate dedup scoring relocated from @samesake/server — no SQL, no I/O.
import type { CollectionDedupDef } from "@samesake/core";
import { sanitiseIdent } from "@samesake/core";
import type { DedupCandidate } from "./types.ts";

/** Score a single candidate against the row. exactKey equality short-circuits to 1.0 (REQ-4). */
export function scoreCandidate(
  cfg: CollectionDedupDef,
  rowFields: Record<string, unknown>,
  cand: DedupCandidate
): number {
  for (const ch of cfg.channels) {
    if (ch.kind !== "exactKey") continue;
    const col = sanitiseIdent(ch.field);
    const rv = rowFields[col];
    if (rv == null || String(rv).trim() === "") continue; // empty/null key never matches (REQ-4)
    const cv = cand.fields[col];
    if (cv != null && String(rv) === String(cv)) return 1.0;
  }
  let sum = 0;
  let wsum = 0;
  for (const ch of cfg.channels) {
    if (ch.kind === "trigram") {
      const col = sanitiseIdent(ch.field);
      sum += ch.weight * (cand.trgm[col] ?? 0);
      wsum += ch.weight;
    } else if (ch.kind === "cosine") {
      sum += ch.weight * (cand.cos ?? 0);
      wsum += ch.weight;
    }
  }
  return wsum > 0 ? sum / wsum : 0;
}

/** Highest-scoring candidate (deterministic — first wins on ties). Null when no candidates. */
export function scoreBest(
  cfg: CollectionDedupDef,
  rowFields: Record<string, unknown>,
  cands: DedupCandidate[]
): { cand: DedupCandidate; score: number } | null {
  let best: { cand: DedupCandidate; score: number } | null = null;
  for (const cand of cands) {
    const score = scoreCandidate(cfg, rowFields, cand);
    if (!best || score > best.score) best = { cand, score };
  }
  return best;
}
