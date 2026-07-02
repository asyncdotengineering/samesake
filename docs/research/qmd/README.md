# QMD (tobi/qmd) → samesake — deep dive

Cloned to [`./repo`](./repo) (`.git` removed). QMD by Tobias Lütke is an **on-device hybrid search engine** for markdown/notes/transcripts, built for agentic workflows. It is the closest public analogue to samesake's retrieval core: **BM25 + vector + LLM re-ranking + RRF**, and it has a tested answer to a question our RFC left open (how to *blend* a reranker with RRF). File references below point into `docs/research/qmd/repo/`.

---

## 1. Product & use case

- **What:** a local CLI + library + MCP server that indexes your files and answers `search` (BM25), `vsearch` (vector), and `query` (hybrid + rerank, the recommended path). Everything runs **on-device** via `node-llama-cpp` + GGUF models — no API, no cloud.
- **Who/why:** "an on-device search engine for everything you need to remember … ideal for your agentic flows." `--json`/`--files` output and an MCP server make it a retrieval tool for LLM agents. Single-user, privacy-first.
- **Stack** (`package.json`): `better-sqlite3` + `sqlite-vec` (vectors) + SQLite FTS5 (BM25) + `node-llama-cpp` (GGUF: `embeddinggemma-300M` embed, `qwen3-reranker-0.6b` rerank, a **fine-tuned** `qmd-query-expansion-1.7B`) + `tree-sitter-*` (AST chunking of code) + `zod` + `@modelcontextprotocol/sdk`.

**Contrast with samesake** (set expectations for transfer): QMD is single-vertical *document* search — text-only, no images/multimodal, no enrichment/vision stage, one user, local small models, file-as-unit (no product catalog, no filters/facets/business ranking). So the *retrieval/rerank/eval mechanics* transfer; the *modality and product-catalog concerns* (visual space, enrichment gate, NLQ filters, business boosts) do not exist in QMD.

## 2. Architecture (the `query` pipeline)

`hybridQuery()` (`src/store.ts:4560`), documented at `:4547-4558`:

1. **BM25 probe → maybe skip LLM** (`:4581-4600`): run FTS first; if the top score is strong AND well-separated from #2 (`STRONG_SIGNAL_MIN_SCORE`/`_GAP`), skip the expensive query-expansion LLM entirely. Disabled when an `intent` is supplied.
2. **Query expansion** (`expandQuery` `:3781`): LLM emits typed variants — `lex` (keyword), `vec` (semantic), `hyde` (hypothetical-doc). Cached. Original query kept and **weighted ×2**.
3. **Type-routed retrieval**: `lex`→FTS5, `vec`/`hyde`→vector (sqlite-vec), original→both. FTS is sync/instant; vector queries are **batch-embedded** in one call.
4. **RRF fusion + bonuses** (`reciprocalRankFusion` `:3871`).
5. **Candidate cut** to `candidateLimit` (default 40; top ~30 kept).
6. **Chunk selection + rerank on chunks** (`rerank` `:3822`) — never on full bodies ("O(tokens) trap", `:4556`).
7. **Position-aware blend** of RRF score and reranker score (`:4786-4793`).
8. Dedup by file, `minScore` filter, slice to limit.

## 3. Implementation deep-dive (with file:line)

### 3.1 RRF + the two "preserve exact match" tricks — `src/store.ts:3871-3914`
```
rrfContribution = weight / (k + rank + 1)     // k = 60
```
Plus two additions samesake's RRF does NOT have:
- **Original-query ×2 weighting** (`getHybridRrfWeights:4543`): `queryType === "original" ? 2.0 : 1.0`. The un-rewritten query's result lists count double, so LLM-expanded variants can't drown the literal query.
- **Top-rank bonus** (`:3902-3909`): a doc that ranks #1 in any list gets `+0.05`, #2–3 get `+0.02`. Preserves documents that are the exact-match winner even if expanded queries disagree. Rationale (`README` §Fusion): "Pure RRF can dilute exact matches when expanded queries don't match."

### 3.2 Position-aware rerank blend — `src/store.ts:4786-4793` ⭐ (the headline learning)
```ts
let rrfWeight;
if (rrfRank <= 3)       rrfWeight = 0.75;   // trust retrieval; reranker only nudges
else if (rrfRank <= 10) rrfWeight = 0.60;
else                    rrfWeight = 0.40;   // tail: trust the reranker
const blendedScore = rrfWeight * rrfScore + (1 - rrfWeight) * rerankScore;
```
The reranker **never replaces** retrieval order — it is blended, and its influence *grows down the ranking*. The top of the list (high-confidence retrieval / exact matches) is protected from a confidently-wrong reranker; the tail (where retrieval is unsure) is where the reranker earns its keep. This is exactly the blend our parent RFC's G4 left unspecified.

