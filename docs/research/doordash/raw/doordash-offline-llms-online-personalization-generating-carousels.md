# Offline LLMs, Online Personalization: Generating carousels at DoorDash
URL: https://careersatdoordash.com/blog/doordash-offline-llms-online-personalization-generating-carousels/
Published: 2026-05-27T15:24:36+00:00
Authors: Yucong Ji, Raghav Saboo, Kyle Hsiao, Vivek Paharia, Pradeep Muthukrishnan, Veronica Sih

## Figures
- https://careersatdoordash.com/wp-content/uploads/2026/05/image-30.png — Figure 1: This horizontal product lineup includes nine personalized grocery items with product photos, prices, sizes, stock badges, and an "add" button on each option. A header reads "Organic produce," with the subheader "Based on your purchases."
- https://careersatdoordash.com/wp-content/uploads/2026/05/image-32.png — Figure 2: This architecture overview shows two connected systems: In the offline write path, DoorDash builds an eligible consumer cohort from consumer-state signals, trims each consumer's memory block for the use case, sends those inputs through batch LLM generation to create carousel definitions, embeds the generated search intents, and ultimately stores the results in Milvus and our online metadata store. In the online read path, when a consumer opens a store, the system looks up that consumer's carousel metadata, retrieves relevant items through both vector search and structured taxonomy lookup, merges and ranks the results, and assembles the final personalized grocery carousels that are shown in the app.
- https://careersatdoordash.com/wp-content/uploads/2026/05/image-33.png — Figure 3: This real-time serving flow for a generated carousel request shows what happens after a consumer opens a store. The service fetches precomputed carousel metadata for that consumer, applies experiment and eligibility gating by theme, and then runs two retrieval branches in parallel: An embedding-based retrieval path using Milvus and an item-lookup path using taxonomy and structured filters. The system merges and deduplicates items from both branches, attaches the LLM-generated title and subtitle, and returns the completed carousel to the client. No LLM is called in this online serving path.
- https://careersatdoordash.com/wp-content/uploads/2026/05/image-31.png — Figure 4: Before the framework was enabled, our internal user saw this "Best Sellers" page for a local pet store. The store-wide ranking is optimized for aggregate popularity, with a mix of dog, cat, and small-animal products, many irrelevant to a cat-only household. Every consumer who visits the store sees an identical carousel, regardless of what they have purchased before.
- https://careersatdoordash.com/wp-content/uploads/2026/05/image-34.png — Figure 5: After the framework is enabled, the consumer sees a top carousel that highlights "Cat Dry Food." The title and underlying search intents were produced offline by the LLM based on this consumer's memory block, which records dry cat food as a recurring previous purchase. Items shown are dry cat food SKUs available at request time at this specific store, retrieved through the parallel embedding-based and taxonomy retrieval paths previously described. A different consumer would see a different theme in this carousel slot.

## Body

Recommendation systems provide highly personalized results, but building hyperpersonalized experiences remains challenging because of the bottlenecks created by content generation and presentation. Typically, surfaces like carousels, titles, groupings, and merchandising concepts are selected from a fixed set, despite playing a major role in how users discover items.

Large language models (LLMs) enable the dynamic generation of these surfaces for each user. The challenge is doing so at the scale and reliability required for a production system. It's too slow and expensive to generate content for high-throughput experiences in the request path, which makes per-user generation difficult to deploy in practice.

DoorDash's framework takes a different approach. We use LLMs as offline content generators, conditioned on a structured consumer state we call a consumer memory block that helps synthesize the store page through carousels themselves, including their titles, subtitles, and the search intents they should use. Those generated intents are then embedded and served via a semantic retrieval layer over a vector database that is fused at request time with a secondary structured taxonomy retrieval path. The result is a hyper-personalized merchandising surface — a store page generated for the individual, not selected from a fixed library.

Here we explore four key elements of our framework that have allowed DoorDash to create a more personalized experience at scale while remaining cost-effective, including:

1. The consumer memory block primitive and how it changes what an LLM can do for personalization.
2. A multi-stage write/read pipeline that decouples generative content production (offline batch LLM) from serving (online vector + structured-taxonomy retrieval).
3. An LLM-as-judge evaluation framework that lets us iterate on generative recommendations with the same rigor we expect from a ranker.
4. The engineering work required to scale batch LLM inference and vector indexing to millions of consumers per refresh cycle.

