import type { DedupCandidate } from "../types.ts";
import { matchWeight } from "./match-weight.ts";
import type { FSModel } from "./model.ts";

export interface RankedMatch {
  candidate: DedupCandidate;
  M: number;
  Pr: number;
  band: "link" | "suggest" | "none";
}

/** Bipartite record→entity ranking: score every candidate, sort by Pr desc, band by autoLink/suggest. */
export function matchOne(
  model: FSModel,
  rowFields: Record<string, unknown>,
  cands: DedupCandidate[]
): RankedMatch[] {
  const ranked: RankedMatch[] = cands.map((candidate) => {
    const { M, Pr } = matchWeight(model, rowFields, candidate);
    const band: RankedMatch["band"] =
      Pr >= model.autoLink ? "link" : Pr >= model.suggest ? "suggest" : "none";
    return { candidate, M, Pr, band };
  });
  // Stable sort: Pr desc; first wins on ties.
  ranked.sort((a, b) => b.Pr - a.Pr);
  return ranked;
}
