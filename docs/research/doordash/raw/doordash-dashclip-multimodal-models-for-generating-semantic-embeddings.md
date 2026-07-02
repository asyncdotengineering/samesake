# DashCLIP: Leveraging multimodal models for generating semantic embeddings
URL: https://careersatdoordash.com/blog/doordash-dashclip-multimodal-models-for-generating-semantic-embeddings/
Published: 2026-02-11T00:52:08+00:00
Authors: Omkar Gurjar, Kin Sum Liu, Praveen Kolli, Utsaw Kumar, Mandar Rahurkar

## Figures
- https://careersatdoordash.com/wp-content/uploads/2026/02/image-21-1024x541.png — Figure 1: This summary of DashCLIP's architecture and training objectives illustrates our two-stage training. Stage 1, shown in blue, trains the unimodal text, image encoders, and the multimodal encoder on the product catalogs. Stage 2, shown in green, aligns the image-text encoder with the query encoder using a query-catalog contrastive (QCC) loss.
- https://careersatdoordash.com/wp-content/uploads/2026/02/image-15.png — (equation: query-catalog contrastive (QCC) loss)
- https://careersatdoordash.com/wp-content/uploads/2026/02/image-20-822x1024.png — Table 1: DashCLIP Embeddings outperform all baselines showing effectiveness of our alignment framework. Off-the-shelf typically struggle on short but specific e-commerce related queries.
- https://careersatdoordash.com/wp-content/uploads/2026/02/image-16.png — Figure 2: This illustrates the final ranking model architecture after incorporating DashCLIP's embedding features.
- https://careersatdoordash.com/wp-content/uploads/2026/02/image-17-1024x234.png — Table 2: Search ranking results on evaluation data collected one week after training (NW). The best model (product + query + purchase history embeddings) is bold and shows statistically significant gains (p < 0.05) over the baselines, with stronger performance for users with purchase history (UPurcHist).
- https://careersatdoordash.com/wp-content/uploads/2026/02/image-19.png — Table 3: Top-line business metrics from A/B Experiment in August 2024. All reported values are statistically significant.
- https://careersatdoordash.com/wp-content/uploads/2026/02/image-18.png — Figure 3: In this scatter plot of product embeddings after t-SNE dimensionality reduction, products from the same categories can be seen forming clusters naturally. Similar clusters like drinks and alcohol are closer to each other.
- https://careersatdoordash.com/wp-content/uploads/2026/02/image-20-822x1024.png — Figure 4: Distribution of cosine similarity between product and query embedding from off-the-shelf BLIP-14M (top) and DashCLIP (bottom). Our embedding achieves a clear separation between the three relevance classes, demonstrating the effectiveness of Product-Query loss in Stage 1.

## Body
DoorDash's Consumer Packaged Goods (CPG) business spans groceries, retail products, alcohol, electronics, pharmaceuticals, and more. At the [International Workshop on Multimodal Generative Search and Recommendation](https://mmgensr-cikm25.github.io/) gathering in Korea in 2025, we [shared how we built a framework](https://arxiv.org/abs/2504.07110) to generate generalizable multimodal representations for CPG products and user queries. Through capturing the rich semantic information contained in product catalogs and user query intent, the embeddings have contributed to a significant performance improvement across ranking and retrieval tasks.

To accommodate DoorDash's continuing growth, the ads quality team set out to build foundational embeddings that can be reused across multiple use cases, such as retrieval, ranking, and relevance. Traditionally, the team has relied on categorical and numerical features such as store attributes, context features, and other handcrafted aggregates as inputs to our machine learning models. While these are important engagement signals, they fail to capture the rich semantic information contained in our product catalogs and don't reflect a deeper understanding of users' personal interests.  To bring these enhancements into our models, we developed DashCLIP, short for Dash Contrastive Language-Image Pretraining, a unified multimodal embedding framework designed to power personalized ad experiences for DoorDash users.

## DashCLIP overview

DashCLIP's architecture addresses the following functional requirements:

