import type {
  Company,
  MatchCandidate,
  MatchedLine,
  PricingRules,
  Quotation,
  QuoteLine,
} from "../../../shared/types.ts";

export interface ConfigResponse {
  company: Company;
  rules: PricingRules;
}

export async function fetchConfig(): Promise<ConfigResponse> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`config: ${res.status}`);
  return res.json();
}

export async function postQuote(
  file: File,
  tier: string,
  customer: string
): Promise<{ quotation: Quotation; matched: MatchedLine[] }> {
  const body = new FormData();
  body.append("file", file);
  body.append("tier", tier);
  body.append("customer", customer);
  const res = await fetch("/api/quote", { method: "POST", body });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `quote: ${res.status}`);
  }
  return res.json();
}

export async function postMatch(text: string, limit = 8): Promise<MatchCandidate[]> {
  const res = await fetch("/api/match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, limit }),
  });
  if (!res.ok) throw new Error(`match: ${res.status}`);
  const data = await res.json();
  return data.candidates;
}

export async function postConfirm(queryText: string, chosenCode: string | null): Promise<void> {
  const res = await fetch("/api/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queryText, chosenCode }),
  });
  if (!res.ok) throw new Error(`confirm: ${res.status}`);
}

export async function postPrice(
  line: MatchedLine,
  tier: string,
  customer: string
): Promise<QuoteLine | null> {
  const res = await fetch("/api/price", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ line, tier, customer }),
  });
  if (!res.ok) throw new Error(`price: ${res.status}`);
  const data = await res.json();
  return data.quoteLine;
}

export async function downloadQuotePdf(
  matched: MatchedLine[],
  tier: string,
  customer: string
): Promise<Blob> {
  const res = await fetch("/api/quote/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matched, tier, customer }),
  });
  if (!res.ok) throw new Error(`pdf: ${res.status}`);
  return res.blob();
}
