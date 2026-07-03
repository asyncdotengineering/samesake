export interface SearchCacheKey {
  project: string;
  collection: string;
  query?: string;
  /** Stable fingerprint of any image query input; distinct images must not collide. */
  image?: string | null;
  filters: unknown;
  weights: unknown;
  /** Resolved retrieval objective; intent and similar return different rankings. */
  mode?: string;
  limit: number;
  offset: number;
  facets: unknown;
  /** HNSW recall dial — different values return different candidate sets. */
  efSearch?: number | null;
  /** Tenancy scope — different tenants must never share a cache entry. */
  scope?: unknown;
  /** Offer attachment toggle — offers:false results must not be served for offers:true. */
  offers?: boolean | null;
}

function stableKey(key: SearchCacheKey): string {
  return [
    key.project,
    key.collection,
    (key.query ?? "").trim().toLowerCase().replace(/\s+/g, " "),
    key.image ?? "",
    JSON.stringify(key.filters ?? {}),
    JSON.stringify(key.weights ?? {}),
    key.mode ?? "",
    key.limit,
    key.offset,
    JSON.stringify(key.facets ?? []),
    key.efSearch ?? "",
    JSON.stringify(key.scope ?? {}),
    key.offers === false ? "no-offers" : "",
  ].join("|");
}

export class SearchResultCache {
  private entries = new Map<string, { value: unknown; at: number; project: string; collection: string }>();

  constructor(
    private readonly opts: { ttlMs: number; maxEntries: number }
  ) {}

  get<T>(key: SearchCacheKey): T | undefined {
    const raw = stableKey(key);
    const hit = this.entries.get(raw);
    if (!hit) return undefined;
    if (Date.now() - hit.at >= this.opts.ttlMs) {
      this.entries.delete(raw);
      return undefined;
    }
    return hit.value as T;
  }

  set(key: SearchCacheKey, value: unknown): void {
    if (this.entries.size >= this.opts.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(stableKey(key), {
      value,
      at: Date.now(),
      project: key.project,
      collection: key.collection,
    });
  }

  invalidateProjectCollection(project: string, collection: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.project === project && entry.collection === collection) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export const searchResultCache = new SearchResultCache({
  ttlMs: 60_000,
  maxEntries: 500,
});
