# Using LLM to transcribe restaurant menu photos
URL: https://careersatdoordash.com/blog/doordash-llm-transcribe-menu/
Published: 2025-03-19T16:49:43+00:00
Authors: Zhe Mai, Zheng Hu, Ying Yang

## Figures
- https://lh7-rt.googleusercontent.com/docsz/AD_4nXeYiVtrlK07449pa3fg4HGqD-MbW4-hddu-UoMJvct0TvEKQjzkyEH7DzJzpAqfvG6SeU-eJyCmHVZxIDouKu6V1-ZfnrEh1AMKlDNoU_QUrotRY9vnBg5qsJIGh-E3sRTdIToyCw?key=90SDjZOkKS2OHuBg_1clIqWD — _Figure 1: OCR extracts text from a menu photo that an LLM then can summarize into a structured data format._
- https://lh7-rt.googleusercontent.com/docsz/AD_4nXf0N1tWa-hvrdP1_jIHmCiDluAPElZ5ydi1OuIW1ozCfA6c6LQ1enaw20PqsK6BYNGaE1P1RTzsiCVWp2rsbzq5nDjtPsOrjCCyPIsPLw1eKgX0XRujGG9bQmnh8v0zgP45Yfz2ww?key=90SDjZOkKS2OHuBg_1clIqWD — _Figure 2: Example transcriptions of menu photos resulting in lower accuracy._
- https://careersatdoordash.com/wp-content/uploads/2025/03/image-2.png — _Table 1: Guardrail model features and inputs_
- https://careersatdoordash.com/wp-content/uploads/2025/03/Transcribing-restaurants-photo-menus-in-no-time-with-LLM-draft-5.png — _Figure 3: We developed a three-component neural network as our guardrail model to take advantage of various types of features_
- https://careersatdoordash.com/wp-content/uploads/2025/03/image.png — _Table 2: Model performance based on architecture. The highest values are represented by deeper green._
- https://careersatdoordash.com/wp-content/uploads/2025/03/Transcribing-restaurants-photo-menus-in-no-time-with-LLM-draft-3-1024x396.png — _Figure 4: Automatic menu transcription pipeline combines human and ML transcriptions through the guardrail model_
- https://careersatdoordash.com/wp-content/uploads/2025/03/Transcribing-restaurants-photo-menus-in-no-time-with-LLM-draft-4-1-1024x519.png — _Figure 5: Updated automatic menu transcription pipeline with both multimodality GenAI models and guardrail model in place._

## Body
A restaurant's menu is one of its most important representations on a delivery platform. To ensure accuracy and alignment with their latest offerings, DoorDash's restaurant partners must actively maintain their menus. This can be challenging, however, for business owners who already are managing demanding daily operations. As a delivery company committed to their success, DoorDash sees a valuable opportunity to integrate AI into this traditionally human-managed process, streamlining efficient updates through submitted menu photos.

Previously, we relied on humans to transcribe and update restaurant menus manually, which is costly and time-consuming. The rapid improvement of large language models, or LLMs, creates an opportunity for a big stepwise change, allowing AI to transcribe information from menu photos. However the diverse menu structures restaurants use pose a challenge for an LLM to do an accurate job at scale. In this blog, we will discuss how we built a system with a guardrail layer for LLMs leveraging traditional Machine Learning (ML) techniques. The guardrail layer serves as an effective control mechanism of LLMs that enables LLM applications to run at scale with high accuracy. It enables AI practitioners to swiftly leverage newly released LLMs while mitigating potential risks that may impact the final product quality. In the meantime, the clever use of traditional ML in this system offers advantages in both low latency and cost efficiency.

## Rapid start with prototyping

LLMs have greatly accelerated how quickly we can develop an initial minimum viable product, completely changing the way we discover possibilities. Figure 1 shows an example of what we could put together quickly for initial evaluation. The process first uses optical character recognition, or OCR, to extract text from a menu image, which is then passed over to an LLM for item-level information extraction and summarization, creating a structured data format.

