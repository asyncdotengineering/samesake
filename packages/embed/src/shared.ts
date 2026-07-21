// Provider-agnostic transport primitives: lazy API-key resolution, diagnostic
// error helpers, and edge-safe base64 for inline image bytes (btoa — no Node
// Buffer, so this boots unchanged on Workers-class runtimes).
//
// No retry / backoff / circuit-breaker is baked in: per the @samesake/embed
// contract §7, transport robustness beyond a single fetch is the consumer's
// concern. Keeping this layer thin is what keeps the runtime-dependency count
// at zero.

export function resolveKey(envVar: string, provider: string): string {
  const key = process.env[envVar];
  if (!key) {
    throw new Error(`[@samesake/embed] ${provider}: no API key — set ${envVar}`);
  }
  return key;
}

export async function fail(res: Response, label: string): Promise<never> {
  const body = await res.text();
  throw new Error(`[@samesake/embed] ${label} ${res.status}: ${body.slice(0, 200)}`);
}

/** A dimension mismatch reaching the vector store is a corruption, not a warning. */
export function assertDim(
  vec: number[],
  expected: number | undefined,
  provider: string,
): void {
  if (expected !== undefined && vec.length !== expected) {
    throw new Error(
      `[@samesake/embed] ${provider}: provider returned a ${vec.length}-dimensional vector, expected ${expected} — dimension mismatch (verify the model's output dimensionality matches req.dim)`,
    );
  }
}

export function imageNotSupported(provider: string): Error {
  return new Error(
    `[@samesake/embed] ${provider}: image embeddings are not supported by this provider — use a multimodal embedder (e.g. gemini)`,
  );
}

/** Edge-safe byte → base64 via the platform btoa global (no Node Buffer). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Resolve an EmbedImageInput to inline_data fields for providers that take base64. */
export async function imageToInlineData(image: {
  url?: string;
  bytes?: Uint8Array;
  mimeType?: string;
}): Promise<{ b64: string; mimeType: string }> {
  if (image.bytes) {
    return { b64: bytesToBase64(image.bytes), mimeType: image.mimeType ?? "image/jpeg" };
  }
  if (image.url) {
    const res = await fetch(image.url);
    if (!res.ok) {
      throw new Error(`[@samesake/embed] image fetch ${res.status} for embed`);
    }
    const mimeType = image.mimeType ?? res.headers.get("content-type") ?? "image/jpeg";
    const buf = new Uint8Array(await res.arrayBuffer());
    return { b64: bytesToBase64(buf), mimeType };
  }
  throw new Error("[@samesake/embed] image input has neither bytes nor url");
}
