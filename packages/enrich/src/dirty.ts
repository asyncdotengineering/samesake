import { createHash } from "node:crypto";
import { imageVersionToken } from "@samesake/core";
import type { RawRow } from "./types.ts";

function hashProduct(
  p: {
    title: string;
    description: string | null;
    price: number | null;
    image_url: string | null;
    available: boolean;
    raw_type: string | null;
    raw_tags: string[];
  },
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

export function contentHash(data: Record<string, unknown>): string {
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
  return hashProduct(
    {
      title: String(p.title),
      description: p.description != null ? String(p.description) : null,
      price: p.price != null ? Number(p.price) : null,
      image_url: p.image_url != null ? String(p.image_url) : null,
      raw_type: p.raw_type != null ? String(p.raw_type) : null,
      raw_tags: p.raw_tags as string[],
      available: Boolean(p.available),
    },
    imageVersion
  );
}

export function selectDirty(
  rows: RawRow[],
  priorHash: (id: string) => string | undefined
): RawRow[] {
  return rows.filter((r) => contentHash(r.data) !== priorHash(r.id));
}
