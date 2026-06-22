import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";
import { tools } from "./tools.ts";

// The Mastra equivalent of the recipe's QueryAgent: one agent, the same system prompt, and
// tools that reach the catalog. The agent decides which collection / search type to use.
export const SYSTEM_PROMPT =
  "You are a friendly e-commerce shopping assistant. " +
  "Help the user find products from the catalog, compare options, and answer questions about brands. " +
  "Recommend specific items with their names, brands and prices, and explain why they match the user's request. " +
  "Use search_products to find items (pass max_price to respect a budget), search_brands for brand details, " +
  "and aggregate_products for counts or averages. Prices are in USD.";

export const ecommerceAgent = new Agent({
  id: "ecommerce-assistant",
  name: "ECommerceAssistant",
  description: "Shopping assistant over a clothing catalog and brand directory, backed by samesake search.",
  instructions: SYSTEM_PROMPT,
  model: openai("gpt-4.1-mini"),
  tools,
});

type ChatMessage = { role: "user" | "assistant"; content: string };

// Mirrors the recipe's ECommerceAssistant class: keep a running conversation so follow-ups
// like "same budget as before" resolve against earlier turns.
export class ECommerceAssistant {
  private history: ChatMessage[] = [];

  constructor(private agent: Agent = ecommerceAgent) {}

  async chat(userMessage: string): Promise<string> {
    this.history.push({ role: "user", content: userMessage });
    // history is structurally a Mastra message list ({ role, content }); bridge the type.
    const response = await this.agent.generate(this.history as Parameters<Agent["generate"]>[0]);
    this.history.push({ role: "assistant", content: response.text });
    return response.text;
  }

  reset() {
    this.history = [];
  }
}
