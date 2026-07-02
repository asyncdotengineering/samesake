# 3 Principles for Building an ML Platform That Will Sustain Hypergrowth

URL: https://careersatdoordash.com/blog/3-principles-for-building-an-ml-platform/
Published: 2022-04-12T13:31:00+00:00
Authors: Hien Luu

## Figures
- https://careersatdoordash.com/wp-content/uploads/2022/04/models-predictions-12-1-1024x598.jpg — Figure 1 - The growth of models in production and total predictions per week
- https://careersatdoordash.com/wp-content/uploads/2022/04/formulate-problem-12-1-1024x811.jpg — Figure 2 - The machine learning development process involves many steps which ideally are sped up in a high-functioning ML platform

## Body

Taking full advantage of a large and diverse set of machine learning (ML) use cases calls for creating a centralized platform that can support new business initiatives, improve user experiences, enhance operational efficiency, and accelerate overall ML adoption.

For a hypergrowth company like DoorDash, building such a system from the ground up is no small task. As you can see from figure 1 below, in a relatively short amount of time we have been able to quadruple the number of models and 5x the number of predictions that our system is able to handle. Among other things, this huge endeavor requires recruiting a high performing team that can lead a thoughtful and intentional collaboration model with the data science community. In this article, we will share DoorDash's journey of building a centralized ML platform that leverages the principles of "dream-big-start-small," "1% better every day" and "customer obsession" to support our ongoing growth, meet the needs of diverse ML use cases, and overcome the challenges of applying ML at scale.

