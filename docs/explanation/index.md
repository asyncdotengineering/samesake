---
title: Explanation
description: Understanding-oriented documentation for samesake — the why behind how the matcher works, not the how-to of using it.
---

# Explanation

This section is the part of the documentation you read away from your editor. Not "how do I do X" (that's in [usage-patterns.md](../usage-patterns.md) and [tutorial.md](../tutorial.md)), and not "what does parameter Y do" (that's the inline docstrings on `MatcherConfig`, `EntityDef`, the `Scorers.*` factories). Explanation is for reasoning about samesake's design — what each piece is *for*, what trade-offs were made, what could have been done differently.

When you find yourself asking "wait, but *why* does it work that way?" — start here.

## Pages

| Page | What it explains |
|---|---|
| [Samesake positioning](../positioning.md) | The visual-commerce/fashion-search category, what the project is not, and the proof standard public docs should use. |
| [Fashion Search Proof](../fashion-search-proof.md) | The measured parity result, corpus, eval method, limitations, and rerun path. |
| [Agentic commerce retrieval direction](../agentic-commerce-direction.md) | The agent-facing retrieval boundary, YC landscape, tool shape, and out-of-scope checkout/payment line. |
| [Search Expert lessons](../research/search-expert-lessons.md) | Prior-art notes on constraint parsing, hybrid retrieval, and top-k constraint-satisfaction evals. |
| [How the matcher scores candidates](./matcher-channels.md) | The five (or seven, for parse-shape) signal channels and how they combine. Why noisy-OR? Why does cosine dominate name-only matching? Why is a brand mismatch fatal in one entity but a soft demotion in another? |
| [Tuning channel weights per entity](./tuning-channel-weights.md) | The reasoning behind per-entity weight declarations. Why the library has defaults at all. When to lean on cosine, when to lean on structured fields, when to give up on a channel entirely. The trade-off space between recall and precision, and which channels move you in which direction. |

## How explanation fits with the rest of the docs

samesake's docs follow the [Diataxis](https://diataxis.fr) shape on purpose:

- **[Tutorial](../tutorial.md)** — "build a bookshop customer matcher in 10 minutes." Linear, hands-on, one path, every command verified.
- **[How-to guides](../how-to/)** — operational playbooks for specific problems. Most teams' entry point is [Onboarding samesake into an existing system](../how-to/onboarding-existing-system.md).
- **[Usage patterns](../usage-patterns.md)** — eleven runnable blueprints for the many ways to mount the matcher. Goal-oriented; you arrive knowing what shape you want.
- **[Recipes](../recipes/)** — copy-paste embedders / parsers per AI provider.
- **Explanation (you are here)** — *why* the matcher scores the way it does, what design choices got made, what's load-bearing about each part.
- **Reference** — the in-code docstrings on `createMatcher`, `Matcher`, `EntityDef`, `Scorers.*`. samesake doesn't ship a generated API-reference site because the TypeScript types ARE the reference, and they live next to the code they describe.

Explanation is the only one of these you can read in the bath. The others want you at a keyboard.
