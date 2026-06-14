import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface FetchedImage {
  mimeType: string;
  bytes: Uint8Array;
}

export interface FetchImageOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  allowedContentTypes?: string[];
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

export type FetchImageFailureReason =
  | "invalid_url"
  | "blocked_destination"
  | "unsupported_content_type"
  | "too_large"
  | "timeout"
  | "network_error";

export type FetchImageResult =
  | { ok: true; bytes: Uint8Array; contentType: string; finalUrl: string }
  | { ok: false; reason: FetchImageFailureReason; finalUrl?: string; message?: string };

const DEFAULT_MAX_BYTES = 6_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function ipv4InCidr(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function isBlockedIpv4(ip: string): boolean {
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ].some(([base, bits]) => ipv4InCidr(ip, base as string, bits as number));
}

function isBlockedIpv6(ip: string): boolean {
  const normal = ip.toLowerCase();
  if (normal === "::" || normal === "::1") return true;
  if (normal.startsWith("fc") || normal.startsWith("fd")) return true;
  if (normal.startsWith("fe8") || normal.startsWith("fe9") || normal.startsWith("fea") || normal.startsWith("feb")) return true;
  if (normal.startsWith("ff")) return true;
  if (normal.startsWith("::ffff:")) {
    const mapped = normal.slice("::ffff:".length);
    if (isIP(mapped) === 4) return isBlockedIpv4(mapped);
  }
  return false;
}

function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true;
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function validateDestination(
  url: URL,
  resolveHostname: (hostname: string) => Promise<string[]>
): Promise<FetchImageResult | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "invalid_url", finalUrl: url.href };
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "blocked_destination", finalUrl: url.href };
  }
  let addresses: string[];
  try {
    addresses = isIP(hostname) ? [hostname] : await resolveHostname(hostname);
  } catch (e) {
    return {
      ok: false,
      reason: "network_error",
      finalUrl: url.href,
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!addresses.length || addresses.some(isBlockedIp)) {
    return { ok: false, reason: "blocked_destination", finalUrl: url.href };
  }
  return null;
}

async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array | "too_large"> {
  const length = res.headers.get("content-length");
  if (length && Number(length) > maxBytes) return "too_large";
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > maxBytes ? "too_large" : bytes;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function fetchRemoteImageSafe(
  rawUrl: string,
  options: FetchImageOptions = {}
): Promise<FetchImageResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowedContentTypes = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
  const resolveHostname = options.resolveHostname ?? defaultResolveHostname;

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const blocked = await validateDestination(current, resolveHostname);
    if (blocked) return blocked;

    let res: Response;
    try {
      res = await fetch(current.href, {
        headers: { "User-Agent": "Mozilla/5.0" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      return {
        ok: false,
        reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error",
        finalUrl: current.href,
        message: e instanceof Error ? e.message : String(e),
      };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location || redirects === maxRedirects) {
        return { ok: false, reason: "network_error", finalUrl: current.href };
      }
      current = new URL(location, current);
      continue;
    }

    if (!res.ok) return { ok: false, reason: "network_error", finalUrl: current.href };

    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!allowedContentTypes.includes(contentType)) {
      return { ok: false, reason: "unsupported_content_type", finalUrl: current.href };
    }

    const bytes = await readBounded(res, maxBytes);
    if (bytes === "too_large") return { ok: false, reason: "too_large", finalUrl: current.href };
    return { ok: true, bytes, contentType, finalUrl: current.href };
  }

  return { ok: false, reason: "network_error", finalUrl: current.href };
}

export async function fetchImageBytes(url: string): Promise<FetchedImage | null> {
  const result = await fetchRemoteImageSafe(url);
  if (!result.ok) return null;
  return { mimeType: result.contentType, bytes: result.bytes };
}
