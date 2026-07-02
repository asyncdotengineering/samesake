---
"@samesake/providers": minor
---

New package: ready-made model-provider adapters for samesake's BYO `embed`/`generate`/`parse`/
`rerank` seams. Zero-dependency fetch adapters for Gemini (multimodal), OpenAI, Voyage, and
Cohere with built-in 429/5xx retry and optional call spacing — plus a Vercel AI SDK bridge
(`@samesake/providers/ai-sdk`, optional `ai` peer) that wraps any AI SDK model object, including
v6 reranking models. The hand-rolled provider glue in apps/matcher, apps/playground, and
apps/ecommerce-assistant is deleted in favor of these adapters.
