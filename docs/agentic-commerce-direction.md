# Agentic Commerce Retrieval Direction

Verified on 2026-06-14 against public YC company pages.

Samesake can be used by AI agents as the retrieval layer for agentic commerce.

But the framing is precise:

> Samesake is not the shopping agent. It is the product-understanding and retrieval engine that shopping agents call when they need grounded, purchasable, explainable product candidates.

An agentic commerce stack roughly needs:

```txt
User intent
  -> agent planner
  -> product retrieval tool
  -> comparison / reasoning
  -> cart / checkout / payment guardrails
  -> post-purchase support
```

Samesake owns this layer:

```txt
product retrieval tool
catalog understanding
image + text + constraints search
merchant ranking policy
explanations
availability / price / variant correctness
```

The tool surface for agents should look more like this than a generic search endpoint:

```ts
findProducts({
  intent: "wedding guest dress, modest, summer, under $150",
  image: { kind: "url", url: inspirationImage },
  constraints: {
    size: "M",
    inStock: true,
    maxPrice: 150,
  },
  shopperContext: {
    preferredBrands: ["Reformation", "Abercrombie"],
    avoid: ["bodycon", "polyester"],
  },
  explain: true,
});
```

And the response returns grounded product candidates, not prose:

```ts
{
  products: [
    {
      id: "sku_123",
      title: "...",
      url: "...",
      price: { amount: 128, currency: "USD" },
      availability: { inStock: true, freshness: "fresh" },
      verification: {
        status: "satisfied",
        satisfied: ["maxPrice", "inStock", "size"],
        violated: [],
        unknown: []
      },
      grounding: {
        project: "shop",
        collection: "products",
        productId: "sku_123",
        indexedAt: "..."
      },
      why: {
        retrieval: {
          space_cosines: { visual: 0.92 }
        }
      }
    }
  ]
}
```

That is agent-useful. Agents need tools that are deterministic, inspectable, and grounded.

## Product Boundary

Samesake is retrieval and product-understanding infrastructure.

It is not:

- A hosted shopping agent.
- A storefront UI.
- A cart or checkout system.
- A payment credential layer.
- Browser automation for autonomous purchasing.

Downstream systems can use Samesake candidates as handoff payloads, but purchase execution stays outside Samesake.

## YC Landscape

| Company | Category | Relationship to Samesake |
| --- | --- | --- |
| [Channel3](https://www.ycombinator.com/companies/channel3) | Internet-scale product graph | Adjacent/direct in agentic product data. Samesake is brand-owned retrieval/ranking rather than a universal product graph. |
| [Kinect](https://www.ycombinator.com/companies/kinect) | Merchant layer / AI storefront agent | Complementary. Kinect-like agents need grounded retrieval tools. |
| [Wildcard](https://www.ycombinator.com/companies/wildcard) | AI shopping visibility / AEO/GEO | Adjacent. Visibility layer, not the merchant-owned retrieval engine. |
| [Anglera](https://www.ycombinator.com/companies/anglera) | Catalog enrichment | Adjacent. Overlaps with enrichment, but Samesake couples enrichment to retrieval, constraints, ranking, and explanations. |
| [Allowance](https://www.ycombinator.com/companies/allowance) | Agent spend control / payment guardrails | Downstream complement after retrieval. |
| [Zinc](https://www.ycombinator.com/companies/zinc) | Programmable purchasing API | Downstream complement after retrieval. |
| [BIK](https://www.ycombinator.com/companies/bik) | Ecommerce CRM/commerce agents | Complementary agent layer that could call retrieval tools. |
| [Yuma AI](https://www.ycombinator.com/companies/yuma-ai) | Ecommerce support agents | Adjacent support layer; support agents need catalog retrieval. |
| [14.ai](https://www.ycombinator.com/companies/14-ai) | Autonomous brand operations | Adjacent operating layer; retrieval remains a lower-level tool. |

The gap:

> The retrieval and product-understanding layer for agentic commerce, starting with fashion.

Compared with the landscape:

- Channel3: internet-scale product graph.
- Kinect: AI storefront / merchant agent.
- Wildcard: AI shopping visibility / AEO/GEO.
- Anglera: product data enrichment.
- Allowance/Zinc: buying/payment/purchasing.
- Samesake: brand-owned multimodal retrieval, ranking, verification, and explanation engine for commerce agents.

The sharp wedge:

> When an AI shopping agent asks, "find me this look, but cheaper, in my size, in stock, from this brand," Samesake is the tool that returns the right products with proof.

## Implementation Links

- Agent tool API: `matcher.findProducts`, `matcher.findSimilarProducts`, and `POST /v1/projects/:project/collections/:collection/agent/find-products`.
- Grounded candidates: product ID, URL, price, availability freshness, source timestamps, and grounding metadata.
- Constraint verification: `best_effort` and `strict` modes.
- Tool schema export: `GET /v1/agent-tools/openapi.json` and `GET /v1/agent-tools/tools.json`.
- Demo/eval: [Agentic Commerce Retrieval Demo](./demo-agentic-commerce-retrieval.md).

## Drift Note

Re-verify YC company descriptions and categories before using this landscape in external fundraising or customer material.
