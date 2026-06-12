// Application-side normaliser. Mirrors the SQL `public.samesake_normalise` function.
// Used for cache keys and any TS-side comparison that needs to match what the DB does.

export function normaliseName(input: string | null | undefined): string {
  if (!input) return "";
  // 1. lowercase
  let s = input.toLowerCase();
  // 2. emoji + dingbats strip
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}]+/gu, " ");
  // 3. Diacritic-strip (NFD + remove combining marks).
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  // 4. non-letter/digit/space → space
  s = s.replace(/[^\p{L}\p{N} ]+/gu, " ");
  // 5. collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}