### 3.3 Reranker — `src/store.ts:3822-3865`, `src/llm.ts`
- Uses llama.cpp's native **ranking context** (`createRankingContext`, `llm.ts:700`) with the cross-encoder `qwen3-reranker-0.6b` (`DEFAULT_RERANK_MODEL`, `llm.ts:253`). Score normalized to 0–1 (README: LLM 0–10 → `/10`).
- **Intent steering** (`:3824`): `rerankQuery = intent ? \`${intent}\n\n${query}\` : query` — a caller "intent" string is prepended so the reranker scores with domain context.
- **Rerank on chunks, cache by chunk text** (`:3826-3858`): cache key is `(query, model, chunk_text)` — *not* file path, because "the reranker score depends on the chunk content, not where it came from." Identical chunks across files are scored once.

### 3.4 Storage & retrieval backends — `src/db.ts`, `src/store.ts`
- Cross-runtime SQLite (`bun:sqlite` / `better-sqlite3`); on macOS swaps in Homebrew SQLite so `sqlite-vec` extensions load (`db.ts:30-45`).
- **BM25** via FTS5; **vectors** via `sqlite-vec` (`vectors_vec` table, `store.ts:4577`). Score normalization (README §Score Normalization): FTS `Math.abs(score)`; vector `1/(1+distance)`; reranker `score/10`.
- **CJK normalization for FTS** (`normalizeCjkForFTS:763`, `rebuildFTSForCjkNormalization:779`) — segments CJK so FTS tokenizes non-space-delimited languages.
- **docid** = first 6 chars of content hash (`CLAUDE.md`); stable short IDs in results (`#abc123`).

### 3.5 Chunking — `src/store.ts:275,2603-2652`, `src/ast.ts`
- Default **regex** chunking: ~900 tokens, 15% overlap, prefers markdown headings as boundaries (`CLAUDE.md`).
- **AST chunking** (`--chunk-strategy auto`, `ast.ts` + tree-sitter): code files chunk at function/class/import boundaries.

### 3.6 Context tree — `src/store.ts:3089 insertContext`, `:3137 listPathContexts`, `src/collections.ts`
The headline differentiator. Context strings attach to `qmd://collection/path` **prefixes** and form a tree; when a sub-document matches, its ancestor context is returned alongside it. README: "allows LLMs to make much better contextual choices when selecting documents. Don't sleep on it!" A global `context add /` injects a system message into every result.

### 3.7 Caching & model lifecycle — `src/store.ts` (getCacheKey/getCachedResult), `src/llm.ts`
- A SQLite cache table memoizes `expandQuery`, `rerank` (by chunk), and embeddings. Re-querying an unchanged corpus is cheap.
- Models stay loaded in VRAM; embed/rerank contexts are disposed after **5 min idle** and transparently recreated (~1s) (README §Performance).

### 3.8 Benchmark harness — `src/bench/score.ts`, `src/bench/bench.ts`
A file-based offline eval: a fixture maps a query → expected files (ground truth), and `scoreResults()` computes **precision@k, recall, recall@1/3/5, MRR, F1** by path-matching. Binary relevance (expected vs not), human-curated — simpler than an LLM judge, fully objective, zero per-run model cost.

### 3.9 Agent surface — `src/mcp/server.ts`, `src/cli/formatter.ts`
MCP server (stdio + HTTP daemon) and `--json`/`--files`/`--xml`/`--md`/`--csv` output, `--min-score`, `--all` — retrieval designed as an agent tool first.

## 4. Learnings for samesake (mapped to the RFCs)

