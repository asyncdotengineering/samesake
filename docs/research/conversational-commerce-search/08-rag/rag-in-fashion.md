# RAG and Retrieval-Augmented Systems in Fashion

> Prior-art dossier for **samesake** — a TypeScript-first "search engine compiler" for visual commerce (fashion-first). samesake compiles a typed catalog into a Postgres + pgvector hybrid retrieval layer (FTS + cosine ANN over BYO embeddings + typed segmented "spaces" vectors, fused via RRF), with hard/soft SQL filters, an NLQ parser, a multimodal enrich pipeline, entity resolution, `/search/explain`, and an agentic `findProducts()` surface that **stops at retrieval**.
>
> This file surveys fashion-*specific* retrieval and grounding: outfit/styling recommendation, multimodal RAG for apparel, virtual stylists / fashion chatbots, compatibility & "complete the look", trend/occasion grounding, fashion knowledge graphs, fashion VQA, and the canonical datasets. The throughline question: **what fashion-specific retrieval/grounding patterns should samesake support, and where do its visual "spaces" + enrich pipeline map onto these?**

---

## 0. TL;DR for samesake

- **The field has converged on fashion-domain embeddings as the substrate.** FashionCLIP (Nature 2022) and Marqo-FashionCLIP/SigLIP (2024) prove that domain-tuned contrastive image-text embeddings beat generic CLIP on fashion retrieval by large margins. samesake's "BYO embeddings + typed spaces" design is the *correct primitive* — it should explicitly bless fashion-tuned models (FashionCLIP, Marqo-FashionSigLIP) as recommended encoders and document the wiring.
- **"Spaces" maps almost 1:1 onto a documented research insight.** Marqo's Generalized Contrastive Learning optimizes seven fashion aspects (description, title, color, details, category, keywords, material). samesake's segmented "spaces" vectors are the retrieval-time analogue: a typed space per aspect (color-space, material-space, occasion-space) fused with RRF. This is a differentiator worth naming explicitly.
- **Compatibility / "complete the look" is a distinct retrieval task samesake does NOT yet model.** It is *complementary* retrieval (find items that go *with* X), not *similar* retrieval (find items *like* X). This is the single biggest fashion-specific gap. It is implementable as a retrieval pattern (a learned compatibility space + asymmetric query) without crossing into "generation" or "recommendations as a service."
- **Grounding/verification is where samesake already has the right instinct.** The 2025 agentic-fashion survey explicitly calls for an "Attribute Guard" that "verifies fine-grained attribute compliance post-retrieval" — exactly what `findProducts()` verification/grounding/why is for. samesake should lean into this as a first-class fashion feature.
- **samesake should stay at retrieval but expose the *hooks* for downstream styling.** Fashion-RAG, FashionM3, Stitch Fix Vision all do generation/try-on; that is downstream of samesake. The right move is to be the *grounded retrieval substrate* those systems retrieve from, with strong attribute/occasion/compatibility filtering and explainability.

---

## 1. The taxonomy of fashion retrieval tasks

Fashion is not one retrieval problem. The literature separates at least six:

| Task | Question | Query → Result | samesake coverage today |
|---|---|---|---|
| **Similarity / catalog search** | "Find items like this / matching this text" | text/image → similar products | **Core** (hybrid FTS + ANN + RRF) |
| **Attribute / category retrieval** | "Black silk midi dress under £200" | constraints → products | **Core** (hard SQL filters gate before rank) |
| **Compatibility / complementary** | "What goes *with* this jacket?" | item → *different-category* items that pair | **Gap** |
| **Complete-the-look (scene-based)** | "Given this outfit/scene, what completes it?" | scene image → complementary products | **Gap** |
| **Fill-in-the-blank (FITB)** | "This outfit is missing one slot — fill it" | partial outfit → best item per slot | **Gap** |
| **Conversational / VQA grounding** | "Is this machine washable? Does it run small?" | NL question over item(s) → grounded answer | **Partial** (NLQ parse + retrieval, no answer-gen) |

