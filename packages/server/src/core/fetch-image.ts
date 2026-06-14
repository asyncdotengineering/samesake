import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import http from "node:http";
import https from "node:https";

export interface FetchedImage {
  mimeType: string;
  bytes: Uint8Array;
}

export interface RawImageResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  cancel?: () => void;
}

export interface RawImageRequest {
  url: URL;
  /** The already-validated destination IPs; the connection MUST go to one of these. */
  pinnedIps: string[];
  timeoutMs: number;
  headers: Record<string, string>;
}

export type ImageTransport = (req: RawImageRequest) => Promise<RawImageResponse>;

export interface FetchImageOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  allowedContentTypes?: string[];
  resolveHostname?: (hostname: string) => Promise<string[]>;
  /** Override the HTTP transport (tests only). Defaults to an IP-pinned node:http/https client. */
  transport?: ImageTransport;
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
const DEFAULT_ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

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

/** Expand any IPv6 form (compressed, zero-padded, embedded IPv4) into 8 16-bit groups. */
function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]!; // strip any zone id
  // Fold a trailing dotted-quad (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) into two hex groups.
  const lastColon = s.lastIndexOf(":");
  const trailer = s.slice(lastColon + 1);
  if (trailer.includes(".")) {
    if (isIP(trailer) !== 4) return null;
    const n = ipv4ToInt(trailer);
    s = `${s.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    return head.map((g) => parseInt(g || "0", 16));
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...new Array(missing).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g || "0", 16));
}

function ipv4FromGroups(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isBlockedIpv6(ip: string): boolean {
  const g = expandIpv6(ip);
  if (!g) return true; // unparseable → fail closed
  // unspecified :: and loopback ::1
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0) {
    return g[7] === 0 || g[7] === 1;
  }
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast ff00::/8
  // IPv4-mapped ::ffff:0:0/96 → check the embedded IPv4
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isBlockedIpv4(ipv4FromGroups(g[6]!, g[7]!));
  }
  // NAT64 64:ff9b::/96 and 64:ff9b:1::/48 → embedded IPv4 in the low 32 bits
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    return isBlockedIpv4(ipv4FromGroups(g[6]!, g[7]!));
  }
  // 6to4 2002::/16 → embedded IPv4 in groups 1-2
  if (g[0] === 0x2002) {
    return isBlockedIpv4(ipv4FromGroups(g[1]!, g[2]!));
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

/** Resolve + validate a destination, returning the IPs the connection must be pinned to. */
async function resolveAndValidate(
  url: URL,
  resolveHostname: (hostname: string) => Promise<string[]>
): Promise<{ addresses: string[] } | FetchImageResult> {
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
  return { addresses };
}

// IP-pinned transport: the TCP connection is forced to a validated address via a custom
// DNS lookup, while the URL hostname is preserved so TLS SNI and certificate validation
// stay bound to the real host. This closes the resolve-then-fetch DNS-rebinding window.
const nodeTransport: ImageTransport = ({ url, pinnedIps, timeoutMs, headers }) =>
  new Promise<RawImageResponse>((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;
    const pinnedLookup: LookupFunction = ((_hostname: string, opts: unknown, cb: unknown) => {
      const results = pinnedIps.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
      const callback = cb as (err: Error | null, ...rest: unknown[]) => void;
      if (opts && (opts as { all?: boolean }).all) callback(null, results);
      else callback(null, results[0]!.address, results[0]!.family);
    }) as unknown as LookupFunction;
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { host: url.host, ...headers },
        lookup: pinnedLookup,
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | undefined>,
          body: res as AsyncIterable<Uint8Array>,
          cancel: () => res.destroy(),
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      const err = new Error("request timed out");
      err.name = "TimeoutError";
      req.destroy(err);
    });
    req.on("error", reject);
    req.end();
  });

// Process-wide transport, overridable in tests so deep pipeline calls (embed-index,
// enrich, search) can be stubbed without real network access. Defaults to the pinned client.
let activeTransport: ImageTransport = nodeTransport;
export function __setImageTransport(transport: ImageTransport | null): void {
  activeTransport = transport ?? nodeTransport;
}

async function readBounded(res: RawImageResponse, maxBytes: number): Promise<Uint8Array | "too_large"> {
  const length = res.headers["content-length"];
  if (length && Number(length) > maxBytes) {
    res.cancel?.();
    return "too_large";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike);
    total += u8.byteLength;
    if (total > maxBytes) {
      res.cancel?.();
      return "too_large";
    }
    chunks.push(u8);
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
  const transport = options.transport ?? activeTransport;

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const validated = await resolveAndValidate(current, resolveHostname);
    if ("ok" in validated) return validated;

    let res: RawImageResponse;
    try {
      res = await transport({
        url: current,
        pinnedIps: validated.addresses,
        timeoutMs,
        headers: { "user-agent": "Mozilla/5.0", accept: "image/*" },
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
      const location = res.headers["location"];
      res.cancel?.();
      if (!location || redirects === maxRedirects) {
        return { ok: false, reason: "network_error", finalUrl: current.href };
      }
      current = new URL(location, current);
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      res.cancel?.();
      return { ok: false, reason: "network_error", finalUrl: current.href };
    }

    const contentType = (res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!allowedContentTypes.includes(contentType)) {
      res.cancel?.();
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
