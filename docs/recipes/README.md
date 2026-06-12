# Embedder + parser recipes

Copy-paste starters. @samesake/server has zero opinions about which LLM you use —
these are reference implementations of the `embed` and `parse` function contracts
for the common stacks.

In your project, drop one of these into `embedder.ts` (or `lib/embedder.ts`)
and import it into your `createMatcher({ ..., embed: ... })` call. None of
these are installed as packages — they're snippets to paste into your repo.

## Embedders (one per provider)

| File | Stack | Install |
|---|---|---|
| [`embedder-gemini.ts`](./embedder-gemini.ts) | Vercel AI SDK + Google Gemini | `bun add ai @ai-sdk/google` |
| [`embedder-openai.ts`](./embedder-openai.ts) | Vercel AI SDK + OpenAI | `bun add ai @ai-sdk/openai` |
| [`embedder-voyage.ts`](./embedder-voyage.ts) | Voyage AI (no SDK) | (raw fetch — nothing to install) |
| [`embedder-ollama.ts`](./embedder-ollama.ts) | Local Ollama (offline / air-gapped) | run `ollama` locally |
| [`embedder-mock.ts`](./embedder-mock.ts) | Deterministic stub for tests | (no deps) |

## Parsers (only needed for parse-shape entities — medications, products)

| File | Stack | Install |
|---|---|---|
| [`parser-gemini.ts`](./parser-gemini.ts) | Vercel AI SDK + Gemini structured-output | `bun add ai @ai-sdk/google` |
| [`parser-openai.ts`](./parser-openai.ts) | Vercel AI SDK + OpenAI structured-output | `bun add ai @ai-sdk/openai` |

## Picking a stack

- **Just starting?** Use `embedder-gemini.ts` + `parser-gemini.ts`. Gemini's embedding model is cheap and the structured-output mode is solid.
- **Already on OpenAI?** Use the OpenAI variants — same shape.
- **Multilingual / mixed-script (Sinhala/Tamil/Hindi)?** Voyage's `voyage-3-large` is strong here. Use `embedder-voyage.ts`.
- **Air-gapped or regulated data?** Use `embedder-ollama.ts` with `nomic-embed-text` or `mxbai-embed-large`. No data leaves your network.
- **Tests?** `embedder-mock.ts` — deterministic, no network, no keys.
- **Mixed?** Write a router (see [`scripts/blueprints/11-mixed-providers.ts`](../../scripts/blueprints/11-mixed-providers.ts)) — one closure dispatches to N providers based on model string, text length, or any signal you want.

## The contract you have to satisfy

```ts
import type { EmbedFn, ParseFn } from "@samesake/server";

// embed: text → vector
const embedFn: EmbedFn = async ({ text, model, dim, taskType, inputType }) => {
  // ...your impl...
  return vector; // number[] of length `dim`
};

// parse: text + schema + instructions → typed object
const parseFn: ParseFn = async ({ text, schema, instructions, model }) => {
  // ...your impl...
  return object; // matches `schema` (samesake's ParsedProductSchema)
};
```

Anything satisfying these signatures works. The matcher does NOT care what's inside.
