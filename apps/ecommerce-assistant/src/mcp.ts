#!/usr/bin/env bun
import { MCPServer } from "@mastra/mcp";
import { tools } from "./tools.ts";
import { ecommerceAgent } from "./agent.ts";

// Expose the catalog over the Model Context Protocol. Any MCP client (Claude Desktop,
// Cursor, another Mastra app) gets the three catalog tools plus the assistant itself —
// registering the agent surfaces it as an `ask_ECommerceAssistant` tool.
export const mcpServer = new MCPServer({
  id: "samesake-ecommerce",
  name: "Samesake E-commerce Assistant",
  version: "1.0.0",
  description: "Search and aggregate a clothing catalog and brand directory backed by samesake.",
  instructions:
    "Use search_products to find clothing items (max_price caps the budget in USD), search_brands " +
    "for brand hierarchy/rating/country, and aggregate_products for counts and average prices.",
  tools,
  agents: { ecommerceAgent },
});

// Run directly (`bun src/mcp.ts`) to serve over stdio.
if (import.meta.main) {
  await mcpServer.startStdio();
}
