---
title: How-to guides
description: Step-by-step playbooks for solving specific operational problems with samesake.
---

# How-to guides

This section is action-oriented. Each page solves one concrete problem with a specific sequence of steps. Unlike the [tutorial](../tutorial.md) (which teaches by building one thing end-to-end), how-to guides assume you know what you're trying to do and just need the steps.

| Guide | Problem it solves |
|---|---|
| [Build fashion search](./build-fashion-search.md) | You have a messy fashion catalog and want reverse image + intent + constraint search with current Samesake primitives. |
| [Onboarding samesake into an existing system](./onboarding-existing-system.md) | You have a production system with data already. You want to add samesake without disrupting users. Covers prepare → bootstrap → cut-over → ongoing sync. |

More how-tos as they're written:

- *Migrating from another matching system (Splink / dedupe / Algolia / Elasticsearch)* — TBD
- *Per-scope calibration after the first quarter of real use* — TBD
- *Operating samesake at scale (>10M rows, >100 req/s)* — TBD
- *Building a custom embedder for a regulated environment* — TBD (see [`recipes/embedder-ollama.ts`](../recipes/embedder-ollama.ts) for a starting point)

## Diataxis context

How-to guides sit between tutorials and reference in the [Diataxis](https://diataxis.fr/) shape:

- **[Tutorial](../tutorial.md)** — learning-oriented; one path; verifies skills
- **How-to guides (you are here)** — goal-oriented; one problem solved cleanly; assumes prior knowledge
- **[Reference](https://github.com/octalpixel/samesake/tree/main/packages)** — information-oriented; the TS types + docstrings in code
- **[Explanation](../explanation/)** — understanding-oriented; the *why* behind the design

If you're not sure where to start, the [Onboarding guide](./onboarding-existing-system.md) is the entry point most teams need first.
