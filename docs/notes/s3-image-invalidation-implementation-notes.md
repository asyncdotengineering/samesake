# S3 image invalidation — implementation notes

## Commits
- `68ed1d2` — C8: `content_hash` folds `image_etag` / `image_updated_at` / `image_version` via `imageVersionToken()`.
- (C9) — `revalidateImages`, `probeRemoteImageSafe`, stage-cache key includes per-row validator.

## Byte-hash vs pHash (REQ-3c)
RFC Q2 mentions pHash; task brief forbids new dependencies. Chose **sha256 over raw bytes** (`sha256:<hex>` stored in `image_etag`) when HEAD returns no ETag/Last-Modified. Detects any byte change with zero deps; near-duplicate tolerance is out of scope for invalidation correctness.

## Root cause fixed in probe path
`requestImage` treated HTTP 304 as a redirect (300–399), causing `network_error` on unchanged conditional probes. 304 is now passed through before redirect handling.

## Stage cache (M1 / REQ-3b)
`stageCacheKey` material is `url@validator` per image URL, threading `image_etag` from the row (or data-level tokens) through `enrichOne` → `runStage`.

## Revalidate behavior
- Conditional HEAD with `If-None-Match` when prior validator is not `sha256:`.
- On change: `indexed_at = NULL`; `enriched_at = NULL` only when enrich stages declare `images`.
- Always records `image_etag` + `image_checked_at`.
- Idempotent/resumable via `opts.limit` ordered scan.
