# Releasing

Versioning is driven by [Changesets](https://github.com/changesets/changesets); publishing is done
with **`bun publish`** (not `changeset publish`). We release **locally** — the CI workflow is
optional (see the appendix).

## Why `bun publish`, not `changeset publish`

Inter-package deps use the `workspace:` protocol — e.g. `@samesake/server` depends on
`@samesake/core: "workspace:^"`. In dev that always resolves to the local package (no version-range
guessing). At publish time it must be rewritten to a real range, or consumers get a broken install.

- `changeset publish` shells out to **npm**, which leaves `workspace:^` untouched → broken package.
- **`bun publish` rewrites it**: `workspace:^` → `^<version>`, `workspace:*` → `<version>`.

Verified: `cd packages/server && bun pm pack` emits `"@samesake/core": "^2.5.0"` in the tarball.

---

## One-time setup

You need npm publish rights on the `@samesake` scope:

```bash
npm login          # or put a token in ~/.npmrc
npm whoami         # confirm you're logged in as a publisher
```

## Every change: add a changeset

With any user-facing change to a published package, add a changeset **in the same PR**:

```bash
bun run changeset            # pick packages, bump type (patch/minor/major), write the summary
git add .changeset && git commit -m "…"
```

Check what's pending at any time:

```bash
bun run changeset status     # lists packages that would bump + at what level
```

Private packages (`apps/*`, `examples/*`) are excluded — they never version or publish.

## Cutting a release (local)

Two steps, with a review in between:

```bash
# 1) bump versions + write per-package CHANGELOGs + consume the changesets
bun run release:version
git diff                                  # review the version bumps + CHANGELOG entries
git commit -am "chore: version packages"

# 2) build, publish, tag
bun run release:publish
git push --follow-tags
```

### What `release:publish` does

1. Builds `sdk`, `server`, `cli`, `mcp`.
2. Runs `bun publish` in each `packages/*` — `|| true` means **already-published versions are
   skipped**, so only the bumped packages actually go out.
3. `bun publish` rewrites `workspace:` deps to real ranges (above).
4. `changeset tag` creates the git tags for the released versions.

## Verify

```bash
npm view @samesake/server version         # etc.
```

A brand-new package name can take a minute to appear in `npm view` (registry read-API lag) even
though the publish succeeded — `npm publish` printing `+ @samesake/x@1.2.3` is the source of truth.

## Sanity-check before publishing (optional)

```bash
cd packages/server && bun pm pack         # inspect the tarball
tar -xzOf samesake-server-*.tgz package/package.json | grep '@samesake'   # deps should be ^x, not workspace:
rm samesake-server-*.tgz
```

---

## Appendix: CI automation (optional)

`.github/workflows/release.yml` can run the same flow on push to `main`. It is **off by default in
practice** because we release locally. To use it you must:

1. **Settings → Actions → General → Workflow permissions** → enable *"Allow GitHub Actions to create
   and approve pull requests"* (the action opens a "Version Packages" PR).
2. **Settings → Secrets and variables → Actions** → add `NPM_TOKEN`.

Then: push to `main` with pending changesets → the action opens a "Version Packages" PR → merging it
runs `release:publish`. Until both are set, the `release` workflow run will fail at the PR-creation
step — that's expected, not a regression.

## Note on CHANGELOG

Changesets writes a **per-package** `CHANGELOG.md`. The root `CHANGELOG.md` is the historical record
through 2.5.0 (the last hand-maintained release).
