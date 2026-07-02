# Decisions — Conversational/Agentic Commerce Search Framework

These are the opinionated, evidence-backed decisions distilled from the 21 dossiers in this
research tree (Marqo teardown, YC segment, academic retailer/conversational/fusion-scaling
literature, OSS engines, commercial platforms, agentic protocols, RAG, recommendations).
Every decision carries a **flip condition**. Citations point to the dossier that grounds it.

## Verdict at a glance

| # | Decision | Verdict | Flip condition |
|---|---|---|---|
| 1 | **Positioning** | Brand-owned, in-app, typed, auditable retrieval **compiler** — the opposite of every hosted-SaaS incumbent. Don't chase the full funnel. | Flip if the market consolidates on hosted-only and "in-app/owned Postgres" stops being a buying criterion for premium/fashion/autonomous-brand teams. |
| 2 | **Hybrid retrieval** | Keep **FTS + cosine ANN fused by RRF** — it is the industry consensus (Walmart, Taobao, Instacart, Etsy, Mercari). | Flip the *default* to convex-combination (CC) once a tenant has a labeled eval set. |
| 3 | **Fusion function** | **RRF (k=60) as zero-config default; expose tunable CC (min-max norm) as the labeled path.** Sweep k in the gate; don't treat 60 as sacred. | Promote CC to default for a tenant once ≥~50 labeled queries exist (Bruch TOIS 2023). |
| 4 | **Next quality lever** | **Optional, distilled, latency-gated cross-encoder reranker over the RRF top-K** — higher leverage and lower architectural risk than re-enabling "spaces". | Adopt only if it beats current grade@10≈2.33 / P@5 0.83 on the LK corpus **within a stated latency+FLOPs budget**. |
| 5 | **"Spaces" (segmented vectors)** | **Keep off by default** (failed the gate) but re-investigate as a *training/fusion* problem — Etsy's unified graph+transformer+term embedding succeeded externally. CC weighting is a cleaner down-weight than dropping. | Turn on per-tenant only if it clears the same gate with CC weighting (not flat RRF). |
| 6 | **ColBERT / SPLADE** | **Do not adopt.** Both break the two-container promise (multi-vector / postings bloat); SPLADE weights are NC-licensed. | Revisit ColBERT only if pgvector gains native multi-vector/MaxSim; SPLADE only with a permissive LSR model. |
| 7 | **Filtered-ANN over-filtering** | **The #1 architectural risk.** Enable + tune pgvector **iterative scans** (`hnsw.iterative_scan='relaxed_order'`); exact KNN fallback on small filtered sets; surface in `/search/explain`. | n/a — this is a must-fix, not an option. |
| 8 | **Scaling substrate** | **Stay in Postgres: pgvector + native FTS.** Perf upgrade path = **pgvectorscale (StreamingDiskANN, PostgreSQL license)** + **pg_textsearch BM25**. Avoid **AGPL** pg_search/ParadeDB and Elasticsearch-AGPL. | Reach for an external engine (Qdrant/Vespa/Milvus) only when a tenant catalog truly exceeds single-Postgres HNSW RAM limits (low-millions+). |
| 9 | **Conversational surface** | **One bounded clarifying question**, gated on retrieval-score entropy/dispersion + hard-filter cardinality, asked over a *typed facet*. Keep the **constrained-schema NLQ parser** (don't add free-form LLM rewrite on the hot path). | Add a second clarification turn only if eval shows monotonic HIT@10 lift without conversion drop. |
| 10 | **Agentic boundary** | **Stop at retrieval.** Validated by the protocol stack, Amazon REAPER, WebShop/ShoppingBench (agents fail at planning/checkout, not retrieval), and the ChatGPT Instant-Checkout rollback (Mar 2026). | Flip only if a checkout standard wins so decisively that "retrieval-only" becomes unsellable — currently the opposite is true. |
| 11 | **Protocol integration** | Build, in order: **(1) UCP-Catalog MCP server**, **(2) ACP product-feed exporter**, **(3) agent-identity/OAuth gating**, **(4) keep parsed-intent + explain serializable** for AP2 mandates. | Reprioritize if a non-UCP/ACP discovery standard reaches comparable agent reach. |
| 12 | **Recommendations** | **Stay retrieval-pure + ship ONE native item-to-item "more-like-this"** (free in pgvector, content-based, cold-start-native, auditable). Do **not** build behavioral CF/sequential/graph. Integrate downstream (AWS Personalize, Recombee). | Build a behavioral surface only if a tenant brings its own interaction log *and* explicitly wants samesake to own ranking on it. |
| 13 | **Generation / RAG** | **Don't add generation.** Harden the **handoff contract**: grounding payload + calibrated scores/entropy + freshness re-verify hook + single MCP tool. | n/a — the contract is the product surface, not a model. |
| 14 | **Eval & proof** | Adopt **ESCI E/S/C/I 4-grade** taxonomy (eval-only — NC license); add **NDCG@10 + Recall@20/50**; **stratify head vs tail**; build a **filtered-recall** eval; treat **online conversion** as the eventual proof bar. | n/a — eval discipline is a standing commitment. |
| 15 | **Fashion retrieval depth** | Deepen retrieval, not generation: **region-grounded enrich embeddings** (VL-CLIP) + **LLM image captions → text** (Pinterest) + a typed **compatibility "space"** for complete-the-look/FITB. | Defer compatibility space if "similar look" demand doesn't materialize in tenant usage. |

### Completeness-pass additions (Decisions 16–25 — full detail in `07-completeness-pass-additions.md`)

| # | Decision | Verdict | Flip condition |
|---|---|---|---|
| 16 | **Multilingual / code-mixed** ⭐ | **The #1 quality investment.** "Local" weakness is structural (low-resource langs + FTS dead on non-Latin + romanized code-mixing). Add a **normalization+transliteration front-door**, adopt **BGE-M3** (sparse head replaces FTS leg), route native-script lexical via `sparsevec`. | Drop the front-door if a model natively handles romanized code-mixed Sinhala/Tamil at parity on the LK bench. |
| 17 | **Embedding defaults + halfvec** | Ship recipes (open: Qwen3-0.6B + Marqo-FashionSigLIP; managed: Gemini/Voyage + Cohere v4). **`halfvec` as default column.** Matryoshka + binary-rescore as scale levers. | Re-pick when a model beats Qwen3 on the LK bench or pgvector ships int8. |
| 18 | **Query-side + named reranker** | **doc2query at index-time** (zero query-cost, attacks vocab mismatch) + **bge-reranker-v2-m3** default. HyDE/query2doc opt-in only. | Promote online-LLM expansion to default only if it clears the LK bench within latency budget. |
| 19 | **Merchandising/faceting/diversity** (table stakes) | **Score modifiers** (multiplicative post-RRF, never in-model), pins/hides, field-collapse diversity, `GROUPING SETS` faceting, count-gated **relaxation ladder → vector-only fallback**, freshness decay — all auditable in `/search/explain`. | Add MMR only if field-collapse insufficient and grade@10/P@5 hold. |
| 20 | **Personalization** (corrects #12/D05) | **Content/context-vector personalization needs no log** (Rocchio taste-vector + negative examples + **visual-onboarding cold-start** + externalized multi-turn state). Still avoid behavioral CF. | Build behavioral only if a tenant brings its own interaction log. |
| 21 | **Agentic/MCP security** | "Stops at retrieval" removes the lethal-trifecta action leg. Own: typed output, provenance + trust-gated modifier, OAuth 2.1 + **no token passthrough** + one read scope, **never return vectors**, gate-before-ANN tenancy. Never claim "injection-safe". | n/a — standing posture. |
| 22 | **Fit/sizing** | Own the retrieval surface, not the model: **size-availability hard gate**, signed `fit_signal` soft modifier, fit-profile context, **BYO FitRecommender** adapter. No body scans. | Deeper fit modeling only with tenant return-outcome data. |
| 23 | **GEO / feeds** | Own catalog **legibility**, refuse rank-control: **feed export adapters** (Google Shopping CSV / ACP / schema.org JSON-LD) + **`/catalog/lint`** + factuality-gated enrich-for-legibility. Keyword stuffing proven to hurt. | Revisit if an engine ever exposes a real ranking signal (none does). |
| 24 | **Visual depth** | **VL-CLIP enrich** now (+18.6% CTR, index-time); **VLM-rerank + MUVERA** as gated pilots; **avoid raw ColPali + VectorChord (AGPL)**; OWL-ViT bbox highlights. | Native-MaxSim path if pgvector gains multi-vector (#640). |
| 25 | **Eval methodology** (deepens #14/D06) | Trust **aggregate deltas not per-item** (judge κ≈0.35); **never enrich+judge with same model family**; version-pin judge; **multimodal + pairwise** judge; **interleaving** for low-traffic tenants. | n/a — standing discipline. |

⭐ = highest-priority single finding of the whole research.

## Docs in this folder

- `01-positioning-and-thesis.md` — the wedge vs Marqo and the hosted-SaaS market; what samesake must *not* chase.
- `02-retrieval-and-ranking.md` — RRF/CC, cross-encoder reranker, "spaces" verdict, ColBERT/SPLADE avoid, filtered-ANN fix, fashion compatibility.
- `03-scaling-and-infra.md` — pgvector regime, pgvectorscale/pg_textsearch upgrade path, license hazards, catalog-size ceiling.
- `04-conversational-agentic-and-protocols.md` — clarifying-question gate, NLQ stance, handoff contract, UCP/ACP/MCP build order.
- `05-recommendations-and-rag-boundary.md` — stay retrieval-pure; the one native item-to-item exception; integration targets.
- `06-eval-and-proof.md` — ESCI, metric set, head/tail stratification, filtered-recall, online proof bar (+ §7 methodology).
- `07-completeness-pass-additions.md` — Decisions 16–25 from the gap-fill pass, each pointing to its `10-gaps/` dossier.
- `../BUILD-READY.md` — prioritized first commits (updated to integrate the completeness-pass tiers).
- `../10-gaps/` — the 11 firsthand gap dossiers + the under-weighted-nugget log.
