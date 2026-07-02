---
"@samesake/core": minor
"@samesake/server": minor
---

Tenancy for collections (P2-1). `CollectionDef.scopes` (e.g. `["tenant_id"]`) compiles each key
to an indexed `scope_<key>` column and makes the full scope MANDATORY on every surface: documents
carry `scope` on push (and per-connector via `ConnectorDef.scope`), and search / facets / explain /
getDocument / grepDocument / removeDocuments / evaluateSearch all require `scope` — there is no
cross-scope read. Ids stay unique per collection; an upsert that would overwrite an id owned by a
different scope is rejected (cross-tenant takeover guard), deletes only touch the caller's scope,
and the search cache keys on scope. HTTP: `scope` in POST bodies, `scope.<key>=` query params on
GET routes; CLI `remove`/`search-explain` accept `--scope k=v`. Adding or changing scopes on an
existing collection is a destructive migration. Scopes are hard isolation ("whose catalog is this
row") — a vendor facet inside one shared marketplace catalog remains a normal field.

Also: the score-drop cutoff's cliff baseline can now be SET (raised, never lowered) by
FTS-anchored hits, so a semantic junk tail behind keyword-matched results is cut correctly.
