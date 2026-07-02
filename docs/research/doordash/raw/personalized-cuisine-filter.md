# Personalized Cuisine Filter
URL: https://careersatdoordash.com/blog/personalized-cuisine-filter/
Published: 2020-01-27T23:12:16+00:00
Authors: Max Li, Xiaochang Miao

## Figures
- https://doordash.engineering/wp-content/uploads/2020/01/unnamed.png — _(no caption)_
- https://doordash.engineering/wp-content/uploads/2020/08/market-submarket-12.jpg — _(no caption; market-submarket levels illustration)_
- https://doordash.engineering/wp-content/uploads/2020/01/Screen-Shot-2020-01-29-at-1.34.27-PM.png — _(no caption; Algorithm)_
- https://doordash.engineering/wp-content/uploads/2020/01/Screen-Shot-2020-01-26-at-2.36.28-PM.png — _(no caption; Algorithm)_

## Body
The consumer shopping experience is a key focus area at DoorDash. We want to provide consumers an enjoyable shopping experience by providing the right recommendation to the right consumer at the right time for the right location. On our app, there are cuisine filters on the top of the explore page. We have built a system that surface the most relevant cuisines based on consumers' personal preference and local popularity.

Unlike typical recommendation tasks in machine learning, at DoorDash, a unique challenge to our recommendation system is to account for where and when the recommendation is provided to a consumer. Different cuisines are available at different locations and different times of the day. When a consumer comes to a new city, we would like to present the popular local cuisines for the consumer to explore while also considering his/her personal preferences. To accommodate these unique requirements of our recommendation system, we developed a multi-level multi-armed bandit model to provide consumers the most relevant cuisine types. This has led to a significant conversion lift.

#### What is the multi-armed bandit algorithm?

The term "multi-armed bandit" comes from a hypothetical experiment where a person must choose between multiple actions (i.e. slot machines, aka "one-armed bandits"), each with an unknown payout. The goal is to determine the best or most profitable outcome through a series of choices. At the beginning of the experiment, when odds and payouts are unknown, the gambler must determine which arm to pull. This is the "multi-armed bandit problem."

#### Why multi-armed bandit?

Multi-armed bandit provides a formal framework for balancing exploration and exploitation. In the hypothetical example, a gambler needs to balance between exploring which arm has the best payout and exploiting the best-payout arm. For the cuisine filter, during exploration, we surface more new types of cuisine for consumers to explore their interests. On the other hand, during exploitation, we recommend our consumers their most preferable types of cuisine. Multi-arm ensures that the most preferable types of cuisine are presented to our consumers, and they have the opportunity to see different types of cuisine that they may potentially like. This helps us understand our consumers a little better every day.

