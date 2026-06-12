export interface FetchedImage {
  mimeType: string;
  bytes: Uint8Array;
}

export async function fetchImageBytes(url: string): Promise<FetchedImage | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 6_000_000) return null;
    const mime =
      res.headers.get("content-type")?.split(";")[0] ||
      (url.includes(".png") ? "image/png" : "image/jpeg");
    if (!mime.startsWith("image/")) return null;
    return { mimeType: mime, bytes: new Uint8Array(buf) };
  } catch {
    return null;
  }
}
