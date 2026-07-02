# Enrichment-accuracy eval (fixture)

Corpus: demo_store/products — 50 gold products, 50 matched, 50 enriched, 0 missing.
Status breakdown: {"ready":40,"quarantined":10}

| attribute | precision | recall | F1 | TP | FP | FN | support | scored |
|---|---|---|---|---|---|---|---|---|
| category |  94.0% |  94.0% |  94.0% | 47 | 3 | 3 | 50 | 50 |
| gender | 100.0% | 100.0% | 100.0% | 50 | 0 | 0 | 50 | 50 |
| colors |  98.1% | 100.0% |  99.0% | 52 | 1 | 0 | 52 | 45 |
| pattern | 100.0% | 100.0% | 100.0% | 4 | 0 | 0 | 4 | 4 |
| is_apparel_product |  98.0% |  98.0% |  98.0% | 49 | 1 | 1 | 50 | 50 |
| **overall (micro)** |  97.6% |  98.1% |  97.8% | | | | | |
| **macro F1** | | |  98.2% | | | | | |

## Disagreements (4 products)

- **15970** (ready) Turtle Check Men Navy Blue Shirt
  - colors: gold=[navy] pred=[navy,blue] extra=[blue]
- **34009** (quarantined) Gini and Jony Girls Black Top
  - category: gold=[tops] pred=[kids] missed=[tops] extra=[kids]
- **39524** (quarantined) Peter England Unisex Orange Sleeve Bag
  - category: gold=[other] pred=[bags] missed=[other] extra=[bags]
- **6842** (ready) Timberland Unisex Rubber Sole Brush Shoe Accessories
  - category: gold=[other] pred=[accessories] missed=[other] extra=[accessories]; is_apparel_product: gold=[false] pred=[true] missed=[false] extra=[true]

