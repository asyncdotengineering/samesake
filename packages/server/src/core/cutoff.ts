// Result cutoff: decides where a result list honestly ends instead of padding
// with nearest neighbours (MICES: bad results are worse than an honest empty
// page; a single global float is known-insufficient, hence pluggable
// strategies). FTS-anchored hits are never cut — a keyword match is real
// evidence; the strategies only judge semantic-only hits.
import type { CollectionCutoffDef } from "@samesake/core";

/** Per-hit retrieval evidence, in final ranked order. */
export interface CutoffEvidence {
  /** true when the hit matched the lexical (FTS) leg */
  ftsPresent: boolean;
  /** query–document cosine from the semantic leg; null when the hit never entered it */
  cos: number | null;
  /** the coherence field's value (category-coherence only) */
  value?: unknown;
}

export const DEFAULT_CUTOFF: CollectionCutoffDef = { strategy: "score-drop" };
const DEFAULT_MAX_DROP = 0.5;
const DEFAULT_MIN_ANCHOR = 0.3;
const DEFAULT_COHERENCE_MIN = 0.5;
const COHERENCE_TOP_N = 10;

export function applyCutoff<T>(
  hits: T[],
  evidence: CutoffEvidence[],
  def: CollectionCutoffDef | undefined
): { hits: T[]; dropped: number } {
  const cfg = def ?? DEFAULT_CUTOFF;
  if (cfg.strategy === "none" || hits.length === 0) return { hits, dropped: 0 };

  const anchored = evidence.some((e) => e.ftsPresent);

  // Shared honest-zero rule: nothing matched lexically AND nothing is
  // semantically close — the query has no real answer in this catalog.
  if (!anchored) {
    const minAnchor = cfg.minAnchor ?? DEFAULT_MIN_ANCHOR;
    const cosVals = evidence.map((e) => e.cos).filter((c): c is number => c != null);
    if (cosVals.length > 0 && Math.max(...cosVals) < minAnchor) {
      return { hits: [], dropped: hits.length };
    }
  }

  if (cfg.strategy === "category-coherence") {
    if (!cfg.field) {
      throw new Error(
        'search.cutoff: strategy "category-coherence" requires `field` (the declared field whose values define coherence)'
      );
    }
    if (anchored) return { hits, dropped: 0 };
    const top = evidence.slice(0, COHERENCE_TOP_N);
    const counts = new Map<string, number>();
    let total = 0;
    for (const e of top) {
      if (e.value == null || e.value === "") continue;
      const key = String(e.value);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
    if (total === 0) return { hits, dropped: 0 };
    const majority = Math.max(...counts.values()) / total;
    if (majority < (cfg.coherenceMin ?? DEFAULT_COHERENCE_MIN)) {
      return { hits: [], dropped: hits.length };
    }
    return { hits, dropped: 0 };
  }

  // score-drop: walk the ranked list; once a semantic-only hit's cosine falls
  // off a relative cliff vs the last semantic evidence seen, the tail is cut
  // (FTS-anchored hits survive the cut).
  const maxDrop = cfg.maxDrop ?? DEFAULT_MAX_DROP;
  let prev: number | null = null;
  let cliffAt = -1;
  for (let i = 0; i < evidence.length; i++) {
    const e = evidence[i]!;
    // Only semantic-only hits move the baseline: an FTS-anchored hit with a low
    // cosine is kept on lexical evidence but must not lower the cliff bar for
    // the semantic tail behind it.
    if (e.cos == null || e.ftsPresent) continue;
    if (prev != null && e.cos < prev * (1 - maxDrop)) {
      cliffAt = i;
      break;
    }
    prev = e.cos;
  }
  if (cliffAt === -1) return { hits, dropped: 0 };
  const kept: T[] = [];
  for (let i = 0; i < hits.length; i++) {
    if (i < cliffAt || evidence[i]!.ftsPresent) kept.push(hits[i]!);
  }
  return { hits: kept, dropped: hits.length - kept.length };
}
