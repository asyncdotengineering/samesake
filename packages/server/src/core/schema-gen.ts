// Given an EntityDef from the consumer's config, generate the per-project DDL strings.
// Idempotent (uses IF NOT EXISTS / OR REPLACE everywhere).
//
// The 4 fixed-shape per-project system tables (name_alias, match_candidate,
// pair_history, scope_thresholds) are emitted from the pgTable declarations
// in src/db/schema/per-project.ts via tableToDDL — single source of truth.
// The per-project entity tables (entity_<kind>, entity_<kind>_match) and the
// match_<kind>() / dedup_<kind>() SQL functions stay hand-written here
// because columns / function bodies are derived from the user's entity config
// at apply time.
//
// All references to utility functions (samesake_normalise, samesake_phonetic,
// samesake_unit) are qualified with `sys` — the matcher's configured system
// schema, passed in by createMatcher via the ctx.
import type { EntityDef } from "@samesake/core";
import { tablesToDDL } from "../db/ddl.ts";
import { perProjectTables } from "../db/schema/per-project.ts";
import { assertIndexableVectorDimension } from "./vector-dim.ts";

export interface GeneratedDDL {
  projectSchema: string;
  statements: string[];
}

export interface SchemaGenConfig {
  /** Postgres schema where utility functions live (default `public`). */
  sys: string;
  /** Prefix for per-project schemas (default `project_`). */
  projectPrefix: string;
}

/**
 * Factory: bind schema-gen helpers to a specific system schema + prefix.
 */
