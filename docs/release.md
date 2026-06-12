# Manual release checklist

GitHub Actions CI is **out of scope** (manual releases). Run this gate locally before every version bump and publish.

## Pre-release gate

From the repo root, with `.env` pointing at a Postgres instance for tests:

```bash
git status --short          # must be clean (no root debris, no stray scratchpads)
bun test                    # read N pass / N fail — do not pipe through tail
bun run typecheck
bun scripts/pack-assert.ts  # all 4 packages + LICENSE + npm install smoke
```

All four must pass. `bun test | tail` swallows exit codes — read the `N pass / N fail` line, not the pipe exit code.

### Rename grep (zero stale names)

```bash
# Stale-name scan (see WBS R-04 pattern); exclude CHANGELOG + README history notes
rg -n 'samesake|SAMESAKE|samesake —|bun cli/samesake' \
  --glob '!CHANGELOG.md' --glob '!README.md'
```

Only approved historical notes in CHANGELOG/README may remain.

### Root debris check

```bash
find . -maxdepth 1 \( -name '*implementation-notes.md' -o -name '*scratchpad.md' \) | wc -l
# expect 0
git ls-files .handoff
# expect empty (.handoff/ is gitignored; no tracked handoff artifacts)
```

### History / secret scan (human, before first public push)

R-11 history rewrite is a separate human gate. Before opening the repo, run your secret scanner and path scan across full git history; document results in the release notes.

### Example smoke (needs `DATABASE_URL` + built packages)

```bash
bun examples/hello-search/run.ts
bun examples/hello-spaces/run.ts
bun examples/quickstart/run.ts
bun examples/hello/run.ts        # needs Gemini API key
```

### Examples status

Confirm the README examples table matches reality — every listed example is runnable, external-data-only, or removed.

## Version bump

1. Decide the new semver across publishable packages:
   - `packages/sdk` (`@samesake/core`)
   - `packages/server` (`@samesake/server`)
   - `packages/cli` (`@samesake/cli`)
   - `packages/jobs-pgboss` (`@samesake/jobs-pgboss`, **experimental**)
2. Update `version` in each `package.json` and align `^x.y.z` dependency pins.
3. Update root and package `CHANGELOG.md` entries under the new version.

## Pack dry-run (human verification)

`pack-assert.ts` automates tarball shape, LICENSE presence, workspace-protocol leak detection, and npm consumer install smoke. Optional human spot-check:

```bash
cd packages/sdk && npm pack --dry-run
cd packages/server && npm pack --dry-run
cd packages/cli && npm pack --dry-run
cd packages/jobs-pgboss && npm pack --dry-run
```

Confirm: no `.map` files, no `src/` or `test/` in tarballs, `dist/` + types present.

## Publish (human step)

`npm publish` is **not** run by automation. After the gate:

```bash
cd packages/sdk && npm publish --dry-run
cd packages/sdk && npm publish

cd packages/server && npm publish --dry-run
cd packages/server && npm publish

cd packages/cli && npm publish --dry-run
cd packages/cli && npm publish

cd packages/jobs-pgboss && npm publish --dry-run
cd packages/jobs-pgboss && npm publish   # experimental adapter
```

Use `npm publish --access public` for scoped packages. Tag the git release to match the version.

## Post-publish

- Push commits and tags to `origin`.
- Verify `npm view samesake version` (and server/cli) match.
- For breaking releases, note migration paths in CHANGELOG.
