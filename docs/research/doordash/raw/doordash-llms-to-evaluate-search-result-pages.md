# How DoorDash leverages LLMs to evaluate search result pages
URL: https://careersatdoordash.com/blog/doordash-llms-to-evaluate-search-result-pages/
Published: 2025-04-30T19:38:12+00:00
Authors: Yulei Liu

## Figures
- https://lh7-rt.googleusercontent.com/docsz/AD_4nXfqAtfJs65wKQE1PNKyd49uYl0DjG-bCOZosH-1XSEorOvdhiHNTBN0MQhtX1nOB3hmfpq9BhsOkeSXsQRYDqDsUu2tNZAOH7AyeNBOgQ-MqtpITnEH02ldloHn-GTuWP2Rqh9U?key=lCOPnPhgHIpy9IlYDIW9p8Cw — Figure 1: Search page on the DoorDash consumer application.
- https://lh7-rt.googleusercontent.com/docsz/AD_4nXdp3qxRNPBvJZCaZ3m-zud3U_hi06O4_dprNVqSTsaFe95TppMqyOKtie6Awxk3o7uQCazVtKKnOHLQtBWvETzryUm3Gm_tlf0AzCy0kMFbr9P4XfnZ7_qhxnaK8w6u_9AQl-jdgA?key=lCOPnPhgHIpy9IlYDIW9p8Cw — Figure 2: WPR breaks the search result page into individual content blocks based on their layout position, allowing us to weight their contribution to overall relevance.
- https://lh7-rt.googleusercontent.com/docsz/AD_4nXfk45aQfnxJ82zGOVGPcSYiC_tyW04-4n8OWCLwbWa-OfUQrZCP6iwRsut8TXDHX_TMGnOgG4aSGgFdOVKfuqvyyox37uv2kV-t4mj19cy5dhNyRBjS8Qibp5Iww9GZWgVGcX7tZg?key=lCOPnPhgHIpy9IlYDIW9p8Cw — Figure 3: The AutoEval feedback loop breaks the evaluation process into stages—expert labeling, model fine-tuning, GPT judgment generation, external auditing, and prompt or model refinement—to ensure continuous quality improvement.
- https://lh7-rt.googleusercontent.com/docsz/AD_4nXdG1d7vbDydENqLEMW0g2V9Tle0jK0-JXus62Zz8zoRDgZqRQvA_A7mW56DxfFz_jRaSyIjBWSww40-UIChILNLpebrTUb30WjEWHMs5V7gmuyS2J-Jp5QPZXfG5j-FtlzWblJw?key=lCOPnPhgHIpy9IlYDIW9p8Cw — Figure 4: In offline benchmark evaluation, the fine-tuned GPT-4o model outperformed external raters in overall accuracy after several quality improvement loops, demonstrating strong alignment with expert standards.

## Body
At DoorDash, delivering relevant and high-quality search results is essential to ensure that customers find what they're looking for quickly and effortlessly. Traditionally, evaluating search relevance relied on human annotations, which posed challenges in scale, latency, consistency, and cost. To solve this, we built AutoEval, a human-in-the-loop system for automated search quality evaluation that is powered by large language models (LLMs). Through leveraging LLMs and our whole-page relevance (WPR) metric, AutoEval enables scalable, accurate, and near-real-time search result assessments.

AutoEval has accelerated iteration cycles, improved consistency, and achieved strong alignment with human judgments, even outperforming crowd annotators in key categories. While the system significantly enhances efficiency, it frees up expert raters to focus on guideline development, edge cases, and calibration.