We believe the framework is broadly applicable to any team trying to use LLMs for personalization without paying the inline LLM latency or reliability tax.

Figure 1 shows a sample item carousel that our framework generated for a consumer who has a high affinity for organic produce.

![](https://careersatdoordash.com/wp-content/uploads/2026/05/image-30.png)_Figure 1:  This horizontal product lineup includes nine personalized grocery items with product photos, prices, sizes, stock badges, and an "add" button on each option. A header reads "Organic produce," with the subheader "Based on your purchases."_

## Current issues with using LLMs for recommendations

The two dominant patterns for LLMs in recommendation systems both have well-known weaknesses for high-throughput, per-consumer personalization:

- _Inline LLM rankers/generators:_ Calling an LLM in the request path provides adaptability but incurs the full cost of LLM latency, billing, and reliability risk on every page load. For a high queries per second (QPS) surface like a grocery store page, this can be a bottleneck; even moderate response times that approach the rendering budget — or worse, partial outages — would directly degrade discovery.
- _LLM-enriched item metadata:_ While it's inexpensive to serve pre-computed item descriptions, tags, or embeddings with an LLM, the personalization signal still has to come from a separate ranker. The LLM never sees the consumer, who does not benefit from the LLM's ability to reason over their state.

Our framework sits in a third regime. We invoke the LLM offline, but condition each call on a single consumer's structured state, and we let the LLM produce not just metadata but the generative artifact — the carousel definition — that the user will see. The serving path is a conventional retrieval infrastructure, which is what makes the architecture cheap, fast, and reliable in production.

### Consumer memory blocks as a foundational primitive

A consumer memory block is a structured, namespaced representation of what we know about a consumer, organized into typed sub-blocks that are each independently maintained by upstream signal pipelines. Each sub-block is responsible for one slice of the consumer state, including such things as long-running preferences, behavioral patterns, household context, brand affinities, and taxonomy-level purchase summaries. A few properties of this representation matter for what we build on top:

- _Composable_: Different downstream use cases can request different subsets of sub-blocks. A dietary use case needs a markedly different slice than a pet use case. The memory block is the contract between consumer modeling and consumer-facing personalization.
- _LLM-friendly:_ Each sub-block has a stable, documented schema and is serializable to compact JSON, which makes it tractable as input to a constrained LLM prompt. The LLM does not need to learn DoorDash's internal data layout; the memory block is the layout.
- _Evidenced, not inferred:_ Sub-blocks are derived from observed consumer behavior and explicit signals, with provenance. This lets the prompt instruct the model to only generate when there is actionable evidence and to abstain otherwise.
- _Extensible:_ New sub-blocks can be added without changing the contract for downstream consumers. New use cases can be onboarded without re-deriving the consumer model.

This is one of the first DoorDash systems to use this primitive at the consumer level for generative personalization. Earlier LLM-driven discovery work in our broader stack tended to operate on item-side or merchant-side contexts. The key architectural shift we're exploring here is our decision to treat the consumer model as a typed input to an LLM, and then treat the LLM's output as a first-class artifact stored in our retrieval infrastructure.

## A multi-stage pipeline system architecture

The framework is organized as two pipelines that meet at a vector index and a metadata table, as shown in Figure 2 below:

![](https://careersatdoordash.com/wp-content/uploads/2026/05/image-32.png)_Figure 2:  This architecture overview shows two connected systems: In the offline write path, DoorDash builds an eligible consumer cohort from consumer-state signals, trims each consumer's memory block for the use case, sends those inputs through batch LLM generation to create carousel definitions, embeds the generated search intents, and ultimately stores the results in Milvus and our online metadata store. In the online read path, when a consumer opens a store, the system looks up that consumer's carousel metadata, retrieves relevant items through both vector search and structured taxonomy lookup, merges and ranks the results, and assembles the final personalized grocery carousels that are shown in the app._

As shown, the write path, which is offline and batch, moves through these processes:

1. _Targeted cohort construction_: Precomputes the eligible-consumer table and the trimmed memory-block payload per use case.
2. _Generative carousel synthesis_: Shards consumers, calls the batch LLM API through our internal LLM gateway, and parses structured JSON outputs into carousel records.
3. _Embedding and index_: A separate embedding flow embeds every generated search intent and bulk-imports the resulting rows — consumer, carousel, intent, and embedding — into Milvus collections under a blue/green alias.
4. _Metadata fan-out_: Consolidates carousel records and delivers them to our online metadata store for lookup.

On the read path, which is online and real-time, the following processes occur:

1. Lookup carousel metadata for the consumer in our online metadata store.
2. In parallel, run embedding-based retrieval (EBR) — for each of the consumer's pre-computed query embeddings, an approximate-nearest-neighbor (ANN) search over a vector index of catalog item embeddings — alongside a structured taxonomy retrieval over our category graph.
3. Fuse, dedupe, and assemble the final carousel objects, attaching the LLM-generated title and subtitle.

The key invariant is that LLM cost is amortized across the refresh interval, while serving cost is bounded by vector and structured retrieval. The LLM never sits in the request path.

### Stage 1: Targeted cohort construction

The first engineering issue was deciding which consumers would benefit enough from LLM inference to justify the cost. At this scale, LLM tokens are costly; it's wasteful to invoke the LLM for every consumer regardless of memory block content.

We push cohorting entirely upstream from the LLM pipeline. A job in DoorDash's declarative feature-engineering platform creates a table of the most eligible consumers, allowing us to generate a per-use-case trimmed memory-block payload as a precomputed dataset; the LLM inference pipeline can then simply consume it. This split has three concrete benefits:

1. Multiple prompt experiments and use cases share the same cohort table without re-running expensive joins against the consumer state lake.
2. The LLM inference pipeline does not have to read from Apache Iceberg at inference time, which removes a large class of failure modes from the long-running batch jobs.
3. Memory block trimming happens once, in a place optimized for that work, instead of inside per-shard inference workers.

The trimming step is non-trivial. A full memory block is much larger than what any single use case needs. We define an explicit per-use-case allowlist of sub-blocks and drop everything else, which both controls token cost and removes irrelevant context that empirically degrades LLM output quality. We discuss this further in our "Lessons learned" section.

### Stage 2: Batch LLM carousel synthesis

The core generative step is a single batch LLM call per consumer per use case. The prompt has two parts:

1. A system prompt that pins the model to the role of a merchandising generator, defines the JSON output schema, and encodes hard constraints, such as retrieval-friendly search intents, abstain-on-insufficient-evidence behavior, and safety constraints.
2. A user prompt that injects the trimmed consumer memory block JSON and asks for up to _N_ carousels for the configured theme.

The output schema is strict and machine-checked. Each carousel includes a title, a subtitle, a confidence score, and a list of search intents that will later become EBR (embedding-based retrieval) queries. Crucially, the model is allowed — and instructed — to mark a theme as not relevant when there isn't sufficient consumer evidence. Abstention is a first-class output, which keeps generic, low-confidence outputs out of the index.

_Prompt iteration as a measurement discipline_: We treated prompt engineering as we would any model iteration loop: Every change had to move a metric on a held-out evaluation set. The prompts went through more than ten production-evaluated revisions per use case, with each revision targeting a specific class of failure surfaced by the evaluators, such as titles that were grammatical but not retrieval-friendly, search intents that drifted away from the title's qualifier, or carousels generated from weak/ambiguous evidence.

The result is a prompt that is much more than a paragraph of instructions. It encodes evidence rules, qualifier handling, food-group/category granularity, and depth vs. diversity tradeoffs that we discovered through systematic eval-driven iteration. Treating the prompt as a versioned artifact and the eval suite as its continuous integration (CI) made the difference between a demo and a production system.

_Sharded inference at consumer scale_: The batch LLM API has a 24-hour completion window, which becomes the binding constraint once an eligible cohort is in the millions. The first version of the pipeline was a single linear flow: Load all consumers, submit one batch, parse, then write. That only worked for runs in the low hundreds of thousands of consumers.

The production version uses Metaflow's foreach to fan out into independent shards, each of which is a self-contained Kubernetes pod with its own batch-API budget. Three design choices made this work at scale:

1. _Object-storage-passed sharded payloads:_ We do not serialize per-shard DataFrames as Metaflow artifacts; we write them to object storage and pass only the path list. This keeps the metadata service out of the data plane.
2. _Per-shard fault isolation:_ A failed shard is independently retriable; successful shards remain checkpointed. Transient API errors no longer mean re-running everything.
3. _Vectorized iteration in the worker:_ Replacing row-wise iteration with itertuples/record-list conversion gave us roughly an order-of-magnitude speedup in per-shard parsing, which matters when a shard is handling hundreds of thousands of rows.

A join\_results step at the end aggregates per-shard statistics and output paths without materializing the full dataset, so the pipeline's memory profile stays flat regardless of cohort size.

_Quality gates between LLM and online storage:_ Before any generated carousel reaches the online storage, it goes through deterministic filters such as confidence-score threshold, minimum search-intent count, title deduplication per consumer, and structural cleanup of the parallel arrays, including the intents, taxonomy IDs, and filter tags that downstream stages depend on. These filters are intentionally cheap and explainable; the expensive evaluators run on top of what they pass.

### Stage 3: Embedding-based retrieval over a vector DB

LLM-generated search intents are only useful if they can be matched against a constantly changing item catalog at low latency. We use our internal embedding model to convert every intent into a 256-dimensional vector, then bulk-import the resulting rows into Milvus.

Along the way, we made a few non-obvious design choices, including:

- _Consumer-partitioned schema:_ consumer\_id is the partition key on the search-intent collection. At serving time, every query is scoped to a single consumer, and partition-key routing means we only scan the relevant segment instead of the whole collection. This is what caps the cost for the per-request EBR as the cohort grows.
- _Blue/green collections per use case:_ Each refresh writes into a fresh, time-stamped collection with one collection per use case × theme. After the bulk import completes and is verified, an alias swap atomically points production traffic at the new collection, and the old collection is released. This gives us safe, zero-downtime rollouts and trivial rollbacks such as re-pointing the alias without coupling the refresh schedules of different use cases to each other.
- _GPU-accelerated, parallel embedding:_ The embedding step itself is a separate Metaflow flow on GPU pods. It expands carousels into per-intent rows, batches embeddings, validates them (filtering NaN/Inf/zero vectors), and writes Parquet files sized to the Milvus bulk-import sweet spot. Splitting embedding from inference lets us iterate on the embedding model and the LLM prompt independently.
- _Hybrid retrieval as a first-class design choice:_ EBR is paired with a structured taxonomy retrieval path. Some intents are best matched by semantic similarity; others (e.g., when the LLM has identified a clean taxonomy node and a hard filter) are best matched by structured lookup. Carrying both retrieval modes through to the serving layer gives us better coverage than either path alone; the source attribution on each retrieved item gives us a downstream signal about which path is doing the work for which kinds of carousels.

### Stage 4: Real-time hybrid retrieval and carousel assembly

At request time, the feed service runs a directed acyclic graph (DAG) that turns the consumer's precomputed carousel metadata into a set of fully-assembled carousels. There is no LLM call in this path — only retrieval and assembly.

Here are the steps leading up to this result:

1. _Metadata lookup:_ Fetch carousel definitions for the consumer from the online metadata store, group by theme, and rank within each theme by the LLM's confidence score. A per-theme cap, controlled by a dynamic value, limits how many of these generated carousels can appear on a given store type.
2. _Per-theme experiment gating:_ Each theme is independently A/B-tested. A consumer is exposed only if they're in a targeted store, have carousel metadata for the theme, and are in the treatment arm.
3. _EBR fan-out:_ For EBR-enabled themes, the EBR service issues a consumer-partitioned Milvus query to fetch all of the consumer's search-intent embeddings, regroups them by carousel, and runs an ANN search against the in-store, in-stock item embedding collection scoped to the current submarket and business. A similarity threshold filters low-confidence matches.
4. _Taxonomy fan-out:_ In parallel with EBR, a structured taxonomy retrieval pulls items by the IDs assigned during generation. Where applicable, it composes structured filters such as a dietary qualifier so that taxonomy results are not just on "the right shelf" but also have the right qualifier on that shelf. When a carousel is missing the structured filters to make taxonomy retrieval safe, this branch is intentionally skipped, and EBR alone owns the carousel.
5. _Fuse and emit:_ EBR and taxonomy results are merged per carousel, deduplicated by item, and packaged into the final carousel object. Each item carries a source tag for downstream analysis that shows which retrieval mode is contributing coverage, and where.

To the consumer, the output looks like a hand-curated carousel with a custom title and subtitle. Operationally, of course, no human wrote it.

![](https://careersatdoordash.com/wp-content/uploads/2026/05/image-33.png)_Figure 3:  This real-time serving flow for a generated carousel request shows what happens after a consumer opens a store. The service fetches precomputed carousel metadata for that consumer, applies experiment and eligibility gating by theme, and then runs two retrieval branches in parallel: An embedding-based retrieval path using Milvus and an item-lookup path using taxonomy and structured filters. The system merges and deduplicates items from both branches, attaches the LLM-generated title and subtitle, and returns the completed carousel to the client. No LLM is called in this online serving path._

### Evaluating generative recommendations at scale with LLM-as-judge

The hardest part of shipping a generative recommendation system is not generation; it is knowing whether a given prompt revision is actually better than the previous one. Traditional rec-system metrics such as click-through rate or conversion are too slow and too noisy to be the inner loop of prompt iteration, and human review does not scale to per-consumer outputs.

We built a hybrid offline evaluation pipeline that combines deterministic, rules-based checks with LLM-as-judge evaluators. Together, they form the CI suite through which every prompt revision must pass before it can be considered for online experimentation.

_Evaluation infrastructure:_ Every prompt revision is scored on a fixed-size, stratified sample. The sample is filtered to production-quality outputs and stratified across confidence levels so that revisions are comparable regardless of how the underlying confidence distribution shifts. Every sample carries a manifest — for example, seed, filters, and distribution — for full reproducibility. There are two separate evaluators:

- _Rule-based evaluators_ are cheap, deterministic checks for properties that have a clean structural definition — for example, does the title open with a recognized qualifier? does it close with a valid category at the right granularity? or does the structural shape match the expectations for downstream retrieval? They run in seconds and catch the long tail of regressions that don't need a model to detect.
- LLM-as-judge evaluators are used for properties that require semantic reasoning. These are separate, smaller LLMs, each with its own carefully designed rubric. They score things like:
  - Whether the carousel's qualifier actually matches the consumer's evidenced preferences in the memory block.
  - Whether the title is a coherent, plausible concept (catching contradictions that grammar checks may miss).
  - Whether each generated search intent is consistent with the title's qualifier and granularity.
  - Whether the assigned taxonomy IDs are aligned with both the title and the underlying memory block.

_Launch thresholds, not vibes:_ Each metric has a launch threshold defined before evaluating a revision. Every threshold must be met before a prompt can be considered ready for online testing. This rules out the common failure mode where a prompt change improves one quality dimension while quietly regressing another. We consider this evaluation framework one of the most transferable parts of this work. Any team using LLMs to generate user-facing artifacts — not just carousels — needs an offline eval suite like this if they want to iterate at engineering speed instead of experiment speed.

### Product impact

The framework is in production today and generating per-consumer carousels across our New Verticals surfaces. The simplest illustration of why the new framework matters is a comparison of what one of us here at DoorDash — a consumer in a household with two adult cats and no other pets — sees on the store page of a local pet store both before and after the framework is enabled.

As shown in Figure 4, the control carousel shows "Best Sellers," a static, store-wide list optimized for what sells in aggregate, not for what this individual consumer buys. Several of the items shown are not relevant to a cat-only household; the carousel is identical for every consumer who visits this store.

![](https://careersatdoordash.com/wp-content/uploads/2026/05/image-31.png)_Figure 4: Before the framework was enabled, our internal user saw this "Best Sellers" page for a local pet store. The store-wide ranking is optimized for aggregate popularity, with a mix of dog, cat, and small-animal products, many irrelevant to a cat-only household. Every consumer who visits the store sees an identical carousel, regardless of what they have purchased before._

Figure 5, however, shows a personalized, system-generated carousel with the headline "Cat Dry Food." The title and underlying retrieval intents were produced offline based on the consumer's memory block. This particular consumer buys dry cat food at roughly bi-weekly intervals, so the surface they're most likely to re-order from appears first on the page, populated with a variety of dry cat food SKUs that are actually in stock at this store.

![](https://careersatdoordash.com/wp-content/uploads/2026/05/image-34.png)_Figure 5: After the framework is enabled, the consumer sees a top carousel that highlights "Cat Dry Food." The title and underlying search intents were produced offline by the LLM based on this consumer's memory block, which records dry cat food as a recurring previous purchase. Items shown are dry cat food SKUs available at request time at this specific store, retrieved through the parallel embedding-based and taxonomy retrieval paths previously described. A different consumer would see a different theme in this carousel slot._

This represents what changes structurally when carousel definitions are generated per consumer instead of selected from a fixed library; the carousels on the page become richer and more thematic to the consumer's needs and not just the store's aggregate catalog.

A/B results from our retail pages are consistent with this anecdote: for the example above, our 3 week experiment showed a ~1% increase in order rate for pet products, and ~0.6% increase in active users in the Pets category.

## Lessons learned

We gleaned several lessons from building this system that we expect to generalize beyond DoorDash and beyond the grocery category, including:

- _Decouple generation from serving:_ Treat the LLM as an offline content generator and the vector index as the serving layer. This architectural decision makes the system both fast and reliable. Inline LLM calls would have made the same product impossible at the QPS and service-level objective of a high-traffic store page.
- _The consumer state is the bottleneck, not the model:_ The single biggest determinant of output quality is the richness and structure of the consumer state we feed in. A typed, evidenced, composable consumer memory block is what unlocks meaningful per-consumer prompts.
- _Prompt engineering is a measurement discipline:_ Without an offline eval suite, prompt changes are guesses; with one, they are versioned artifacts with measurable improvements. The highest-leverage decision we made was to build the eval framework first — even before the prompt was good.
- _Trim the input before you trim the output:_ Per-use-case sub-block trimming gave us a meaningful drop in token cost and, more importantly, improved output quality by removing context that the model would otherwise have spent attention considering.
- _Hybrid retrieval beats either path alone:_ Pairing EBR with structured taxonomy retrieval gives us coverage that neither path provides on its own; the source attribution gives us a feedback signal indicating where each path is pulling its weight.
- _Treat batch LLM as distributed computing:_ When the eligible cohort exceeds what fits in a single batch-API window, prompt engineering stops and distributed systems engineering begins. Sharding, fault isolation, and out-of-band data passing are all required to make the pipeline work.

### Next up

This framework is a foundation, not a finished product. Among the directions we are most actively investing in now are:

- _Merchant-conditioned generation:_ We are conditioning the LLM on a merchant-side memory block in addition to the consumer block so that generated carousels reflect not only what the consumer wants but what the specific store can credibly serve.
- _More themes on the same primitive:_ The pipeline is theme-agnostic; new themes are an exercise in defining the prompt, the eval suite, and the memory-block trim, with no changes to the serving infrastructure.
- _Faster refresh:_ The current refresh cadence is a cost/freshness tradeoff. We are exploring incremental refresh paths so that newly observed consumer behavior can influence the next session.
- _Multilingual generation:_ We are working to extend the generative path through DoorDash's internationalization stack so that titles and subtitles can respect discrete locales.
- _Retrieval-augmented-generation style memory-block selection:_ We are working to replace static per-theme allowlists with a retrieval step that dynamically picks the most relevant sub-blocks for each generation request.

## Conclusion

Our framework demonstrates how we leverage personalized LLMs at scale to generate content tailored for our consumers from the ground up. The consumer memory block primitive is what makes that conditioning rich enough to matter; the multi-stage pipeline is what makes it operable at scale; and the LLM-as-judge eval framework is what makes it safe to iterate on.

We believe this pattern — generating offline against a typed consumer model, serving online via vector and structured retrieval, and treating your prompts like models with their own CI — generalizes to almost any team trying to use LLMs for personalization without paying inline cost. The framework is in production today and generating per-consumer carousels across our New Verticals surfaces. It is the template on which we expect to build the next several generative discovery features.

### Acknowledgments

We would like to offer special thanks to Camrick Solorio for contributing to the LLM evaluations process, to Veronica Sih and Pradeep Muthukrishnan, whose work gave us enormous inspiration for building our current system, to Priya Trivedi and Jocelyn Yang for sharing valuable product insights and inspiration, and to Emma Dang, Taoxin Jian, Jimmy Sindhwad, Doga Pamir, and Nachiket Paranjape help on our LLM inference infrastructure as well as evals system.
