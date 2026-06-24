import { CLASSIFY_RULES, type Kind } from "./rules.ts";

export interface Classification {
  kind: Kind;
  why: string;
  /** false → no rule matched; the line is a guess and should go to human review, not auto-priced. */
  confident: boolean;
}

// Classify a Cisco line from its part number alone — no catalog lookup.
export function classify(partNumber: string): Classification {
  for (const rule of CLASSIFY_RULES) {
    if (rule.match.test(partNumber)) return { kind: rule.kind, why: rule.why, confident: true };
  }
  // Nothing matched — default to product (one-time) but flag it. This is the review gate:
  // a guess never silently misprices a line; an operator confirms it. (At scale, samesake's
  // enrich pipeline would classify these from the description before they ever hit review.)
  return { kind: "product", why: "no prefix rule matched — guessed product; needs review", confident: false };
}
