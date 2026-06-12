import { eq, and, sql, type SQL } from "drizzle-orm";
import type { MatchCandidate, MatchResult, EntityDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import type { EmbedService } from "./embed.ts";
import type { ParseService } from "./parse.ts";
import type { ProjectsService } from "./projects.ts";
import type { SchemaGen } from "./schema-gen.ts";
import { asJsonb } from "../db/client.ts";
import { perProjectTables } from "../db/schema/per-project.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { toVectorLiteral } from "./embed.ts";

const DEFAULT_AUTO_LINK_THRESHOLD = 0.92;
const DEFAULT_SUGGEST_THRESHOLD = 0.54;

export interface MatchInput {
  project: string;
  kind: string;
  text: string;
  scope: Record<string, string>;
  opts?: { limit?: number; phone?: string };
}

type MatchedRow = {
  entity_id: bigint;
  name: string;
  cos_sim: number | null;
  trgm_sim: number;
  phon_eq: boolean;
  phone_eq: boolean;
  alias_hit: boolean;
  combined: number;
};

export interface ConfirmInput {
  project: string;
  kind: string;
  queryText: string;
  scope: Record<string, string>;
  chosenEntityId: string | null;
}

export interface DeclineInput {
  project: string;
  kind: string;
  queryText: string;
  scope: Record<string, string>;
  declinedEntityId: string;
}

export interface DedupInput {
  project: string;
  kind: string;
  scope: Record<string, string>;
  scoreFloor?: number;
  minClusterSize?: number;
  limit?: number;
}

export interface DedupCluster {
  representative: { entityId: string; name: string };
  members: Array<{ entityId: string; name: string }>;
  totalCount: number;
  estimatedConfidence: number;
}

export interface MatchBatchQuery {
  queryText: string;
  phone?: string;
  ref?: string;
}

export interface MatchBatchInput {
  project: string;
  kind: string;
  scope: Record<string, string>;
  queries: MatchBatchQuery[];
}

export type MatchHitMethod =
  | "phone-exact"
  | "name-exact"
  | "alias-hit"
  | "phonetic-unique"
  | "combined-match"
  | "no-match";

export interface MatchBatchOutcome {
  queryText: string;
  ref: string | null;
  hitMethod: MatchHitMethod;
  candidates: MatchCandidate[];
  combined: number;
}

export interface MatchBatchResult {
  outcomes: MatchBatchOutcome[];
  counts: Record<MatchHitMethod, number>;
}

type CheapWaveRow = {
  q_idx: number;
  entity_id: bigint;
  entity_name: string;
};

export function makeMatchService(
  ctx: MatcherCtx,
  embedService: EmbedService,
  parseService: ParseService,
  projectsService: ProjectsService,
  schemaGen: SchemaGen
) {
  const { db } = ctx;
  const SYS_NORMALISE = sql`${sql.identifier(ctx.schema)}.samesake_normalise`;
  const SYS_PHONETIC = sql`${sql.identifier(ctx.schema)}.samesake_phonetic`;

  async function thresholdsForScope(
    schema: string,
    kind: string,
    scope: Record<string, string>
  ): Promise<{ autoLink: number; suggest: number }> {
    // Lookup priority:
    //   1. exact (entity_kind, scope_json) row
    //   2. kind-wide default with scope_json = '{}' (consumer's
    //      one-time setScopeThresholds at boot)
    //   3. library defaults (0.92 / 0.55) — calibrated for phone-exact +
    //      name-exact people-shape matches
    //
    // ORDER BY exact-match-first using a CASE expression so a single
    // round-trip returns the right row.
    const t = perProjectTables(schema);
    const r = await db
      .select({
        autoLink: t.scopeThresholds.autoLinkThreshold,
        suggest: t.scopeThresholds.suggestThreshold,
      })
      .from(t.scopeThresholds)
      .where(
        and(
          eq(t.scopeThresholds.entityKind, kind),
          sql`${t.scopeThresholds.scopeJson} = ${JSON.stringify(scope)}::jsonb
              OR ${t.scopeThresholds.scopeJson} = '{}'::jsonb`
        )
      )
      .orderBy(
        sql`(${t.scopeThresholds.scopeJson} = ${JSON.stringify(scope)}::jsonb) DESC`
      )
      .limit(1);
    if (r[0]) {
      return { autoLink: Number(r[0].autoLink), suggest: Number(r[0].suggest) };
    }
    return { autoLink: DEFAULT_AUTO_LINK_THRESHOLD, suggest: DEFAULT_SUGGEST_THRESHOLD };
  }

  async function setScopeThresholds(input: {
    project: string;
    kind: string;
    scope: Record<string, string>;
    autoLink: number;
    suggest: number;
  }): Promise<void> {
    const schema = schemaGen.projectSchemaName(input.project);
    const kind = sanitiseIdent(input.kind);
    const t = perProjectTables(schema);
    if (input.autoLink < 0 || input.autoLink > 1) {
      throw new Error(`setScopeThresholds: autoLink must be in [0, 1], got ${input.autoLink}`);
    }
    if (input.suggest < 0 || input.suggest > 1) {
      throw new Error(`setScopeThresholds: suggest must be in [0, 1], got ${input.suggest}`);
    }
    if (input.suggest > input.autoLink) {
      throw new Error(
        `setScopeThresholds: suggest (${input.suggest}) must be ≤ autoLink (${input.autoLink})`
      );
    }
    await db
      .insert(t.scopeThresholds)
      .values({
        scopeJson: input.scope,
        entityKind: kind,
        autoLinkThreshold: input.autoLink,
        suggestThreshold: input.suggest,
      })
      .onConflictDoUpdate({
        target: [t.scopeThresholds.scopeJson, t.scopeThresholds.entityKind],
        set: {
          autoLinkThreshold: input.autoLink,
          suggestThreshold: input.suggest,
          calibratedAt: sql`now()`,
        },
      });
  }

  async function persistTelemetry(
    schema: string,
    input: MatchInput,
    candidates: MatchCandidate[]
  ): Promise<void> {
    if (candidates.length === 0) return;
    const t = perProjectTables(schema);
    const rowsToInsert = candidates.map((c, i) => ({
      scopeJson: input.scope,
      queryText: input.text,
      queryKind: input.kind,
      sourceTable: null,
      sourceId: null,
      candidateId: BigInt(c.entityId),
      combinedScore: c.combined.toFixed(3),
      cosineScore: c.components.cosSim !== null ? c.components.cosSim.toFixed(3) : null,
      trgmScore: c.components.trgmSim.toFixed(3),
      phoneticScore: c.components.phonEq ? "1.000" : "0.000",
      aliasHit: c.components.aliasHit,
      phoneEq: c.components.phoneEq,
      components: {},
      rankPos: i + 1,
    }));
    await db.insert(t.matchCandidate).values(rowsToInsert);
  }

  async function runMatch(input: MatchInput): Promise<MatchResult> {
    const schema = schemaGen.projectSchemaName(input.project);
    const kind = sanitiseIdent(input.kind);
    const limit = input.opts?.limit ?? 5;
    const phone = input.opts?.phone ?? null;

    const entity = await projectsService.getEntityDef(input.project, input.kind);
    if (!entity) {
      throw new Error(`unknown entity kind '${input.kind}' in project '${input.project}'`);
    }

    if (entity.parse) {
      return await runAssetMatch(input, entity, schema, kind, limit);
    }

    const firstEmbeddingDef = entity.embeddings ? Object.values(entity.embeddings)[0] : undefined;
    if (!firstEmbeddingDef) {
      throw new Error(`entity '${input.kind}' has no embedding declared`);
    }
    const queryEmb = await embedService.embedQuery({
      text: input.text,
      model: firstEmbeddingDef.model,
      dim: firstEmbeddingDef.dim,
      taskType: firstEmbeddingDef.taskType,
      inputType: "query",
    });
    const embLit = toVectorLiteral(queryEmb);

    const matchFn = sql`${sql.identifier(schema)}.${sql.identifier(`match_${kind}`)}`;
    const rows = await db.execute<MatchedRow>(sql`
      SELECT entity_id, name, cos_sim, trgm_sim, phon_eq, phone_eq, alias_hit, combined
      FROM ${matchFn}(
        ${asJsonb(input.scope)}::jsonb,
        ${input.text},
        ${embLit}::vector,
        ${phone},
        ${limit}
      )
    `);

    const candidates: MatchCandidate[] = rows.map((r) => ({
      entityId: String(r.entity_id),
      name: r.name,
      combined: Number(r.combined),
      rrfScore: 0,
      components: {
        cosSim: r.cos_sim === null ? null : Number(r.cos_sim),
        trgmSim: Number(r.trgm_sim),
        phonEq: r.phon_eq,
        phoneEq: r.phone_eq,
        aliasHit: r.alias_hit,
      },
    }));

    const queryTextNormalised = input.text.trim().toLowerCase();
    const top = candidates[0];
    const t = await thresholdsForScope(schema, kind, input.scope);
    const resolved =
      top && top.combined >= t.autoLink
        ? { entityId: top.entityId, confidence: top.combined, source: "autolink" as const }
        : undefined;

    await persistTelemetry(schema, input, candidates);

    // r.candidates contains ONLY actionable candidates (combined >= suggest).
    // Previously the top was always included as an informational fallback,
    // but that caused consumers to treat sub-suggest noise as review-worthy.
    // Consumers wanting the raw top score can persist candidates via the
    // matchCandidate telemetry table (already happening above).
    return {
      candidates: candidates.filter((c) => c.combined >= t.suggest),
      queryTextNormalised,
      resolved,
    };
  }

  async function runAssetMatch(
    input: MatchInput,
    entity: EntityDef,
    schema: string,
    kind: string,
    limit: number
  ): Promise<MatchResult> {
    const parsed = await parseService.parseProductName(input.text, {
      model: entity.parse?.model,
      instructions: entity.parse?.instructions,
    });

    const embNames = Object.keys(entity.embeddings!);
    const itemEmbName = embNames.find((n) => n.toLowerCase().includes("item")) ?? embNames[0]!;
    const fullEmbName = embNames.find((n) => n.toLowerCase().includes("full")) ?? embNames[embNames.length - 1]!;
    const itemDef = entity.embeddings![itemEmbName]!;
    const fullDef = entity.embeddings![fullEmbName]!;

    const itemSrc = `${parsed.item_canonical} ${parsed.variant ?? ""}`.trim();
    const fullSrc = input.text;
    const [itemEmb, fullEmb] = await Promise.all([
      embedService.embedQuery({
        text: itemSrc,
        model: itemDef.model,
        dim: itemDef.dim,
        taskType: itemDef.taskType,
        inputType: "query",
      }),
      embedService.embedQuery({
        text: fullSrc,
        model: fullDef.model,
        dim: fullDef.dim,
        taskType: fullDef.taskType,
        inputType: "query",
      }),
    ]);
    const itemLit = toVectorLiteral(itemEmb);
    const fullLit = toVectorLiteral(fullEmb);

    const matchFn = sql`${sql.identifier(schema)}.${sql.identifier(`match_${kind}`)}`;
    const rows = await db.execute<{
      entity_id: bigint;
      name: string;
      item_cos: number | null;
      full_cos: number | null;
      trgm_sim: number;
      phon_eq: boolean;
      brand_match: "match" | "mismatch" | "unknown";
      size_compatible: boolean;
      alias_hit: boolean;
      combined: number;
    }>(sql`
      SELECT entity_id, name, item_cos, full_cos, trgm_sim, phon_eq,
             brand_match, size_compatible, alias_hit, combined
      FROM ${matchFn}(
        ${asJsonb(input.scope)}::jsonb,
        ${input.text},
        ${itemLit}::vector,
        ${fullLit}::vector,
        ${parsed.brand_normalised},
        ${parsed.item_canonical},
        ${parsed.variant},
        ${parsed.size_value},
        ${parsed.size_unit},
        ${parsed.internal_code},
        ${limit}
      )
    `);

    const candidates: MatchCandidate[] = rows.map((r) => ({
      entityId: String(r.entity_id),
      name: r.name,
      combined: Number(r.combined),
      rrfScore: 0,
      components: {
        cosSim: r.item_cos === null ? null : Number(r.item_cos),
        trgmSim: Number(r.trgm_sim),
        phonEq: r.phon_eq,
        phoneEq: false,
        aliasHit: r.alias_hit,
      },
    }));

    const top = candidates[0];
    const t = await thresholdsForScope(schema, kind, input.scope);
    const resolved =
      top && top.combined >= t.autoLink
        ? { entityId: top.entityId, confidence: top.combined, source: "autolink" as const }
        : undefined;

    await persistTelemetry(schema, input, candidates);

    return {
      candidates: candidates.filter((c) => c.combined >= t.suggest),
      queryTextNormalised: parsed.item_canonical,
      resolved,
    };
  }

  async function runConfirm(input: ConfirmInput): Promise<{ ok: true }> {
    const schema = schemaGen.projectSchemaName(input.project);
    const kind = sanitiseIdent(input.kind);
    const t = perProjectTables(schema);

    if (input.chosenEntityId !== null) {
      const chosenId = BigInt(input.chosenEntityId);
      const alias = input.queryText;

      await db
        .insert(t.nameAlias)
        .values({
          scopeJson: input.scope,
          entityKind: kind,
          entityId: chosenId,
          alias,
          aliasNormalised: sql`${SYS_NORMALISE}(${alias})`,
          source: "user-confirm",
          confidence: 1.0,
        })
        .onConflictDoNothing();

      await db
        .insert(t.pairHistory)
        .values({
          scopeJson: input.scope,
          entityKind: kind,
          entityId: chosenId,
          aliasNormalised: sql`${SYS_NORMALISE}(${input.queryText})`,
          confirmCount: 1,
        })
        .onConflictDoUpdate({
          target: [t.pairHistory.scopeJson, t.pairHistory.entityKind, t.pairHistory.entityId, t.pairHistory.aliasNormalised],
          set: {
            confirmCount: sql`${t.pairHistory.confirmCount} + 1`,
            lastAt: sql`now()`,
          },
        });
    }

    const chosenBigInt = input.chosenEntityId === null ? -1n : BigInt(input.chosenEntityId);
    await db
      .update(t.matchCandidate)
      .set({
        outcome: sql`CASE WHEN ${t.matchCandidate.candidateId} = ${chosenBigInt}::bigint THEN 'accepted' ELSE 'ignored' END`,
        outcomeAt: sql`now()`,
      })
      .where(
        and(
          eq(t.matchCandidate.queryText, input.queryText),
          eq(t.matchCandidate.queryKind, kind),
          sql`${t.matchCandidate.scopeJson} = ${JSON.stringify(input.scope)}::jsonb`,
          sql`${t.matchCandidate.outcome} IS NULL`,
          sql`${t.matchCandidate.createdAt} > now() - INTERVAL '5 minutes'`
        )
      );

    return { ok: true };
  }

  async function runDecline(input: DeclineInput): Promise<{ ok: true }> {
    const schema = schemaGen.projectSchemaName(input.project);
    const kind = sanitiseIdent(input.kind);
    const t = perProjectTables(schema);
    const declinedId = BigInt(input.declinedEntityId);

    await db
      .insert(t.pairHistory)
      .values({
        scopeJson: input.scope,
        entityKind: kind,
        entityId: declinedId,
        aliasNormalised: sql`${SYS_NORMALISE}(${input.queryText})`,
        declineCount: 1,
      })
      .onConflictDoUpdate({
        target: [t.pairHistory.scopeJson, t.pairHistory.entityKind, t.pairHistory.entityId, t.pairHistory.aliasNormalised],
        set: {
          declineCount: sql`${t.pairHistory.declineCount} + 1`,
          lastAt: sql`now()`,
        },
      });

    await db
      .update(t.matchCandidate)
      .set({ outcome: "declined", outcomeAt: sql`now()` })
      .where(
        and(
          eq(t.matchCandidate.queryText, input.queryText),
          eq(t.matchCandidate.queryKind, kind),
          sql`${t.matchCandidate.scopeJson} = ${JSON.stringify(input.scope)}::jsonb`,
          eq(t.matchCandidate.candidateId, declinedId),
          sql`${t.matchCandidate.outcome} IS NULL`,
          sql`${t.matchCandidate.createdAt} > now() - INTERVAL '1 day'`
        )
      );
    return { ok: true };
  }

  async function runDedup(input: DedupInput): Promise<{ clusters: DedupCluster[] }> {
    const schema = schemaGen.projectSchemaName(input.project);
    const kind = sanitiseIdent(input.kind);
    const scoreFloor = input.scoreFloor ?? 0.95;
    const minClusterSize = input.minClusterSize ?? 2;
    const limit = input.limit ?? 100;

    const dedupFn = sql`${sql.identifier(schema)}.${sql.identifier(`dedup_${kind}`)}`;
    const rows = await db.execute<{
      cluster_key: bigint;
      members: Array<{ id: string; name: string }>;
      total: number;
      min_score: number;
    }>(sql`
      SELECT cluster_key, members, total, min_score
      FROM ${dedupFn}(
        ${asJsonb(input.scope)}::jsonb,
        ${scoreFloor},
        ${minClusterSize},
        ${limit}
      )
    `);

    return {
      clusters: rows.map((r) => ({
        representative: { entityId: r.members[0]!.id, name: r.members[0]!.name },
        members: r.members.map((m) => ({ entityId: m.id, name: m.name })),
        totalCount: Number(r.total),
        estimatedConfidence: Number(r.min_score),
      })),
    };
  }

  async function runMatchBatch(input: MatchBatchInput): Promise<MatchBatchResult> {
    const schema = schemaGen.projectSchemaName(input.project);
    const kind = sanitiseIdent(input.kind);
    const entity = await projectsService.getEntityDef(input.project, input.kind);
    if (!entity) {
      throw new Error(`unknown entity kind '${input.kind}' in project '${input.project}'`);
    }

    const outcomes: MatchBatchOutcome[] = input.queries.map((q) => ({
      queryText: q.queryText,
      ref: q.ref ?? null,
      hitMethod: "no-match",
      candidates: [],
      combined: 0,
    }));

    function record(i: number, method: MatchHitMethod, entityId: string, name: string): void {
      outcomes[i] = {
        queryText: input.queries[i]!.queryText,
        ref: input.queries[i]!.ref ?? null,
        hitMethod: method,
        candidates: [
          {
            entityId,
            name,
            combined: 1.0,
            rrfScore: 0,
            components: {
              cosSim: null,
              trgmSim: 0,
              phonEq: method === "phonetic-unique",
              phoneEq: method === "phone-exact",
              aliasHit: method === "alias-hit",
            },
          },
        ],
        combined: 1.0,
      };
    }

    const scopeFragments: SQL[] = entity.scopes
      .filter((s) => input.scope[s] !== undefined)
      .map((s) => sql`e.${sql.identifier(sanitiseIdent(`scope_${s}`))} = ${input.scope[s]}`);
    const scopeWhere: SQL = scopeFragments.length === 0
      ? sql`TRUE`
      : sql.join(scopeFragments, sql` AND `);

    const nameField =
      Object.keys(entity.fields).find((f) => f.toLowerCase() === "name") ??
      Object.keys(entity.fields)[0]!;
    const nameCol = sql.identifier(sanitiseIdent(nameField));

    const valueRowFragments: SQL[] = input.queries.map(
      (q, i) => sql`(${i}::int, ${q.queryText}::text, ${q.phone ?? null}::text)`
    );
    const valuesCTE = sql`(VALUES ${sql.join(valueRowFragments, sql`, `)}) AS q(idx, query_text, phone)`;

    const entityTable = sql`${sql.identifier(schema)}.${sql.identifier(`entity_${kind}`)}`;
    const matchTable = sql`${sql.identifier(schema)}.${sql.identifier(`entity_${kind}_match`)}`;
    const aliasTable = sql`${sql.identifier(schema)}.name_alias`;
    const fkCol = sql.identifier(`${kind}_id`);

    // ── Wave 1: phone-exact ─────────────────────────────────────────────
    const phoneField = Object.keys(entity.fields).find((f) => f.toLowerCase() === "phone");
    if (phoneField) {
      const phoneCol = sql.identifier(sanitiseIdent(phoneField));
      const w1 = await db.execute<CheapWaveRow>(sql`
        SELECT q.idx::int AS q_idx, e.id AS entity_id, e.${nameCol} AS entity_name
        FROM ${valuesCTE}
        JOIN ${entityTable} e ON e.${phoneCol} = q.phone
        WHERE q.phone IS NOT NULL AND ${scopeWhere}
      `);
      for (const r of w1) {
        if (outcomes[Number(r.q_idx)]!.hitMethod === "no-match") {
          record(Number(r.q_idx), "phone-exact", String(r.entity_id), r.entity_name);
        }
      }
    }

    // ── Wave 2: name-exact (normalised) ─────────────────────────────────
    const w2 = await db.execute<CheapWaveRow>(sql`
      SELECT q.idx::int AS q_idx, e.id AS entity_id, e.${nameCol} AS entity_name
      FROM ${valuesCTE}
      JOIN ${matchTable} m
        ON m.name_normalised = ${SYS_NORMALISE}(q.query_text)
      JOIN ${entityTable} e ON e.id = m.${fkCol}
      WHERE ${scopeWhere}
    `);
    for (const r of w2) {
      if (outcomes[Number(r.q_idx)]!.hitMethod === "no-match") {
        record(Number(r.q_idx), "name-exact", String(r.entity_id), r.entity_name);
      }
    }

    // ── Wave 3: alias-hit ───────────────────────────────────────────────
    const w3 = await db.execute<CheapWaveRow>(sql`
      SELECT q.idx::int AS q_idx, na.entity_id, e.${nameCol} AS entity_name
      FROM ${valuesCTE}
      JOIN ${aliasTable} na
        ON na.alias_normalised = ${SYS_NORMALISE}(q.query_text)
       AND na.entity_kind = ${kind}
       AND na.scope_json = ${asJsonb(input.scope)}::jsonb
      JOIN ${entityTable} e ON e.id = na.entity_id
      WHERE ${scopeWhere}
    `);
    for (const r of w3) {
      if (outcomes[Number(r.q_idx)]!.hitMethod === "no-match") {
        record(Number(r.q_idx), "alias-hit", String(r.entity_id), r.entity_name);
      }
    }

    // ── Wave 4: phonetic-unique ─────────────────────────────────────────
    if (entity.phonetic) {
      const phonName = Object.keys(entity.phonetic)[0]!;
      const phonCol = sql.identifier(sanitiseIdent(phonName));
      const w4 = await db.execute<CheapWaveRow & { dup_count: number }>(sql`
        WITH cand AS (
          SELECT q.idx::int AS q_idx, e.id AS entity_id, e.${nameCol} AS entity_name,
                 COUNT(*) OVER (PARTITION BY q.idx) AS dup_count
          FROM ${valuesCTE}
          JOIN ${matchTable} m
            ON m.${phonCol} = ${SYS_PHONETIC}(q.query_text)
           AND m.${phonCol} IS NOT NULL
          JOIN ${entityTable} e ON e.id = m.${fkCol}
          WHERE ${scopeWhere}
        )
        SELECT DISTINCT q_idx, entity_id, entity_name, dup_count FROM cand WHERE dup_count = 1
      `);
      for (const r of w4) {
        if (outcomes[Number(r.q_idx)]!.hitMethod === "no-match") {
          record(Number(r.q_idx), "phonetic-unique", String(r.entity_id), r.entity_name);
        }
      }
    }

    // ── Wave 5: fallback per-row runMatch for survivors ─────────────────
    for (let i = 0; i < outcomes.length; i++) {
      if (outcomes[i]!.hitMethod !== "no-match") continue;
      const q = input.queries[i]!;
      try {
        const r = await runMatch({
          project: input.project,
          kind: input.kind,
          text: q.queryText,
          scope: input.scope,
          opts: { limit: 5, phone: q.phone },
        });
        const top = r.candidates[0];
        if (top) {
          outcomes[i] = {
            queryText: q.queryText,
            ref: q.ref ?? null,
            hitMethod: "combined-match",
            candidates: r.candidates,
            combined: top.combined,
          };
        }
      } catch (e) {
        ctx.observability.log("warn", "match-batch", "fallback failed", {
          index: i,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const counts: Record<MatchHitMethod, number> = {
      "phone-exact": 0,
      "name-exact": 0,
      "alias-hit": 0,
      "phonetic-unique": 0,
      "combined-match": 0,
      "no-match": 0,
    };
    for (const o of outcomes) counts[o.hitMethod]++;

    return { outcomes, counts };
  }

  return { runMatch, runConfirm, runDecline, runDedup, runMatchBatch, setScopeThresholds };
}

export type MatchService = ReturnType<typeof makeMatchService>;
