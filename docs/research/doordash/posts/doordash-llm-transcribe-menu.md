# Using LLM to transcribe restaurant menu photos
URL: https://careersatdoordash.com/blog/doordash-llm-transcribe-menu/

## Key mechanisms
- **OCR → LLM structured extraction (Figure 1):** MVP pipeline is OCR on menu photos, then an LLM itemizes/summarizes OCR text into structured menu data — not end-to-end vision-only transcription.
- **Three documented failure modes (Figure 2):** Accuracy drops when (1) inconsistent menu layout scrambles OCR reading order, breaking item↔attribute linkage; (2) cropped/incomplete menus produce orphan attributes; (3) bad photos (dark, glare, clutter) degrade both OCR and LLM.
- **Separate guardrail classifier, not prompt tuning alone:** A dedicated ML model predicts whether a transcription will meet accuracy requirements *before* auto-publish; they explicitly stopped trying to prompt-tune the LLM to perfection under limited-label constraints.
- **Guardrail inputs = photo + intermediate + output (Table 1 / Figure 3):** Features span three modalities — image, OCR raw text, LLM summary — with emphasis on *interaction* signals (e.g., illogical OCR order, attribute orphans, unreadable fonts). Architecture tried: CNN/Transformer image encoders (VGG16, ResNet, ViT, DiT) concatenated with tabular FC layers → binary “accurate enough?” head.
- **LightGBM wins on limited labels (Table 2):** On two metrics — mean transcription accuracy and % meeting accuracy requirements — **LightGBM beat all neural variants**; ViT worst (insufficient labeled data). Latency/cost cited as advantage of traditional ML guardrail.
- **Partial automation with human fallback (Figure 4):** Every photo is transcribed; guardrail scores it; above threshold → auto menu update; below → human transcription queue. Quality bar fixed, automation rate rises as models improve.
- **Model-agnostic guardrail layer (Figure 5):** After multimodal GenAI arrived, they run **multiple transcription backends** (OCR+LLM vs native multimodal) through the *same* guardrail — tradeoffs (multimodal: better context, worse on bad photos; OCR+LLM: stable but weaker context) absorbed at routing time, not by changing the quality threshold ad hoc.
- **Eval framing:** Guardrail is trained/evaluated against human-judged transcription accuracy on menu photos, not LLM self-report or BLEU-like text metrics.
- **Stated future work:** Fine-tune transcription models on accumulated human transcriptions; improve **upstream photo quality** because it remains the dominant failure driver for all model families.

## Learnings for samesake
### L1: Post-enrichment quality gate beats chasing perfect vision-LLM output  [maps: G2]
- DoorDash evidence: Production path is LLM transcription **plus** a guardrail that blocks auto-publish when predicted accuracy is low; they explicitly chose this over endless LLM prompt/instruction investment.
- Samesake action: Implement RFC `PipelineDef.gate` in `packages/sdk/src/templates/fashion.ts` / `enrich-pipeline.ts` — quarantine on `confidence < FASHION_CONFIDENCE_FLOOR` (0.4), `is_apparel_product === false`, `category === 'other'`; set `pipeline_status='quarantined'`, null vectors per REQ-5b, exclude from all search channels (REQ-6b). Treat LLM `confidence` as a *feature*, not a post-hoc review filter only (`review.ts` today).
- Why / caveat: Same failure shape — vision LLM struggles on bad/incomplete product shots — but fashion SKUs are structurally simpler than arbitrary menu layouts; a rule gate on existing schema fields is proportionate v1. DoorDash’s learned guardrail is phase 2 once quarantine + `reviewCorrect` yields labeled pass/fail rows.

### L2: Gate on cross-signal interactions, not final JSON alone  [maps: G2 | NEW]
- DoorDash evidence: Guardrail features deliberately encode **photo × OCR × LLM** interactions (scrambled OCR order, orphan attributes, unreadable image regions) — not just the final structured record.
- Samesake action: Extend `gate(ctx)` beyond scalar `confidence`: (a) `uncertain_fields` density / presence of high-stakes fields (`category`, `colors`, `gender` per `fashion.ts:147`); (b) cross-stage consistency when classify vs extract disagree on category/type; (c) image-side signals from `fetch-image.ts` / G1 validators (failed fetch, tiny dimensions, pHash drift vs stored etag). Log `reason` per RFC for later LightGBM training.
- Why / caveat: No OCR middle layer in samesake — interaction is **image + stage-1 classify + stage-2 extract + compose output**, not OCR text order. Still directly addresses “mostly inferred” enrichments that would poison `embed_doc` and visual space if indexed (embedding hygiene REQ-11b).

