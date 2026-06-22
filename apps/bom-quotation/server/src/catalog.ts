// The catalog as a samesake entity. A BOM line is matched to a catalog part via
// entity resolution: cosine over the description embedding + pg_trgm over the
// normalized name (codes / part numbers / prefix-suffix). This is the piece that
// makes keyword-ish matching robust where plain FTS is weak.
import { sql } from "drizzle-orm";
import { entity, fields, Scorers } from "@samesake/core";
import { createMatcher, createDbFromUrl } from "@samesake/server";
import { geminiEmbed, geminiGenerate, EMB_MODEL, EMB_DIM } from "./gemini.ts";
import { catalog, PROJECT, SCOPE, ENTITY_KIND } from "./config.ts";
import type { CatalogPart, MatchCandidate } from "../../shared/types.ts";

export const partEntity = entity(ENTITY_KIND, {
  fields: {
    // `description` is the clean, unique part name — it is the embedding source AND
    // the value returned on a match candidate, so we recover the catalog part from it.
    description: fields.text({ required: true }),
    // `searchkey` folds in code + aliases for fuzzy trigram matching of part numbers
    // and client shorthand, without polluting the description embedding.
    searchkey: fields.text({ optional: true }),
    code: fields.text({ optional: true }),
    brand: fields.text({ optional: true }),
    category: fields.text({ optional: true }),
  },
  scopes: ["company"],
  embeddings: {
    desc_emb: { source: "description", model: EMB_MODEL, dim: EMB_DIM },
  },
  scoring: {
    channels: [
      Scorers.cosine({ embedding: "desc_emb", weight: 0.6 }),
      Scorers.trigram({ field: "searchkey", weight: 0.4 }),
    ],
  },
});

export type Matcher = ReturnType<typeof createMatcher>;

export function makeMatcher(databaseUrl: string): Matcher {
  return createMatcher({
    databaseUrl,
    apiKey: "bom-quotation-key",
    migrate: "eager",
    embed: geminiEmbed,
    generate: geminiGenerate,
  });
}

/** Fold aliases into the embedded/trigram text so client vocabulary matches. */
function searchText(p: CatalogPart): string {
  return [p.description, p.code, ...(p.aliases ?? [])].filter(Boolean).join(" ");
}

/** Apply the schema and load the catalog into the entity (idempotent upsert). */
export async function setupCatalog(matcher: Matcher): Promise<{ schema: string; parts: number }> {
  await matcher.migrate();
  const { schema } = await matcher.apply(PROJECT, { entities: [partEntity], collections: [] });
  const parts = catalog();
  await matcher.upsertBatch(
    { project: PROJECT, entity: partEntity },
    parts.map((p) => ({
      id: p.code,
      scope: SCOPE,
      data: {
        description: p.description,
        searchkey: searchText(p),
        code: p.code,
        brand: p.brand,
        category: p.category,
      },
    }))
  );
  return { schema, parts: parts.length };
}

// The match candidate's `name` is the (clean, unique) description we upserted, so a
// map keyed on it recovers the catalog part without a DB round-trip.
const byDescription = new Map<string, CatalogPart>();
function partFromCandidateName(name: string): CatalogPart | undefined {
  if (byDescription.size === 0) for (const p of catalog()) byDescription.set(p.description, p);
  return byDescription.get(name);
}

// samesake's confirm() keys on the internal entity id (a bigint), not our part
// code — so map code -> entity id once after setup, for the /api/confirm route.
const codeToEntityId = new Map<string, string>();
export async function buildCodeIndex(databaseUrl: string, schema: string): Promise<void> {
  const { db, close } = createDbFromUrl(databaseUrl);
  try {
    const rows = await db.execute<{ external_id: string; id: string }>(
      sql.raw(`SELECT external_id, id::text AS id FROM "${schema}".entity_${ENTITY_KIND}`)
    );
    codeToEntityId.clear();
    for (const r of rows) if (r.external_id) codeToEntityId.set(r.external_id, String(r.id));
  } finally {
    await close();
  }
}
export function entityIdForCode(code: string): string | undefined {
  return codeToEntityId.get(code);
}

/** Match one normalized BOM line; returns catalog candidates with confidence. */
export async function matchLine(matcher: Matcher, text: string, limit = 4): Promise<MatchCandidate[]> {
  const res = await matcher.match({ project: PROJECT, kind: ENTITY_KIND, text, scope: SCOPE, opts: { limit } });
  return res.candidates
    .map((c): MatchCandidate | null => {
      const part = partFromCandidateName(String(c.name));
      if (!part) return null;
      return {
        code: part.code,
        description: part.description,
        brand: part.brand,
        confidence: c.combined,
        listPrice: part.listPrice,
        unit: part.unit,
      };
    })
    .filter((c): c is MatchCandidate => c !== null);
}
