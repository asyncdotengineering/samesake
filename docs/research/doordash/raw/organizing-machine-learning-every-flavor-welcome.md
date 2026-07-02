# Organizing Machine Learning: Every Flavor Welcome!

URL: https://careersatdoordash.com/blog/organizing-machine-learning-every-flavor-welcome/
Published: 2020-02-13T00:23:07+00:00
Authors: Alok Gupta

## Figures
(No in-article figures found; only header photo and author headshot.)

## Body

## DoorDash's principles and processes for democratizing Machine Learning

Six months ago I joined DoorDash as their first Head of Data Science and Machine Learning. One of my first tasks was to help decide how we should organize machine learning (ML) teams in order for us to reap the maximum benefit from this wonderful technology. You can learn more about some of the current use cases of ML at DoorDash at our blog here.

Having spent some time at previous technology companies and spoken to many more, I was acutely aware of many of the challenges that come up.

#### **Challenges**

1. ML is poorly defined: Is a linear regression in Excel ML? What about a toy random forest in a local Jupyter notebook? Where is the line between analytics and ML?
2. ML needs Engineering and Science: ML at technology companies requires performant optimal decision-making.
3. ML advances rapidly: Even over just the last five years we have seen modeling approaches and platforms and languages change almost every 18 months.
4. ML is trendy: many people view ML as magic and so everyone wants to work on it.

In #2 'performant' implies we need low latency, reliability, and scale - typically in a Software Engineer's wheelhouse, while 'optimal' implies we need mathematical and statistical excellence - typically in a Data Scientist's toolkit. This is often the biggest elephant in the room: who _should_ work on ML? Engineers or Data Scientists? Both? Neither? This debate often leads to friction in teams and employee unhappiness.

At DoorDash, our core values include 'One Team One Fight' and 'Make Room At The Table'. We want people of all different backgrounds / titles with ML expertise to come in and feel able to do their best work. So we chose to do things differently, more inclusively. We drew up a charter for ML with the following vision and principles:

#### **Vision**

Build data-driven software for advanced measurement and optimization

#### **Principles**

1. Democracy: everyone can build and run an ML model given sufficient tooling and guidance.
2. Talent: we want to attract and grow the best business-impact focused ML practitioners.
3. Speed: if a cost-effective third party ML solution already exists then we should use it.
4. Sufficiency: if a function (typically Engineering) can implement a good-enough ML solution unaided then they should do so.
5. Incrementality: if a function (typically Data Science) can add enough incremental value to an ML solution then they should do so.
6. Accountability: each ML solution has a single technical lead acting as the technical decision-maker.

The idea behind the vision is that we only want to build ML where it is actually needed - not where it might be interesting. We look for business opportunities where simple analytics or rules only get you 10-40% of the impact. This ensures the return on an ML practitioner's time is super high for the business.

The principles ensure that we can hire the best people and that we are as efficient with our talent as possible. Ownership and accountability are essential for motivating and empowering employees to do their best work. Note that these principles are pretty general and could probably be applied to most tools.

An important corollary of these principles is that we do not pigeon-hole any function i.e. we do not say what a Data Scientist can or cannot work on, or what an Engineer can or cannot work on. We believe in blurry lines and helping ML practitioners grow in whichever areas they want to - so it is fine for a Data Scientist to work on production code or an ML Engineer to build features.

What enables this flexibility while maintaining a high standard is principle #6, which states that we have a single person _accountable_ for a project. That does not mean that this person must do the work, only that they must ensure it is done correctly - and they may choose to have it done by a Data Scientist or an Engineer or someone else.

There is no single unique structure or process that adheres to the vision and principles, rather, any structure chosen needs to be clearly articulated to ensure it is set up for success. At DoorDash, we landed on the following structures and processes to meet the principles:

#### **Organization**

1. Reporting lines: ML Engineers report to Engineering managers and ML Data Scientists report to DS managers. ML Infrastructure reports into the central Data Platform team.
2. Hiring: Job descriptions and hiring processes for ML Engineers and ML Data Scientists are reviewed and approved by ML Council.
3. Technology: Strong investment in a centralized ML platform by Data Platform (workflow, provisioning, orchestration, feature stores, common data preparation, validation, quality checks, monitoring, etc.). Potential ML infrastructure technology (build/buy) decisions reviewed and approved by ML Council.
4. Execution:
   1. Any person(s) at the company can identify a use case for ML and draft a proposal (business problem, estimated impact versus build / maintenance cost, solution, team composition, single technical lead).
   2. The proposal is reviewed, amended, and approved by the pod's / vertical's cross-functional leads (PM, EM, DS Manager, Analytics Manager, etc.). The leads should approve the business problem, prioritization, and impact / cost.
   3. The proposal is reviewed, amended, and approved by the ML Council.
   4. All steps of the review will be transparent: ML Council and ML practitioners will meet weekly at 'ML Review' to review items and debate next steps. Decisions will be made at this ML Review and notes will be taken and emailed to all interested folks.

A key feature at DoorDash is that we do not use reporting lines as a mechanism to enforce alignment and collaboration. Reporting lines do not scale well, especially as a company grows and attracts different flavors of Engineers and Data Scientists. Instead, we force collaboration and cross-functional decision-making through an ML Council:

#### **ML Council**

1. Composition: the ML Council is composed of a group of experienced ML practitioners across the company, typically senior Engineering ML, Data Science ML, and Infrastructure ML folks. It is led by the ML Council Chair, who serves as the decision-maker for escalations. Rotates on some cadence e.g. every 12 months
2. Role: the role of the ML Council is to:
   1. provide balance between project-specific variability vs company wide uniformity, so that we are efficient as a company
   2. review and give feedback on all of new ML applications
   3. facilitate the cross-pollination of ideas and solutions
   4. create better visibility into common pieces (to feed into infra)
   5. encourage more proactive communication of data sources and solutions.
3. Responsibility: Typically the ML Council should ensure that if production performance is the biggest blocker to success then the tech lead is an ML Engineer. Otherwise if statistical performance is the biggest blocker to success then the tech lead is a Data Scientist. The ML Council should check solutions have enough support and where possible are part of the long term ML platform investment.
4. Autonomy: If the ML Council disagrees on the solution / team / lead, then the ML Council Chair tie-breaks and makes a decision.

The ML Council is the glue which holds all the different functions (Engineering, Data Science, Infra, etc) together and keeps all the different teams using ML (Search, Dispatch, Marketing, Forecasting, Fraud, etc) collaborating and learning from each other.

At DoorDash we have had this organization in place for about five months and things seem to be going well. We will no doubt hit stumbling blocks and have to adjust our processes or clarify certain pieces - but this is part of the excitement of working in a fast-moving dynamic technology startup like DoorDash.

Going forward we will be writing many more blog posts about our problems, failures, and successes with ML, and how we use advanced experimentation methodology to test and iterate. We are committed to sharing our insights and learnings so that the wider ML community can benefit - please check back at our blog regularly to read the latest posts.

If you are passionate about solving challenging problems in this space, we are hiring for our ML teams and you can apply here. If you are interested in working on other areas at DoorDash check out our careers page.