### L3: Partial automation = quarantine + human review loop, not silent index  [maps: G2 | G6]
- DoorDash evidence: Figure 4 pipeline — all items processed; guardrail fail → human path; pass → production. They never ship low-confidence transcriptions to consumers to “save cost.”
- Samesake action: Split RFC statuses cleanly: **`quarantined`** = quality gate fail (human review via existing `review.ts` / `reviewCorrect` → few-shot examples); **`failed`/`dead`** = infra errors with `retryFailed` backoff (G6). Do not index quarantined rows and do not rely on nulled vectors alone — FTS still matches `title` (REQ-6b). Wire review UI to `pipeline_status='quarantined'` and `gate.reason`.
- Why / caveat: DoorDash has a staffed human transcription queue at marketplace scale; samesake retailers are smaller — but the *mechanism* (block search, preserve enriched JSON for correction) is the same and cheaper than bad vectors in HNSW.

### L4: Bad source photos are an upstream gate, not an index-time zero vector  [maps: G1 | G2]
- DoorDash evidence: Low photo quality is called out as the root cause affecting **both** OCR+LLM and multimodal paths; future work targets photo quality *before* transcription.
- Samesake action: Align G1 + G2 + M5: `revalidateImages` + pHash/`image_etag` in `content_hash` and `stageCacheKey` (REQ-3b); on index-time image fetch/embed failure, mark `pipeline_status='failed'` with `last_error` — **never** write zero visual segment and set `indexed_at` (`embed-index.ts:163-207` today). Optionally add gate predicates on minimum image dimensions / fetch status before spending enrich tokens.
- Why / caveat: Fashion catalog images are usually studio-grade vs phone photos of laminated menus — but CDN re-crops, stale URLs, and marketplace seller uploads still trigger the same silent-drift failure mode G1 fixes.

### L5: Keep transcription/enrichment swappable; keep the quality bar fixed  [maps: G2 | G3 | NEW]
- DoorDash evidence: Figure 5 — guardrail unchanged while swapping OCR+LLM for multimodal GenAI; none of the backends dominated; guardrail absorbs model tradeoffs so automation rate can rise without moving the accuracy threshold per model.
- Samesake action: Implement compose/gate as model-invariant `PipelineDef` hooks (RFC §2.3) so consumers can swap BYO `generate`/vision models without changing search contract; measure **auto-index rate** (% `ready` vs `quarantined`) and quarantine reasons when evaluating a new model — not ad-hoc threshold tweaks or skipping `composeFashionEmbedDoc`. Feed `reviewCorrect` outcomes into stage few-shots (already cached by SHA1 prompt|image|schema) as DoorDash’s planned fine-tuning analogue — skip full model fine-tune until label volume justifies it.
- Why / caveat: samesake adds retrieval stages DoorDash doesn’t discuss (RRF, rerank, spaces) — guardrail only protects enrich→index; G4/G5 rerank and G7 boosts remain separate relevance layers.

## Applicability caveats
- **No OCR seam:** DoorDash’s strongest interaction features (OCR reading order, raw text chaos) have no direct analogue; samesake’s equivalent is vision-stage consistency, not text-order heuristics.
- **Table 1 / Table 2 lack numbers:** The post never publishes feature names, label counts, guardrail threshold, or accuracy targets — you cannot copy their LightGBM feature set or operating point; only the architectural pattern transfers.
- **Human ops at different scale:** Partial automation assumes a human correction path; for tiny catalogs, quarantine volume may be manageable by hand, but there is no DoorDash-scale ops team — rule gate + review endpoint is sufficient; learned guardrail is optional.
- **Search stack not covered:** Nothing on hybrid retrieval, embeddings, reranking, or business boosts — maps to G4/G5/G7 only by absence; DoorDash optimizes transcription correctness, not query-time ranking.
- **Vertical mismatch:** Menu transcription is text/price/category extraction from documents; samesake is visual+intent fashion search with filterable attrs and multi-space vectors — guardrail should quarantine bad enrichments, not replicate menu-specific linkage logic.