![Figure 1](https://lh7-rt.googleusercontent.com/docsz/AD_4nXeYiVtrlK07449pa3fg4HGqD-MbW4-hddu-UoMJvct0TvEKQjzkyEH7DzJzpAqfvG6SeU-eJyCmHVZxIDouKu6V1-ZfnrEh1AMKlDNoU_QUrotRY9vnBg5qsJIGh-E3sRTdIToyCw?key=90SDjZOkKS2OHuBg_1clIqWD)
_Figure 1: OCR extracts text from a menu photo that an LLM then can summarize into a structured data format._

### LLM key challenges and pain points

An LLM's text understanding provides excellent summarization and organization. However, given our user cases, we require very high transcription accuracy, which is difficult for an LLM to achieve because of its lack of familiarity with the variety of menu structures, and LLM's ability to follow instructions in complicated scenarios. Through human evaluation of a large number of menu photos, a reasonable proportion of menus can be transcribed with various errors, such as incorrect item names or categories. After a thorough investigation, we found that the LLM created transcription errors primarily when it encountered three sub-optimal types of menu photos, as shown in Figure 2:

- Inconsistent menu structure, leading to confusing OCR raw texts
- Incomplete menus, causing difficulty in the correct linkage between items and their attributes
- Low photographic quality, such as too dark, too many flares, or too many irrelevant items in the foreground or background

![Figure 2](https://lh7-rt.googleusercontent.com/docsz/AD_4nXf0N1tWa-hvrdP1_jIHmCiDluAPElZ5ydi1OuIW1ozCfA6c6LQ1enaw20PqsK6BYNGaE1P1RTzsiCVWp2rsbzq5nDjtPsOrjCCyPIsPLw1eKgX0XRujGG9bQmnh8v0zgP45Yfz2ww?key=90SDjZOkKS2OHuBg_1clIqWD)
_Figure 2: Example transcriptions of menu photos resulting in lower accuracy._

To enhance accuracy, we have made an intensive effort to improve the LLM's performance gap. However given our high accuracy standards, we still need a tremendous amount of time and investment to improve the LLMs, postponing the realization of their value. As a result, we've developed more innovative approaches to move AI automation to production. The key to ensuring an LLM's accuracy is to build an LLM system with a suitable automatic guardrail process and LLM itself, instead of having LLM being a standalone product. The system allows us to not only optimize for high accuracy, also seek for cost and lower latency.

## Introducing an LLM guardrail

Our guardrail framework is based on a machine learning (ML) model that identifies whether an LLM transcription can achieve high accuracy. Simultaneously, the framework must be flexible enough to adapt to rapid developments in AI models. The following outlines our journey toward achieving these goals.

### Generating guardrail model training features

To understand transcription quality, the guardrail model must learn how each menu photo interacts with both OCR and LLM summarization. As with building any other machine learning model, it is key to identify and process the right set of features. We focus in particular on generating features that can explain the interactions between a menu photo, its OCR output, and the LLM summarization because:

- An inconsistent menu structure leads to an illogical order in the OCR output's raw text. For example, the OCR might not be able to read the menu by category or in any particular order. We have observed arbitrary ordering of text recognition that makes it more difficult for an LLM to link the right item attributes together.
- Incomplete menus may output attributes from items that are only partially visible, resulting in extraneous or mismatched attributes, confusing the LLM on the correct item<>attribute linkage.
- Because photo quality can be subpar in many different ways, challenges are generated for both the OCR and the LLM, including minuscule, unusable fonts and cluttered foregrounds and backgrounds that obscure text.

It soon became clear that we could not rely solely on menu photos for machine learning. Instead, we decided to use three types of features/inputs for the model, as shown in Table 1:

![Table 1](https://careersatdoordash.com/wp-content/uploads/2025/03/image-2.png)
_Table 1: Guardrail model features and inputs_

### Guardrail model training and performance

We developed a simple model structure with a three-component neural network design as in Figure 3, to predict whether a transcription is sufficiently accurate. It utilizes pre-trained image models to understand both image features, concatenates with fully connected layers for tabular features, and passes to final classification layers (fully connected layers and a classifier head). We considered the following pre-train image models for exploration:

1. Convolutional Neural Network (CNN) based pre-train image model: Visual Geometry Group 16 ([VGG16](https://arxiv.org/abs/1409.1556)) and Deep Residual Network ([ResNet](https://arxiv.org/abs/1512.03385))
2. Transformer-based pre-train image model: Vision Transformer ([ViT](https://arxiv.org/abs/2010.11929)) / Document Image Transformer ([DiT](https://huggingface.co/docs/transformers/en/model_doc/dit))

![Figure 3](https://careersatdoordash.com/wp-content/uploads/2025/03/Transcribing-restaurants-photo-menus-in-no-time-with-LLM-draft-5.png)
_Figure 3: We developed a three-component neural network as our guardrail model to take advantage of various types of features_

Table 2 below shows the comparison among different model architectures based on two main metrics: average transcription accuracy across all test menu photos and percentage of transcriptions that met accuracy requirements. Surprisingly, we found that the simplest model — Light Gradient-Boosting Machine, or LightGBM for short — outperforms all models while maintaining the fastest run time. The neural network with [ResNet](https://arxiv.org/abs/1512.03385) (residual networks) follows closely behind, while the neural network with Vision Transformers, or [ViT](https://arxiv.org/abs/2010.11929), performs the worst of the five. A key reason for its poor performance is that we have limited labeled data, making it difficult to take full advantage of more complex model designs.

![Table 2](https://careersatdoordash.com/wp-content/uploads/2025/03/image.png)
_Table 2: Model performance based on architecture. The highest values are represented by deeper green._

## Enabling automation of partial transcriptions

![Figure 4](https://careersatdoordash.com/wp-content/uploads/2025/03/Transcribing-restaurants-photo-menus-in-no-time-with-LLM-draft-3-1024x396.png)
_Figure 4: Automatic menu transcription pipeline combines human and ML transcriptions through the guardrail model_

To bring the LLM transcription model to production, we came up with the partial automation transcription pipeline to combine human and ML transcriptions, as shown in Figure 4. In this pipeline, all validated photos are passed to our transcription model, whose features and performance will be generated and evaluated by the guardrail model. Transcribed information becomes readily available for the menu photos that pass the auditing threshold for accuracy. For those that don't pass, the system moves photo menus to the human process. This system marked our first step toward improving efficiency in the manual human processes without sacrificing quality.

## Quick adaptation to improved transcription automation

During the six months following the development of our first guardrail model, there was rapid evolution in the generative AI world, including the development of multimodality models. We continue to explore and test new transcription models, evaluating their pros and cons. Each generation transcription model has unique advantages and shortcomings, but none significantly outperforms the others. For example, multimodality models are great at context understanding but more prone to errors when handling bad-quality photos, resulting in overall higher transcription failure rates. OCR+LLM models, on the other hand, maintain relatively stable performance but underperform on context understanding.

Nonetheless, our guardrail model framework has allowed us to leverage newly released state-of-the-art AI models quickly. It balances the pros and cons of different models and helps the system steadily reach a higher ratio of automation while ensuring quality.

![Figure 5](https://careersatdoordash.com/wp-content/uploads/2025/03/Transcribing-restaurants-photo-menus-in-no-time-with-LLM-draft-4-1-1024x519.png)
_Figure 5: Updated automatic menu transcription pipeline with both multimodality GenAI models and guardrail model in place._

## Looking into the future

With the rapid development of generative AI and increasing investment, this has become a fast learning and exploring process for all of us. From this journey, we've learned that more supervision is needed to realize full value and move into reliable production. The guardrail ML model has proven most viable for achieving these purposes.

As our journey continues, we are seeing improvement in our current pipeline, even as we explore additional options for optimizing and improving the performance of both transcription and guardrail models. For example, current LLM/multimodal models are trained with a general dataset and no domain expertise on restaurant menus. Because we have an increasing availability of manually transcribed data, we could extend its use to fine-tune custom LLM/multimodal models.

One of the biggest challenges with both transcription models, however, is the poor quality of menu photos. Additional processes could be put in place to ensure quality improvements, which could lead to advancements in downstream transcription. Those are just some of the areas we plan to continue working on. We are excited about the potential to continually improve our AI system to provide the most up-to-date information from restaurants to consumers.
