# Evolving DoorDash's Substitution Recommendations Algorithm
URL: https://careersatdoordash.com/blog/evolving-doordashs-substitution-recommendations-algorithm/
Published: 2022-09-08T12:21:00+00:00
Authors: Dawn Lu

## Figures
- https://doordash.engineering/wp-content/uploads/2022/09/Screen-Shot-2022-09-07-at-5.06.09-PM.png — _Figure 1: New UI that allows customers to engage with substitution recommendations_
- https://doordash.engineering/wp-content/uploads/2022/09/image3.png — _Figure 2: Example of recommendations using an unsupervised model_
- https://doordash.engineering/wp-content/uploads/2022/09/image1-1.png — _Figure 3: Example of recommendations using a LightGBM model_
- https://doordash.engineering/wp-content/uploads/2022/09/image4.png — _Figure 4: Example of recommendations using a deep learning model with semantic item embeddings_

## Body
When expanding from made-to-order food delivery to new product verticals like groceries, convenience, and retail, new challenges arise, including how to ensure inventory will be available to fulfill orders. As a business, we always want customers to receive all the items they ordered. For restaurant orders, this is easy to do because merchants offer relatively small menus and it's uncommon for dishes to become unavailable. However, as DoorDash expands its business into new verticals like grocery stores inventory becomes more of an issue. Grocery merchants have inventories with hundreds of thousands of SKUs requiring Dashers — our name for delivery drivers — to enter stores and shop for the items required to fulfill a delivery. This Dasher shopping experience has two unique challenges:

(1) the item ordered is not available or not found, and/or

(2) the Dasher can't find a good substitution for an out-of-stock item on the customer's behalf

Here we will dive into the details of how we're solving the second problem with machine learning by recommending relevant substitutions.

## Why we need a substitution recommendations model

Before we start the development of any machine learning project at DoorDash, we seek to understand — from first principles — how a predictive model might improve the customer experience. Naturally, we want to create a seamless experience for customers that ensures they receive an acceptable substitution if what they originally ordered is out of stock or cannot be found. It's a win-win outcome when we are able to offer a good substitute; the customer gets something equivalent to what they ordered, which means, for instance, they have all the ingredients they need to cook their recipe. Additionally, DoorDash does not need to refund the cost of the original item and the merchant doesn't lose out on any sales.

### Legacy chat solution

Before we rolled out a recommendations product for substitutions, the customer experience was full of friction. When an item was out of stock, Dashers would have to call or text customers while they were in the store to discuss alternative options and agree on a substitute item. While this approach could lead to a good substitution, it was time-consuming and exhausting for both the customer and the Dasher. So, we set out to create a low-friction way to collect a customer's substitution preferences ahead of time. Dashers then could meet customer needs without any back-and-forth communication. To build this experience effectively, we needed to show customers high-quality substitution recommendations that had been generated programmatically with a machine learning (ML) model.

## The evolution of our recommendations algorithm

Our recommendations model evolved over time alongside our substitution UI menu, as shown in Figure 1. We started with an unsupervised approach, then proceeded to binary classification, and eventually pursued a deep learning recommendation model.

