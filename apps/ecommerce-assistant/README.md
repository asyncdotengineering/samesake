# E-commerce Assistant (samesake + Mastra + MCP)

A recreation of Weaviate's [Query Agent E-commerce Assistant recipe](https://github.com/weaviate/docs/blob/main/docs/query-agent/recipes/query-agent-ecommerce-assistant.md),
built with this repo's **samesake** search engine for retrieval, **[Mastra](https://mastra.ai)** for
the agent, and an **MCP** server so any MCP client can use the catalog.

It loads the same demo data (the public `weaviate/agents` datasets on Hugging Face) and answers the
same questions — vintage items under a budget, budget-carrying follow-ups, "which brand lists the most
shoes", and a multi-collection brand profile.

## How it maps to the Weaviate recipe

| Weaviate recipe | This app |
| --- | --- |
| `ECommerce` + `Brands` collections | two `@samesake/core` `collection()`s — see `src/samesake.ts` |
| `text2vec_weaviate` vectors | `gemini-embedding-2` doc embeddings + Postgres FTS, combined with RRF |
| `QueryAgent` (auto-routes search / filter / aggregate) | a Mastra `Agent` (`gpt-4.1-mini`) with tools — `src/agent.ts` |
| semantic / filtered search | `search_products`, `search_brands` (hybrid; NLQ parses "under $200" with `gemini-3.1-flash-lite`) |
| GROUP BY / COUNT / AVG | `count_products_by_brand` + `average_price` (direct SQL over the compiled collection table) — `src/tools.ts` |
| `ECommerceAssistant` history class | `ECommerceAssistant` wrapper over `agent.generate(history)` |
| _(added requirement)_ | `@mastra/mcp` `MCPServer` exposing the tools + agent over stdio — `src/mcp.ts` |

## Models

- **Embeddings:** `gemini-embedding-2`
- **NLQ (budget parsing):** `gemini-3.1-flash-lite`
- **Agent:** OpenAI `gpt-4.1-mini`

## Setup

Requires Postgres with the `pgvector` extension (Neon, Supabase, or local). Copy `.env.example` to the
repo root `.env` and fill in `SAMESAKE_DATABASE_URL`, `GEMINI_API_KEY`, and `OPENAI_API_KEY`.

```bash
bun install
# pick ONE seed:
bun run --cwd apps/ecommerce-assistant seed:sql  # reproducible — loads data/seed.sql.gz (452 products + 103 brands, pre-embedded). No Hugging Face download, no Gemini calls. Needs `psql`.
bun run --cwd apps/ecommerce-assistant seed      # from scratch — fetch the weaviate/agents datasets from Hugging Face + embed every row with gemini-embedding-2

bun run --cwd apps/ecommerce-assistant demo      # run the recipe conversation through the agent
```

`seed:sql` is the fast/cheap path: the catalog (with its `gemini-embedding-2` vectors and indexed
state) is committed as a `pg_dump` (`data/seed.sql.gz`), so a fresh clone gets a working,
pre-indexed assistant in seconds. Query embeddings are still computed live at search time.

## MCP

```bash
bun run --cwd apps/ecommerce-assistant mcp     # serve the catalog tools + agent over stdio
```

Register it with an MCP client (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "samesake-ecommerce": {
      "command": "bun",
      "args": ["run", "--cwd", "/absolute/path/to/apps/ecommerce-assistant", "mcp"]
    }
  }
}
```

Exposed MCP tools (namespaced `samesake_*`): `searchProducts`, `searchBrands`, `countProductsByBrand`,
`averagePrice`, and `ask_ecommerceAgent` (the agent itself).
