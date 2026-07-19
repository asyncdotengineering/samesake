# @samesake/providers

## 5.0.0

### Patch Changes

- Updated dependencies [717cbee]
- Updated dependencies [c5d2c85]
  - @samesake/server@5.0.0

## 4.0.0

### Minor Changes

- 396c9a5: New package: ready-made model-provider adapters for samesake's BYO `embed`/`generate`/`parse`/
  `rerank` seams. Zero-dependency fetch adapters for Gemini (multimodal), OpenAI, Voyage, and
  Cohere with built-in 429/5xx retry and optional call spacing — plus a Vercel AI SDK bridge
  (`@samesake/providers/ai-sdk`, optional `ai` peer) that wraps any AI SDK model object, including
  v6 reranking models. The hand-rolled provider glue in apps/matcher, apps/playground, and
  apps/ecommerce-assistant is deleted in favor of these adapters.

### Patch Changes

- Updated dependencies [396c9a5]
- Updated dependencies [396c9a5]
- Updated dependencies [396c9a5]
- Updated dependencies [396c9a5]
  - @samesake/server@4.0.0
