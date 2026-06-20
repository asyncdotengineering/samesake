import { createHash } from "node:crypto";

export function stripHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&quot;|&#\d+;|&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface NormalizedProduct {
  title: string;
  description: string | null;
  price: number | null;
  currency: string;
  image_url: string | null;
  url: string;
  vendor: string | null;
  raw_type: string | null;
  raw_tags: string[];
  available: boolean;
  content_hash: string;
}

export function imageVersionToken(fields: {
  image_etag?: unknown;
  image_updated_at?: unknown;
  image_version?: unknown;
}): string | null {
  if (fields.image_etag != null && String(fields.image_etag)) return String(fields.image_etag);
  if (fields.image_updated_at != null && String(fields.image_updated_at))
    return String(fields.image_updated_at);
  if (fields.image_version != null && String(fields.image_version))
    return String(fields.image_version);
  return null;
}

function contentHash(
  p: Omit<NormalizedProduct, "content_hash">,
  imageVersion?: string | null
): string {
  const parts = [
    p.title,
    p.description,
    p.price,
    p.image_url,
    p.available,
    p.raw_type,
    JSON.stringify(p.raw_tags),
  ];
  if (imageVersion) parts.push(imageVersion);
  return createHash("sha1").update(parts.join("|")).digest("hex");
}

export function normalizeShopify(
  item: Record<string, unknown>,
  store: { domain: string; currency: string }
): NormalizedProduct | null {
  if (!item.title || !item.handle) return null;
  const variants = (item.variants as Record<string, unknown>[] | undefined) ?? [];
  const variant = variants[0] ?? {};
  const tagsRaw = item.tags;
  let raw_tags: string[] = [];
  if (Array.isArray(tagsRaw)) {
    raw_tags = tagsRaw.map(String);
  } else if (typeof tagsRaw === "string") {
    raw_tags = tagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  const p: Omit<NormalizedProduct, "content_hash"> = {
    title: String(item.title).trim(),
    description: stripHtml(item.body_html).slice(0, 4000) || null,
    vendor: item.vendor != null ? String(item.vendor) : null,
    raw_type: item.product_type ? String(item.product_type) : null,
    raw_tags,
    price: variant.price != null ? Number(variant.price) : null,
    currency: store.currency,
    available: variants.some((v) => v.available !== false),
    image_url:
      ((item.images as { src?: string }[] | undefined)?.[0]?.src as string | undefined) ?? null,
    url: `https://${store.domain}/products/${String(item.handle)}`,
  };
  return { ...p, content_hash: contentHash(p, null) };
}

export function normalizeWoo(
  item: Record<string, unknown>,
  store: { domain: string; currency: string }
): NormalizedProduct | null {
  if (!item.name || !item.permalink) return null;
  const prices = (item.prices as Record<string, unknown> | undefined) ?? {};
  const minor = (prices.currency_minor_unit as number | undefined) ?? 2;
  const price =
    prices.price != null ? Number(prices.price) / 10 ** minor : null;
  const categories = (item.categories as { name?: string }[] | undefined) ?? [];
  const tags = (item.tags as { name?: string }[] | undefined) ?? [];

  const p: Omit<NormalizedProduct, "content_hash"> = {
    title: stripHtml(item.name),
    description:
      stripHtml(`${item.description ?? ""} ${item.short_description ?? ""}`).slice(0, 4000) ||
      null,
    vendor: null,
    raw_type: categories.map((c) => c.name).filter(Boolean).join(", ") || null,
    raw_tags: tags.map((t) => t.name).filter(Boolean) as string[],
    price,
    currency: (prices.currency_code as string | undefined) || store.currency,
    available: item.is_in_stock !== false,
    image_url:
      ((item.images as { src?: string }[] | undefined)?.[0]?.src as string | undefined) ?? null,
    url: String(item.permalink),
  };
  return { ...p, content_hash: contentHash(p, null) };
}

export function computeContentHash(data: Record<string, unknown>): string {
  const p = {
    title: data.title ?? "",
    description: data.description ?? null,
    price: data.price ?? null,
    image_url: data.image_url ?? null,
    available: data.available ?? false,
    raw_type: data.raw_type ?? null,
    raw_tags: Array.isArray(data.raw_tags) ? data.raw_tags : [],
  };
  const imageVersion = imageVersionToken({
    image_etag: data.image_etag,
    image_updated_at: data.image_updated_at,
    image_version: data.image_version,
  });
  return contentHash(
    {
      title: String(p.title),
      description: p.description != null ? String(p.description) : null,
      price: p.price != null ? Number(p.price) : null,
      currency: String(data.currency ?? ""),
      image_url: p.image_url != null ? String(p.image_url) : null,
      url: String(data.url ?? ""),
      vendor: data.vendor != null ? String(data.vendor) : null,
      raw_type: p.raw_type != null ? String(p.raw_type) : null,
      raw_tags: p.raw_tags as string[],
      available: Boolean(p.available),
    },
    imageVersion
  );
}
