// Layer 4 — match + gate. samesake returns ranked candidates; we then (a) drop
// candidates whose hard specs contradict the line (an M8 query never matches M10),
// and (b) bucket by confidence: autoLink → matched, suggest → human review, else
// unmatched. For a quotation, a wrong auto-match is worse than asking a human.
import { catalog } from "../config.ts";
import { matchLine, type Matcher } from "../catalog.ts";
import type { NormalizedBomLine, MatchedLine, PricingRules, LineSpecs } from "../../../shared/types.ts";

const specsByCode = new Map(catalog().map((p) => [p.code, p.specs]));

/** Specs that must never silently conflict between the query and a candidate. */
const HARD: (keyof LineSpecs)[] = ["ratingA", "poles", "csaMm2", "cores", "sizeMm", "watt", "ways"];

// Pole notation varies ("single pole" / "1P" / "SP"); canonicalize before comparing.
function canonPole(p: unknown): string {
  const s = String(p).toLowerCase().replace(/[\s-]/g, "");
  if (/(tpn|3pn|triplepoleandneutral|triplepoleneutral)/.test(s)) return "TPN";
  if (/(4p|fp|fourpole|4pole)/.test(s)) return "4P";
  if (/(tp|3p|triplepole|3pole)/.test(s)) return "TP";
  if (/(dp|2p|doublepole|2pole)/.test(s)) return "DP";
  if (/(sp|1p|singlepole|1pole)/.test(s)) return "SP";
  return s;
}

function specCompatible(line: LineSpecs, part: LineSpecs | undefined): boolean {
  if (!part) return true;
  for (const k of HARD) {
    const a = line[k];
    const b = part[k];
    if (a == null || b == null) continue;
    if (k === "poles") {
      if (canonPole(a) !== canonPole(b)) return false;
    } else if (String(a) !== String(b)) return false;
  }
  return true;
}

export async function gateLine(matcher: Matcher, line: NormalizedBomLine, rules: PricingRules): Promise<MatchedLine> {
  const all = await matchLine(matcher, line.normalized, 5);
  const compatible = all.filter((c) => specCompatible(line.specs, specsByCode.get(c.code)));
  // If hard specs eliminated everything, surface the raw candidates for human review
  // rather than silently auto-matching something incompatible.
  const pool = compatible.length ? compatible : all;
  const top = pool[0] ?? null;

  let status: MatchedLine["status"] = "unmatched";
  if (top) {
    if (compatible.length && top.confidence >= rules.matching.autoLink) status = "matched";
    else if (top.confidence >= rules.matching.suggest) status = "review";
  }

  return {
    line,
    status,
    chosen: status === "matched" ? top : null,
    alternatives: pool.slice(0, 4),
    confirmedByUser: false,
  };
}
