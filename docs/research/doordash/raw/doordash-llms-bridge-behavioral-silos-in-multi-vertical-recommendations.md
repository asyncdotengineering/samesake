# Mind the Gap: Using LLMs to bridge behavioral silos in multi-vertical recommendations
URL: https://careersatdoordash.com/blog/doordash-llms-bridge-behavioral-silos-in-multi-vertical-recommendations/
Published: 2025-12-03T22:42:13+00:00
Authors: Nimesh Sinha, Raghav Saboo, Sudeep Das, Martin Wang

## Figures
- https://careersatdoordash.com/wp-content/uploads/2025/12/image-17.png — Figure 1: A multi-stage system that effectively scales to millions of users and items
- https://careersatdoordash.com/wp-content/uploads/2025/12/image-18.png — Table 1: Improvements in the results with prompt engineering techniques
- https://careersatdoordash.com/wp-content/uploads/2025/12/image-15.png — Table 2: Human Evaluation of LLM-Generated Feature Personalization. N=1000 samples per signal
- https://careersatdoordash.com/wp-content/uploads/2025/12/image-16.png — Table 3: LLM Evaluation of LLM-Generated Feature Personalization (GPT-4o). N=1000 samples per signal
- https://careersatdoordash.com/wp-content/uploads/2025/12/image-14.png — (multi-task ranker total loss equation, uncaptioned)
- https://careersatdoordash.com/wp-content/uploads/2025/12/image-11.png — (shared trunk and task heads equation, uncaptioned)
- https://careersatdoordash.com/wp-content/uploads/2025/12/image-12.png — Figure 2: Relative improvement (%) in AUC-ROC for the Proposed Model over the Baseline across different consumer cohorts.
- https://careersatdoordash.com/wp-content/uploads/2025/12/image-13.png — Figure 3: Relative improvement (%) in MRR for the Proposed Model over the Baseline across different consumer cohorts
- https://careersatdoordash.com/wp-content/uploads/2025/12/image-10.png — Figure 4: Relative improvement (%) in online shadow traffic metrics for the Proposed Model versus the Baseline

## Body

_A recap of our RecSys 2025 Paper: " [Mind the Gap: Using LLMs to Bridge Behavioral Silos in Multi-Vertical Recommendations](https://genai-ecommerce.github.io/assets/papers/GenAIECommerce2025/recsys2025-workshops_paper_206.pdf)"_

