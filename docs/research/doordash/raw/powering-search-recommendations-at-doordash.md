# Powering Search & Recommendations at DoorDash
URL: https://careersatdoordash.com/blog/powering-search-recommendations-at-doordash/
Published: 2017-07-07T04:05:20+00:00
Authors: Aamir Manasawala

## Figures
- https://doordash.engineering/wp-content/uploads/2018/12/Powering-Search-Recommendations-at-DoorDash.png — Personalization Search Architecture

## Body
Customers across North America come to DoorDash to discover and order from a vast selection of their favorite stores. Our mission is to surface the best stores for our consumers based on their personal preferences. However, the notion of "best stores" for a consumer varies widely based on their diet, taste, budget, and other preferences.

To achieve this mission, we are building search products that provide a **personalized discovery and search experience** based on a consumer's past search and order history with DoorDash. This article details our approach for personalization in our search ecosystem, which has provided a significant lift in conversion from search to checkout.

### **Search and recommendation challenges**

The three-sided nature of DoorDash platform (involving consumers, dashers and merchants) presents a lot of **interesting and unique** search challenges in addition to the general search and recommendation related problems. Some challenges include:

- **Sparsity:** not every consumer can see every store, making this different from a typical e-commerce recommendations problem
- **Cold-start problem**: cases when new stores or consumers enter the system
- **Tradeoff** between relevance versus diversity
- Including accurate **driving distance** in search selection

### **Search overview at DoorDash**

We use [Elasticsearch](https://www.elastic.co/products) to power the consumer search for our website and apps. Elasticsearch is an open source, distributed, Lucene-based inverted index that provides search engine capabilities without reinventing the wheel.

For our search engine there are two primary components:

The first is the **indexing module (offline)**. This component reads the store object from the database (Postgres in our case) and writes it to Elasticsearch for bootstrapping, as well as for partial asynchronous updates on the database store object.

Second is the **search module (online)**. Web and mobile clients call the backend search API with the specified consumer location. A JSON-based Elasticsearch query is constructed at the Django backend to call Elasticsearch. The query is executed inside Elasticsearch to retrieve relevant results, which are deserialized and returned to the client. The Elasticsearch query is primarily designed to achieve two purposes:

- _Selection_: Out of all the available stores, only select those that are orderable from the consumer's address. This is primarily achieved by the [geoshape](https://www.elastic.co/guide/en/elasticsearch/reference/current/geo-shape.html) features of Elasticsearch. How we compute a geoshape to get an accurate driving distance for each address and store pair is a discussion for a separate blog post.
- _Ranking or scoring_: Out of the selected subset of stores, we need to rank them according to relevance. Before the personalized ranking we ran a number of sorting experiments including ranking by popularity, price, delivery, estimated time of arrival, ratings, and more. The main learning from the experiments was that there was no global best ranking for every user, but rather the notion of "best" varied across each user, which led us to use personalization.

### **ML modeling for recommendations**

Now let's talk about the ML model training and testing for personalization. For including personalization in Elasticsearch, we define a knowledge-based recommender system over consumer / store pairs. For every consumer we are evaluating how good the recommendation is for each specific store based on the consumer's order history and page views.

To help us out, let's define some basic terms (note that Medium doesn't handle equations well, so apologies in advance for the janky formatting):

- _c_i_: consumer with unique id _i_
- _s_j_: store with unique id _j_
- d( _c_i_): data profile of consumer _c_i_
- d( _s_j_): data profile of store _s_j_
- _f^k_: kth feature in the ML model
- _f^k_ij_: value of kth feature for ( _c_i_, _s_j_) pair

The data profile of consumer _c_i_ mainly refers to all the data that we need as a signal for the recommendation model. We store and update d( _c_i_) for each _c_i_ in the database for it to be consumed in the online pipeline.

The data profile of store _s_j_ is stored in Elasticsearch by the indexing pipeline.

_f^k_ is a feature in the machine learning model and _f^k_ij_ is the specific value for the ( _c_i_, _s_j_) pair. For example, one feature we include is how much overlap there is between the cuisines the consumer _c_i_ had ordered from in the past and the cuisine of the store _s_j_. We would include similar features based on viewing store pages, price range, etc. For training, we generate _f^k_ij_ for each _i_, _j_ such that _c_i_, _s_j_ are visible to each other from the selection criteria described earlier along with a 0/1 flag, which generates the data in the following format:

