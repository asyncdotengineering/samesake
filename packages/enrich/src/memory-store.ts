// Reference EnrichStore — the complete in-memory implementation of the
// dirty -> ready | quarantined | failed | dead state machine. No DB, no
// network; the Tier-2 surface a caller gets when they omit `store` from
// createEnricher, and the fixture back-end for the factory suite.
//
// Scope isolation and the cosine dedup channel are production-store concerns:
// the memory store has no scope column (RawRow/EnrichedRow carry none) and no
// embedding plane, so `candidates` returns every OTHER enriched row and reports
// `cos: null`. A Postgres/D1 production store narrows both; this one exists to
// exercise the trgm/exactKey/clustering logic and the failure state machine.
import { contentHash } from "./dirty.ts";
import type {
  RawRow,
  DedupCandidate,
  DedupCandidateProvider,
  DedupFeedback,
} from "./types.ts";
import type { EnrichStore, EnrichedRow } from "./store.ts";

/** Jaccard similarity over the set of lowercased, space-padded character 3-grams. 0 when both inputs are empty. */
export function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const padded = ` ${s} `.toLowerCase();
    const out = new Set<string>();
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

interface Entry {
  id: string;
  data: Record<string, unknown>;
  imageEtag?: string | null;
  hash: string;
  dirty: boolean;
  enriched?: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: number;
  dead: boolean;
  deadReason?: string;
}

const DEAD_AFTER = 5;

// Exponential backoff in ms: 2s, 4s, 8s, 16s, 32s -> dead. Capped at 60s.
const backoffMs = (attempts: number): number => Math.min(2 ** attempts * 1000, 60000);

export function memoryStore(): EnrichStore {
  const rows = new Map<string, Entry>();
  const declined = new Set<string>();
  const confirmed = new Map<string, string>();
  const pairKey = (a: string, b: string) => `${a}|${b}`;

  const toRaw = (e: Entry): RawRow => ({
    id: e.id,
    data: e.data,
    ...(e.imageEtag !== undefined ? { imageEtag: e.imageEtag } : {}),
  });

  const candidates: DedupCandidateProvider = async (row) => {
    const out: DedupCandidate[] = [];
    for (const e of rows.values()) {
      if (e.id === row.id || !e.enriched) continue;
      const trgm: Record<string, number> = {};
      for (const [field, rv] of Object.entries(row.fields)) {
        if (typeof rv !== "string") continue;
        const cv = e.enriched[field];
        trgm[field] = trigramSimilarity(rv, cv == null ? "" : String(cv));
      }
      out.push({ id: e.id, group: null, fields: e.enriched, trgm, cos: null });
    }
    return out;
  };

  const feedback: DedupFeedback = {
    isDeclined: async (a, b) => declined.has(pairKey(a, b)) || declined.has(pairKey(b, a)),
    suggestionStatus: async (rowId, group) => confirmed.get(pairKey(rowId, group)) ?? null,
  };

  return {
    async upsert(input) {
      for (const r of input) {
        const hash = contentHash(r.data);
        const existing = rows.get(r.id);
        if (existing && existing.hash === hash) continue; // unchanged — no-op
        // New id OR changed content: store the raw row, (re)dirty it, reset failure
        // state (a content change is effectively a fresh row to enrich).
        rows.set(r.id, {
          id: r.id,
          data: r.data,
          imageEtag: r.imageEtag ?? null,
          hash,
          dirty: true,
          enriched: undefined,
          attempts: 0,
          nextAttemptAt: 0,
          dead: false,
          deadReason: undefined,
        });
      }
    },

    async loadDirty(limit) {
      const out: RawRow[] = [];
      for (const e of rows.values()) {
        if (!e.dirty || e.dead) continue;
        out.push(toRaw(e));
        if (out.length >= limit) break;
      }
      return out;
    },

    async writeEnriched(input) {
      for (const r of input) {
        const e = rows.get(r.id);
        if (!e) continue;
        e.enriched = r.enriched;
        e.dirty = false;
        e.attempts = 0;
        e.nextAttemptAt = 0;
        e.dead = false;
        e.deadReason = undefined;
      }
    },

    async recordFailure(id, _error) {
      const e = rows.get(id);
      if (!e) return;
      e.attempts += 1;
      e.nextAttemptAt = Date.now() + backoffMs(e.attempts);
      // Leave the dirty pool: a failed row only re-enters via loadRetryable once
      // its backoff window elapses, never a second time through loadDirty.
      e.dirty = false;
      if (e.attempts >= DEAD_AFTER) {
        e.dead = true;
        e.deadReason = _error == null ? "dead" : String(_error);
      }
    },

    async loadRetryable(limit) {
      const now = Date.now();
      const out: RawRow[] = [];
      for (const e of rows.values()) {
        if (e.dead || e.attempts <= 0 || e.nextAttemptAt > now) continue;
        out.push(toRaw(e));
        if (out.length >= limit) break;
      }
      return out;
    },

    async markDead(id, reason) {
      const e = rows.get(id);
      if (!e) return;
      e.dead = true;
      e.deadReason = reason;
    },

    async loadEnriched(limit) {
      const out: EnrichedRow[] = [];
      for (const e of rows.values()) {
        if (!e.enriched) continue;
        out.push({ id: e.id, enriched: e.enriched });
        if (out.length >= limit) break;
      }
      return out;
    },

    candidates,
    feedback,
  };
}
