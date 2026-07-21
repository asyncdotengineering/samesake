// Pure: resolves an opaque content-version token for a row's image, used to key
// the enrich stage cache so an image change invalidates cached LLM output.
// Prefers etag, then updated_at, then version; null when none are present.
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