![](https://lh7-rt.googleusercontent.com/docsz/AD_4nXfqAtfJs65wKQE1PNKyd49uYl0DjG-bCOZosH-1XSEorOvdhiHNTBN0MQhtX1nOB3hmfpq9BhsOkeSXsQRYDqDsUu2tNZAOH7AyeNBOgQ-MqtpITnEH02ldloHn-GTuWP2Rqh9U?key=lCOPnPhgHIpy9IlYDIW9p8Cw)_Figure 1: Search page on the DoorDash consumer application._

## Why traditional search evaluation doesn't scale

It's helpful to understand the limitations of traditional human-driven relevance annotation before we dive into the details of AutoEval and WPR. For years, DoorDash and many others relied on human labelers to evaluate — query by query — the quality of search results. While effective in small batches, this approach simply cannot scale with the burgeoning complexity and size of modern search systems. Among the challenges are:

- _Scalability constraints_: It isn't feasible to manually assess millions of query-document pairs, especially as search evolves daily.
- _Slow feedback loops_: Human annotation cycles can take days or weeks, slowing iteration speed for search improvements.
- _Inconsistent ratings_: Each human rater interprets guidelines differently, leading to label noise and requiring calibration.
- _Limited coverage_: Annotated datasets overrepresent high-frequency, or head, queries, while underrepresenting tail queries, where relevance problems often hide.

These limitations became increasingly costly as DoorDash scaled to support diverse verticals, including restaurants, retail, grocery, and pharmacy.

### Enter LLM-powered evaluation

To overcome these challenges, we transitioned to an evaluation approach powered by LLMs capable of delivering scalable, consistent, and near-real-time relevance judgments. LLM-powered evaluation unlocks:

- _Automated assessments_ of millions of relevance judgments per day.
- _Faster iteration_ on new ranking models, filters, and user interface (UI) changes.
- _Broader coverage_ across head, torso, and tail queries.
- _Consistent reasoning_ grounded in well-structured prompts and guidelines.

Paired with human oversight and auditing, LLMs became a powerful tool to scale our evaluation capability without sacrificing quality.

### Whole-page relevance: Measuring the page, not just the result

We developed our WPR metric to align with what users see and engage with so that we could rigorously evaluate a search page's usefulness. This custom metric is designed to evaluate the entire search impression, not just individual results. It builds on the idea behind normalized discounted cumulative gain (NDCG) but adapts the concept for a 2-D user interface.

Unlike NDCG, which evaluates a vertical list, WPR measures multiple content blocks arranged spatially on the screen, including stores, dishes, and items. As shown in Figure 2, each content type is weighted by its visual prominence and expected user impact, which is similar to how we assign real estate value on the DoorDash app. This lets us measure how successfully the entire page, not just the top result, fulfills a user's intent.

![](https://lh7-rt.googleusercontent.com/docsz/AD_4nXdp3qxRNPBvJZCaZ3m-zud3U_hi06O4_dprNVqSTsaFe95TppMqyOKtie6Awxk3o7uQCazVtKKnOHLQtBWvETzryUm3Gm_tlf0AzCy0kMFbr9P4XfnZ7_qhxnaK8w6u_9AQl-jdgA?key=lCOPnPhgHIpy9IlYDIW9p8Cw)_Figure 2: WPR breaks the search result page into individual content blocks based on their layout position, allowing us to weight their contribution to overall relevance._

WPR supports full-stack search evaluation across all stages, including:

- Retrieval: Are the right candidates being retrieved?
- Ranking: Are results presented in the most useful order?
- Post-processing: Are filters and blends improving relevance?
- User experience composition: Does the layout guide the user effectively?

#### Two key WPR applications

1. _Offline feature evaluation_: When launching a new ranking model, processing logic change, or UI update, we use WPR to assess its offline impact before rollout to online A/B testing. This helps detect regressions or confirm improvements with confidence.

2. _Continuous production monitoring on relevance_: We use the WPR score daily to measure search relevance and capture quality signals beyond user engagement and system performance.

### Introducing AutoEval: LLM-powered evaluation at scale

As DoorDash's search system scaled to support multiple verticals – from restaurants to retail to pharmacy – and increasingly complex UI layouts, evaluating relevance across such a diverse and dynamic landscape became a major engineering challenge. While useful, manual human annotation was too slow to keep pace with fast iteration cycles and real-time production needs.

To address this, we built AutoEval: a human-in-the-loop, LLM-powered evaluation system designed to assess search relevance quickly, scalably, and consistently. AutoEval has become a critical part of how we evaluate everything from offline experiments to daily production traffic.

![](https://lh7-rt.googleusercontent.com/docsz/AD_4nXfk45aQfnxJ82zGOVGPcSYiC_tyW04-4n8OWCLwbWa-OfUQrZCP6iwRsut8TXDHX_TMGnOgG4aSGgFdOVKfuqvyyox37uv2kV-t4mj19cy5dhNyRBjS8Qibp5Iww9GZWgVGcX7tZg?key=lCOPnPhgHIpy9IlYDIW9p8Cw)_Figure 3: The AutoEval feedback loop breaks the evaluation process into stages—expert labeling, model fine-tuning, GPT judgment generation, external auditing, and prompt or model refinement—to ensure continuous quality improvement._

#### How AutoEval works

As shown in Figure 3, AutoEval's architecture is designed to turn a query and its corresponding search results into structured tasks that are evaluated by LLMs. Each judgment is rolled up using our WPR metric to give the search result page a holistic score.

AutoEval supports a full evaluation pipeline, including:

- _Query Sampling_: We sample real user queries from live traffic across intent, frequency, geographic, and daypart dimensions.
- _Prompt construction_: Each query-result pair is converted into a structured prompt tailored to the evaluation task such as dish-to-store or cuisine-to-store.
- _LLM inference_: The prompt is passed to an LLM, base or fine-tuned, which returns a structured relevance judgment.
- _WPR aggregation_: Judgments are aggregated to generate a page-level WPR score.
- _Auditing and monitoring_: Judgments are regularly sampled for human review to ensure quality, stability, and alignment.

#### Designing prompts to reflect rating guidelines

Prompt engineering is at the core of AutoEval's effectiveness. Each prompt mirrors our internal human rating guidelines and includes structured context, such as store name, menu items, dish titles, or metadata tags, to help the LLM replicate the type of reasoning a trained human evaluator would perform.

Prompts are carefully crafted to reflect:

- The user's query intent, for example cuisine, dish, or brand
- Document type, for example store card or item result
- Expected criteria for relevance, grounded in our expert-created rating rubrics

Over time, we experimented with various prompting strategies, including zero-shot, few-shot, and structured templates. We found that task-specific structured prompts paired with rule-based logic and domain-specific examples offered the most consistent, interpretable, and human-aligned results.

In addition to structure, we employ several prompt techniques that enhance LLM judgment quality, including:

- _Chain-of-thought reasoning_: We explicitly break down rating tasks into multi-step logic — for example, exact match → substitute → off-target — so the model can reason in stages. It is designed to mirror this thought process using inline instructions and fallback reasoning, allowing the LLM to simulate the evaluator's decision-making process step-by-step.
- _Contextual grounding_: Prompts include rich, structured metadata such as geolocation or store menu to mimic what a human would review.
- _Embedded guidelines_: For complex domains like food or retail stores, we incorporate fragments of evaluation criteria directly into the prompt as in-context instruction.
- _Alignment with internal rubrics_: Prompts reflect the same conditional logic and categories used by internal and crowd raters, ensuring interpretability and calibration across judgment sources.

#### Fine-tuning with expert-labeled data

In addition to prompt engineering, we fine-tune our LLMs on high-quality, human-labeled data for key evaluation categories.

This process starts with internal DoorDash experts, who generate relevance annotations following well-defined guidelines. These labels form our golden dataset, which we split into training and evaluation sets for fine-tuning models and benchmarking their performance.

It is critical to have experts justify their annotations to ensure the model not only learns the correct label but also the reasoning behind it. These justifications guide prompt refinement, reveal ambiguous cases, and help align model behavior with human expectations.

Fine-tuned models improve alignment in high-impact categories such as:

- _Store name search_: Analyzes store category and menu overlap to determine if the store result accurately matches what was intended.
- _Cuisine search_: Identifies relevant items from the menu to evaluate whether a store satisfies a cuisine-based query.
- Dish/item search: Finds close or exact menu matches to assess whether a store offers the queried dish or item.

#### Human-in-the-Loop: Auditing and iteration

While the fine-tuned model drives scale, we keep human expertise in the loop through structured auditing. First, external raters review a sample of LLM-generated judgments, flagging low-quality outputs which internal experts then investigate. This effort leads to prompt improvements, creation of new golden data, and ongoing fine-tuning and evaluation. The resulting tight feedback loop looks like this:

1. Internal experts generate golden data.
2. Model is fine-tuned and evaluated.
3. External raters audit outputs.
4. Experts analyze flagged outputs and refine prompts or labels.
5. Loop continues with improved models and better-aligned prompts.

### Key wins and impact

AutoEval has delivered substantial improvements across DoorDash's relevance evaluation life cycle, enabling us to scale faster, iterate more confidently, and focus human expertise where it matters most.

- _Throughput and turnaround time_: AutoEval has reduced relevance judgment turnaround time by 98% compared to human evaluation, unlocking a nine-fold increase in capacity and resolving a major bottleneck in our offline experimentation pipeline.

- _Efficiency_: AutoEval has freed expert raters from repetitive labeling tasks, allowing them to focus on guideline development, auditing, and edge case resolution, which has raised overall quality and consistency of our evaluation standards.

- _Accuracy_: Fine-tuned LLMs consistently match or outperform external raters in key relevance tasks, including store name and dish-level search satisfaction.

These wins have transformed how we evaluate, monitor, and improve the DoorDash search experience, turning what was a slow, manual process into a fast, scalable, and efficient structure.

![](https://lh7-rt.googleusercontent.com/docsz/AD_4nXdG1d7vbDydENqLEMW0g2V9Tle0jK0-JXus62Zz8zoRDgZqRQvA_A7mW56DxfFz_jRaSyIjBWSww40-UIChILNLpebrTUb30WjEWHMs5V7gmuyS2J-Jp5QPZXfG5j-FtlzWblJw?key=lCOPnPhgHIpy9IlYDIW9p8Cw)_Figure 4: In offline benchmark evaluation, the fine-tuned GPT-4o model outperformed external raters in overall accuracy after several quality improvement loops, demonstrating strong alignment with expert standards._

### Future directions

While AutoEval has already transformed how we evaluate search relevance at DoorDash, we're just getting started. We have several exciting areas on our roadmap that will push accuracy, flexibility, and scalability even further, including:

- _Decoupling from a single LLM provider via internal gateway:_ We plan to migrate from directly calling OpenAI's public API to routing traffic through our internal GenAI gateway. This abstraction layer will allow us to compare performance flexibly across multiple LLM vendors, enabling experimentation with cost, latency, and accuracy trade-offs without changing downstream systems.

- _Exploring in-house LLMs for greater control and cost efficiency:_ In collaboration with DoorDash's machine learning research team, we're exploring the feasibility of training and deploying in-house LLMs optimized for our specific search evaluation tasks. This could unlock further scalability, model efficiency, and cost reductions while allowing tighter alignment with DoorDash-specific language patterns and domain expertise.

- _Enhancing prompt context with external knowledge sources:_ To better handle tail queries and unfamiliar entities, we plan to enrich prompts using external data sources. For instance, if a user searches for a local store that hasn't yet onboarded with DoorDash, we could fetch additional context — say, from external search APIs — about the store and its menu to allow the LLM to make a more informed relevance judgment even with limited internal data.

### Conclusion

AutoEval demonstrates how a thoughtful combination of LLMs, prompt engineering, and human expertise can create a scalable, reliable, and efficient evaluation system. By powering both offline iteration and real-time relevance monitoring, AutoEval is helping DoorDash deliver better search results faster and more intelligently while maintaining the human judgment that underpins our quality standards.