samesake is excellent at rows 1–2 and architecturally positioned for row 6 (it parses NL into a constrained schema and grounds answers in retrieved products via `findProducts()`). Rows 3–5 are the **fashion-specific retrieval patterns** the field has spent a decade on and samesake does not yet model.

---

## 2. Fashion-domain embeddings (the substrate samesake already bets on)

### FashionCLIP — *Contrastive language and vision learning of general fashion concepts* (Nature Scientific Reports, 2022)

- **What:** CLIP (ViT-B/32 image encoder + masked-self-attention text encoder) fine-tuned on ~800K Farfetch products. "FashionCLIP is a general model to embed images of fashion products and their description in the same vector space."
- **Who:** Chia, Attanasio, Bianchi et al. — industry (Coveo, Farfetch) + academia (Stanford, Bocconi, Bicocca). Published in *Scientific Reports* 12:18958.
- **Proven:** Effective zero-shot transfer across fashion retrieval/classification tasks vs generic CLIP. Weights open-sourced (MIT) on HuggingFace (`patrickjohncyh/fashion-clip`).
- **Relevance to samesake:** This is the canonical BYO embedding for a fashion-first engine. samesake's docs should recommend it (or its successors) as the default image+text encoder feeding the vector columns.

### Marqo-FashionCLIP / Marqo-FashionSigLIP (Marqo, 2024)

- **What:** 150M-param embedding models trained on >1M fashion products with rich metadata, using **Generalized Contrastive Learning (GCL)** — optimizing *seven fashion aspects simultaneously*: **descriptions, titles, colors, details, categories, keywords, materials.**
- **Proven (their benchmarks, 7 public datasets, 52K–721K images each):**
  - Marqo-FashionSigLIP: **+57% Recall@1** text-to-image vs FashionCLIP2.0
  - Marqo-FashionCLIP: **+22% Recall@1** text-to-image vs FashionCLIP2.0
  - +8–13% Precision@1 on category/sub-category; ~10% faster inference.
- **License:** Apache 2.0; HuggingFace + Marqo Cloud.
- **Marketed vs proven:** the benchmark deltas are reproducible (public eval suite); the "best for e-commerce" framing is marketing. The *load-bearing* insight is GCL's multi-aspect objective.
- **Relevance to samesake — this is the closest analogue to "spaces".** GCL bakes all seven aspects into *one* embedding at train time. samesake's typed segmented "spaces" do the analogous thing at **retrieval time and in user space**: a color-space, a material-space, an occasion-space, each a separate vector column, fused with RRF. samesake gets the same multi-aspect behavior **without retraining an encoder** — a strong story for BYO-model users. Document this mapping explicitly.

### VL-CLIP — *Visual Grounding + LLM-Augmented CLIP* (Walmart, arXiv 2507.17080, 2025)

- **Problem:** CLIP's *global* image embeddings miss fine-grained attributes; product text is noisy; generic VLMs don't transfer.
- **Method:** (1) **Grounding DINO** localizes the product region (kills background noise) before embedding; (2) an LLM summarizer→evaluator→refiner rewrites product descriptions into structured text; (3) contrastive fine-tune with symmetric InfoNCE.
- **Proven:** HITS@5 **0.6758 (fashion)** / 0.6692 (home) vs CLIP 0.3080/0.2355. Production A/B: **+18.6% CTR, +15.5% add-to-cart, +4% GMV** on "one of the largest U.S. e-commerce platforms" (Walmart), 7M products.
- **Relevance to samesake:** Two transferable ideas. (a) **Region-grounded embeddings** — embed the *segmented garment*, not the lifestyle photo. samesake's **enrich pipeline is the natural home for a detect-and-crop step** before embedding. (b) **LLM-normalized attribute text** feeding the FTS/text vector — again an enrich-pipeline job. Both are retrieval-quality wins that stay inside samesake's stated scope (enrich + retrieval), not generation.

---

## 3. Multimodal RAG for apparel (image + text)

### Fashion-RAG — *Multimodal Fashion Image Editing via Retrieval-Augmented Generation* (IJCNN 2025, arXiv 2504.14011)