export function makeSchemaGen(config: SchemaGenConfig) {
  const SYS = config.sys;
  const PREFIX = config.projectPrefix;

  function projectSchemaName(slug: string): string {
    const safe = slug.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
    return `${PREFIX}${safe}`;
  }

  function generateProjectDDL(
    projectSlug: string,
    entities: EntityDef[]
  ): GeneratedDDL {
    const schema = projectSchemaName(projectSlug);
    const stmts: string[] = [];

    stmts.push(`CREATE SCHEMA IF NOT EXISTS ${schema};`);
    stmts.push(...systemTablesDDL(schema));

    for (const e of entities) {
      if (!e.name) throw new Error("entity must have a name");
      stmts.push(...entityTablesDDL(schema, e));
      stmts.push(matchEntityFunctionDDL(schema, e));
      stmts.push(dedupEntityFunctionDDL(schema, e));
    }

    return { projectSchema: schema, statements: stmts };
  }

  function systemTablesDDL(schema: string): string[] {
    const t = perProjectTables(schema);
    return [
      tablesToDDL([t.nameAlias, t.matchCandidate, t.pairHistory, t.scopeThresholds]),
      `CREATE INDEX IF NOT EXISTS match_candidate_outcome_idx
         ON ${schema}.match_candidate (query_kind, outcome, created_at DESC)
         WHERE outcome IS NOT NULL;`,
    ];
  }

  function entityTablesDDL(schema: string, e: EntityDef): string[] {
    if (!e.name) throw new Error("entity must have a name");
    const kind = sanitiseIdent(e.name);
    const scopeCols = e.scopes
      .map((s) => `  ${sanitiseIdent(`scope_${s}`)} text NOT NULL`)
      .join(",\n");
    const fieldCols = Object.entries(e.fields)
      .map(([k, def]) => {
        const colType = def.type === "number" ? "double precision" : "text";
        const nullable = def.required ? "NOT NULL" : "";
        return `  ${sanitiseIdent(k)} ${colType} ${nullable}`.trimEnd();
      })
      .join(",\n");

    const embedCols = e.embeddings
      ? Object.entries(e.embeddings).map(
          ([name, def]) => {
            assertIndexableVectorDimension({
              owner: `entity ${e.name}`,
              field: `embeddings.${name}`,
              dimensions: def.dim,
            });
            return `  ${sanitiseIdent(name)} vector(${def.dim})`;
          }
        )
      : [];
    const phonCols = e.phonetic
      ? Object.entries(e.phonetic).map(
          ([name]) => `  ${sanitiseIdent(name)} text`
        )
      : [];

    const parseCols = e.parse
      ? [
          "  brand text",
          "  brand_normalised text",
          "  item text",
          "  item_canonical text",
          "  variant text",
          "  size_value double precision",
          "  size_unit text",
          "  internal_code text",
          "  namespace_prefix text",
          "  parser_confidence double precision",
        ]
      : [];

    const matchColsAll = [
      "  name_normalised text",
      ...parseCols,
      ...embedCols,
      ...phonCols,
      "  embedding_model text",
      "  embedded_at timestamptz",
    ];

    const indexStmts: string[] = [];
    if (e.embeddings) {
      for (const [name] of Object.entries(e.embeddings)) {
        const idx = sanitiseIdent(`entity_${kind}_${name}_idx`);
        const col = sanitiseIdent(name);
        indexStmts.push(
          `CREATE INDEX IF NOT EXISTS ${idx}
             ON ${schema}.entity_${kind}_match USING hnsw (${col} vector_cosine_ops)
             WITH (m = 16, ef_construction = 64);`
        );
      }
    }
    indexStmts.push(
      `CREATE INDEX IF NOT EXISTS entity_${kind}_norm_trgm_idx
         ON ${schema}.entity_${kind}_match USING gin (name_normalised gin_trgm_ops)
         WHERE name_normalised ~ '^[\\x20-\\x7e]+$';`
    );
    if (e.parse) {
      indexStmts.push(
        `CREATE INDEX IF NOT EXISTS entity_${kind}_brand_idx
           ON ${schema}.entity_${kind}_match (brand_normalised)
           WHERE brand_normalised IS NOT NULL;`,
        `CREATE INDEX IF NOT EXISTS entity_${kind}_code_idx
           ON ${schema}.entity_${kind}_match (internal_code)
           WHERE internal_code IS NOT NULL;`
      );
    }
    if (e.scopes.length > 0) {
      indexStmts.push(
        `CREATE INDEX IF NOT EXISTS entity_${kind}_scope_idx
           ON ${schema}.entity_${kind} (${e.scopes
          .map((s) => sanitiseIdent(`scope_${s}`))
          .join(", ")});`
      );
    }

    return [
      `
      CREATE TABLE IF NOT EXISTS ${schema}.entity_${kind} (
        id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        external_id text UNIQUE,
${scopeCols},
${fieldCols},
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      `,
      `
      CREATE TABLE IF NOT EXISTS ${schema}.entity_${kind}_match (
        ${kind}_id  bigint PRIMARY KEY REFERENCES ${schema}.entity_${kind}(id) ON DELETE CASCADE,
${matchColsAll.join(",\n")}
      );
      `,
      ...indexStmts,
    ];
  }

  function matchEntityFunctionDDL(schema: string, e: EntityDef): string {
    if (e.parse) {
      return matchAssetFunctionDDL(schema, e);
    }
    return matchPeopleFunctionDDL(schema, e);
  }

  /**
   * Pull per-channel weights from the entity's scoring.channels declaration.
   * Falls back to library defaults for channels the entity didn't declare.
   * Channels with weight 0 are treated as absent (no contribution to combined).
   */
  function extractWeights(e: EntityDef): {
    phoneExact: number | null;        // null = channel not declared
    cosineByEmbedding: Map<string, number>;
    trigram: number | null;
    phoneticEq: number | null;
    aliasHit: number | null;
    brand: { matchBoost: number; mismatchFactor: number } | null;
  } {
    const channels = e.scoring?.channels ?? [];
    const out = {
      phoneExact: null as number | null,
      cosineByEmbedding: new Map<string, number>(),
      trigram: null as number | null,
      phoneticEq: null as number | null,
      aliasHit: null as number | null,
      brand: null as { matchBoost: number; mismatchFactor: number } | null,
    };
    for (const ch of channels) {
      const w = ch.weight ?? null;
      if (w === 0) continue;  // explicit 0 = skip
      switch (ch.kind) {
        case "phoneExact":
          out.phoneExact = w ?? 1.0;
          break;
        case "cosine":
          if (ch.embedding) out.cosineByEmbedding.set(ch.embedding, w ?? 0.6);
          break;
        case "trigram":
          out.trigram = w ?? 0.25;
          break;
        case "phoneticEq":
          out.phoneticEq = w ?? 0.2;
          break;
        case "aliasHit":
          out.aliasHit = w ?? 0.4;
          break;
        case "brandGate":
          out.brand = {
            matchBoost: ch.matchBoost ?? 1.3,
            mismatchFactor: ch.mismatchFactor ?? 0.2,
          };
          break;
        // internalCodeExact + sizeUnitGate are flags/gates, not noisy-OR weights
      }
    }
    return out;
  }

  function matchPeopleFunctionDDL(schema: string, e: EntityDef): string {
    if (!e.name) throw new Error("entity name required");
    const kind = sanitiseIdent(e.name);

    const embeddingName = e.embeddings ? Object.keys(e.embeddings)[0] : null;
    const embeddingCol = embeddingName ? sanitiseIdent(embeddingName) : null;
    const embeddingDim = embeddingName ? e.embeddings![embeddingName]!.dim : 768;

    const phoneticName = e.phonetic ? Object.keys(e.phonetic)[0] : null;
    const phoneticCol = phoneticName ? sanitiseIdent(phoneticName) : null;

    const nameField = Object.keys(e.fields).find((f) => f.toLowerCase() === "name") ?? Object.keys(e.fields)[0]!;
    const nameCol = sanitiseIdent(nameField);

    const phoneField = Object.keys(e.fields).find((f) => f.toLowerCase() === "phone");
    const phoneCol = phoneField ? sanitiseIdent(phoneField) : null;

    // Per-entity channel weights — read declared values, fall back to defaults.
    const w = extractWeights(e);
    // Build the noisy-OR multiplier list from ONLY the channels this entity
    // actually uses. Omitted channels become no-ops in the formula instead of
    // weight-zero placeholders, keeping the SQL tight.
    const multipliers: string[] = [];
    if (w.phoneExact !== null && phoneCol) {
      multipliers.push(`(1 - ${w.phoneExact} * CASE WHEN phone_eq THEN 1.0 ELSE 0.0 END)`);
    }
    const firstCosineWeight = embeddingName ? (w.cosineByEmbedding.get(embeddingName) ?? null) : null;
    if (firstCosineWeight !== null && embeddingCol) {
      multipliers.push(`(1 - ${firstCosineWeight} * GREATEST(COALESCE(cos_sim, 0)::double precision, 0))`);
    }
    if (w.trigram !== null) {
      multipliers.push(`(1 - ${w.trigram} * GREATEST(trgm_sim::double precision, 0))`);
    }
    if (w.phoneticEq !== null && phoneticCol) {
      multipliers.push(`(1 - ${w.phoneticEq} * CASE WHEN phon_eq THEN 1.0 ELSE 0.0 END)`);
    }
    if (w.aliasHit !== null) {
      multipliers.push(`(1 - ${w.aliasHit} * GREATEST(alias_score - 0.5, 0) * 2.0)`);
    }
    // If no channels declared at all, fall back to a constant 0 → combined = 1
    // for any row (degenerate). Better: combined = 0. We choose 0 here so the
    // matcher returns nothing (operator clearly forgot to declare channels).
    const combinedExpr = multipliers.length > 0
      ? `decline_factor * (1 - (\n                ${multipliers.join(" *\n                ")}\n              ))`
      : `0::double precision`;

    const scopeFilter = e.scopes
      .map(
        (s) =>
          `(_scope ? '${s}' AND e.${sanitiseIdent(
            `scope_${s}`
          )} = (_scope ->> '${s}')) OR (NOT _scope ? '${s}')`
      )
      .map((c) => `(${c})`)
      .join(" AND ");

    return `
      CREATE OR REPLACE FUNCTION ${schema}.match_${kind}(
        _scope jsonb,
        _query_text text,
        _query_emb vector(${embeddingDim}),
        _phone text DEFAULT NULL,
        _limit int DEFAULT 5
      ) RETURNS TABLE (
        entity_id bigint,
        name text,
        cos_sim double precision,
        trgm_sim double precision,
        phon_eq boolean,
        phone_eq boolean,
        alias_hit boolean,
        combined double precision
      ) LANGUAGE sql STABLE PARALLEL SAFE AS $func$
        WITH q AS (
          SELECT ${SYS}.samesake_normalise(_query_text) AS norm,
                 ${SYS}.samesake_phonetic(_query_text) AS phon
        ),
        candidates AS MATERIALIZED (
          SELECT
            e.id        AS entity_id,
            e.${nameCol} AS name,
            ${phoneCol ? `e.${phoneCol}` : `NULL::text`} AS phone,
            m.name_normalised,
            ${embeddingCol ? `m.${embeddingCol}` : `NULL::vector`} AS emb,
            ${phoneticCol ? `m.${phoneticCol}` : `NULL::text`} AS phon_hash
          FROM ${schema}.entity_${kind} e
          LEFT JOIN ${schema}.entity_${kind}_match m ON m.${kind}_id = e.id
          WHERE ${e.scopes.length > 0 ? scopeFilter : "TRUE"}
        ),
        scored AS (
          SELECT
            c.entity_id,
            c.name,
            ${embeddingCol
              ? `CASE WHEN c.emb IS NOT NULL THEN 1 - (c.emb <=> _query_emb) ELSE NULL END`
              : `NULL::double precision`} AS cos_sim,
            -- trgm_sim = max of (normalised-text similarity, phonetic-signature similarity).
            -- The second term is the cross-script bridge: for pairs whose original-script
            -- characters share zero n-grams (e.g. 'Anuja' vs 'අනූජ'), the phonetic
            -- signatures (both 'NCVRN') do share n-grams, so this lifts the channel
            -- from 0 to ~1.0 on cross-script same-name pairs. Intra-script pairs are
            -- unaffected because the original-text similarity dominates there.
            GREATEST(
              CASE WHEN c.name_normalised IS NOT NULL
                THEN similarity((SELECT norm FROM q), c.name_normalised)
                ELSE 0::real END,
              CASE WHEN c.phon_hash IS NOT NULL AND length(c.phon_hash) >= 3 AND length((SELECT phon FROM q)) >= 3
                THEN similarity((SELECT phon FROM q), c.phon_hash)
                ELSE 0::real END
            ) AS trgm_sim,
            (c.phon_hash IS NOT NULL AND c.phon_hash = (SELECT phon FROM q)) AS phon_eq,
            (_phone IS NOT NULL AND c.phone IS NOT NULL AND c.phone = _phone) AS phone_eq,
            COALESCE(ph.confirm_count, 0) AS confirm_count,
            COALESCE(ph.decline_count, 0) AS decline_count
          FROM candidates c
          LEFT JOIN ${schema}.pair_history ph
            ON ph.scope_json = _scope
           AND ph.entity_kind = '${kind}'
           AND ph.entity_id = c.entity_id
           AND ph.alias_normalised = (SELECT norm FROM q)
        ),
        enriched AS (
          SELECT *,
            1.0 / (1.0 + exp(-(confirm_count::double precision - decline_count::double precision))) AS alias_score,
            exp(-0.5 * GREATEST((decline_count - confirm_count)::double precision, 0)) AS decline_factor,
            (confirm_count > 0 AND decline_count = 0) AS alias_hit
          FROM scored
        ),
        combined AS (
          SELECT *, ${combinedExpr} AS combined
          FROM enriched
        )
        SELECT entity_id, name, cos_sim, trgm_sim::double precision,
               phon_eq, phone_eq, alias_hit, combined
        FROM combined
        ORDER BY combined DESC NULLS LAST
        LIMIT _limit;
      $func$;
    `;
  }

  function matchAssetFunctionDDL(schema: string, e: EntityDef): string {
    if (!e.name) throw new Error("entity name required");
    const kind = sanitiseIdent(e.name);
    if (!e.embeddings) throw new Error("parse entity must declare at least one embedding");

    const embNames = Object.keys(e.embeddings);
    const itemEmbName = embNames.find((n) => n.toLowerCase().includes("item")) ?? embNames[0]!;
    const fullEmbName = embNames.find((n) => n.toLowerCase().includes("full")) ?? embNames[embNames.length - 1]!;
    const itemDim = e.embeddings[itemEmbName]!.dim;
    const fullDim = e.embeddings[fullEmbName]!.dim;
    const itemEmbCol = sanitiseIdent(itemEmbName);
    const fullEmbCol = sanitiseIdent(fullEmbName);

    const nameField = Object.keys(e.fields).find((f) => f.toLowerCase() === "name") ?? Object.keys(e.fields)[0]!;
    const nameCol = sanitiseIdent(nameField);

    // Per-entity channel weights — parse-shape variant. Cosine has TWO slots
    // (item + full); brand has matchBoost / mismatchFactor instead of a weight.
    const w = extractWeights(e);
    const itemCosineWeight = w.cosineByEmbedding.get(itemEmbName) ?? null;
    const fullCosineWeight = w.cosineByEmbedding.get(fullEmbName) ?? null;
    const brandMatchBoost = w.brand?.matchBoost ?? 1.0;
    const brandMismatchFactor = w.brand?.mismatchFactor ?? 1.0;

    const assetMultipliers: string[] = [];
    if (itemCosineWeight !== null) {
      assetMultipliers.push(`(1 - ${itemCosineWeight} * GREATEST(COALESCE(item_cos, 0)::double precision, 0))`);
    }
    if (fullCosineWeight !== null) {
      assetMultipliers.push(`(1 - ${fullCosineWeight} * GREATEST(COALESCE(full_cos, 0)::double precision, 0))`);
    }
    if (w.trigram !== null) {
      assetMultipliers.push(`(1 - ${w.trigram} * GREATEST(trgm_sim::double precision, 0))`);
    }
    if (w.aliasHit !== null) {
      assetMultipliers.push(`(1 - ${w.aliasHit} * GREATEST(alias_score - 0.5, 0) * 2.0)`);
    }
    const assetNoisyOr = assetMultipliers.length > 0
      ? `(1 - (\n                ${assetMultipliers.join(" *\n                ")}\n              ))`
      : `0::double precision`;

    const scopeFilter = e.scopes
      .map(
        (s) =>
          `(_scope ? '${s}' AND e.${sanitiseIdent(`scope_${s}`)} = (_scope ->> '${s}')) OR (NOT _scope ? '${s}')`
      )
      .map((c) => `(${c})`)
      .join(" AND ");

    return `
      CREATE OR REPLACE FUNCTION ${schema}.match_${kind}(
        _scope jsonb,
        _query_text text,
        _query_item_emb vector(${itemDim}),
        _query_full_emb vector(${fullDim}),
        _q_brand_norm text DEFAULT NULL,
        _q_item_canon text DEFAULT NULL,
        _q_variant text DEFAULT NULL,
        _q_size_value double precision DEFAULT NULL,
        _q_size_unit text DEFAULT NULL,
        _q_internal_code text DEFAULT NULL,
        _limit int DEFAULT 5
      ) RETURNS TABLE (
        entity_id bigint,
        name text,
        item_cos double precision,
        full_cos double precision,
        trgm_sim double precision,
        phon_eq boolean,
        brand_match text,
        size_compatible boolean,
        alias_hit boolean,
        combined double precision
      ) LANGUAGE sql STABLE PARALLEL SAFE AS $func$
        WITH q AS (
          SELECT ${SYS}.samesake_normalise(_query_text) AS norm,
                 ${SYS}.samesake_phonetic(_query_text) AS phon
        ),
        q_unit AS (
          SELECT canonical AS canon, family AS fam, factor
          FROM ${SYS}.samesake_unit(_q_size_unit)
        ),
        candidates AS MATERIALIZED (
          SELECT
            e.id        AS entity_id,
            e.${nameCol} AS name,
            m.name_normalised,
            m.${itemEmbCol} AS item_emb,
            m.${fullEmbCol} AS full_emb,
            m.brand_normalised,
            m.item_canonical,
            m.variant,
            m.size_value,
            m.size_unit,
            m.internal_code
          FROM ${schema}.entity_${kind} e
          LEFT JOIN ${schema}.entity_${kind}_match m ON m.${kind}_id = e.id
          WHERE ${e.scopes.length > 0 ? scopeFilter : "TRUE"}
        ),
        code_hits AS (
          SELECT entity_id, name,
            NULL::double precision AS item_cos,
            NULL::double precision AS full_cos,
            NULL::double precision AS trgm_sim,
            false AS phon_eq,
            'unknown'::text AS brand_match,
            true AS size_compatible,
            false AS alias_hit,
            1.0::double precision AS combined
          FROM candidates
          WHERE _q_internal_code IS NOT NULL
            AND internal_code IS NOT NULL
            AND lower(internal_code) = lower(_q_internal_code)
        ),
        size_gated AS (
          SELECT c.*,
            (
              _q_size_value IS NULL
              OR c.size_value IS NULL
              OR (
                _q_size_unit IS NOT NULL AND c.size_unit IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM ${SYS}.samesake_unit(c.size_unit) cu, q_unit qu
                  WHERE cu.family = qu.fam
                    AND ABS((_q_size_value * COALESCE(qu.factor, 1))
                           - (c.size_value * COALESCE(cu.factor, 1))) < 0.5
                )
              )
              OR (
                _q_size_value IS NOT NULL AND c.size_value IS NOT NULL
                AND ABS(_q_size_value - c.size_value) < 0.5
              )
            ) AS size_ok
          FROM candidates c
          WHERE _q_internal_code IS NULL OR c.internal_code IS DISTINCT FROM _q_internal_code
        ),
        gated AS (SELECT * FROM size_gated WHERE size_ok),
        scored AS (
          SELECT g.entity_id, g.name,
            CASE WHEN g.item_emb IS NOT NULL THEN 1 - (g.item_emb <=> _query_item_emb) ELSE NULL END AS item_cos,
            CASE WHEN g.full_emb IS NOT NULL THEN 1 - (g.full_emb <=> _query_full_emb) ELSE NULL END AS full_cos,
            CASE WHEN g.name_normalised IS NOT NULL
              THEN similarity((SELECT norm FROM q), g.name_normalised)
              ELSE 0::real END AS trgm_sim,
            false AS phon_eq,
            CASE
              WHEN _q_brand_norm IS NULL OR g.brand_normalised IS NULL THEN 'unknown'::text
              WHEN lower(_q_brand_norm) = lower(g.brand_normalised) THEN 'match'::text
              ELSE 'mismatch'::text
            END AS brand_match,
            g.size_ok AS size_compatible,
            COALESCE(ph.confirm_count, 0) AS confirm_count,
            COALESCE(ph.decline_count, 0) AS decline_count
          FROM gated g
          LEFT JOIN ${schema}.pair_history ph
            ON ph.scope_json = _scope
           AND ph.entity_kind = '${kind}'
           AND ph.entity_id = g.entity_id
           AND ph.alias_normalised = (SELECT norm FROM q)
        ),
        enriched AS (
          SELECT *,
            1.0 / (1.0 + exp(-(confirm_count::double precision - decline_count::double precision))) AS alias_score,
            exp(-0.5 * GREATEST((decline_count - confirm_count)::double precision, 0)) AS decline_factor,
            (confirm_count > 0 AND decline_count = 0) AS alias_hit
          FROM scored
        ),
        combined AS (
          SELECT *,
            LEAST(
              decline_factor *
              CASE brand_match
                WHEN 'match'    THEN ${brandMatchBoost}::double precision
                WHEN 'mismatch' THEN ${brandMismatchFactor}::double precision
                ELSE                 1.0::double precision
              END
              * ${assetNoisyOr},
              1.0
            ) AS combined
          FROM enriched
        ),
        unioned AS (
          SELECT * FROM code_hits
          UNION ALL
          SELECT entity_id, name, item_cos, full_cos, trgm_sim, phon_eq,
                 brand_match, size_compatible, alias_hit, combined
          FROM combined
        )
        SELECT * FROM unioned
        ORDER BY combined DESC NULLS LAST
        LIMIT _limit;
      $func$;
    `;
  }

  function dedupEntityFunctionDDL(schema: string, e: EntityDef): string {
    if (!e.name) throw new Error("entity name required");
    const kind = sanitiseIdent(e.name);
    const embeddingName = e.embeddings ? Object.keys(e.embeddings)[0] : null;
    if (!embeddingName) {
      return `-- dedup_${kind}: skipped (no embedding declared)`;
    }
    const embeddingCol = sanitiseIdent(embeddingName);

    // Display field: prefer a literal "name" field; otherwise the first
    // declared field. Don't hard-code "name" — entities like cashbook_entry
    // use "counterparty" as their primary text.
    const nameField =
      Object.keys(e.fields).find((f) => f.toLowerCase() === "name") ??
      Object.keys(e.fields)[0]!;
    const nameCol = sanitiseIdent(nameField);

    const scopeFilter = e.scopes
      .map(
        (s) =>
          `(_scope ? '${s}' AND a.${sanitiseIdent(
            `scope_${s}`
          )} = (_scope ->> '${s}') AND b.${sanitiseIdent(
            `scope_${s}`
          )} = (_scope ->> '${s}')) OR (NOT _scope ? '${s}')`
      )
      .map((c) => `(${c})`)
      .join(" AND ");

    return `
      CREATE OR REPLACE FUNCTION ${schema}.dedup_${kind}(
        _scope jsonb,
        _score_floor double precision DEFAULT 0.95,
        _min_cluster_size int DEFAULT 2,
        _limit int DEFAULT 100
      ) RETURNS TABLE (
        cluster_key bigint,
        members jsonb,
        total int,
        min_score double precision
      ) LANGUAGE sql STABLE PARALLEL SAFE AS $func$
        WITH pairs AS (
          SELECT
            a.id AS a_id, a.${nameCol} AS a_name,
            b.id AS b_id, b.${nameCol} AS b_name,
            1 - (am.${embeddingCol} <=> bm.${embeddingCol}) AS cos_sim
          FROM ${schema}.entity_${kind} a
          JOIN ${schema}.entity_${kind}_match am ON am.${kind}_id = a.id
          JOIN ${schema}.entity_${kind} b ON a.id < b.id
          JOIN ${schema}.entity_${kind}_match bm ON bm.${kind}_id = b.id
          WHERE am.${embeddingCol} IS NOT NULL
            AND bm.${embeddingCol} IS NOT NULL
            AND (${e.scopes.length > 0 ? scopeFilter : "TRUE"})
            AND 1 - (am.${embeddingCol} <=> bm.${embeddingCol}) >= _score_floor
        ),
        flat AS (
          SELECT LEAST(a_id, b_id) AS cluster_key, a_id AS node_id, a_name AS node_name, cos_sim FROM pairs
          UNION
          SELECT LEAST(a_id, b_id) AS cluster_key, b_id, b_name, cos_sim FROM pairs
        )
        SELECT
          cluster_key,
          jsonb_agg(DISTINCT jsonb_build_object('id', node_id::text, 'name', node_name)) AS members,
          COUNT(DISTINCT node_id)::int AS total,
          MIN(cos_sim) AS min_score
        FROM flat
        GROUP BY cluster_key
        HAVING COUNT(DISTINCT node_id) >= _min_cluster_size
        ORDER BY total DESC, min_score DESC
        LIMIT _limit;
      $func$;
    `;
  }

  return { projectSchemaName, generateProjectDDL };
}

export function sanitiseIdent(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

export type SchemaGen = ReturnType<typeof makeSchemaGen>;
