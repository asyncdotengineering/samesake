---
title: Lexical scoring — why samesake doesn't use BM25
description: How samesake's Postgres-native lexical leg works, why product search does not require BM25, and how lexical quality is measured.
---

Samesake's lexical leg is the exact-word signal in hybrid search. It is useful for names,
brands, colors, and other catalog terms that a semantic embedding may not preserve precisely. It
is deliberately small and Postgres-native.

## What the lexical leg does today

The lexical leg first builds a full-text query and uses an **OR gate** to protect recall. A product
that matches any meaningful query term can enter the lexical candidate set; ordering happens after
that recall decision.

Within the candidate set, ordering is two-tiered:

1. Candidates matching all query terms are ranked first by `ts_rank_cd`.
2. Partial matches follow, ranked by `ts_rank_cd` against the OR-rewritten query.

This is an AND-coverage-first policy. It makes complete lexical matches visible without requiring a
separate scoring extension.

The indexed `tsvector` gives the title the higher weight, `A`, and the body/search text the lower
weight, `B`, through PostgreSQL `setweight`. A title match therefore remains more important than
the same term found only in descriptive text.

The lexical leg contributes **rank**, not a calibrated score, to reciprocal rank fusion (RRF).
RRF combines the lexical rank with the semantic and other retrieval-leg ranks. Changing the
absolute magnitude of a lexical score does not change that fusion contract; changing lexical order
does.

## Why BM25 is not the product-search bar

BM25 is a reasonable default for long, unstructured text, and it remains common in Lucene-lineage
systems. It is not, however, the relevance definition used by the main product-search-native
engines:

- [Algolia's ranking criteria](https://www.algolia.com/doc/guides/managing-results/relevance-overview/in-depth/ranking-criteria/)
  explicitly rejects variations of TF-IDF, including BM25, and resolves results with ordered
  tie-breaking criteria such as typo, words, filters, proximity, attribute, exactness, and custom
  ranking. Product records are short and structured, so term frequency is not treated as the main
  relevance signal.
- [Typesense's ranking and relevance](https://typesense.org/docs/guide/ranking-and-relevance.html)
  uses `_text_match` heuristics such as token overlap, edit distance, proximity, and field
  weights. Its text match does not use IDF or document-length normalization.
- [Meilisearch's ranking rules](https://www.meilisearch.com/docs/learn/relevancy/ranking_rules)
  are an ordered bucket sort: words, typo, proximity, attribute, sort, and exactness decide which
  bucket a result occupies before later rules break ties.

Lucene-lineage engines such as Elasticsearch and OpenSearch do default to BM25. Their ecommerce
guidance still layers business `function_score` signals and hybrid RRF around the text score. BM25
is therefore one valid engine convention, not a universal quality bar for a structured catalog.

## Why it matters less in a hybrid

RRF consumes rank order. The semantic leg covers vocabulary mismatch — for example, a query term
and a product description that express the same intent with different words — while the lexical
leg anchors exact catalog evidence. Product records are usually short, fielded, and structured, so
length normalization is less central than coverage, field weights, and the hard filters compiled
from the query.

That does not make lexical quality unimportant. A bad lexical order can still change the fused
result set. It means the relevant question is whether the shipped policy loses on the product
corpus, not whether it implements a particular long-document formula.

## What guards lexical quality

The permanent lexical A/B regression fixture uses a length-varied product corpus and compares the
shipped `ts_rank_cd` ordering with `ts_rank` using normalization flags `2|4`. The fixture is
extension-free and runs in the eval harness. It measures whether length-varied descriptions cause
short, on-topic products to lose to long, diffuse ones, and keeps the lexical decision empirical.

The broader search evaluation still measures the hybrid result, but this fixture isolates the
lexical leg so semantic changes or RRF weighting cannot hide a lexical regression.

## When we would revisit BM25

The decision would be revisited if the fixture shows a material lexical loss on a length-varied
product corpus, or if long-prose documents become a primary use case rather than a catalog
description edge case. Until then, the Postgres-native `ts_rank_cd` two-tier ordering, `setweight`
title/body weights, and lexical A/B gate are the maintained path.
