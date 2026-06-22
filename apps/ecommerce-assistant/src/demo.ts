#!/usr/bin/env bun
import { ECommerceAssistant } from "./agent.ts";
import { getMatcher } from "./samesake.ts";

// Drives the assistant through the same conversation the Weaviate recipe demonstrates:
// a vintage-under-$200 ask, a budget-carrying follow-up, an aggregation, a multi-collection
// brand question, then a short multi-turn chat that relies on history.
async function main() {
  const assistant = new ECommerceAssistant();

  const turns = [
    "I like the vintage clothes, can you list me some options that are less than $200?",
    "What about some nice shoes, same budget as before?",
    "What is the name of the brand that lists the most shoes?",
    "Does the brand 'Loom & Aura' have a parent brand or child brands and what countries do they operate from? " +
      "Also, what's the average price of a item from 'Loom & Aura'?",
    "Tell me more about the brand that makes the first pair you mentioned.",
  ];

  for (const turn of turns) {
    console.log(`\n[36m> ${turn}[0m`);
    const answer = await assistant.chat(turn);
    console.log(answer);
  }

  await getMatcher().close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