- **Abstract (verbatim opening):** *"In recent years, the fashion industry has increasingly adopted AI technologies to enhance customer experience... virtual try-on and multimodal fashion image editing -- which utilizes diverse input modalities such as text, garment sketches, and body poses -- have become a key area of research."*
- **Method:** retrieves multiple garments matching a text spec, then **projects retrieved garment images into the textual embedding space of Stable Diffusion via textual inversion**, so generation incorporates real catalog attributes. Evaluated on the **Dress Code** dataset; outperforms baselines qualitatively and quantitatively. Claims to be "the first... RAG approach specifically tailored for multimodal fashion image editing."
- **Relevance to samesake:** This is **RAG-for-generation** — *downstream* of samesake's retrieval boundary. The important lesson is the *shape*: the generator is only as good as the retriever feeding it real garments. samesake is exactly the "retrieve real, attribute-correct garments" half. **Positioning:** samesake can be the retrieval backend a Fashion-RAG-style editor pulls from; samesake should not build the diffusion side.

### "Multimodal RAG with CLIP for fashion recommendations" (practitioner pattern)

- The common community pattern (e.g., the Medium/Byte-Sized AI walkthrough): CLIP-embed catalog images → vector store → at query time embed a user image + text → retrieve nearest products → optionally hand to an LLM to phrase a recommendation. This is **exactly samesake's hybrid retrieval minus the LLM phrasing step**, and validates the core architecture. The differentiator samesake adds over the naive pattern: hard SQL filters that gate *before* ranking (so "under £200, in stock" is guaranteed, not hoped for) and RRF fusion of text + image + spaces.

---

## 4. Outfit compatibility, complete-the-look, and complementary retrieval (the biggest gap)

### Complete the Look — *Scene-based Complementary Product Recommendation* (CVPR 2019)

- **Authors:** Kang, Kim, Leskovec, Rosenberg, McAuley (Pinterest / Stanford / UCSD).
- **Task (verbatim framing):** given a **scene image** and a **product image**, compute a distance that "reflects visual complementarity between the scene and the product." Compatibility measured **globally and locally** via CNNs + attention. Datasets: **STL-Fashion** and **STL-Home** (scene–product pairs, product bounding boxes, categories).
- **Key distinction:** complementarity ≠ similarity. The whole point is to retrieve items that are *visually different* but *go together*. Standard ANN over a similarity embedding actively retrieves the *wrong* thing here.
- **Relevance to samesake:** To support "complete the look", samesake needs a **compatibility space** — a vector column where two items that *pair well* are close, learned from outfit co-occurrence (Polyvore-style). Query becomes asymmetric: "items in category C whose compatibility-vector is near *this* item's compatibility-vector." This fits samesake's spaces model cleanly (it's just another typed vector column + a category hard-filter), but the **embedding must be a compatibility embedding, not a similarity one** — a BYO-model requirement to document.

### Outfit compatibility on Polyvore (FITB + compatibility prediction)

