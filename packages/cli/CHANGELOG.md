# @samesake/cli

## 2.0.1

### Patch Changes

- 87a8d9c: Use `workspace:^` for inter-package dependencies. In dev this always resolves to the local
  workspace package; at publish `bun publish` rewrites it to a real `^<version>` (verified via
  `bun pm pack`). Replaces the previous loose `^2.0.0` ranges that could silently resolve to a stale
  published version (the bug that left `apps/playground` pinned to `^1.3.0`).
- Updated dependencies [87a8d9c]
  - @samesake/server@2.4.1
