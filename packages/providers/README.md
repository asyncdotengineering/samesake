# @samesake/providers

Ready-made model-provider adapters for samesake's BYO seams. Every factory returns exactly the
closure `createMatcher()` accepts — BYO stays first-class, these just delete the boilerplate.

```ts
import { createMatcher } from "@samesake/server";
import { geminiEmbedder, geminiGenerator, cohereReranker } from "@samesake/providers";

const matcher = createMatcher({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
  apiKey: process.env.SAMESAKE_API_KEY!,
  embed: geminiEmbedder(),        // EmbedFn — multimodal (text + image)
  generate: geminiGenerator(),    // GenerateFn — NLQ + enrichment
  rerank: cohereReranker(),       // RerankFn — optional second stage
});
```

## Built-in adapters (zero dependencies, plain fetch)

| Provider | embed | generate | parse | rerank | key env var |
|---|---|---|---|---|---|
| Gemini | `geminiEmbedder` (multimodal) | `geminiGenerator` | `geminiParser` | — | `GEMINI_API_KEY` |
| OpenAI | `openaiEmbedder` | `openaiGenerator` | `openaiParser` | — | `OPENAI_API_KEY` |
| Voyage | `voyageEmbedder` | — | — | `voyageReranker` | `VOYAGE_API_KEY` |
| Cohere | `cohereEmbedder` | — | — | `cohereReranker` | `COHERE_API_KEY` |

All factories take the same options:

```ts
geminiEmbedder({
  apiKey: "...",        // default: the provider's env var
  model: "...",         // default model when the request carries none
  baseUrl: "...",       // proxies / regional endpoints
  minIntervalMs: 120,   // space out calls during bulk indexing
  retries: 8,           // 429/5xx retries with exponential backoff (default 5)
});
```

## Vercel AI SDK bridge (`@samesake/providers/ai-sdk`)

Already on the AI SDK? Wrap any of its model objects — the entire AI SDK provider ecosystem
plugs into samesake without glue. `ai` is an **optional** peer dependency, only needed for
this subpath.

```ts
import { google } from "@ai-sdk/google";
import { aiSdkEmbedder, aiSdkGenerator } from "@samesake/providers/ai-sdk";

createMatcher({
  embed: aiSdkEmbedder(google.textEmbedding("gemini-embedding-2"), {
    providerOptions: ({ dim, taskType }) => ({
      google: { outputDimensionality: dim, ...(taskType ? { taskType } : {}) },
    }),
  }),
  generate: aiSdkGenerator(google("gemini-2.5-flash-lite")),
});
```

Also available: `aiSdkParser(model)` and `aiSdkReranker(model)` (AI SDK v6 reranking models).
Note the AI SDK's `embed()` is text-only — for image spaces (visual similarity) use the native
multimodal `geminiEmbedder` or bring your own.