### L1 ⭐ Position-aware rerank blend — answers the open question in G4
- **QMD:** `store.ts:4786-4793` blends `rrfWeight·rrf + (1−rrfWeight)·rerank`, weight `0.75/0.60/0.40` by RRF rank — reranker influence grows down the list; top exact-matches protected.
- **samesake:** the parent RFC G4 says "ship a default reranker" but `search.ts:850-855` currently *replaces* order with the reranker's. **Adopt the blend instead of a hard replace** in `rerankHits`: keep first-stage `rrf_score`, blend with the reranker score by the hit's RRF rank. This is the single most copyable idea — it directly de-risks G4 (a confidently-wrong LLM reranker can't destroy a high-confidence visual/exact match).
- **Maps:** amend RFC **G4 / REQ-13-14** (blend, don't replace). Effort **S**.

### L2 RRF: weight the literal query over the NLQ rewrite + top-rank bonus
- **QMD:** original query ×2 (`getHybridRrfWeights:4544`) + top-rank bonus (`:3902-3909`) so query expansion can't dilute exact matches.
- **samesake:** `search.ts` RRF (`RRF_K=60`) treats all channels/queries flat, and NLQ `semanticRewrite` *replaces* the query. Borrow: when NLQ rewrites, run **both** the literal and rewritten query and weight the literal higher; add a top-rank bonus so a product that's the #1 FTS exact match isn't buried by semantic expansion. Same anti-dilution rationale.
- **Maps:** **NEW** (refines core RRF in `search.ts`). Effort **M**.

### L3 Strong-signal short-circuit to skip LLM work
- **QMD:** `hybridQuery:4589-4600` skips query expansion when the BM25 top score is strong and gapped.
- **samesake:** NLQ already skips on short queries (`nlq.ts`); add a **strong-FTS-signal skip** (exact brand/style hit) to avoid an LLM NLQ/rerank call when retrieval is already confident. Latency + cost.
- **Maps:** **NEW** / refines G4 + NLQ. Effort **S**.

### L4 Rerank on a bounded `rerank_doc`, cache by content — validates G5, adds the cost discipline
- **QMD:** reranks chunks not bodies ("O(tokens) trap", `:4556`); caches rerank by `(query, chunk_text)` not file (`:3835`).
- **samesake:** G5's `rerank_doc` must be **bounded** (it's sent to the judge/reranker per candidate), and rerank/judge calls must be **cached by `(query, rerank_doc-hash)`** — exactly what the G8 eval RFC already specifies (`sha1(judgeVersion|query|rerank_doc)`). QMD independently validates that cache key shape.
- **Maps:** **G5 + eval-harness REQ-8**. Effort: already in scope.

### L5 Intent-steered reranking
- **QMD:** prepends a caller `intent` to both expansion and rerank queries (`:3824`).
- **samesake:** the e-commerce-assistant (Mastra) and agentic surfaces have shopper context; pass an `intent`/`shopperContext` string into the reranker prompt so "something for a beach wedding under $80" reranks with that framing, not just the literal query. Composes with the NLQ `semantic_query`.
- **Maps:** **G4** (reranker input). Effort **S**.

### L6 Start the G8 eval with a binary, judge-free golden metric — then add the LLM judge
- **QMD:** `bench/score.ts` is precision@k / recall@k / MRR / F1 against **human-curated expected files** — objective, no model, no calibration risk.
- **samesake:** we already have `evals/golden-queries-fashion-lk.json` and `constraints.max_price` for objective metrics. **Ship the binary "expected-product-ids per query" metric first** (free, deterministic), then layer the graded LLM judge (G8 RFC REQ-2/6) on top. This de-risks the eval harness: the judge can be wrong, the expected-ids can't.
- **Maps:** **eval-harness RFC** — sequence binary-objective before graded-judge. Effort: scoping, **S**.

### L7 Context tree → "why matched" + collection/category context for agents
- **QMD:** ancestor context returned with each hit so an LLM selects better; global context = system message.
- **samesake:** for agentic consumers, return per-hit **provenance/why-matched** (samesake's `explain` already has per-channel ranks) plus a short **collection/category context** string, and support a global context injected into agent tool output. Turns raw hits into LLM-selectable candidates — directly useful for the e-commerce-assistant.
- **Maps:** **NEW** (agent output / `explain` surface). Effort **M**.

### L8 A cheap default *text* reranker model for the fashion template
- **QMD:** `qwen3-reranker-0.6b` as the local default; they also *fine-tuned* a query-expansion model — i.e. investing in expansion/rerank quality pays off.
- **samesake:** G4's default reranker is BYO + LLM-judge (per the RFC/Mastra finding). QMD suggests offering **`qwen3-reranker`/Cohere `rerank-v3.5` as a documented drop-in** for consumers who want a dedicated cross-encoder instead of an LLM-judge — behind the same `RelevanceScoreProvider`-style interface (the Mastra pattern). Honest caveat: a 0.6B local reranker is text-only and can't see images, so it's a *text-channel* reranker only; samesake's visual reranking still needs a multimodal path.
- **Maps:** **G4** (reranker backend options). Effort **S** (docs + interface).

### L9 Minor borrows
- **CJK/multilingual FTS normalization** (`normalizeCjkForFTS:763`) — samesake serves LK/multilingual fashion; FTS tokenization for non-English/CJK is worth a look (`collections-schema-gen.ts` uses `to_tsvector('english', …)` — a known limitation). Effort **M**.
- **MCP-first + `--json/--files` agent output** validates samesake's agentic-commerce direction.

## 5. What does NOT transfer (honest)
- **On-device GGUF / no-API** is the opposite of samesake's cloud-quality, multimodal posture (`model-preferences`: gemini embeddings). QMD's tiny local models can't do visual embeddings or vision enrichment — samesake's core. Borrow the *algorithms*, not the runtime.
- **AST chunking / 900-token chunking** — N/A: a fashion product is one unit, not a long document to chunk.
- **No enrichment / quality gate / business ranking / filters/facets** — QMD has none of samesake's product-catalog concerns; nothing to learn there (those come from the DoorDash corpus instead).
- **HyDE expansion** is doc-RAG-shaped; samesake's NLQ semantic rewrite is the analogue and is enough for short product queries.

## 6. Net actions (ranked)
1. **G4: blend, don't replace** — adopt QMD's position-aware blend in `rerankHits` (L1). *Highest-value, smallest change; amend the RFC.*
2. **G4: intent-steered rerank** (L5) and **document a cross-encoder backend option** (L8).
3. **Core RRF: literal-query weighting + top-rank bonus** (L2) and **strong-signal skip** (L3).
4. **Eval harness: ship the binary objective metric before the graded judge** (L6); reuse QMD's precision@k/recall@k/MRR/F1 shape (`bench/score.ts`).
5. **Agent output: context/why-matched** (L7); **CJK FTS** if multilingual is a near-term target (L9).
