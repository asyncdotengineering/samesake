# Releasing

Versioning + publishing is driven by [Changesets](https://github.com/changesets/changesets),
adapted for **bun**. The one bun-specific gotcha (researched + verified):

> `changeset publish` does **not** resolve bun's `workspace:` protocol — it shells out to
> `npm publish`, and npm leaves `workspace:^` in the published `package.json` (a broken install).
> **`bun publish` does** resolve it: `workspace:^` → `^<version>` at pack time. So we version with
> Changesets but publish with `bun publish`.

Inter-package deps therefore use `workspace:^` (e.g. `@samesake/server` → `@samesake/core: "workspace:^"`).
In dev that always resolves to the local package (no version-range guessing — the bug that left
`apps/playground` pinned to a stale `^1.3.0`). At publish, `bun pm pack`/`bun publish` rewrite it to
the real `^<core-version>`. Verified: `bun pm pack` on `@samesake/server` emits `"@samesake/core": "^2.5.0"`.

## Day-to-day

Add a changeset with every user-facing change:

```bash
bun run changeset        # pick packages + bump type, write the changelog line
git add .changeset && git commit
```

## Cutting a release

Automated via `.github/workflows/release.yml` (needs an `NPM_TOKEN` repo secret):
on push to `main`, the changesets action opens a **"version packages"** PR; merging it publishes
everything ahead of npm.

To release manually:

```bash
bun run ci:version       # changeset version && bun update  → bumps + per-package CHANGELOGs + lockfile
git commit -am "chore: version packages"
bun run ci:publish       # build, `bun publish` each packages/* (skips already-published), then tag
git push --follow-tags
```

`ci:publish` loops `packages/*` and runs `bun publish || true`, so already-published versions are
skipped and only the bumped ones go out. Private packages (`apps/*`, `examples/*`) are never published.

## Note on CHANGELOG

Changesets writes a **per-package** `CHANGELOG.md` going forward. The root `CHANGELOG.md` is the
historical record through 2.5.0 (the last hand-maintained release).
