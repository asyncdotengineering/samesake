# Integrating a Search Ranking Model into a Prediction Service

URL: https://careersatdoordash.com/blog/integrating-a-scoring-framework-into-a-prediction-service/
Published: 2020-10-01T19:14:04+00:00
Authors: Ezra Berger

## Figures
- https://careersatdoordash.com/wp-content/uploads/2020/10/select-ranking-12-1-1024x996.jpg — Figure 1: Our legacy workflow performs all necessary computations and transformations within the search microservice, which means there are few resources left to improve the model's scalability.
- https://careersatdoordash.com/wp-content/uploads/2020/10/send-store-ids-14-1-1024x735.jpg — Figure 2: Our new workflow separates the compute-intensive processes from search into Sibyl, freeing up resources to iterate on scorers.
- https://careersatdoordash.com/wp-content/uploads/2020/10/snowflake-12-1-1024x118.jpg — Figure 3. Our ETL data pipeline copies store and consumer features from our data storage to the feature store.

## Body

As companies utilize data to improve their user experiences and operations, it becomes increasingly important that the infrastructure supporting the creation and maintenance of machine learning models is scalable and will enable high productivity. DoorDash recently faced this issue concerning its search scoring and ranking models: the high demands on CPU and memory resources caused new model production to be unscalable. Specifically, the growth in feature numbers per added model would have been unsustainable, forcing us to reach our maximum CPU and/or RAM constraints too quickly.

To resolve this problem, we migrated some of our scoring models, used to personalize and rank consumer search results, to the DoorDash internal prediction service Sibyl, which would allow us to free up space and memory within the search service and thus add new features in our system. Our scorers now run successfully in production while leaving us plenty of resources to incorporate new features and develop more advanced models.

## The problems with DoorDash's existing scoring infrastructure

In previous articles, we've outlined our current scoring mechanism, as well as our work testing more sophisticated machine learning models in addition to logistic regression. Our goal is to enhance our scoring models while ensuring that the site's search and recommendation procedure is fast and relevant. Due to the store ranking procedure's dependency on customers' preferences, the input features into our search models are transformed from a combination of store and consumer features. This process is outlined in Figure 1, below:

![](https://careersatdoordash.com/wp-content/uploads/2020/10/select-ranking-12-1-1024x996.jpg)Figure 1: Our legacy workflow performs all necessary computations and transformations within the search microservice, which means there are few resources left to improve the model's scalability.

The search and recommendation tech stack faced a number of obstacles, including excessive RAM and CPU usage and difficulty in adding additional models. Besides the fact that these new models would have required storing even more features, thereby further increasing our RAM and CPU load, the process for creating a new model was already tedious and time-intensive.

### Excessive RAM and CPU usage

As the number of model features increases, the existing scoring framework becomes less and less optimal for the following reasons: Features are stored in a database and cached in Redis and RAM, and given the constraints on both resources, onboarding new features to the model causes both storage and memory pressure. The assembly of new scorers becomes infeasible as we reach our limits on space and RAM; therefore, storing features within the search infrastructure is limiting our ability to create new models. Moreover, because we must warm up the in-memory cache before serving requests, the preexisting scoring mechanism also causes reliability issues.

Additionally, we face excessive CPU usage, as hundreds of thousands of CPU computations are needed for our model per client request. This restricts the computations we can make in the future when building new models.

### The challenges of adding additional models

It is difficult to implement and add new models within the existing search infrastructure because the framework hinders productive development. All features and corresponding coefficients have to be manually listed in the code, and while we formerly labeled this design as "ML model change friendly," the implementation of the corresponding ranking script for new models can still take up a lot of time.

For example, one of our most deployed scorers has 23 features, and all associated operations for the features had to be coded or abstracted. Given that more sophisticated models may require many more features, it could take a week or more to onboard a new model, which is far too slow and not scalable enough to meet the business' needs.

## Moving search models to our prediction service

To overcome these issues with the model infrastructure, we moved our scoring framework to DoorDash's Sibyl prediction service. We previously discussed the innovation, development, and actualization of our in-house prediction service in an article on our engineering blog.

In essence, this migration to Sibyl frees up database space and allows us to more easily construct new models. To accomplish this migration, we have to compose a computational graph that states the operations necessary to realize each new model, assuming that the relevant features are already stored within Sibyl's feature store and the required operations already exist within Sibyl.

We break the Sibyl migration task down into three major steps:

1. Migrate all feature values from the search service to Sibyl's feature store, which is specifically designed to host features. This allows us to free up storage and memory within the search infrastructure.
2. Implement unsupported operations to Sibyl, including those necessary for feature processing, ranking, and the logistic regression model.
3. Finally, compose the required computational graphs for the scoring framework.

Since DoorDash uses many different search scoring models, we pick the most popular for the migration. These three steps outlined above are applicable to all scorers, with the primary difference among them being the input ranking features in the model. Figure 2, below, details how the ranking architecture has changed since the migration.

![](https://careersatdoordash.com/wp-content/uploads/2020/10/send-store-ids-14-1-1024x735.jpg)Figure 2: Our new workflow separates the compute-intensive processes from search into Sibyl, freeing up resources to iterate on scorers.

### Migrating ranking features from search to Sibyl

The first step in the migration is to move the ranking features from our existing data storage into the feature store using an ETL pipeline. Specifically, we want to move all of the store and consumer features necessary to compute the ranking features (the model's input features), as well as the feature computation for "offline" ranking features. These offline features rely on only one feature type. For instance, a Boolean ranking feature whose value only depends on store features would be classified as an offline feature.

#### Building the ETL pipeline

![](https://careersatdoordash.com/wp-content/uploads/2020/10/snowflake-12-1-1024x118.jpg)Figure 3. Our ETL data pipeline copies store and consumer features from our data storage to the feature store.

After processing all of our relevant store and consumer features, we need to transform them into our ranking features. We map each of our original ranking feature names to its corresponding Sibyl name, which follows a consistent and descriptive naming format. This, along with a distinctive feature key name, allows us to access the value for any ranking feature given the relevant store IDs or consumer IDs.

For ranking features that have dependencies in both the store and consumer tables, we modify the cache key to store both IDs. Furthermore, before loading any feature into the feature store and before feature processing, we check that the feature is non-null, nonzero, and non-false (null, zero, and false features will be handled in Sibyl using default values instead). Figure 3, above, outlines the end to end approach.

For the sake of consistency, we create a separate table in Snowflake containing columns for the Sibyl feature name, feature key, and feature value.

### Migrating the ranking models from search to Sibyl

Next, we focus on processing online features. Before we can accomplish this, however, we have to introduce a list type in Sibyl. Initially, Sibyl supported only three types of features: numerical, categorical, and embedding-based features. However, many of our ranking features are actually list-based, such as tags or search terms. Moreover, the lists are of arbitrary length, and hence cannot be labeled as embedding features.

To implement these lists in Sibyl, we store both a dynamic array and an offsets matrix. The matrix of offsets holds the length of all list-based features in lieu of the list itself, and the dynamic array is a one-dimensional list concatenating the list values from all of the list-based features.

For instance, given two list-based features with values [1,2,3,4,5] and [2,2,3,4,4,6], the offsets matrix would be {5,6} and the dynamic array would be {1,2,3,4,5,2,2,3,4,4,6}. Notice that the offsets matrix can be used to calculate the inclusive start index and exclusive end index within the dynamic array for each list feature. Hence, we are able to deduce the original lists from these two data structures.

#### Including previously unsupported operations

With the inclusion of lists, we then move on to implementing the missing operations required for processing online features. Previously, Sibyl supported basic arithmetic (add, subtract, multiply, divide, etc.), comparison (equal, greater than, greater than or equal to, etc.), and Boolean (and, or, not) operations. However, some ranking features necessitate vector computations. For our scoring models, we needed to include a cosine similarity operation used to compute the cosine distance between the store2vec and consumer2vec features.

Additionally, to cover all of the necessary computations, we first came up with a required list of computations, which we then conflated into the operations below to reduce computational overhead:

1. size(), which returns the number of elements in a list
2. count_matches(), which counts the number of common elements between two lists
3. count_matches_at(), which counts the number of occurrences of the value at a specific index in one list ("list1") in the other list ("list2"). To give a high level overview, given index 2 and the two aforementioned lists ([1,2,3,4,5] and [2,2,3,4,4,6]), we want to count the number of occurrences of the value at the second index of the first list in the second list. In this example, we would return 1 since 3 occurs once in the second list. In actuality, this operation has been adapted to handle even more complex cases that involve three or more list inputs.

In some cases, we need to create sets from our lists as to only consider unique values. However, Sibyl operations should only return numeric types. Hence, we add a unique parameter to each of these operations. These three aforementioned operations cover all of the necessary list computations, concluding the feature processing aspect of the migration.

To complete the full ranking migration to Sibyl, we finally had to integrate our ranking model into the prediction service. Our current search ranking model is based on the logistic function. Overall, implementing a logistic regression model was pretty similar to the other aforementioned vector operations since the inputs involved are treated as vectors. We are still entertaining the idea of upgrading to more advanced models in the future, such as boosted trees or some type of deep learning model.

### Composing the overall scoring framework

To tie all of these components together, we compose the model in a computational graph format. The ranking models implemented are all composite models, which enable custom processing as opposed to pure models. Using the predefined Sibyl composite model structure, we can instantiate the computational graph for each scorer as follows:

The model computational graphs are composed of input nodes and compute nodes. Input nodes host the input numerical, categorical, embedding, and list features, while compute nodes chain the aforementioned Sibyl operations to perform the requisite calculations which will return the final value in a "result" compute node.

For each model we also define a configuration file composed of detailed input nodes. This includes default values for each feature, which is important since null-, zero-, and false-valued features are not stored in the feature store from the ETL step. We also include dimension and sequence length in the configuration file when applicable. With this step, we are able to obtain the uploaded features from the feature store given a specific store ID and/or consumer ID and input them into the models, and receive a logistic regression score as the output.

## Conclusion

In completing the migration of our scorers from our search infrastructure to Sibyl prediction service, we were able to absolve our increasing RAM usage and move one step closer to improving the productivity and standardization of DoorDash's machine learning models. Furthermore, the new computational graph model format allowed us to reduce the time necessary to produce new models from up to a week to a few hours, on average.

Other companies facing memory pressure due to model improvements or increases in feature numbers would likely find it advantageous to migrate to a dedicated feature store and/or separate prediction service. While Sibyl is internal to DoorDash, a company-wide prediction service can prove to be rewarding in the future, especially if there are many overlapping machine learning use cases across teams.