- _Multimodality encodings:_ Products on our platform contain both text and visual information. We leverage contrastive learning on the product catalog to approximate a human-like understanding of products, capturing the complementary information from each modality.
- _Domain adaptation:_ We perform continual pretraining on off-the-shelf models to adapt the embeddings to DoorDash's data distribution.
- _Query embedding alignment:_ To enable search recommendations, we introduce a second stage of alignment in our architecture for a dedicated query encoder that is trained to generate query embeddings in the same space as the product embeddings.
- _Relevance dataset curation:_ We curate a high-quality relevance dataset that combines internal human annotations with knowledge from large language models (LLMs), providing robust supervision for embedding alignment. This eliminates the position and selection bias introduced when historical engagement data is used for training.

### Model architecture

In addition to incorporating the functional requirements described above, DashCLIP also focuses on learning embeddings that can be generalized for use in various DoorDash applications. We show our architecture in Figure 1. DashCLIP includes such components as:

- Image and text unimodal encoders
- An image-grounded text encoder
- A text-only query encoder

![](https://careersatdoordash.com/wp-content/uploads/2026/02/image-21-1024x541.png)_Figure 1: This summary of DashCLIP's architecture and training objectives illustrates our two-stage training.  Stage 1, shown in blue, trains the unimodal text, image encoders, and the multimodal encoder on the product catalogs. Stage 2, shown in green, aligns the image-text encoder with the query encoder using a query-catalog contrastive (QCC) loss._

### Dataset preparation

We curate two main datasets for use in training DashCLIP:

- _Catalog dataset:_ We curated a list of roughly 400,000 products — including their titles, images, and aisle categories — to use their catalog data for continual pre-training and evaluation.
- _Query-product relevance dataset:_ To align the query embedding and product embedding in the same space, we require a relevance dataset that assigns a relevance label — {0: irrelevant, 1: moderately relevant, 2: highly relevant} — to each query/product pair. We started with about 700,000 human labels, which were then used to fine-tune a GPT model and label 32 million pairs to create the final dataset.

### Model training

We initialize the image-text product encoders and the query encoder from a pre-trained checkpoint model, [BLIP-14M](https://arxiv.org/abs/2201.12086), which is short for bootstrapping language-image pretraining. Following this, we train DashCLIP in two stages:

- In Stage 1,we perform continual pretraining of the product encoders on 400,000 raw product image/title pairs from our catalog. This helps the encoders adapt to the characteristics and patterns of the product domain.
- In Stage 2,we align the query embedding with the product embedding by minimizing a contrastive loss in the projection space of the image-text product encoder and text-only query encoder.

Stage 1 uses the image-text contrastive (ITC)  and image-text matching (ITM) losses defined in the [BLIP paper.](https://arxiv.org/abs/2201.12086) For Stage 2, we design the query-catalog contrastive (QCC) loss, which is defined as:

![](https://careersatdoordash.com/wp-content/uploads/2026/02/image-15.png)

Where 𝐶𝑖 is the multi-modal hidden representation of the 𝑖-th product, 𝑄𝑖+ is the positive (relevant) query for the 𝑖-th product, 𝑄𝑖j- is the 𝑗-th negative query among the 𝑁 negative samples for the 𝑖-th product. We average this loss over the batch size 𝐵. 𝑠𝑖𝑚 is the cosine similarity function, and 𝜏 is the temperature parameter.

### Results

We performed extensive offline and online evaluation of DashCLIP across use cases spanning different stages of the ads funnel, as well as general e-commerce applications.

We leveraged the embedding of a user's query to perform a K-nearest neighbor search in the embedding space of the product to create a ranked list of potential relevant candidates for the next downstream selection, such as ranking. We compared DashCLIP multimodal embeddings to various popular architectures such as [CLIP](https://arxiv.org/pdf/2103.00020), [BLIP](https://arxiv.org/abs/2201.12086), and [FLAVA](https://arxiv.org/abs/2112.04482) (foundational language and vision alignment). As shown in Table 1, DashCLIP outperformed all baselines by significant gains, demonstrating the effectiveness of product-query alignment in our proposed framework. Off-the-shelf models lack the specificity of the e-commerce domain and frequently fail when used on short but specific queries.

![](https://careersatdoordash.com/wp-content/uploads/2026/02/image-20-822x1024.png)_Table 1: DashCLIP Embeddings outperform all baselines showing effectiveness of our alignment framework. Off-the-shelf typically struggle on short but specific e-commerce related queries._

#### Offline ranking results

DoorDash models the ranking problem as a binary classification task in which the model predicts the probability of the user clicking a given candidate ad. As shown in Figure 2, for the ranking model, we integrated the projected product, query, and user purchase history-derived feature embeddings using the following architecture:

![](https://careersatdoordash.com/wp-content/uploads/2026/02/image-16.png)_Figure 2: This illustrates the final ranking model architecture after incorporating DashCLIP's embedding features._

This architecture promotes the crossing between the different embeddings before interacting them with the existing features. As shown in Table 2, our model's embedding features outperform the baseline deep cross net (DCN) model in terms of the offline area-under-the-curve/receiver-operating-characteristic metric. Users with a purchase history — (𝑁𝑊 ∩ 𝑈𝑃𝑢𝑟𝑐𝐻𝑖𝑠𝑡 ) — benefit more from our embeddings than do users with no purchase history, which demonstrates the effectiveness of DashCLIP embeddings in capturing user interests.

![](https://careersatdoordash.com/wp-content/uploads/2026/02/image-17-1024x234.png)_Table 2: Search ranking results on evaluation data collected one week after training (NW). The best model (product + query + purchase history embeddings) is bold and shows statistically significant gains (p < 0.05) over the baselines, with stronger performance for users with purchase history (UPurcHist)._

#### Online deployment

Following the successful offline experiments, we set up an online A/B experiment to evaluate our best candidate against online traffic for about 10 days. The results are shown in Table 3:

![](https://careersatdoordash.com/wp-content/uploads/2026/02/image-19.png)_Table 3: Top-line business metrics from A/B Experiment in_ _August 2024. All reported values are statistically significant._

Besides significantly improving top-line metrics, our analysis showed that the new model increased engagement rates for most of the top queries and categories, driving more revenue for sponsored products ads and improving the relevance measure. As a result, the model was deployed to serve 100% of traffic.

## Applications beyond ranking

As part of our effort to build generalizable embeddings, we wanted to test DashCLIP's effectiveness in other e-commerce areas. For this, we picked the following two tasks:

- _Aisle category prediction_:We wanted to test if the embeddings could capture the aisle category, an internal label signifying the type of product.
- _Product-query relevance prediction:_ We wanted to test whether the embeddings could capture the product-query relevance.

We performed qualitative and quantitative evaluations for both tasks. For quantitative evaluation, we trained simple classifiers using the product embeddings for aisle category prediction, and both product and query embeddings for relevance prediction as inputs. For qualitative evaluation, we plotted the embeddings after t-distributed stochastic neighbor embedding (t-SNE) dimensionality reduction and annotated the aisle category of each product. For the second task, we plotted the distribution of cosine similarity scores between product and query embeddings.

The classifiers trained using DashCLIP embeddings performed significantly better than the baseline BLIP-14M embeddings, as shown in Figures 3, and 4 below.

![](https://careersatdoordash.com/wp-content/uploads/2026/02/image-18.png)_Figure 3: In this scatter plot of product embeddings after t-SNE dimensionality reduction, products from the same categories can be seen forming clusters naturally. Similar clusters like drinks and alcohol are closer to each other._![](https://careersatdoordash.com/wp-content/uploads/2026/02/image-20-822x1024.png)_Figure 4: Distribution of cosine similarity between product and query embedding from off-the-shelf BLIP-14M (top) and DashCLIP (bottom). Our embedding achieves a clear separation between the three relevance classes, demonstrating the effectiveness of Product-Query loss in Stage 1._

## Future work and takeaways

We plan to extend the ideas behind DashCLIP into our restaurant business to build store and dish embeddings. Moreover, we plan to extend these ideas to learn semantic user representations to encode long-term user behaviors and interests. Ultimately, we plan to transition toward semantic ID representations to enable better generalization.

Overall, we concluded that off-the-shelf models don't deliver optimal performance. Entity representations should instead be built by pre-training on semantic data before any application-specific optimization. We also discovered that when large-scale human-annotated data is not available, LLMs can provide a dependable alternative to generate high-quality labels.
