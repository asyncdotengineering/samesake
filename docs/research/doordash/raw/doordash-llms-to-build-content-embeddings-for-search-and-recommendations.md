# Using LLMs to build content embeddings for search and recommendations
URL: https://careersatdoordash.com/blog/doordash-llms-to-build-content-embeddings-for-search-and-recommendations/
Published: 2026-04-14T20:10:15+00:00
Authors: Xiaochang Miao, Heather Song

## Figures
- https://careersatdoordash.com/wp-content/uploads/2026/04/header_image.png — Header Image Description: Example of semantic meaning beyond engagements
- https://careersatdoordash.com/wp-content/uploads/2026/04/image-15.png — Figure 1: Overview of content-first embedding strategy - User embedding derived from pre-trained content encoders, then worked as input for engagement sequence model for both Retrieval and ranking stage
- https://careersatdoordash.com/wp-content/uploads/2026/04/image-16.png — Figure 2: Architecture of LLM Embedding Inference and Use Cases. By using narrative profiles and order history, and menu metadata, we use LLM for embedding generation, then it's used in different recommendation use cases.
- https://careersatdoordash.com/wp-content/uploads/2026/04/image-7-1024x189.png — (equation: hit@k metric definition)
- https://careersatdoordash.com/wp-content/uploads/2026/04/image-17.png — Table 1: Item-to-item similarity — progressive improvements. All values are relative to MiniLLM (384d) on raw item metadata.
- https://careersatdoordash.com/wp-content/uploads/2026/04/image-18.png — Table 2: Store-to-store similarity — data x model decomposition. All values are relative to MiniLLM (384d) on existing store tags.
- https://careersatdoordash.com/wp-content/uploads/2026/04/image-19.png — Table 3: Query-to-Entity EBR relevance evaluation (relative numbers) on different models.
- https://careersatdoordash.com/wp-content/uploads/2026/04/image-8-1024x264.png — (equation: EBR relevance probability objective)
- https://careersatdoordash.com/wp-content/uploads/2026/04/image-20.png — Figure 3: Example of search results. Control - production search retrieval; treatment - New EBR with LLM embeddings (real restaurant names are hidden)
- https://careersatdoordash.com/wp-content/uploads/2026/04/image-11-1024x550.png — Figure 4: Search relevance nDCG by query segmentation. LLM search pipeline's relevance for cuisine queries and dish queries are both higher than core search.
- https://careersatdoordash.com/wp-content/uploads/2026/04/image-21.png — Figure 5: These GenAI-powered store carousels introduce a user to customized options they may not otherwise encounter.

## Body
_Header Image Description: Example of semantic meaning beyond engagements_

A persistent bottleneck has constrained search and recommendation functions at DoorDash for years — the caliber of content embedding depends on data quality, while personalization depends on embedding quality. Behavioral approaches tried to skip the first step, hoping co-visitation alone could reveal meaning. But behavior is a proxy, not the signal. Identity, context, and intent make up the gap between a spicy Sichuan noodle soup and a delicate Cantonese wonton broth, or between a sparkling cider and a bag of rice. Clicks don't capture it.