As DoorDash expands into more verticals, we see "behavioral silos": most customers have a deep history in only a few categories. At [RecSys 2025](https://genai-ecommerce.github.io/GenAIECommerce2025), we shared how DoorDash built a large language model (LLM) powered framework that turns restaurant orders and search into cross-vertical affinity features, then plugs them into our production ranking models. The approach improved relevance, especially for cold start scenarios, and shows consistent offline and online gains, while keeping inference costs practical via prompt design, caching, and small language models.

## Why this matters

In multi-vertical marketplaces, signal quality varies wildly by category. For example, restaurants have compact menus and high reorder frequency, which produce dense, clean behavioral data. Categories like grocery, retail, and convenience are a different story. With tens to hundreds of thousands of SKUs, user behavior spreads thinly across an enormous catalog.  The same customer may be well understood in restaurants yet effectively cold-start elsewhere.

This asymmetry creates a modeling gap. Standard recommenders see little data per SKU, and popularity baselines overexpose a small set of head products, pushing aside relevant long tail items and weakening personalization. The core question is how to reuse the signals we already trust - orders, searches, and session context - into portable representations that lift relevance across large, diverse catalogs.

## Hypothesis

Consumer behavior across verticals contains hidden patterns such as preferences for cuisine, dietary patterns, and price anchors that can be abstracted into **cross domain semantic features.**

Our hypothesis is that if we capture these patterns as **structured, catalog aligned signals**, we can reuse them in categories where interaction data is sparse, like long tail SKUs in grocery or retail. Instead of waiting for a user's history to accumulate, these cross domain features let us personalize from day one, improving relevance across very large and diverse catalogs.

LLMs make this feasible by distilling diverse behavioral logs across categories (of orders, search queries, clickstreams etc.) into clean, semantically meaningful features that models can use. They act as a **semantic bridge** by translating noisy activity into high fidelity, generalizable user representations that our retrieval and ranking systems can understand and act on. Some examples of the gaps which can be bridged using LLMs:

- A customer who repeatedly orders Indian food (e.g. Butter Chicken, Vegetable Samosa, Naan) in restaurants is often also interested in Vegetable sides, Chicken, Naan, Spices in grocery.
- Someone who frequently orders vegan and dairy-free dishes is more likely to buy plant-based milks, meat alternatives, and dairy-free items in grocery stores.
- Someone who frequently searches for protein bars could be interested in cereal bars, granola bars, and protein powder.

## Approach Overview: Semantic feature generation

![](https://careersatdoordash.com/wp-content/uploads/2025/12/image-17.png)_Figure 1: A multi-stage system that effectively scales to millions of users and items_

### Hierarchical RAG: turning user activity into signals

We use LLMs to translate unstructured user behavior, like restaurant orders and search queries, into a structured, four level product taxonomy (L1–L4). Example: L1: Dairy & Eggs → L2: Cheese → L3: Hard Cheeses → L4: Cheddar.

On a 20% sample of the last three months of consumer data, we run a Hierarchical Retrieval Augmented Generation (H-RAG) pipeline that infers which product categories each user is most likely interested in. These inferred "affinities" become powerful features for our recommendation models. There are three stages to the pipeline:

- The model first predicts broad category affinities at higher taxonomy levels (L1, L2).
- These high-confidence predictions then constrain the search space at deeper levels (L3, L4).
- The model iteratively refines its guesses, avoiding plausible but wrong subcategories.

For our multi task learning (MTL) ranking, we focus mainly on L2 and L3, as L1 is too generic to provide meaningful signals and L4 is often too sparse in real world data. This top down strategy improves both the precision and relevance of the final category affinities.

### Prompt design and inference controls

We carefully structured the prompt to make the model's job as easy and reliable as possible:

- **Chronological ordering**: Restaurant names and ordered items are concatenated in time order, with recent actions first. Search queries are handled the same way, helping the model capture evolving tastes.
- **Rich context**: We included the taxonomy structure and anonymized profile attributes, so the model knows exactly what categories it is allowed to use.

To keep outputs deterministic and high quality, we:

- Set temperature = 0.1.
- Instruct the model to assign a confidence score \[0,1\] to each inferred category.
- Keep only categories with confidence ≥ 0.80.

This acts as a builtin filter, removing low confidence or spurious associations. Before these prompt refinements, a user who ordered Indian food might get tagged with generic categories like "Sandwiches." Afterward these refinements, the model surfaces more relevant, fine grained categories such as "Specialty Breads (Naan)", which better reflect the true cuisine, as shown in Table 1

![](https://careersatdoordash.com/wp-content/uploads/2025/12/image-18.png)_Table 1: Improvements in the results with prompt engineering techniques_

### Model choice and cost optimization

We benchmarked several models, including GPT 4o and GPT 4o-mini. For this task, GPT 4o-mini delivered similar output quality at a much lower cost, so we adopted it.

To reduce costs even further:

- We cached the static part of the prompt (instructions + taxonomy).
- We appended only the dynamic user history for each request, and used just-in-time feature materialization so affinities are recomputed only when a user performs a new action.

These optimizations cut total computation costs by ~80%, while preserving the fidelity and usefulness of the generated taxonomic features.

### Feature quality evaluation

To evaluate the feature quality, we used the following setups:

- Human evaluation: Raters scored personalization relevance on a 3-point scale.
- LLM-as-a-judge: GPT 4o scored personalization on the same 3-point scale.

As shown in Table 2 (human) and Table 3 (LLM as a judge), features derived from search queries achieved higher personalization scores than those from order history. This aligns with the fact that search reflects explicit intent, while orders provide more implicit preference signals.

![](https://careersatdoordash.com/wp-content/uploads/2025/12/image-15.png)_Table 2: Human Evaluation of LLM-Generated Feature Personalization. N=1000 samples per signal_

![](https://careersatdoordash.com/wp-content/uploads/2025/12/image-16.png)_Table 3: LLM Evaluation of LLM-Generated Feature Personalization (GPT-4o). N=1000 samples per signal_

### Integration with multi-task ranker architecture with LLM-enhanced features

Our item ranker jointly optimizes for multiple objectives (e.g., click through rate, add to cart, purchase) using a multi task learning setup. The total loss is a weighted sum of task-specific losses:

![](https://careersatdoordash.com/wp-content/uploads/2025/12/image-14.png)

where y^t is the prediction for task (t), yt is the label, and ɑ is a task weight.

#### Feature augmentation

We enrich the model input by concatenating LLM-derived user affinities with existing features:

uLLM : sparse LLM features from orders and search queries,

ueng: user engagement features,

ieng: item engagement features (e.g., category, brand, price)

Variable length categorical fields (e.g., lists of taxonomy IDs in uLLM  are handled by mapping each ID through a shared embedding table and applying mean pooling over the resulting embeddings, yielding a fixed-size representation and efficient parameter sharing.

#### Shared Trunk and Task Heads

The concatenated user and item features are passed through a shared MLP trunk ɸ, followed by task-specific heads:

![](https://careersatdoordash.com/wp-content/uploads/2025/12/image-11.png)

where (ɸ) is an activation function (e.g., sigmoid), and (wt, bt )are the parameters for task (t).

## Results

### Offline and online performance

We evaluated the performance of our model on the full user base and two key cohorts: cold start consumers (new to non-restaurant verticals) and power consumers (highly active).

**Offline results (vs. baseline):**

- We evaluated performance on the overall population and two key cohorts: cold-start consumers (new to non-restaurant verticals) and power consumers (highly active in these verticals).
- For the overall population, the proposed model achieved a 4.4% relative improvement in AUC-ROC as shown in Figure 2 and a 4.8% relative improvement in MRR (Mean Reciprocal Rank) as shown in Figure 3 over the baseline, indicating a clear uplift in ranking quality.
- For cold-start consumers, the combined signals, especially from restaurant orders, yielded a 4.0% lift in AUC-ROC and a 1.1% lift in MRR. This supports our hypothesis that historical taste preferences from restaurants can transfer effectively to other verticals.
- For power consumers, search query signals drove the largest gains. The model delivered a 5.2% lift in AUC-ROC and a 2.2% lift in MRR, showing that it can adapt well to recent, high-intent behavior.

![](https://careersatdoordash.com/wp-content/uploads/2025/12/image-12.png)_Figure 2: Relative improvement (%) in AUC-ROC for the Proposed Model over the Baseline across different consumer cohorts_.

![](https://careersatdoordash.com/wp-content/uploads/2025/12/image-13.png)_Figure 3: Relative improvement (%) in MRR for the Proposed Model over the Baseline across different consumer cohorts_

### Online Deployment

We validated these gains in production. The online results showed an improvement of +4.3% in AUC-ROC, and +3.2% MRR vs. the baseline (Figure 4), closely matched the offline analysis. This confirms that LLM-generated taxonomic features deliver consistent, real-world improvements in personalization quality.

![](https://careersatdoordash.com/wp-content/uploads/2025/12/image-10.png)_Figure 4: Relative improvement (%) in online shadow traffic metrics for the Proposed Model versus the Baseline_

## Next Steps

- **Extend LLM features earlier in the stack** by incorporating affinity signals into candidate retrieval (e.g., Two-Tower models), not just the final ranker.
- **Experiment with richer prompting and smaller open weights models**, such as chain-of-thought, self-correction, or fine-tuned lightweight LLMs, to improve quality while further reducing cost.
- **Model temporal dynamics explicitly** by tracking how affinities decay or evolve over time (e.g., session aware or time weighted features) to better capture shifting user intent.
- **Utilize Semantic IDs** that capture stable, meaning based representations of products and categories, and use them as a common layer across retrieval and ranking.

## Key takeaways for practitioners

- **Use LLMs as semantic feature generators**: map orders and searches into structured taxonomic affinities and plug them into your existing ranking models, especially to transfer signals from data rich to data sparse verticals.
- **Constrain and stabilize LLMs**: provide an explicit taxonomy, require per category confidence scores (and drop low confidence ones), use chronological histories, clear rules, and low temperature to reduce hallucinations.
- **Make it practical**: pick the smallest model that meets quality, cache static prompt pieces, update features just in time, validate with both human raters and an LLM as a judge, and integrate these features into existing models for deployment.
