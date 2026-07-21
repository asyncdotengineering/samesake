# @samesake/embed

Dual-form, provider-neutral embedder wrapper for
[samesake](https://github.com/asyncdotengineering/samesake).

`createEmbedder` combines a consumer-supplied single-request closure and batch
closure into one callable `Embedder`. The result exposes `.many()` and an
immutable `.caps` descriptor, and validates every returned vector against the
request dimension.

## Install

```bash
bun add @samesake/embed
```

## Usage

```ts
import { createEmbedder } from "@samesake/embed";

const embed = createEmbedder({
  single: (request) => provider.embed(request),
  many: (requests) => provider.embedMany(requests),
  caps: { image: true, interleaved: true, dims: "any", maxBatch: 64 },
});

const vector = await embed({ text: "waterproof hiking boots", model: "your-model", dim: 1024 });
const vectors = await embed.many(rows);
```

The provider adapter owns transport, authentication, model defaults, and
retry policy. Bring any provider that satisfies the closures; the wrapper adds
no provider, domain, backend, or dimension default.

## Invariants

- `model` and `dim` remain caller-supplied on every request.
- `.many()` delegates to the supplied batch closure; it never turns a batch
  into a loop over the single closure.
- A vector with the wrong length throws a diagnostic dimension-mismatch error.
- A batch response with the wrong number of vectors throws.
- The package has no runtime dependencies beyond the type-only core contract.
