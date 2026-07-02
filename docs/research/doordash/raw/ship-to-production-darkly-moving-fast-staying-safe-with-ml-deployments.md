# Ship to Production, Darkly: Moving Fast, Staying Safe with ML Deployments

URL: https://careersatdoordash.com/blog/ship-to-production-darkly-moving-fast-staying-safe-with-ml-deployments/
Published: 2022-03-08T16:00:00+00:00
Authors: Bob Nugman

## Figures
(No in-article figures found; only header photo and author headshot.)

## Body

At DoorDash, machine learning (ML) models are invoked many millions of times each day. Each of them uses dozens or hundreds of features that take a dazzling amount of computational power to produce.

These models, which play many critical roles, including fraud detection, must meet stringent requirements of reliability and correctness in order to be put into production. We also need to be able to quickly adapt them to evolving business needs and improved understanding of the problems being addressed.

In this article, we describe the practice of "dark shipping" of ML models. This practice allows us to balance the tension between the needs of reliability and speed for model deployment, which can be challenging in some areas of ML application, such as for models that prevent fraud and abuse.

## The challenges of launching ML fraud models

The challenges to successfully launching machine learning fraud models include:

- Complex feature engineering
- Scaling and availability
- Correctness in production

Let's start by examining them individually.

### Complex feature engineering

Our anti-fraud specialists are in constant search for insights into how to identify and stop fraud, even as the fraudsters are in constant search of new ways to perpetrate fraud.

The insights produced by anti-fraud specialists then need to be implemented in ways that can be leveraged by machine learning algorithms. This is usually done through the process of feature engineering, which involves data scientists who create the new features, train, and evaluate different model variants, settling on the most promising features and modeling techniques.

These features and models then need to be fully trained and put into production by ML engineers, which leads us to the next challenge.

### Scaling and availability

Once a novel fraud-fighting approach has been identified and validated by anti-fraud specialists and data scientists, it then needs to be delivered to production. DoorDash has a capable general-purpose machine learning platform. The anti-fraud ML model capability, while leveraging the DoorDash ML platform, is invoked in the context of the overall anti-fraud platform. Leveraging these two platforms allows us to address the challenges of scale and availability, while tying complex ML models into the context of fighting fraud.

As a result, hundreds of complex model features are computed in real-time and the models are invoked for nearly every interaction with the platform, resulting in activation of anti-fraud measures depending on decisions rendered by the models.

### Ensuring correctness in production

In addition to meeting the challenges of scale and availability, we must meet the challenges of end-to-end correctness while invoking the models. Potentially, lots of things can go wrong, and even though we test the models at every stage during the model development lifecycle, the final answer to model correctness can be found only in production, with real, novel data.

This presents a conundrum: What if the new version of the model we shipped is less efficient than the previous model at stopping fraud? Even worse, what if the new model has a catastrophic defect, leading to the blocking of every attempted transaction? Another nightmare scenario: What if the model performs as expected but exerts prohibitively high load on our systems, due to expensive queries? At DoorDash volumes, a regression of that kind can result in systems quickly grinding to a halt under unexpected load.

Clearly, we cannot ship a model to production and just hope for the best.

## A familiar challenge – change management

Generally speaking, change management is a familiar problem, particularly in large, business-critical software systems. In fact, the vast majority of production regressions and outages are caused by human-introduced changes, such as changes to code or configuration of the systems.

To meet the challenge of change management, the software industry has developed a large body of knowledge, skills, and tools when it comes to the rollout of code and configuration.

Modern large-scale software systems deploy continuously or nearly so. One of the techniques making it possible is shipping the new code darkly: The new code paths are "guarded" by feature flags and are not activated on deployment but are activated after deployment, usually gradually and under careful observation of relevant metrics. If a regression is observed, the offending code paths can be turned off quickly, without the need for code rollbacks or deployment forward hotfixes, as these usually take much longer.

## ML adds additional complications of change management

However, as mentioned above, management of change for ML models presents additional complications, including:

- **Data quality**: Both at the time of training and at the time of inference (production operation), we need to make sure that the data is extracted consistently, without errors.
- **Training stability:** for example, sensitivity to hyperparameter values, consistency on retraining
- **Difficulty of automating verification:** Writing good tests for code is hard enough. Writing similar testing suites for ML models is nearly impossible. Yet somehow we must control the quality of model scores and decisions.
- **Difficulty of sense-making**: While the source code can be examined directly to find bugs and make sense of its workings, the ML models are less easily interpretable.

With ML models, even more so than with "regular" code, expectations of correctness can be verified only in production. But how to do it safely? By using a dark rollout.

## Solution: Dark rollout of ML models

After a reasonable pre-production validation, we ship the model to production in a manner that allows us to fully validate it with real traffic before we allow it to make live decisions. Below is the sequence of steps developed and practiced by the DoorDash Anti-Fraud DSML team.

### Step 0: Pre-production iterations

Before a model goes to production, it is iterated rapidly and extensively in the development environments, where it is updated, trained, evaluated, and tuned, with a turnaround time ranging from minutes to hours. Once the backtesting results look consistently good, it's time to go to production.

### Step 1: Production: Shadow traffic, 1% volume

If new model features require additional production code (for example, to integrate with novel data sources), it's added as dark code paths, along with the model invocaction code.

These changes are highly standardized: They leverage the Anti-Fraud team's rule engine and DoorDash's ML service, together implementing a complete model lifecycle. The result is a trained model that can serve predictions reliably and at scale.

The rule engine provides important facilities for fault isolation, observability through logging and metrics, integration with data sources, as well as integration into overall DoorDash microservice architecture.

These facilities allow us to exercise the new model with "shadow" traffic (that is, without any business decision impact), with a volume as low as just a fraction of a percent.

At this time, the model is exercised safely (at low volume and with shadow traffic only), while in a true production environment, end-to-end. This allows us to verify multiple things:

- There are no errors due to misconfiguration, missing data sources, timeouts, etc.
- The model performance is within expected parameters.
- All features are extracted correctly; that is, inference-time feature extractors produce the same values as training-time feature extractors.
- There are no anomalies in system metrics, such as high latencies, memory consumption, CPU utilization, etc.

These checks are performed with both the specialized tools (for example, for feature extraction consistency) as well as with standard observability and alerting stack (using time-series dashboards, log monitoring, alerting, and paging services).

### Step 2: Production: Shadow traffic, 100% volume

We can now ramp up the shadow traffic to 100% of the volume, which serves two purposes:

- We can analyze model performance without risking any adverse business impact.
- We can make sure there's no undue deterioration of system metrics due to additional load.

### Step 3: Experiment: Incumbent model vs. new model

By now, we are reasonably confident that the model will perform well. But will it do better than the previous champion model? To find out, we use the DoorDash Curie experimentation system, setting up an experiment that compares the performance of the old and the new models in a rigorous evaluation. Once we see statistically significant improvement, the new model is ramped up to receive 100% of the live traffic – until a newer version arrives to challenge the champion!

## Conclusion

The practice of shipping ML models darkly enables us to iterate on production ML deployments quickly while minimizing risk of regressions. This is achieved by applying production change-management practices borrowed from modern software engineering and adapted for the specifics of machine learning. We encourage ML practitioners to explore this and other techniques that bridge the gap between applied ML and modern production engineering.
