# @samesake/embed

Dual-form, multimodal, provider-neutral embedder for
[samesake](https://github.com/asyncdotengineering/samesake).

One object that is simultaneously:

- **callable as a single-request `EmbedFn`** — `(req) => Promise<number[]>`,
  routed to the provider's single-content endpoint (the search hot path);
- **`.many(reqs)`** — batch embedding routed to the provider's batch endpoint,
  auto-chunked to `caps.maxBatch`, order-preserved (the ingest throughput path);
- **`.caps`** — an immutable capability descriptor
  `{ image, interleaved, dims, maxBatch }`.

Because the object is callable as an `EmbedFn`, the **same** handle drops into
`createSearch({ embed })` (which reaches for the single form) and
`createEnricher({ embed })` (which reaches for `.many`).

Plain `fetch`. **Zero runtime dependencies** (only `@samesake/core`, and only
for types). Edge / Workers-safe — no Node built-ins (base64 uses the platform
`btoa`, not `Buffer`).

## Install

```bash
bun add @samesake/embed
```

Set the provider key in the environment:

```bash
export GEMINI_API_KEY=...   # for gemini()
export VOYAGE_API_KEY=...   # for voyage()
```

## Usage

```ts
import { gemini, voyage } from "@samesake/embed";

// Tier 1 — single form (a one-off query embedding).
const embed = gemini();
const vec = await embed({
  text: "waterproof hiking boots",
  model: "gemini-embedding-2", // caller supplies model + dim — no consumer default
  dim: 768,
  taskType: "RETRIEVAL_QUERY",
});

// Tier 2 — multimodal single (image lands in the same space as text).
const imgVec = await embed({
  image: { url: "https://cdn.example.com/boot-42.jpg", mimeType: "image/jpeg" },
  model: "gemini-embedding-2",
  dim: 768,
  taskType: "RETRIEVAL_DOCUMENT",
});

// Tier 3 — batch form (ingest throughput; chunks to caps.maxBatch).
const vectors = await embed.many(
  docs.map((d) => ({
    text: d.body,
    model: "gemini-embedding-2",
    dim: 768,
    taskType: "RETRIEVAL_DOCUMENT",
  })),
);

// Tier 4 — capability-driven routing (fail fast, honestly).
if (embed.caps.image) {
  /* hand it an image */
} else {
  throw new Error("configured embedder cannot embed images");
}
```

### Provider neutrality

`voyage()` is the text-only contrast — it declares `caps.image === false` and
**throws** (never silently embeds empty text) when handed an image:

```ts
const textOnly = voyage();
textOnly.caps.image; // false
await textOnly({ image: { url: "..." }, model: "voyage-3.5", dim: 1024 });
// throws: image embeddings are not supported by this provider
```

## Invariants

- `dim` and `model` are always caller-supplied per request; no consumer number
  (e.g. `768`) appears as a default anywhere in this package.
- `many` routes to the provider **batch** endpoint — never a loop over the single
  endpoint — and preserves order: `result[i]` is the vector for `reqs[i]`.
- No auto-coalescing of concurrent single calls; batching happens only via
  `.many()` (the single form is the latency-sensitive search path).
- A returned vector whose length ≠ `req.dim` throws a diagnostic error — a
  dimension mismatch reaching the vector store is a corruption, not a warning.
- Zero runtime dependencies; edge/Workers-safe.
