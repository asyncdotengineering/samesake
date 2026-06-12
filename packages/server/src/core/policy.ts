import type { MatcherCtx } from "../types.ts";

export interface PolicySlot {
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

export interface PolicyConfig {
  llm?: PolicySlot;
  embed?: PolicySlot;
  connector?: PolicySlot;
}

export const DEFAULT_LLM_RETRIES = 6;
export const DEFAULT_LLM_BACKOFF_MS = 4000;
export const DEFAULT_NLQ_TIMEOUT_MS = 5000;
export const DEFAULT_CONNECTOR_TIMEOUT_MS = 60_000;

export function resolvePolicy(config?: PolicyConfig): Required<PolicyConfig> {
  return {
    llm: {
      retries: config?.llm?.retries ?? DEFAULT_LLM_RETRIES,
      backoffMs: config?.llm?.backoffMs ?? DEFAULT_LLM_BACKOFF_MS,
      timeoutMs: config?.llm?.timeoutMs ?? DEFAULT_NLQ_TIMEOUT_MS,
    },
    embed: {
      retries: config?.embed?.retries ?? 1,
      backoffMs: config?.embed?.backoffMs ?? DEFAULT_LLM_BACKOFF_MS,
      timeoutMs: config?.embed?.timeoutMs,
    },
    connector: {
      retries: config?.connector?.retries ?? 1,
      backoffMs: config?.connector?.backoffMs ?? DEFAULT_LLM_BACKOFF_MS,
      timeoutMs: config?.connector?.timeoutMs ?? DEFAULT_CONNECTOR_TIMEOUT_MS,
    },
  };
}

export async function callWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number | undefined,
  label = "operation"
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return fn();
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)
    ),
  ]);
}

export async function callWithRetry<T>(
  fn: () => Promise<T>,
  slot: PolicySlot,
  isRateLimit?: (e: unknown) => boolean
): Promise<T> {
  const maxAttempts = slot.retries ?? DEFAULT_LLM_RETRIES;
  const baseBackoff = slot.backoffMs ?? DEFAULT_LLM_BACKOFF_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await callWithTimeout(fn, slot.timeoutMs, "llm");
    } catch (e) {
      lastErr = e;
      const rateLimited = isRateLimit?.(e) ?? (e as { status?: number }).status === 429;
      const delay = rateLimited ? 20_000 * (attempt + 1) : baseBackoff * (attempt + 1);
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

export function ctxPolicy(ctx: MatcherCtx): Required<PolicyConfig> {
  return ctx.policy;
}
