# samesake

Alias package for [`@samesake/cli`](https://www.npmjs.com/package/@samesake/cli) so the short form
just works:

```bash
bunx samesake init my-shop && cd my-shop
bun run db:up && bun install && bun run seed
bun run search "red running shoes"
```

Samesake is the enrichment + fast-search toolkit you can replace your ecommerce search with:
declare your catalog in TypeScript, bring your own models, run it on the Postgres you already
have. Docs and source: [github.com/asyncdotengineering/samesake](https://github.com/asyncdotengineering/samesake).

> Note: versions ≤ 0.2.0 of this name were an early entity-resolution DSL, superseded by
> [`@samesake/core`](https://www.npmjs.com/package/@samesake/core).