![](https://careersatdoordash.com/wp-content/uploads/2022/04/models-predictions-12-1-1024x598.jpg)_Figure 1 - The growth of models in production and total predictions per week_

## What is an ML platform?

At the highest level, an ML platform consists of infrastructure, services, tools, and libraries to support the end-to-end ML development process. That highly iterative process is a scientific endeavor that requires ongoing experimentation over the course of multiple steps, as depicted in Figure 1. The faster data scientists can go through this iterative process, the faster they can come up with solutions to business problems.

![](https://careersatdoordash.com/wp-content/uploads/2022/04/formulate-problem-12-1-1024x811.jpg)_Figure 2 - The machine learning development process involves many steps which ideally are sped up in a high-functioning ML platform_

Many aspects of machine learning development are complex and technical. In order for data scientists to move through this iterative process quickly, they need software engineering solutions to abstract the underlying complexity, perform feature engineering, and speed up model development at scale. The ML platform centralizes these abstractions. For example, in the feature engineering step, the platform provides a declarative way of performing feature engineering logic, during which it figures out how to execute the logic, orchestrate the necessary computations, and secure the necessary compute resources. Similar abstractions are provided throughout the ML development lifecycle and are often featured in an ML platform.

## The principles we applied to build and scale our ML platform

Given the complexity of an ML platform, a principled approach is required to achieve success. At DoorDash, we used three key principles:

- Dream big, start small
- 1% better every day
- Customer obsession

These principles guided us to clarity in setting a direction and outlining a roadmap, anticipating the needs of our customers, delighting them with well-crafted components of the platform, and incrementally improving the infrastructure based on customer feedback and what we learned along the way.

The following delves into each of our key principles and illustrates how following these principles has enabled us to support our data science users and scale our ML platform.

## How "dream big, start small" helped us navigate

To realize our goals, we first established a clear vision of what the completed ML platform would look like. Establishing that big-picture goal gave us a north star by which we could navigate. To develop that dream, we studied industry-leading ML platforms such as Michaelangelo from Uber, Pro-ML from LinkedIn, FBLearner from FB, TFX from Google. With those in mind, we then gathered an understanding of DoorDash's ML use cases and specific needs. Merging this research, we developed a product vision document that contained the ultimate vision for what we wanted, the north-star metrics to get there, a one-year roadmap, and the strategic bets we would have to place. What we discovered throughout this process was that, while the core capabilities of most ML platforms are quite similar, what tends to set them apart and helps with the successful adoption is a set of strategic bets that they established going in.

With that in mind, we established the following strategic bets:

- _Focus on platform velocity_ – We strongly believe in automation via such things as tooling, infrastructure, and to accelerate iteration speed and bring ML models from idea to production faster.
- _Building a machine learning platform-as-a-service_ – We believe providing a cohesive set of components that work in concert to automate the entire ML pipeline and manage ML artifacts will improve the platform's user experience and general usability.
- _Commitment to observability_ – Model predictive performance can decay with time or show unexpected results. We want our users to be able to know about decay, manage it, and take corrective actions quickly to resolve underlying issues for all models and features they build on the platform.

Focusing on these strategic bets does not imply that the ML platform's inherent characteristics are not important. Scalability, reliability, usability, and other fundamental factors remain critical to success. Rather, the strategic bets act as guiding lights to help us stay on course throughout our journey toward building an ML platform best-suited to meet DoorDash's unique and ever-growing needs.

### What it means to start small

After we pursued the "dream big" part of our working principles, we knew we needed to "start small." Starting small encourages us to make meaningful progress and impact incrementally while remaining strategic about where we should double-down. In a fast-moving company like DoorDash, we don't have the luxury of time involved in building an ML platform using a master plan with sequential steps. We needed to start creating value for our customers fast.

#### Starting small with the Sibyl prediction service

Rather than opting for either of the most common approaches to creating an ML platform – sequentially or slowly fleshing out a full but barebones system – DoorDash went a different route. We started small with a laser focus on building a single core component called prediction service, which we knew would bring meaningful results for our customers.

The logistics team was one of the first DoorDash teams to heavily utilize ML. Their ML use cases revolve around the order dispatch optimization problem and their prediction service plays an integral part in helping with the dispatch optimization problems.

At the beginning of the COVID-19 pandemic, DoorDash food orders multiplied rapidly. The logistics team's prediction service needed a facelift to keep up with the increased model prediction volume. We partnered with the team to better understand the scaling challenges, their ML model type, prediction latency, and feature volume. Then we married their needs with our long-term vision for the ML platform: supporting a diverse set of use cases to create our Sibyl prediction service to perform online predictions at high throughput and low latency. Among its notable capabilities are batch predictions, model shadowing, and feature fetching. After Sibyl was up and running, we worked closely with the logistics team to migrate their models onto the new service. That process had its own interesting challenges, which we have previously detailed in this blog post. The migration was completed successfully with the new prediction service able to handle the logistics team's scalability, throughput, and latency requirements.

While the product vision gives us a path toward building the ML platform, starting small, demonstrating progress, and then doubling down when an idea takes shape leads to meaningful business impact. Our success with onboarding impactful use cases first from the logistics team and then from the search and discovery team proves that the "dream-big-start-small" principle is an effective approach to building large and complex projects such as an ML platform.

## 1% better is about iteration not perfection

The "1% better every day" principle reminds us that constant and never-ending improvement will lead to sustainable and transformative change. As the ML platform adoption takes on more data science teams and use cases, it is imperative to monitor for needed improvements and address customer pain points and feedback.

### Operating at scale shines a light on inefficiencies

As the number of ML use cases increased, demand on the ML platform escalated to support billions of predictions per day and to store billions of features. The higher the demand, the more inefficiencies made themselves known, including feature store space usage, cost, and manageability.

To detect surprises and make adjustments as needed, we regularly tracked the ML platform's progress to ensure it was following its north star goals and that secondary metrics were showing progress. At one point, we noticed the feature volume was increasing at an alarming rate, which translates to additional cost and operational overhead. Once the reason for the increased feature volume was clear, we investigated how features could be stored more efficiently. We objectively assessed different storage solutions and optimization options via benchmarking them. The final optimization we implemented reduced costs three-fold and cut feature fetching latencies by 38%. The details of the benchmark and optimizations are described in detail in "Building a Gigascale ML Feature Store with Redis, Binary Serialization, String Hashing, and Compression." The experience demonstrated how following the "1% better" principle, rather than striving for elusive perfection, results in constant improvements to our platform as it continues to expand to meet the needs of our customers.

## Not all improvements require a technical solution

To us, customer experience is just as important as platform capabilities. As DoorDash grows, we're bringing on more data scientists every month. Recently, our biannual customer survey revealed a need for a proper onboarding experience for new data scientists so they can be productive during their first three months at DoorDash. Each component of the ML platform had its own onboarding documentation, but they were not tied together to capture the big picture, such as best practices and how various components fit together. So the team leveraged the existing documentation to create more comprehensive onboarding content for the new hires. After the first onboarding workshop, we received positive feedback from the survey about the onboarding process and the data scientists' level of comfort using the ML platform. Now, not only are new personnel more productive from the start, but our team receives fewer support requests to help get them up to speed.

Recognizing when an improvement is needed requires a clear picture of where things are and the direction they are going. That means continuous tracking of key measures and ongoing incremental investments in making improvements – the embodiment of the "1% better every day" principle.

## Customer obsession keeps us ahead of customer needs

The precepts around customer obsession found in a retail environment also apply to meeting the needs of internal customers. By establishing the principle of customer obsession early on, we have been able to stay connected, create a delightful experience, and be one step ahead of our customers' needs.

As detailed below, customer obsession is accomplished through understanding use cases and success metrics, applying the Golden Rule, and anticipating needs with what we call "french fry moments."

### Understanding customer use cases and their success metrics

Building a successful ML platform requires more than getting the technology right. It also requires meeting evolving customer needs over time. There are a few ways to learn about those needs, but one of the most effective approaches within DoorDash involves developing a one-pager – a report that details a customer project's use case, its success metrics, and its estimated business impact. Armed with this information, we can prioritize enhancements through a task stack rank process, keeping a close eye on overall business impact. Knowing what our customers need and why also gives our team perspective on how their work impacts DoorDash overall, motivating everyone to stay focused and ensure on-time delivery.

### Applying the Golden Rule to support customers

Customer support is one of the key ingredients of a successful ML platform, so we support our customers in a way that we would like to be supported. We also commit to providing customer support promptly and with respect and fairness. When a request has been fulfilled, we ensure satisfactory closure.

Customers come to us when they encounter problems while using our platform or when they are unsure of what to do in certain situations. We are mindful about the challenge of striking a balance between unblocking our customers and being overwhelmed with a high volume of support requests. As the platform's capabilities expand and more customers use it, it is critical to evaluate the support load frequently and make any adjustments needed to address increased support issues. At the weekly team meeting, in addition to discussing the critical support issues, we also discuss customer support volume to better understand where the additional volume comes from. As the data science team size increases, the support volume around the model deployment goes up. After we invested in automating the model deployment process, the support load for this area went down dramatically.

To help balance good customer support against our limited bandwidth, we:

- Incorporate customer support time into the quarterly planning process
- Conduct weekly reviews of support issues to detect gaps and underlying problems
- Continuously update the FAQ wiki page to address repeated questions quickly with minimum effort
- Organize group customer onboarding sessions to reduce volume of repeat questions

Focusing on our customers and staying connected to them not only makes them happy, but also motivates our team members to build and deliver impactful solutions.

### Delight customers with "french fry moments"

Google's phrase "french fry moments" refers to the concept of anticipating needs. The concept was created after an executive saw a scene on the sitcom _30 Rock_ in which Tracy Jordan's character becomes outraged after he receives the burger he ordered but not the fries he did **_not_** order, prompting him to yell: "Where are the french fries I didn't order? When will you learn to anticipate me?"

This concept motivates us to go beyond customer feedback and anticipate customer needs. We'll discuss how to bring about these "french fry moments" with a few examples from our past work.

During the initial release of the Sibyl prediction service, we noticed an important process was slow and manual. We had provided a way for users to test their models during the migration of existing models to Sibyl; the testing procedure involved creating a Python script to make gRPC calls to test and validate model predictions before deploying those models to production. As more data scientists joined DoorDash, however, we observed that this manual process was not scalable, slowing the ML development process and generating repeated questions about putting together the Python script. Without any prompting from our customers, we automated the model testing process by building a simple web application to enable data scientists to test their ML models easily using their browser and a few mouse clicks. The end result of this preemptive thinking: happy customers, proven productivity improvements, and a reduced support load for us.

Sometimes french fry moments come simply from knowing what's best for the customer. Because we have more access to performance data about our systems, we can own expected outcomes. When our systems are not working as intended, we can step in, improve our systems, and deliver a french fry moment without any direct user feedback prompting it. For example, when we first released our feature quality monitoring capability (as outlined in "Maintaining Machine Learning Model Accuracy Through Monitoring"), we required an onboarding step to take advantage of the feature. We saw that adoption was limited and became curious about why data scientists didn't take advantage of it even though they knew this feature would help detect model prediction issues quickly. We discovered that the onboarding step was actually a friction that hindered adoption of the monitoring tool we had built. So, in the second release of the feature quality monitoring capability, we enabled complete monitoring for all features, eliminating the onboarding step entirely. Our swift action delivered a french fry moment, streamlining processes and delighting customers without requiring that they say a word.

The french fry moment concept encourages us to tap into our creative thinking to delight our customers with solutions that don't require prompting from them. Sometimes we end up benefiting from those solutions ourselves, creating a win-win scenario for everyone.

## Future Work

Now that we have established a good ML platform foundation to build on, we are pursuing ambitious goals as we look toward the future. We plan to advance our platform to provide more value to our customers and to support more challenging use cases to meet expanding business needs.

- _Build feature engineering and model training at scale._ Large and complex use cases like search and recommendation and advertisement and promotion require continuous model training with billions of feature values to provide optimal predictive power. Creating and maintaining large feature pipelines and training large ML models require an efficient and scalable distributed computation and model training infrastructure.
- _Double down on the ML portal._ This is the web UI for data scientists to manage their machine learning workflow. As the ML platform capability expands, it is increasingly important to provide an easy-to-use self-service way for data scientists to automate their machine learning workflow as much as possible.
- _Create self-service ML observability_. The more models that are onboarded to the ML platform, the more there are at stake. We would like to add advanced ML model monitoring and debugging capabilities so that data scientists can quickly identify and debug model prediction quality issues or quality degradation.
- _Enable model prediction flexibility and scalability_. We anticipate there will be more image recognition and NLP-related use cases soon. As such, it is imperative to evolve the current ML model prediction infrastructure to be more scalable, more flexible to support both simple and complex use cases, and more efficient to meet business growth.