This problem spans every DoorDash vertical — including food, groceries, retail, and gifting, with each holding catalog richness that sparse metadata flattens away. Large language models, or [LLMs, break the data-quality bottleneck by generating rich, standardized profiles at scale.](https://careersatdoordash.com/blog/doordash-profile-generation-llms-understanding-consumers-merchants-and-items/) That unlocks embedding quality, which ultimately makes content-first personalization and search viable across all surfaces.

This post explores how DoorDash uses LLM-generated merchant and item profiles to create content embeddings that improve semantic search, recommendations, and cold-start discovery across multiple verticals. It covers our content-first embedding strategy, model evaluation framework, product impact across search and homepage surfaces, and future directions for generative retrieval and personalization.

## Traditional playbook for content embeddings

Two broad strategies converged for learning content and user embeddings in web-scale search and recommendation systems. The story of how each matured reveals why neither alone can resolve the problem.

The first wave bet on semantics. In this paradigm, a deep neural network model learns to encode product photos or textual metadata -- for example, the product catalog, taxonomy, or product descriptions — as high-dimensional vectors, before a sequence model traces how a consumer engages with those products or content to form a user vector in the same high-dimension space, which is also known as a  [Hilbert space](https://en.wikipedia.org/wiki/Hilbert_space).  In practice, content encoders typically came from fine-tuning open-source vision models — for example, [ResNet](https://arxiv.org/pdf/1908.01707), VGG, or CLIP — and language models such as Bert Family; they also could come from training a multi-task  WHAT, such as [Pintext](https://dl.acm.org/doi/10.1145/3292500.3330671), with domain-specific labels gathered through human annotators.

This route delivers day-0 semantics and strong cold-start behavior, but the quality historically hinged on base model generalization and the richness of human labels and metadata, both of which substantially improved in the large-language model (LLM) era.

The second half of this paradigm derives user embeddings from engagement sequences.  For example, Pinterest's [PinnerSage](https://arxiv.org/pdf/2007.03634) represents each user with multiple interest vectors for better recall and diversity, while [PinnerFormer](https://arxiv.org/pdf/2205.04507) trains a sequential user representation geared to long-term engagement; both were deployed at production scale — for example, [action speaks louder than words](https://arxiv.org/pdf/2402.17152)).

The hard part is serving WHAT?. Longer histories raise feature fetch + inference cost; stateful user vectors require streaming updates/backfills/identity merges, for example [PinsAct](https://arxiv.org/pdf/2306.00248). Retrieval must keep item re-encodes, approximate-nearest-neighbor (ANN) indexes, and embedding-space versions consistent during refreshes and rollouts.

The pendulum later swung toward behavior. Here, content embeddings are shaped directly by behavioral signals **:**

- [YouTube's candidate generation neural network](https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/45530.pdf) jointly learns user and video embeddings from watch/search/context features using sampled-softmax on implicit "watch" events, pulling user vectors toward the watched video's embedding and pushing away sampled negatives.
- Pinterest pushed beyond pairwise co-visitation with PinSage, which builds a pinboard graph from actions such as saving pins to boards, sampling neighborhoods via random walks, and training with engagement-derived pairs using a max-margin ranking loss, yielding large-scale A/B gains.

This approach is fast, scalable, and tightly aligned with engagement objectives, but semantics remain implicit. Popularity tends to swell, cold or brand-new items wait their turn, and with limited data the ID tables can overfit, often requiring careful tricks such as [ID hashing or frequency adaptive learning rate](https://arxiv.org/pdf/2505.05605) s to compensate.

Ultimately,  a better design is to blend the two: Bootstrap content embeddings, let engagement bend the space, track evolving intent with sequences, and use a feature-rich ranker to make the final call.

![](https://careersatdoordash.com/wp-content/uploads/2026/04/image-15.png)_Figure 1: Overview of content-first embedding strategy - User embedding derived from pre-trained content encoders, then worked as input for engagement sequence model for both Retrieval and ranking stage_

## Why content-first and why now

DoorDash's discovery surfaces span restaurants, groceries, convenience, and gifting — each with distinct catalog dynamics and engagement density. The embedding strategy that works for Pinterest -- billions of saves per day on an infinite-scroll feed — or YouTube's hours of continuous watch sessions doesn't automatically transfer. Our alternative approach centers on content-first embeddings, with user representations learned separately through sequential modeling, as seen in such examples as [PinnerFormer](https://arxiv.org/pdf/2205.04507), [UserLLM](https://arxiv.org/pdf/2402.13598), [Scaling Law for Ads Recommendation](https://arxiv.org/pdf/2601.20083), or [Large Foundation Model](https://arxiv.org/html/2508.14948v1).

### Why content-first fits DoorDash

- _Transactional, not endless-scroll:_ Sessions are intentful and brief. Users typically order weekly; even power users aren't streaming hundreds of interactions per day. There would be limited data for pure ID/behavioral training on many cohorts and surfaces, inviting overfitting and making long-tail relevance brittle.
- _Catalog dynamics without firehose volume:_ Menus and product catalogs evolve because of issues such as seasonal items, limited-time offers, or new SKUs, but not at the minute-to-minute velocity of social feeds. Semantically rich, day-0 content embeddings provide stable meaning that doesn't depend on accumulating clicks.
- _Fairness to the cold start and SMBs:_ Engagement-only learning amplifies popularity. Content-first semantics reduce "rich get richer" effects by giving smaller merchants and new items high-quality representations from the start.
- _Cross-vertical coverage:_ Some surfaces are data-sparse — for instance, grocery compared to restaurant home feed or search ads vs. organic. Semantic embeddings and generalization features carry value across these low-traffic domains.

#### LLMs make this strategy viable at scale:

- _Rich, standardized profiles at scale with cheaper semantics:_ [Building on our earlier profile-generation](https://careersatdoordash.com/blog/doordash-profile-generation-llms-understanding-consumers-merchants-and-items/) and [AI menu-description](https://careersatdoordash.com/blog/doordash-ai-menu-descriptions/) work, LLMs produce consistent, high-quality narratives for merchants and items such as ingredients, preparation, attributes, or context that reduce reliance on human-labeling efforts.
- _World knowledge leads to better cold starts_: LLMs inject semantics across product categories even without interaction data, reducing reliance on heavy user logs to shape the product experience in niche areas such as gifting, in-store recommendation for SMBs, or  new vertical ad rankings.
- _Native text and multimodal embeddings:_ Modern LLM families expose embedding heads that encode text and images directly — such as Google Gemini embeddings, Qwen embedding models, or OpenAI/Cohere — enabling simpler alignment across modalities and cross-modal retrieval, such as both profile text and menu/product photos.

### From profile to embedding

We investigated whether off-the-shelf (OOTS) LLM embedding models suffice for food discovery when paired with domain-specific corpus design and rigorous evaluation.

_Problem statement:_ Let m denote an off-the-shelf (OOTS) encoder such as Gemini-class, OpenAI, MiniLM, or Qwen.

Inputs **𝛘 ℇ 𝚾** are LLM-generated merchant/item profiles -- standardized narratives of ingredients, preparation, cuisine, and dietary attributes.

For items with images, we first generate text descriptions from the images using a vision-language model, then combine those descriptions with other item metadata to create a comprehensive text profile for embedding.

- _Regular inference at scale_,or Metaflow catalog embeddings must stay fresh as menus evolve, but regenerating the full corpus daily is wasteful. We use incremental inference via Metaflow, which only requires re-embedding entities when their underlying content has changed.
- _Daily extract/transform/load_collects and refreshes inputs:
  - Order history aggregates and ratings/social proof
  - Menu metadata, including items, descriptions, categories, and prices
  - Merchant/store attributes, including hours, location signals, and tags where applicable
- _Profile refresh_ regenerates narratives when underlying content changes, such as menu edits, new items, or distribution shifts.
- _Embedding inference_ computes updated vectors for changed merchants/items in batch.
- _Publishing_ writes embeddings to persistent storage/index so that downstream experiments can consume them consistently.

This pipeline ensures that downstream models always consume the latest semantics without paying for redundant re-encodes.

![](https://careersatdoordash.com/wp-content/uploads/2026/04/image-16.png)_Figure 2: Architecture of LLM Embedding Inference and Use Cases. By using narrative profiles and order history, and menu metadata, we use LLM for embedding generation, then it's used in different recommendation use cases._

### Embedding model evaluation and selection

We evaluated multiple embedding families — hosted frontier models such as text-embedding-03 models and open-source encoders such as MiniLM and Qwen. We weren't looking for the best encoder, but one that would beset fit our operational reality —  large-scale offline catalog backfills and low-latency online query embedding for ANN searches.

We measured each candidate on retrieval effectiveness -- Hit Rate@K and normalized discounted cumulative gain, or nDCG@K — semantic fidelity, systems latency, and index efficiency as a function of embedding dimensionality.

The evaluation required a design choice: How to build golden datasets without a human annotation bottleneck. Our solution was an LLM-as-a-judge harness — calibrated LLM judgments producing reference rankings for entity similarity and query relevance. We validated this with two complementary offline evaluations: Entity-to-entity similarity via pairwise comparison and query-to-entity relevance via retrieval.

### Entity similarity by pairwise comparison

_Dataset construction:_ We built reference rankings using an LLM-as-a-judge harness. For each target entity, sample candidates at varying taxonomy distances such as close neighbors and hard negatives decompose similarity into facet-level comparisons -- cuisine, preparation, ingredients, dietary constraints — and then aggregate into an overall score. Separate datasets for item-to-item and store-to-store evaluation.

_Evaluation metrics and results_: We use hit@k as an evaluation metric. The definition of this metric is

![](https://careersatdoordash.com/wp-content/uploads/2026/04/image-7-1024x189.png)

_Ek_ is the top _k_ most relevant candidates using embedding embedding-based retrieval (EBR),  is the LLM labeled true k most relevant candidates. By computing the size of intersection set and divided by _k_, we get the hitRate@k.

We structured our evaluation as a series of controlled comparisons, isolating one variable at a time. As shown below, tables 1 and 2 measure entity similarity -- item-to-item and store-to-store — using Hit@K against LLM-judge reference rankings. Each table builds a progressive story — starting from a baseline, then upgrading data or model independently — so the reader can attribute each gain to a specific lever. Table 3 shifts to asymmetric query-to-entity retrieval (nDCG@K) to confirm the selected model generalizes beyond symmetric similarity.

#### Does data quality or model choice matter more for item similarity?

![](https://careersatdoordash.com/wp-content/uploads/2026/04/image-17.png)_Table 1: Item-to-item similarity — progressive improvements. All values are relative to MiniLLM (384d) on raw item metadata._

Read the table as a progression. Upgrading the model alone as seen in row 2, gemini-embedding-001 on raw metadata, yields only +5.92% at Hit@5; a better encoder barely moves the needle when the input is noisy metadata. Upgrading the data alone as seen in row 3, LLM profiles with text-embedding-005, yields +31.22%, which shows that data quality dominates. Combining both, as seen in row 4, yields +37.55%, but the incremental model gain from 31% to 38% is small relative to the data gain from 6% to 31%. The single largest lever is input representation, not model choice. Rows 5 through 7 show supplementary comparisons: 256-dimensional embeddings with MRL retain most quality relative to 784d, and the semantic similarity task type substantially outperforms the retrieval document for entity-to-entity comparison.

#### Does the same pattern hold for stores, where we can decompose data vs. model gains more cleanly?

![](https://careersatdoordash.com/wp-content/uploads/2026/04/image-18.png)_Table 2: Store-to-store similarity — data x model decomposition. All values are relative to MiniLLM (384d) on existing store tags._

The 2x2 design reveals a striking symmetry: Upgrading data alone as seen in row 3, MiniLLM on LLM profiles, and upgrading the model alone, as shown in row 2, gemini-embedding-001 on existing store tags, yield identical gains of +161% at Hit@5. Data quality and model quality contribute independently and are roughly equal in magnitude for stores. Combining both yields the largest gain — +209%. We also evaluated text-embedding-3-large (256d), which performed comparably to gemini-embedding-001 (+196% Hit@5). Rows 5 and 6 show supplementary task-type and model comparisons.

### Query-to-entity relevance analysis by embedding-based retrieval evaluation

The entity similarity results establish that gemini-embedding-001 paired with LLM profiles produces the best pair-wise representations. The next question: Does this advantage extend to retrieval when queries and entities live in different distributions?

_Dataset construction_: We stratified queries by frequency tier (head, torso, tail) within submarkets, ran EBR to retrieve top-K entities, and scored each ⟨query, entity⟩ pair with a calibrated LLM judge. nDCG@K per query, averaged across queries.

To better match production semantics, we used different [task types](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/embeddings/task-types) as RETRIEVAL_QUERY for online query embeddings and RETRIEVAL_DOCUMENT for offline entity embeddings.

![](https://careersatdoordash.com/wp-content/uploads/2026/04/image-19.png)_Table 3: Query-to-Entity EBR relevance evaluation (relative numbers) on different models._

### Embedding Model selection summary

Based on these evaluations and our operational constraints, we adopted gemini-embedding-001 with 256-dimensional output -- [leveraging MRL](https://arxiv.org/pdf/2205.13147) — using SEMANTIC_SIMILARITY task type for entity-entity comparisons and asymmetric RETRIEVAL_QUERY / RETRIEVAL_DOCUMENT task types for search retrieval, which balances embedding quality against index efficiency.

With gemini-embedding-001 as our encoder and 256-dimensional MRL embeddings as our output format, we deployed these embeddings across three product surfaces.

## Product applications

A single set of content embeddings powers both recommendation and search, two modes that traditionally require separate models:

- Entity-to-entity similarity: We compute nearest neighbors in SEMANTIC_SIMILARITY embedding space to power "related items/stores," substitution, and cross-vertical discovery. This mode is also a backbone for generative recommendation, where embedding neighborhoods become the candidate set for a generator/reranker.
- Embedding-based retrieval: We retrieve candidates directly from embedding indexes using query-entity cosine similarity. This is especially powerful for one-shot search; even rare, compositional, or vibe-based queries map into meaningful semantic regions without requiring historical engagement.

### Semantic search

_Store-level embedding retrieval_: Search quality is bounded by retrieval quality; if a relevant store/item never enters the candidate set, no downstream ranker can recover it. Historically, retrieval begins with lexical matching -- inverted index + expansions — then graduates to hybrid retrieval by attaching a learned embedding retriever, often a two-tower model trained with limited supervision and engagement signals. With LLM embeddings, we can promote semantic retrieval from "selectively enabled" to default-on:

- _One-shot generalization for tail queries:_ Embed the query online and retrieve against offline store/item profile embeddings, so that even rare or novel queries can retrieve semantically aligned candidates.
- _Semantic recall without behavioral bootstrapping:_ The representation already encodes world knowledge and compositional meaning, reducing dependence on query-level engagement density.
- _Unified retrieval across verticals:_ The same mechanism works for food, grocery, and gifts, enabling cross-domain discovery such as "healthy snack box for a flight" → grocery + convenience + gifting.

A clean way to formalize the retrieval objective is to interpret EBR as maximizing the relevance probability:

![](https://careersatdoordash.com/wp-content/uploads/2026/04/image-8-1024x264.png)

Here is _T_ a temperature controlling sharpness; this provides a principled bridge to generative recommendation. The retriever supplies _𝜖K(q)_, and a generator/reranker produces the final ranked list conditioned on query + context, for example [GPT4Rec](https://assets.amazon.science/2b/4f/3f9ad06f48cfb80cc38b3a8ba335/gpt4rec-a-generative-framework-for-personalized-recommendation-and-user-interests-interpretation.pdf)).

In the experiment, this broader retrieval lift showed up in funnel + top-line outcomes:

- +0.0724% lift in 7D active customer share
- Null search rate is reduced by −3.65%
- Core search session CVR is increased by +0.66%

The null search rate reduction is particularly telling — 3.65% fewer searches return nothing useful, which is precisely the tail-query scenario for which semantic retrieval has the most to offer. Combined with the CVR lift, these results confirm that broader semantic recall translates to completed transactions, not just more candidates.

The Szechuan example shown in Figure 3 below illustrates the mechanism. The treatment group retrieves a diverse set of Chinese stores semantically aligned with the query, while the control group surfaces only a single Sichuan restaurant. Semantic embeddings capture that "Szechuan" implies a cuisine family, not a single keyword match.

![](https://careersatdoordash.com/wp-content/uploads/2026/04/image-20.png)_Figure 3: Example of search results. Control - production search retrieval; treatment - New EBR with LLM embeddings (real restaurant names are hidden)_

_Item-embedding-based RAG in search system_: Store-level retrieval proved the concept, but search queries often target specific dishes, not stores. The natural next step was to push EBR to the item level and add an LLM-powered reranker to the pipeline.

Using item profile embeddings, we layered item-level EBR alongside the existing store-level retrieval. We then added a fine-tuned [Qwen 3 Rerank model](https://huggingface.co/Qwen/Qwen3-Reranker-4B) that scores each candidate by consuming the search query, the item profiles of the top-k most relevant items within a store, and the store profile. We tested this upgraded pipeline against the store-EBR-only baseline from the previous experiment.

This upgrade improves ranking quality notably on semantically demanding intents; dish queries increase by 7.8%, while cuisine queries improve by 1.4%.

![](https://careersatdoordash.com/wp-content/uploads/2026/04/image-11-1024x550.png)_Figure 4: Search relevance nDCG by query segmentation. LLM search pipeline's relevance for cuisine queries and dish queries are both higher than core search._

This item-level retrieval also enables image contextualization for search results. Because we retrieve and rank individual items per store, we know which items are most relevant to the query and can use their images to decorate the store's search result card. Instead of a generic store header, we display the most query-relevant item photo, making the result visually self-explanatory. The item profile text embeddings drive this selection, capturing richer food-domain semantics than pixel-level features such as CLIP alone.

### Homepage discovery

Beyond search, the same embeddings power recommendation on the DoorDash homepage. In co-purchase carousels, SEMANTIC_SIMILARITY embeddings over store profiles with cosine thresholding improved trial merchant visit rate (+0.435%) and homepage clicks per impression (+0.110%), producing cleaner cuisine clusters than behavioral embeddings. The bigger opportunity is fully generative, personalized rails.

#### Generative personalized carousels

- Where co-purchase carousels look backward at ordering patterns, generative carousels look forward, creating personalized discovery themes from scratch. An LLM generates a carousel theme from the consumer profile and context, such as time of day, then embeds the theme and retrieves nearest-neighbor stores and representative dishes within the delivery radius. Final ordering uses the existing store ranker, optionally blended with embedding similarity.
- Consumer homepage order rate increased by 2.4% relatively; consumer reorder rate in the previous seven days increased by+0.164% relatively, with variable profit per order increased by 0.32%.
- Offline precision@10 on the homepage improved 68% to 85%.

![](https://careersatdoordash.com/wp-content/uploads/2026/04/image-21.png)_Figure 5: These GenAI-powered store carousels introduce a user to customized options they may not otherwise encounter._

This pattern connects naturally to [semantic ID](https://arxiv.org/pdf/2306.08121)/ [generative retrieval](https://arxiv.org/pdf/2305.05065), which will prove useful in future. Instead of retrieving purely by dense similarity, we can discretize entities into semantic codes and retrieve, or even recommend, by generating identifiers. This direction is explored in the TIGER paradigm (Transformer Index for Generative Recommenders) and the Better Generalization with Semantic IDs technique, which shows how discretized semantic representations can improve generalization, especially for long-tail and cold-start regimes, which are the exact scenarios homepage rails must handle gracefully.

## Limitation: Consumer embeddings from consumer profiles

LLM profile embeddings are bounded by text-describability. If everything meaningful about an entity can be expressed in natural language, the embedding captures it well. The bottleneck is not the model, but whether text is the right modality for that entity. This principle explains why the approach succeeds for items and stores but breaks down for consumers. An item's identity lives naturally in language — for instance ingredients, preparation or flavor profiles. A store can be defined by its cuisine, neighborhood, and price point. These are declarative facts that text profiles capture faithfully. A consumer's identity, on the other hand, lives in behavior — the trajectory of choices over time, contextual shifts between a Sunday morning and a Friday night, and latent preferences that resist narration. The text modality does not match the information modality.

A consumer profile compresses dozens of loosely related preferences into a single vector, averaging away the distinctions that make recommendations useful. Items and stores are coherent topics — one cuisine, one set of attributes per profile — but a consumer who loves both spicy Sichuan and delicate sushi cannot be faithfully represented by an average. The lesson: For consumers, the path forward is not better text but engagement-derived representations that capture temporal patterns and evolving intent. Yet even richer aggregations over purchase history — whether mean-pooled embeddings or sequential models — capture what a consumer ordered over time without encoding why.

A consumer's effective representation should vary by situation. The same person ordering lunch near the office — which entails such attributes as quick, solo, and grab-and-go — has a fundamentally different intent than when browsing at home for a big shareable meal with family. Time of day, location, occasion, and dining companions all modulate what "relevant" means, and a single trajectory through an engagement history compresses these situational shifts away. This suggests consumer representations ultimately need a context-conditioning mechanism — a base representation built from engagement history, modulated by situational signals such as time, geolocation, and occasion  at the time of inference, so that the same history produces different effective embeddings depending on the moment. This remains an open direction, and one we see as essential for closing the gap between content-side and consumer-side representation quality.

## Future directions

Currently, we have deliberately created a hybrid strategy. We bootstrap high-fidelity content semantics using LLM-generated profiles plus off-the-shelf embedding models, and then let downstream systems such as retrieval, ranking, and sequence models "bend" the space toward DoorDash objectives. The next wave of improvements is less about swapping an embedder and more about turning semantic representations into a durable interface that scales across surfaces, modalities, and evolving catalogs.

A natural next step is to discretize the profile embedding space into semantic IDs and use those codes as the language of personalization. The main value is sequence modeling over meaning — map each store/item into discrete semantic codes, then train sequential models to learn transitions over intent — for example, "spicy → cooling drink" or "sushi → miso soup" — rather than brittle raw entity IDs. Recent work shows semantic IDs can improve generalization and cold-start behavior while remaining compact enough for large-scale sequential models. This connects directly to [generative retrieval, where a model predicts](https://arxiv.org/abs/2305.05065) an item's semantic identifier token-by-token instead of doing ANN over dense vectors.

Generative retrieval, in turn, opens the door to a retriever-generator architecture for recommendations. Our embedding-based retrieval already produces a candidate set. That set becomes the conditioning context for a generator/reranker that produces the final ranked list, keeping production constraints such as availability or delivery radius, while letting generation add controlability and richer personalization. Framing recommendations in the format "generate hypothetical search queries, then retrieve" yields interpretable intent representations, which are conceptually the same pattern we already use in theme-as-query carousels, but pushed further into a generative framework.

Finally, we see an opportunity to close the loop. Instead of treating LLM profiles and embeddings as a one-time enrichment step, make them part of a system that continuously improves with usage signals. The LLM generates or refines profiles, retrieves grounding evidence such as menus, reviews, and knowledge-graph facts to keep generation faithful, and a lightweight feedback step updates representations when the system observes mismatches such as user skips, reformulations, or facet shifts. This turns profiles into living representations that adapt to changing menus and shifting tastes.
