# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately via GitHub's **Report a vulnerability** flow on
[asyncdotengineering/samesake](https://github.com/asyncdotengineering/samesake/security/advisories/new).
Do **not** open a public issue for security reports.

You can expect an acknowledgement within 5 business days. Samesake is an alpha open-source
project — there is no bug bounty, but reports are triaged seriously and fixes ship in the next
release.

## Supported versions

Only the latest published 3.x release line receives security fixes. Alpha versioning means no
backports.

## Deployment hardening

Samesake runs inside your own app with your own Postgres — most of the attack surface is yours to
configure. The essentials:

- **Auth**: every HTTP route requires a Bearer key (`SAMESAKE_API_KEY` master key or a per-project
  key). Never expose the matcher HTTP surface without it.
- **Database**: use a dedicated database/role; the runtime executes DDL per project, so scope the
  role to its own database, not a shared cluster-admin login.
- **BYO model keys**: the framework never holds LLM API keys — your `embed`/`generate` closures
  do. Keep provider keys (`GEMINI_API_KEY`, `OPENAI_API_KEY`, …) out of the framework config.
- **Image fetching**: enrichment fetches product images through an SSRF-guarded fetcher
  (`packages/server/src/core/fetch-image.ts`); still, only feed it catalog data you trust.

See [`docs/production.md`](./docs/production.md) for the full production guide.
