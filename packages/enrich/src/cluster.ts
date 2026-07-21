// Pure clustering decision loop for offer dedup — the autoLink/suggest/found bands freed from SQL.
import type { CollectionDedupDef } from "@samesake/core";
import { scoreBest } from "./dedup-score.ts";
import type { ClusterDecision, DedupCandidateProvider, DedupFeedback, DedupRow } from "./types.ts";

/** Pure autoLink/suggest/found decision loop over a candidate provider + feedback port; emits one ClusterDecision per row, in order. */
export async function clusterBatch(
  cfg: CollectionDedupDef,
  rows: DedupRow[],
  candidates: DedupCandidateProvider,
  feedback: DedupFeedback
): Promise<ClusterDecision[]> {
  const decisions: ClusterDecision[] = [];
  // Candidate/leader id -> group id founded THIS batch, so a later row whose best candidate
  // was founded here joins that group instead of the leader's own id.
  const founded = new Map<string, string>();

  for (const row of rows) {
    const cands = await candidates(row);
    const best = scoreBest(cfg, row.fields, cands);

    if (best && best.score >= cfg.autoLink) {
      const leaderGroup = best.cand.group ?? founded.get(best.cand.id) ?? best.cand.id;
      if (!(await feedback.isDeclined(row.id, best.cand.id))) {
        founded.set(best.cand.id, leaderGroup);
        decisions.push({ rowId: row.id, outcome: "link", group: leaderGroup, score: best.score });
        continue;
      }
      // declined → fall through to FOUND
    } else if (best && cfg.suggest !== undefined && best.score >= cfg.suggest) {
      const candGroup = best.cand.group ?? best.cand.id;
      if (!(await feedback.isDeclined(row.id, candGroup))) {
        decisions.push({ rowId: row.id, outcome: "suggest", group: candGroup, score: best.score });
        continue;
      }
      // declined → fall through to FOUND
    }

    // FOUND (default / fall-through): best may be null (no candidates) or a declined
    // autoLink/suggest pair that must never re-cluster — score is kept either way.
    founded.set(row.id, row.id);
    decisions.push({ rowId: row.id, outcome: "found", group: row.id, score: best ? best.score : null });
  }

  return decisions;
}
