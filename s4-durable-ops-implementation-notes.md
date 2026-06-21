# S4 durable ops — implementation notes

## Defaults
- `MAX_ATTEMPTS` / `DEFAULT_MAX_ATTEMPTS`: **5**
- `maxErrorRate` / `DEFAULT_MAX_ERROR_RATE`: **0.5**
- `minSamples` / `DEFAULT_MIN_SAMPLES`: **10**

## Chunk A — backoff clamp
Extracted `recordPipelineFailure` to `pipeline-failure.ts` with `power(2, LEAST(attempt_count, 12))` before the seconds cap. `enrich-pipeline.ts` delegates to it.

## Chunk B — retryFailed
`retry.ts`: marks `attempt_count >= maxAttempts` rows `dead`, then retries eligible `failed` rows past `next_attempt_at`. Enrich path when `enriched_at IS NULL`; otherwise `indexOne`. Wired as `matcher.retryFailed`.

## Chunk C — error-rate circuit breaker
`assertErrorRateWithinLimit` in `pipeline-failure.ts`; called from `runEnrichCollection` (failed enrich attempts) and `runIndexCollection` (image pipeline failures). Throws with rate + counts after `minSamples`.

## Chunk D — image failures + M6
Image fetch/embed failures throw `ImagePipelineError` → `recordPipelineFailure`, row skipped (no `indexed_at`). `markIndexSkipped` nulls `space_vec` only when collection has spaces (avoids UPDATE on missing column).

## Deviation
Updated `spaces-image.test.ts` — prior zero-vector-on-failure assertion replaced (M5 supersedes).

## Verification
- `bun test packages/server/test`: **206 pass, 0 fail**
- `bunx tsc --noEmit` in `packages/server`: clean
- `grep power(2, LEAST(attempt_count` in `pipeline-failure.ts`: present