- **Polyvore dataset:** ~68,306 outfits / ~251,008 garments — the canonical outfit-compatibility benchmark. Two standard tasks: **compatibility prediction** (score a set as an outfit) and **fill-in-the-blank (FITB)** (pick the item that best completes a partial outfit).
- **Methods span:** type-aware embeddings (different metric per category pair), GNNs over outfit graphs (*Outfit Compatibility using GNN*, arXiv 2404.18040, reports AUC ~0.95 with an "outfit token"), and transformer incompatibility detectors (**VICTOR**, arXiv 2207.13458).
- **Fashion Outfit Complementary Item Retrieval** (arXiv 1912.08967): builds explicit *retrieval* ground truth on Polyvore Outfits (most prior work only scored compatibility, didn't retrieve). Directly relevant: it frames complementary recommendation as a *retrieval* problem with recall metrics — the framing samesake would adopt.
- **Relevance to samesake:** FITB ≈ "this outfit has an empty shoe slot; retrieve the best shoe." Implementable as: hard-filter to the missing category, rank by compatibility-space proximity to the present items (aggregated), fuse with availability/price. **Stays at retrieval. No generation.**

### Verdict table — compatibility/complete-the-look approaches

| Approach | Year | Retrieval-shaped? | Needs special embedding? | Fits samesake spaces? | Verdict for samesake |
|---|---|---|---|---|---|
| Complete the Look (scene-based, attention) | 2019 | Partial (scoring) | Yes (compat) | Yes | **Adopt the task framing**; reference design for a compatibility space |
| Type-aware embeddings (Polyvore) | 2018+ | Yes | Yes (per-type metric) | Yes (one space per type-pair is heavy) | **Differentiate** — RRF over a single compat-space is simpler |
| GNN outfit compatibility (AUC ~0.95) | 2024 | No (scores sets) | Yes (graph) | No (graph ≠ ANN) | **Avoid in-engine**; too heavy, not a retrieval primitive |
| Complementary Item Retrieval w/ recall GT | 2019 | **Yes** | Yes | **Yes** | **Adopt** — closest to a samesake retrieval pattern |
| VICTOR (transformer incompatibility) | 2022 | No | Yes | No | **Avoid** — diagnostic, not retrieval |

**Bottom line:** the right samesake feature is a **typed "compatibility space"** + asymmetric, category-gated retrieval — adopting the *complementary item retrieval* framing, not the GNN/transformer scoring framing.

---

## 5. Virtual stylists, fashion chatbots, and agentic styling

### FashionM3 — *Multimodal, Multitask, Multiround Fashion Assistant* (arXiv 2504.17826, 2025)

- **What:** a fashion assistant built on a fashion-fine-tuned VLM. Capabilities: **personalized recommendation, alternative suggestion, product image generation, virtual try-on simulation.** Multiround = conversational.
- **Data:** **FashionRec** — 331,124 multimodal dialogue samples across basic / personalized / alternative recommendation tasks.
- **Relevance to samesake:** FashionM3 spans retrieval *and* generation *and* try-on. samesake is the **retrieval + alternative-suggestion** core; the generation/try-on are downstream. The "multiround" insight matters: a stylist conversation needs **stateful constraint accumulation** ("formal-ish, K-pop inspired, under €200" then "actually make it warmer"). samesake's NLQ parser → constrained schema is the right substrate, but conversational state (carrying/relaxing constraints across turns) is a gap worth noting.

### Agentic Personalized Fashion Recommendation in the Age of Generative AI (survey, arXiv 2508.02342, 2025)

This is the most directly useful paper for samesake's positioning. Verbatim load-bearing claims:

- **Why fashion is hard:** *"Fashion is intensely visual, with color palettes, textures, and designs needing careful coordination across body (e.g., tops, pants, jackets, bags)."* and *"Fashion experiences rapid, often short-lived (seasonal and cultural) swings. A jacket popular this winter may be outdated next year."*
- **RAG + grounding in their pipeline (AMMR):** *"multimodal encoders, dynamic query composition, and an LLM-based agentic planner to deliver fast, accurate, and constraint-aware recommendations."*
- **Post-retrieval verification (this is the key one):** *"Attribute Guard (Bliva-3): Verifies fine-grained attribute compliance post-retrieval, minimizing false positives."*
- **Trend grounding:** the planner *"accesses external trend API; Memory injects recent style tokens into composer."*
- **Critic:** *"Evaluates recommendations for safety, fairness, and ROI, eliminating unsuitable options."*
- **Open eval gap:** *"Lack of standard protocols for evaluating outfit-level compatibility or for capturing 'style drift' over a season."* and a call for a *"Holistic Evaluation Protocol."*
- **Reliability:** *"Safeguarding against hallucinations in LLM-generated explanations, ensuring robust retrieval-augmented verification."*

**Relevance to samesake (high):**
- The **"Attribute Guard / verify attribute compliance post-retrieval"** is *exactly* what `findProducts()` verification/grounding/why does. samesake should brand this as a fashion feature: every returned item carries proof that it satisfies the parsed constraints (color, material, price, availability), eliminating LLM-hallucinated "this is a red dress" when it isn't.
- **Trend/occasion grounding** is a known gap with a known shape: inject time-varying "style tokens" / occasion context into the query. In samesake this is a **trend/occasion space** (vectors for "office-summer-2026", "quiet-luxury") plus soft-filter relaxation — a natural extension, BYO-data.
- samesake correctly **stops before the Critic/planner/generation** — those are agent-orchestration concerns outside a retrieval engine.

### Production virtual stylists (PROVEN-in-market vs MARKETED)

- **Stitch Fix (Style Assistant / Vision, 2024–2025):** conversational AI Style Assistant (iOS beta) gives AI-generated outfit ideas; **Stitch Fix Vision** lets clients upload a selfie + full-length photo to see realistic generated images of themselves in **full outfits** in varied backdrops. Reported "higher order values" in early rollout (vendor-reported, not independently verified). *Proven:* shipped product. *Marketed:* the lift numbers.
- **Algolia "Intelligent Fashion" (2024):** vendor solution layering fashion-tuned search/merchandising on top of retrieval — a competitor to the "search-as-a-service" framing samesake deliberately *isn't* (samesake runs in your own app, two containers). Differentiation point, not a model to adopt.
- **ClaireBot / community stylist bots:** image-in → style advice; demonstrates the *demand* but not a rigorous system.

---

## 6. Fashion knowledge graphs and ontologies (grounding by structure, not just vectors)

- **Fashionpedia** (arXiv 2004.12276): an **ontology + segmentation + attribute-localization** dataset. Explicitly positioned to "construct a large-scale fashion knowledge graph... at the product level," covering "main garments, garment parts, attributes, and relationships," with stated applicability to "fashion product recommendation" and "fashion visual search." This is the canonical *structured* fashion vocabulary.
- **Occasion-specific ontologies** (e.g., ResearchGate: *Ontology-Driven Fashion Recommender for Occasion-Specific Apparels*) and **clothing knowledge graphs** (user/clothing/context KGs, Apriori-mined attribute↔context rules) ground recommendation in explicit relations rather than learned proximity.
- **Relevance to samesake:** samesake's **typed catalog declaration is already a lightweight ontology** — typed attributes, categories, constraints compiled to SQL. The KG literature suggests two cheap wins: (1) an **attribute taxonomy / synonym layer** in the enrich pipeline (so "burgundy" ≈ "wine" ≈ "maroon" map to one color node, improving both FTS and color-space recall); (2) **occasion ↔ attribute rules** ("black-tie" → {floor-length, dark, formal-fabric}) usable to *expand or constrain* NLQ output. This is structured grounding that complements vectors and fits samesake's "compile a typed declaration" identity. It does **not** require a full graph DB — relational rules + a synonym table suffice.

---

## 7. Fashion VQA and conversational grounding

### FashionVQA (CVPR-W 2023 / arXiv 2208.11253)

- **What:** a domain-specific VQA system answering NL questions about apparel in photoshoot images. Dataset: **168M QA samples** auto-generated from **207K images**, with difficulty-aware sampling. A VLM (same transformer encodes question + decodes answer) **surpasses human-expert accuracy** even on human-written (non-template) questions.
- **Stated applications:** *"dialogue, recommendation, and search engines for clothing."* Authors emphasize domain-specific data is required — general web VQA data is insufficient.
- **Relevance to samesake:** VQA is the **answer-generation** end of conversational commerce; samesake stops at retrieval. But the *grounding discipline* transfers: a question like "is this linen?" should be answered from **structured attributes** (enrich-extracted), not hallucinated by an LLM looking at a photo. samesake's enrich pipeline + attribute store is the **trustworthy source a fashion VQA layer would query**. Positioning: samesake supplies grounded facts; a downstream VQA/chat layer phrases them. This is the safe division of labor the agentic survey's "Attribute Guard" implies.

---

## 8. Canonical datasets (reference for benchmarking / enrich-pipeline design)

| Dataset | Scale | What it provides | Primary tasks | Relevance to samesake |
|---|---|---|---|---|
| **DeepFashion** | ~800K images | attributes, landmarks, categories, cross-domain pairs | attribute prediction, retrieval, landmark | Benchmark for attribute extraction (enrich pipeline) |
| **Fashion-Gen** | 325,536 images / 293,008 stylist captions (260,480 train / 32,528 val), multi-view | high-res image–caption pairs | generation, retrieval, captioning | Image-text retrieval eval; multi-view embedding |
| **FACAD** (Fashion Captioning, ECCV 2020, arXiv 2008.02693) | **993K images / 130K captions** (avg 21 words, vs MS-COCO's 10.4) | fine-grained attribute-rich captions | fashion captioning | Source/eval for **LLM-normalized attribute text** (cf. VL-CLIP) |
| **Polyvore / Polyvore Outfits** | 68,306 outfits / 251,008 garments | curated outfits, item types | compatibility, FITB, complementary retrieval | **The** benchmark for a compatibility space |
| **Fashionpedia** | ~48K images | ontology + segmentation + localized attributes | segmentation, attribute localization, KG | Ontology/synonym layer; region-grounded embedding |
| **Dress Code** | (try-on pairs) | garment ↔ model pairs | virtual try-on, image editing | Used by Fashion-RAG; downstream (try-on) |
| **STL-Fashion / STL-Home** | scene–product pairs + bboxes | scene-based complementarity | complete-the-look | Compatibility/scene retrieval |

**Licensing caution:** several (DeepFashion, Fashion-Gen, FACAD, Polyvore) are **research-only / non-commercial** or scraped from commercial platforms (Polyvore from the defunct Polyvore.com; Fashion-Gen from a vendor). Treat as **eval/benchmark assets, not redistributable training data**. FashionCLIP weights are MIT; Marqo-Fashion* are Apache-2.0 — those are the *safe-to-ship* artifacts.

---

## 9. Synthesis — what samesake should do (grounded in its scope)

### Adopt (clearly inside samesake's retrieval boundary)
1. **Bless fashion-domain embeddings as the recommended BYO encoders** — FashionCLIP (MIT) and Marqo-FashionSigLIP (Apache-2.0). Document the wiring into the image/text vector columns with their proven recall deltas.
2. **A typed "compatibility space" for complementary retrieval (complete-the-look / FITB).** Asymmetric, category-gated, RRF-fused with availability/price. Adopt the *complementary item retrieval* framing (recall metrics on Polyvore), not the GNN/transformer scoring framing.
3. **Region-grounded embeddings in the enrich pipeline** (VL-CLIP lesson): detect-and-crop the garment before embedding; LLM-normalize attribute text into the FTS/text vector. Pure retrieval-quality wins.
4. **Brand `findProducts()` verification as a fashion "Attribute Guard."** Every returned item carries proof it satisfies parsed constraints (color/material/price/availability) — directly answering the survey's "verify attribute compliance post-retrieval, minimize false positives."

### Differentiate
5. **"Spaces" = retrieval-time, BYO-model GCL.** Position samesake's segmented spaces as achieving Marqo-GCL's multi-aspect behavior *without retraining an encoder* — a typed space per aspect (color/material/occasion), fused with RRF. This is a genuine architectural differentiator.
6. **Compile-time ontology.** samesake's typed catalog *is* a lightweight fashion KG; add an attribute synonym/taxonomy layer + occasion↔attribute rules in enrich/NLQ. Structured grounding without a graph DB.

### Integrate (expose hooks, don't build)
7. **Trend/occasion grounding** as a soft-filterable **occasion/trend space** + constraint relaxation — addresses the survey's "style drift" gap while staying in retrieval.
8. **Conversational constraint state.** NLQ already parses to a constrained schema; add multi-turn accumulate/relax so a stylist chat layer (FashionM3-style) can sit on top.

### Avoid (downstream of samesake; do NOT build)
9. **Generation / image editing / virtual try-on** (Fashion-RAG, FashionM3 generation, Stitch Fix Vision) — samesake is the *retrieval substrate* these retrieve from.
10. **In-engine GNN/transformer compatibility *scoring*** — too heavy, not a retrieval primitive. Express compatibility as a vector space instead.
11. **VQA answer generation** — supply grounded facts; let a downstream layer phrase them.

### Should samesake expand beyond retrieval?
**No — but it should expand *within* retrieval.** The fashion literature shows three retrieval tasks samesake doesn't model (compatibility, complete-the-look, FITB) that are *squarely retrieval* and squarely fashion-first. Adding a compatibility space and occasion/trend grounding deepens the retrieval moat without crossing into generation/recommendations-as-a-service. The generation work (Fashion-RAG, try-on) confirms the boundary is correct: those systems are only as good as the grounded retriever feeding them, and that retriever is what samesake is for.

---

## Sources

- Fashion-RAG: Multimodal Fashion Image Editing via Retrieval-Augmented Generation (IJCNN 2025) — https://arxiv.org/abs/2504.14011
- FashionM3: Multimodal, Multitask, and Multiround Fashion Assistant (2025) — https://arxiv.org/abs/2504.17826
- Agentic Personalized Fashion Recommendation in the Age of Generative AI (survey, 2025) — https://arxiv.org/html/2508.02342v1 · PDF https://arxiv.org/pdf/2508.02342
- VL-CLIP: Enhancing Multimodal Recommendations via Visual Grounding and LLM-Augmented CLIP (Walmart, 2025) — https://arxiv.org/html/2507.17080v1
- Contrastive language and vision learning of general fashion concepts (FashionCLIP, Nature Sci. Rep. 2022) — https://www.nature.com/articles/s41598-022-23052-9 · arXiv https://arxiv.org/abs/2204.03972 · code https://github.com/patrickjohncyh/fashion-clip
- Marqo-FashionCLIP / Marqo-FashionSigLIP (GCL, 2024) — https://www.marqo.ai/blog/search-model-for-fashion · https://www.marktechpost.com/2024/08/17/marqo-releases-marqo-fashionclip-and-marqo-fashionsiglip-a-family-of-embedding-models-for-e-commerce-and-retail/
- Complete the Look: Scene-based Complementary Product Recommendation (CVPR 2019) — https://openaccess.thecvf.com/content_CVPR_2019/papers/Kang_Complete_the_Look_Scene-Based_Complementary_Product_Recommendation_CVPR_2019_paper.pdf · https://cs.stanford.edu/people/jure/pubs/completethelook-cvpr19.pdf
- Fashion Recommendation: Outfit Compatibility using GNN (2024) — https://arxiv.org/html/2404.18040v1
- VICTOR: Visual Incompatibility Detection with Transformers (2022) — https://arxiv.org/pdf/2207.13458
- Fashion Outfit Complementary Item Retrieval (2019) — https://arxiv.org/pdf/1912.08967
- FashionVQA: A Domain-Specific Visual Question Answering System (CVPR-W 2023) — https://arxiv.org/abs/2208.11253 · https://openaccess.thecvf.com/content/CVPR2023W/CVFAD/papers/Wang_FashionVQA_A_Domain-Specific_Visual_Question_Answering_System_CVPRW_2023_paper.pdf
- Fashionpedia: Ontology, Segmentation, and an Attribute Localization Dataset (2020) — https://arxiv.org/pdf/2004.12276
- Fashion Captioning / FACAD (ECCV 2020) — https://arxiv.org/pdf/2008.02693
- Fashion-Gen: The Generative Fashion Dataset and Challenge — https://www.academia.edu/73944113/Fashion_Gen_The_Generative_Fashion_Dataset_and_Challenge
- FaD-VLP: Fashion Vision-and-Language Pre-training towards Unified Retrieval and Captioning (2022) — https://arxiv.org/pdf/2210.15028
- Integrating Domain Knowledge into LLMs for Enhanced Fashion Recommendations (2025) — https://arxiv.org/pdf/2502.15696
- Stitch Fix Vision / generative AI styling (2025) — https://www.digitalcommerce360.com/2025/10/09/stitch-fix-vision-generative-ai-try-on/ · https://newsroom.stitchfix.com/blog/how-were-revolutionizing-personal-styling-with-generative-ai/
- Algolia Intelligent Fashion Solution (2024) — https://www.algolia.com/about/news/algolia-launches-intelligent-fashion-solution

*Fetch note: the FashionM3 PDF returned binary/corrupted content via fetch; its facts above are sourced from the arXiv abstract page instead. All other facts are from the cited fetched pages or search-result extracts.*
