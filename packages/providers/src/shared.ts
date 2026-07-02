// Shared plumbing for every adapter: lazy API-key resolution, transient-error
// retry with exponential backoff, optional call spacing for bulk indexing,
// and base64 for inline images.

export interface ProviderOptions {
  /** Defaults to the provider's canonical env var (e.g. GEMINI_API_KEY). */
  apiKey?: string;
  /** Default model when the request doesn't carry one (collections usually do). */
  model?: string;
  /** Override the API host (proxies, regional endpoints, mocks). */
  baseUrl?: string;
  /**
   * Minimum spacing between calls in ms. Bulk indexing can trip per-minute
   * provider quotas; spacing smooths the burst, retry absorbs the rest.
   */
  minIntervalMs?: number;
  /** Retries on 429/500/503 (exponential backoff, 2s → 30s). Default 5. */
  retries?: number;
}

export function resolveKey(
  opts: ProviderOptions,
  envVar: string,
  provider: string
): string {
  const key = opts.apiKey ?? process.env[envVar];
  if (!key) {
    throw new Error(
      `[@samesake/providers] ${provider}: no API key — set ${envVar} or pass { apiKey }`
    );
  }
  return key;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 5
): Promise<Response> {
  let delay = 2000;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok || ![429, 500, 503].includes(res.status) || attempt > retries) return res;
    await sleep(delay);
    delay = Math.min(delay * 2, 30000);
  }
}

export async function fail(res: Response, label: string): Promise<never> {
  throw new Error(`[@samesake/providers] ${label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Serialize calls with a minimum gap. Returns a gate to await before each call. */
export function makeThrottle(minIntervalMs: number | undefined): () => Promise<void> {
  if (!minIntervalMs || minIntervalMs <= 0) return () => Promise.resolve();
  let gate: Promise<void> = Promise.resolve();
  return () => {
    const prev = gate;
    gate = prev.then(() => sleep(minIntervalMs));
    return prev;
  };
}

export function toBase64(data: Uint8Array | string): string {
  return typeof data === "string" ? data : Buffer.from(data).toString("base64");
}

/** Fetch remote image bytes → base64 (for providers that only take inline data). */
export async function imageToBase64(image: {
  url?: string;
  bytes?: Uint8Array;
  mimeType?: string;
}): Promise<{ b64: string; mimeType: string }> {
  if (image.bytes) return { b64: toBase64(image.bytes), mimeType: image.mimeType ?? "image/jpeg" };
  if (image.url) {
    const r = await fetch(image.url);
    if (!r.ok) throw new Error(`[@samesake/providers] image fetch ${r.status} for embed`);
    const mimeType = image.mimeType ?? r.headers.get("content-type") ?? "image/jpeg";
    return { b64: Buffer.from(await r.arrayBuffer()).toString("base64"), mimeType };
  }
  throw new Error("[@samesake/providers] image input has neither bytes nor url");
}
