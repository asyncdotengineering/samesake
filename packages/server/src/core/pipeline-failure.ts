import type { MatcherCtx } from "../types.ts";
import { getPgClient } from "./db-utils.ts";

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_MAX_ERROR_RATE = 0.5;
export const DEFAULT_MIN_SAMPLES = 10;

export interface ErrorRateOpts {
  maxErrorRate?: number;
  minSamples?: number;
}

export function assertErrorRateWithinLimit(
  processed: number,
  failed: number,
  opts?: ErrorRateOpts
): void {
  const maxErrorRate = opts?.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE;
  const minSamples = opts?.minSamples ?? DEFAULT_MIN_SAMPLES;
  if (processed < minSamples) return;
  const rate = failed / processed;
  if (rate > maxErrorRate) {
    throw new Error(
      `Pipeline run aborted: failure rate ${(rate * 100).toFixed(1)}% (${failed}/${processed}) ` +
        `exceeds threshold ${(maxErrorRate * 100).toFixed(0)}%`
    );
  }
}

export async function recordPipelineFailure(
  ctx: MatcherCtx,
  table: string,
  rowId: string,
  error: unknown
): Promise<void> {
  const msg = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await ctx.storage.client("pipeline-failure").unsafe(
    `UPDATE ${table}
     SET attempt_count = attempt_count + 1,
         last_error = $1,
         pipeline_status = 'failed',
         next_attempt_at = now() + make_interval(secs => LEAST(3600, power(2, LEAST(attempt_count, 12))::int)),
         updated_at = now()
     WHERE id = $2`,
    [msg, rowId]
  );
}
