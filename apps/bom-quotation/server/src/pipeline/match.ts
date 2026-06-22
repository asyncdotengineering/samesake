// Layer 4 — match + gate. samesake returns ranked candidates; we then drop candidates
// whose hard specs contradict the line (a 32 A query never matches a 40 A part) and bucket
// by confidence: autoLink → matched, suggest → review, else unmatched. The hard-spec list,
// the synonym canonicalization, and the thresholds all come from the rule pack — not code.
import { catalog } from "../config.ts";
import { matchLine, type Matcher } from "../catalog.ts";
import { canon } from "../rulepack/canon.ts";
import type { NormalizedBomLine, MatchedLine, LineSpecs } from "../../../shared/types.ts";
import type { RulePack } from "../rulepack/schema.ts";

const specsByCode = new Map(catalog().map((p) => [p.code, p.specs]));

function specCompatible(line: LineSpecs, part: LineSpecs | undefined, pack: RulePack): boolean {
  if (!part) return true;
  for (const key of pack.matching.hard) {
    const k = key as keyof LineSpecs;
    const a = line[k];
    const b = part[k];
    if (a == null || b == null) continue;
    if (key === "poles") {
      if (canon(pack, "poles", a) !== canon(pack, "poles", b)) return false;
    } else if (String(a) !== String(b)) {
      return false;
    }
  }
  return true;
}

export async function gateLine(matcher: Matcher, line: NormalizedBomLine, pack: RulePack): Promise<MatchedLine> {
  const all = await matchLine(matcher, line.normalized, 5);
  const compatible = all.filter((c) => specCompatible(line.specs, specsByCode.get(c.code), pack));
  // If hard specs eliminated everything, surface the raw candidates for human review
  // rather than silently auto-matching something incompatible.
  const pool = compatible.length ? compatible : all;
  const top = pool[0] ?? null;

  let status: MatchedLine["status"] = "unmatched";
  if (top) {
    if (compatible.length && top.confidence >= pack.matching.autoLink) status = "matched";
    else if (top.confidence >= pack.matching.suggest) status = "review";
  }

  return {
    line,
    status,
    chosen: status === "matched" ? top : null,
    alternatives: pool.slice(0, 4),
    confirmedByUser: false,
  };
}