_\[0/1 flag, f^0_ij , f^1_ij , f^2_ij , … f^k_ij …\] for each i, j such that s_j falls in selectable range of c_i._

Positive examples (marked as 1 in the data model) are the ones where the consumer _c_i_ ordered from that store and the negatives are the ones where, despite the store being exposed to the consumer, the consumer did not order.

We use this data to compute the probability of consumer _c_i_ ordering from _s_j_ given by:

_Probability(c_i orders from store s_j) = 1/(1+e^(-1* ( w_k * f^k_ij)) )_ where _w_k_ is the weight of kth feature.

We trained the data using the [logistic regression](https://en.wikipedia.org/wiki/Logistic_regression) model to estimate _w_k_ for our dataset.

### **Personalization in Elasticsearch**

Now let's discuss how we integrate the personalization piece into the Elasticsearch ecosystem, which serves our app and website in real time. To achieve scoring we have to implement the above mentioned logistic regression scoring function inside Elasticsearch. We accomplished that through the [script scoring](https://www.elastic.co/guide/en/elasticsearch/guide/1.x/script-score.html) feature of Elasticsearch, which is used for customized ranking use cases such as ours. This script has access to documents inside Elasticsearch and parameters that can be passed as run time arguments in the Elasticsearch query. The score generated by the script is then used for ranking a [script based sorting](https://www.elastic.co/guide/en/elasticsearch/reference/1.7/search-request-sort.html#_script_based_sorting) feature to get the desired ranking.

The following diagram describes the overall architecture depicting offline and online components.

[![](https://doordash.engineering/wp-content/uploads/2018/12/Powering-Search-Recommendations-at-DoorDash-1024x525.png)](https://doordash.engineering/wp-content/uploads/2018/12/Powering-Search-Recommendations-at-DoorDash.png) Personalization Search Architecture

#### **Offline components:**

1. The indexing pipeline indexes d( _s_j_) for all stores in the Elasticsearch index.
2. ML data pipeline writes d( _c_i_) for all consumers in the database. The database is updated offline to reflect changes in d( _c_i_) based on _c_i_ activity.

#### **Online components:**

1. DoorDash clients call the search backend API for _c_i_
2. Search module calls database to fetch d( _c_i_) for _c_i_ which the offline ML data pipeline has populated
3. Search Module on fetching d( _c_i_) generates the Elasticsearch query
4. Search Module hits Elasticsearch with the generated query where d( _c_i_) is passed as arguments to the script
5. Elasticsearch ranking script, which is an implementation of the logistic regression scoring function described in the ML modeling section above, is executed as part of the Elasticsearch JVM process. This script is essentially a function of d( _c_i_) and d( _s_j_). The script gets d( _c_i_) as arguments from step 4 and gets d( _s_j_) as part of the index data, which was stored from offline step a. The script generates the score and Elasticsearch ranks them by script score.
6. Personalized results are deserialized and returned to the clients

#### Advantages of this design:

- **Minimal Latency impact:** Since search is a latency sensitive product, the personalized version should not contribute to latency. There is only 1 extra database read per search call (which can also be cached). The script ranking function is executed inside Elasticsearch, which is distributed and cache optimized. We have already rolled out the feature to 100% of customers with no impact on Elasticsearch latency.
- **Horizontally scalable:** Higher search volume results in more heap usage, which can be addressed by adding more nodes to the Elasticsearch cluster or increasing head size per node.
- **ML model change friendly**: The overall architecture works with any ML model. We can experiment with different ML models by implementing the corresponding ranking script and invoking it based on experimentations from backend search modules without changing any other piece.
- **Fault Tolerant:** In cases of failure to get d( _c_i_) in any step we can fall back to the default option and use the baseline non-personalized feed.

### **Future work**

We've only scratched the surface with the work we've done. Here are some areas that we are working on to make our search engine even better:

- **Machine Learning models**: We are testing more sophisticated ML models on top of logistic regression model and experimenting with personalized models for how much variety to include for users.
- **Real time features:** We are improving our data pipeline to have real time features and to better incorporate feedback from activity.
