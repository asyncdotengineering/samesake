import type { MatcherCtx } from "../types.ts";

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
  await ctx.storage.recordFailure(table, rowId, msg);
}