![image](https://doordash.engineering/wp-content/uploads/2020/01/unnamed.png)

#### What is the multi-level multi-armed bandit model?

Here, _multi-level_ refers to multiple levels of geolocations. From the lowest level to the highest level, these geolocations are districts, submarkets, markets, regions, countries, and the world. A consumer's geolocation carries important information to help us understand what his/her cuisine preference is. At each level of geolocation, we model the 'average' cuisine preference. The 'average' preference represents the cuisine preference of consumers-like-me. If a consumer lives in a place where most consumers like Korean food, then this consumer is more likely to be interested in Korean food than an 'average' consumer is. Similarly, if a newly launched district is in a submarket where certain types of cuisine are popular, then it is likely that the same types of cuisine will be popular in this new market.

![market-submarket-12](https://doordash.engineering/wp-content/uploads/2020/08/market-submarket-12.jpg)

The 'average' preference from the higher level of geolocation serves as the prior knowledge modeled by [prior probabilities](https://en.wikipedia.org/wiki/Prior_probability) of each cuisine being liked by a consumer or an imaginary 'average' consumer at a geolocation level. For example, the prior knowledge of a consumer's cuisine preference is the preference of the 'average' consumer at the district level, and the prior knowledge of the 'average' consumer at the district level is the 'average' preference at the submarket level. The [posterior probability](https://en.wikipedia.org/wiki/Posterior_probability) of a cuisine being preferred by a consumer or an 'average' consumer is computed using [Bayes' theorem](https://en.wikipedia.org/wiki/Bayesian_inference), which unifies the prior probability and evidence (data) to provide a posterior probability.

We use the [Thompson sampling](https://en.wikipedia.org/wiki/Thompson_sampling) approach for multi-armed bandit. In essence, different types of cuisine are ordered by their posterior probabilities of being liked by a consumer. And these posterior probabilities are influenced by the cuisine popularities of all levels of geolocations, where popularity at the district level (lowest level) influences the most and popularity at global level (highest level) influences the least.

#### Why multi-level?

We devised this multilevel model to address two challenges: 1) cold start–what to recommend for the consumers who don't have any purchase history at DoorDash or for a newly launched market, 2) how to present the local favorites to consumers while also recognizing their personal preference.

Cold start is a common challenge for recommendation systems. At DoorDash this challenge is twofold – new consumers and new districts. When we onboard a new consumer, we don't yet have historical data to learn the consumer's cuisine preference, and, therefore, the cuisine filter will represent the prior knowledge of his/her cuisine preference. As we collect more and more data from this consumer, the cuisine filter will represent more and more of his/her personal preference rather than the prior knowledge. Similarly, for a newly launched district, for any consumers in that district, the cuisine filter represents the prior knowledge derived from the cuisine preference from the sub-market (one level above the district).

When consumers come to a new district, certain types of cuisine may be very popular in this district but not in the district where the consumer usually orders from. For example, when a sushi-lover comes to a town popular for Korean food, she may still want to order sushi or to explore the famous local Korean BBQ. To present the local favorites to consumers while also recognizing their personal preference, we need to derive the prior knowledge from the new district. And the cuisine filter ranked by posterior probabilities will represent the balance between local popularity and the consumer's personal preference.

#### Algorithm

![Algorithm](https://doordash.engineering/wp-content/uploads/2020/01/Screen-Shot-2020-01-29-at-1.34.27-PM.png)

![Algorithm](https://doordash.engineering/wp-content/uploads/2020/01/Screen-Shot-2020-01-26-at-2.36.28-PM.png)

#### Results

Evaluation was done through A/B testing a control group (cuisine filter set at the district level by the local operators), to a treatment group using alphabetical ordering (different types of cuisine were ordered alphabetically), and to a second treatment group using the personalized cuisine filter. The alphabetical order didn't yield a significant conversion lift, whereas the personalized cuisine filter did gIve a statistically significant conversion lift and double-digit relative increase in cuisine filter click-through rate.

#### Day-part extension

The aforementioned approach serves as a very fundamental Multi-Armed Bandit approach to empower personalization. But it could be extended to incorporate various contextual information, eg. time of day. For instance, a consumer will likely order different types of food for breakfast, lunch and dinner. To make sure the current recommendation framework could adapt to the temporal preferences of cuisines, we can re-calculate the hyper-parameters (α , β) through aggregating consumers' purchases by day-part. Thus, at various times of the day, different sets of hyper-parameters will be used in Thompson Sampling to generate more personalized cuisine types.

#### Conclusion

As a customer-obsessed company, our mission is to provide the best shopping experience to our consumers. Machine learning plays a key role in accomplishing our mission. The multi-level multi-armed bandit model is an initial attempt to personalize the cuisine filter. Although this has yielded a significant conversion lift, there are definitely many more areas to improve. We defined consumers-like-me as consumers from the same district, but better prior knowledge can be derived from more sophisticated consumer segmentation. Also geolocation and time of day are the context we consider but, in the future, we may employ contextual bandit to incorporate more information about the consumer and the consumer interactions with DoorDash.
