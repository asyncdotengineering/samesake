# Red-team (adversarial) search eval — implementation notes

A devil's-advocate suite built to **fail** the engine: adversarial, out-of-distribution, numerical,
contradictory, injection, degenerate, and polysemy queries run against the live post-fix
`fashionparity` engine. The value is the findings, not a green board.

- Suite: `evals/adversarial-queries.json` (50 queries, 7 buckets, each tagged `expect: relevant|empty|graceful` + optional price `bounds`).
- Runner: `examples/fashion-search/eval-adversarial.ts` — per-query `matcher.search` in try/catch (a crash is a FINDING), deterministic price-violation checks, framework LLM judge (`gemini-3.1-flash-lite`) for relevance/false-positive. Artifact: `evals/runs/<ts>-adversarial.{json,md}`.

## Result: 50 queries → 16 findings, **0 crashes, 0 injection breaches**

**Held up (no action):**
- **Injection (6/6 pass):** `'; DROP TABLE c_products; --`, `UNION SELECT api_key FROM samesake_projects`, `red dress' OR '1'='1`, prompt-injection, `<script>`, `{{7*7}}` — all treated as literal text, no SQL error, no secret leak. SQL is parameterized (`addParam` in `runHybridQuery`).
- **Contradiction (7/7 graceful):** "black white dress", "men's saree", "cheap luxury under 500", "sleeveless long sleeve" — no crash; returns best-effort or narrows (kids XXL suit → 1 hit).
- **Degenerate:** whitespace → controlled validation error; single-char / stopwords / punctuation / emoji → no crash. Empty `q` correctly rejected.
- **Polysemy (6/6 pass):** tank→tops, clutch→bags, pumps/mules→footwear, boxers→underwear all resolve to apparel (meanGrade 1–2).

## Findings, ranked

### 1. No out-of-distribution rejection — 7/8 OOD queries return junk (HIGH)
"gaming laptop", "iphone 15 pro max", "car tyres", "whey protein", "office chair", "birthday cake",
"3 bedroom house" each return 5 nearest-neighbour fashion items (judge grade **0**). Only "dslr camera
lens" returned empty. A real store showing 5 random dresses for "gaming laptop" is bad UX.
- **Root cause:** `def.search.relevanceFloor` is unset, so `effectiveFloor` is null → the cosine
  floor that would drop below-threshold nearest-neighbours never applies (`search.ts` `runRanked`).
- **Fix (needs calibration, not a blind constant):** set a `relevanceFloor` and re-run BOTH the golden
  eval (must not re-empty use-case queries — the exact tension `effectiveFloor` navigates) and this
  red-team (OOD should flip to no-results). Requires the cosine-similarity distribution of OOD vs real
  top hits to pick the threshold; do not guess.

### 2. Price-constraint parsing + price data quality (MED)
- "top for 0 rupees" → returns tops at 1990–3650 (bound ignored). "shoes under -500" → returns price=0
  items. NLQ doesn't parse "for N rupees" / `0` / negative as a `max_price`.
- "dress under 100" returns judge-relevant dresses → the corpus contains **price=0 / sub-100-LKR rows**
  (data quality) that satisfy the (correct) filter. Surfaces an ingest/enrichment price-hygiene gap.
- **Fix:** extend `FASHION_NLQ_INSTRUCTIONS` price rules ("for N rupees" → max; reject/ignore ≤0);
  add a price-sanity check at ingest (flag price=0).

### 3. Multilingual (Sinhala/Tamil) retrieval weak (MED — LK market)
"රතු ගවුම" (Sinhala) and "சிவப்பு ஆடை" (Tamil) for "red dress" return poor hits (meanGrade 0–0.75).
The judge is multilingual but the corpus text + query embedding path favour English. Real gap for a
Sri-Lankan storefront. **Fix:** multilingual query normalization/translation before embed, or a
Sinhala/Tamil-aware embedding — a deliberate roadmap item, not a quick patch.

### 4. Eval-harness blind spot: judge can't see price (LOW — fix the test)
`candidateSummary` (framework `judge.ts`) omits `price`, so for numerical queries the judge can't
confirm the price constraint and grades conservatively → num-01/03/04 "WEAK" are partly judge
artifacts (the returned items were in-range with 0 price-violations). **Fix:** add `price` to
`candidateSummary`. Note: this shifts all judged grades, so re-baseline the golden eval when applied.

## Verdict

The engine is **robust and safe** (no crashes, injection-proof, handles contradictions/degenerate/
polysemy) but has **no OOD rejection** and **weak multilingual + price-phrase parsing** — all genuine,
now-measured gaps. None are quick blind fixes; each has a guarded path above. Reproduce:
`cd examples/fashion-search && bun --env-file=../../.env eval-adversarial.ts`.