![Figure 1](https://doordash.engineering/wp-content/uploads/2022/09/Screen-Shot-2022-09-07-at-5.06.09-PM.png)
_Figure 1: New UI that allows customers to engage with substitution recommendations_

### Phase 1: An unsupervised approach

When DoorDash first launched these new product verticals, we didn't have much labeled data indicating what customers believed were good or bad substitutions. To resolve that problem, we started out with an unsupervised approach that leveraged our item metadata. We found a simple yet effective technique for identifying similar items involved using [TF-IDF](https://en.wikipedia.org/wiki/Tf%E2%80%93idf) cosine similarity based on an item's name. Furthermore, our catalog team built out a well-defined taxonomy that let us apply heuristics on top of the text-based similarity score to restrict recommendations to relevant categories. This approach, for example, successfully recommended other Coca-Cola products when customers ordered a 12-pack of Coca-Cola, as shown in Figure 2.

![Figure 2](https://doordash.engineering/wp-content/uploads/2022/09/image3.png)
_Figure 2: Example of recommendations using an unsupervised model_

### Phase 2: Binary classification with LightGBM

After we established the initial unsupervised model, the team set out to collect more labeled data. Working closely with the product and engineering teams, we launched a feature that asked consumers to rate suggested substitutions as either "thumbs-up" or "thumbs-down." This provided the data needed to establish a customer feedback loop, a critical next step in our recommendations journey. After we collected enough data, we moved to a supervised learning approach. This required building a binary classifier to predict the probability that any item in our catalog would be a good substitute for an ordered item. We chose to use [LightGBM](https://www.microsoft.com/en-us/research/project/lightgbm/) for this phase because of both its relatively high performance with minimal hyperparameter tuning and its history of success in many machine learning applications at DoorDash.

Incorporating customer feedback allowed us to identify more relevant substitutions that extended beyond superficially "similar" items. In Figure 3, we expand on our earlier Coca-Cola example. Customers who have ordered a 12-pack of Coca-Cola would rather substitute a 12-pack of Pepsi or Dr. Pepper than a two-liter bottle of Coke. As it turns out, quantity is more important than brand loyalty when customers are ordering in bulk.

![Figure 3](https://doordash.engineering/wp-content/uploads/2022/09/image1-1.png)
_Figure 3: Example of recommendations using a LightGBM model_

### Phase 3: Deep learning recommendations model

The team built product features to show these recommendations to more customers and across more surface areas as the quality of recommendations improved. As a result, we were able to collect an increasing volume of customer feedback. As the data expanded, we explored using a [deep learning recommendation model](https://ai.facebook.com/blog/dlrm-an-advanced-open-source-deep-learning-recommendation-model/) implemented in [PyTorch](https://pytorch.org/). First introduced by Facebook several years ago, this model combines principles from approaches based on collaborative filtering and predictive analytics. Specifically, categorical features (or in this context, items in our catalog) are processed as embeddings and there is a bottom MLP that encodes our dense feature. Next, feature interactions are computed explicitly and the results are processed to discern a top MLP, which is fed into a [Sigmoid function](https://en.wikipedia.org/wiki/Sigmoid_function) to yield a probability score.

This approach relies on having high-quality embeddings. Fortunately, we were able to leverage existing work from the DoorDash ML team, which already had been developing [semantic item embeddings](https://doordash.engineering/2021/09/08/using-twin-neural-networks-to-train-catalog-item-embeddings/). These embeddings provide a richer representation of an item beyond the raw text-based TF-IDF vector because the embeddings are trained on the search behaviors of DoorDash users. This approach helped us identify better recommendations for items that are more difficult to substitute, such as items that have less historical customer feedback because of relatively lower purchase volume. For example, as shown in Figure 4, the LightGBM model recommended canned corn as a substitute for canned green beans. The deep learning model, however, recommended canned green peas, because item embeddings accurately represent that beans are more similar to peas than corn.

![Figure 4](https://doordash.engineering/wp-content/uploads/2022/09/image4.png)
_Figure 4: Example of recommendations using a deep learning model with semantic item embeddings_

## Measuring recommendation quality and impact

One of our biggest challenges from the start was measuring the quality of our substitution recommendations and quantifying improvements. While we were using an unsupervised model, we leveraged manual reviews to measure recommendation quality. That involved identifying top-selling items across product categories and curating ideal substitutions for them to create a "golden" dataset. We then compared what percentage of the algorithm's recommendations were matched by human-curated substitutions.

Once we moved to a supervised model, we were able to use standard classification accuracy metrics like [AUC](https://en.wikipedia.org/wiki/Receiver_operating_characteristic) to compare different model iterations offline. More importantly, we were able to apply an [experimentation infrastructure](https://doordash.engineering/2020/09/09/experimentation-analysis-platform-mvp/) to evaluate our models based on customer experience impact. Specifically, we tracked input metrics such as the customer approval rate (which represented the relevance of our recommendations) and coverage (percent of ordered items with recommendations). Ultimately, our goal was to drive key business output metrics and customer satisfaction, including how frequently we substituted items that weren't found and how well customers rated those substitutions. As a result of the close collaboration and cross-functional effort across ML, product, and engineering over time, we were able to improve our business metrics by a substantial amount.

## Conclusion

Data science teams seeking to build recommendation algorithms often run into the classic cold-start problem. This typically happens when a company is first established or when it expands into new product or service categories. Data scientists need to overcome many challenges to make step-by-step improvements, including building an MVP solution while working with cross-functional teams to collect the data they need.

In these situations, DoorDash data scientists apply first principles thinking to understand the exact problem that needs to be solved with a ML model. Depending on a problem's context, classic techniques like collaborative filtering might not be the best approach. Two important takeaways we learned were: (1) don't underestimate simple solutions and (2) if labeled data is scarce, it can be worthwhile to invest in collecting item metadata.

Next steps include investing in richer item metadata for high-priority categories. For example, produce and meat are more difficult to substitute and customers tend to be more sensitive about these categories. Additionally, we can incorporate new things such as product attributes — for example, "organic" or "kosher" — as well as item image embeddings. We also plan to develop personalized recommendations because we've observed that customers have highly individualized substitution preferences.

## Acknowledgments

At DoorDash, early stage machine learning projects such as this often involve extensive cross-functional collaboration. Special thanks to Cam Miller, Kurt Smith, Thibault de Waziers, Emmanuel Chimezie, ThulasiRam Peddineni, Eun Ro, Meaghan Davis, Ben Friedman, and many others who've contributed!
