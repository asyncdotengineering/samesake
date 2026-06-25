# @samesake/mcp

A stdio [MCP](https://modelcontextprotocol.io) server that turns any deployed **samesake** matcher
into agent tools — so Claude Desktop, Cursor, or any MCP client can search and shop your catalog.

It's a thin, version-decoupled HTTP client: it imports no samesake code and needs no DB access —
just a deployment URL and a project key. Point it at a matcher and go.

## Tools

| Tool | What it does |
|---|---|
| `samesake_search` | Hybrid (keyword + semantic) search with structured filters + facet counts; `mode:"similar"` for nearest-neighbour |
| `samesake_find_products` | Grounded, purchasable product candidates for a shopper intent (stops before checkout) |
| `samesake_find_similar` | Products similar to a reference `productId` or `imageUrl` |

All tools are read-only. `project` / `collection` default to env and can be overridden per call.

## Use it

```bash
SAMESAKE_URL=https://your-matcher.example.com \
SAMESAKE_API_KEY=sk_proj_… \
SAMESAKE_PROJECT=shop \
SAMESAKE_COLLECTION=products \
npx -y @samesake/mcp
```

In an MCP client config (e.g. Claude Desktop / Cursor):

```json
{
  "mcpServers": {
    "samesake": {
      "command": "npx",
      "args": ["-y", "@samesake/mcp"],
      "env": {
        "SAMESAKE_URL": "https://your-matcher.example.com",
        "SAMESAKE_API_KEY": "sk_proj_…",
        "SAMESAKE_PROJECT": "shop",
        "SAMESAKE_COLLECTION": "products"
      }
    }
  }
}
```

## Environment

| Var | Required | Meaning |
|---|---|---|
| `SAMESAKE_URL` | yes | Base URL of the deployed matcher (the Hono `/v1` API) |
| `SAMESAKE_API_KEY` | yes | A **project** key for the target project (Bearer auth) |
| `SAMESAKE_PROJECT` | no | Default project slug (else pass `project` per call) |
| `SAMESAKE_COLLECTION` | no | Default collection (else pass `collection` per call) |

Built on the official `@modelcontextprotocol/sdk`. Wraps samesake's public `/v1` endpoints
(`/search`, `/agent/find-products`, `/agent/find-similar-products`).
