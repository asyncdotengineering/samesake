// Explain endpoint — for a given (queryText, candidateId), return the full
// per-channel scoring breakdown.
import { sql } from "drizzle-orm";
import type { MatcherCtx } from "../types.ts";
import type { EmbedService } from "./embed.ts";
import type { ProjectsService } from "./projects.ts";
import type { SchemaGen } from "./schema-gen.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { toVectorLiteral } from "./embed.ts";
import { normaliseName } from "./normalise.ts";

export interface ExplainInput {
  project: string;
  kind: string;
  queryText: string;
  candidateId: string;
  scope: Record<string, string>;
  phone?: string;
}

export interface ExplainResult {
  query: { text: string; normalised: string };
  candidate: { entityId: string; name: string };
  scores: {
    cosSim: { value: number | null; weight: number; contribution: number };
    trgmSim: { value: number; weight: number; contribution: number };
    phonEq: { value: boolean; weight: number; contribution: number };
    phoneEq: { value: boolean; weight: number; contribution: number };
    aliasHit: { value: boolean; weight: number; contribution: number };
  };
  combined: number;
  decision: "auto-link" | "suggest" | "below-threshold";
  decisiveChannels: string[];
  thresholds: { autoLink: number; suggest: number };
}

const W = { phone: 1.0, cosine: 0.6, trgm: 0.25, phon: 0.2, alias: 0.4 } as const;
const AUTO_LINK = 0.92;
const SUGGEST = 0.55;

function combine(p: { phoneEq: boolean; cosSim: number | null; trgmSim: number; phonEq: boolean; aliasHit: boolean }): number {
  const cos = p.cosSim ?? 0;
  return (
    1 -
    (1 - (p.phoneEq ? 1 : 0)) *
      (1 - W.cosine * Math.max(cos, 0)) *
      (1 - W.trgm * Math.max(p.trgmSim, 0)) *
      (1 - W.phon * (p.phonEq ? 1 : 0)) *
      (1 - W.alias * (p.aliasHit ? 1 : 0))
  );
}

export function makeExplainService(
  ctx: MatcherCtx,
  embedService: EmbedService,
  projectsService: ProjectsService,
  schemaGen: SchemaGen
) {
  const db = ctx.storage.db;
  const SYS = ctx.schema;

  return {
    async runExplain(input: ExplainInput): Promise<ExplainResult> {
      const schema = schemaGen.projectSchemaName(input.project);
      const kind = sanitiseIdent(input.kind);

      const entity = await projectsService.getEntityDef(input.project, input.kind);
      if (!entity) throw new Error(`unknown entity kind '${input.kind}'`);
      const firstEmbedding = entity.embeddings ? Object.values(entity.embeddings)[0] : undefined;
      if (!firstEmbedding) throw new Error(`entity '${input.kind}' has no embedding`);

      const candidateIdNum = BigInt(input.candidateId);

      const candRows = await db.execute<{ name: string }>(sql`
        SELECT name FROM ${sql.identifier(schema)}.${sql.identifier(`entity_${kind}`)}
        WHERE id = ${candidateIdNum}
      `);
      if (candRows.length === 0) throw new Error(`candidate ${input.candidateId} not found`);
      const candidateName = candRows[0]!.name;

      const queryEmb = await embedService.embedQuery({
        text: input.queryText,
        model: firstEmbedding.model,
        dim: firstEmbedding.dim,
        taskType: firstEmbedding.taskType,
      });
      const embLit = toVectorLiteral(queryEmb);

      const firstEmbName = Object.keys(entity.embeddings!)[0]!;
      const firstEmbCol = sql.identifier(sanitiseIdent(firstEmbName));
      const firstPhonName = entity.phonetic ? Object.keys(entity.phonetic)[0] : null;
      const phoneField = Object.keys(entity.fields).find((f) => f.toLowerCase() === "phone");

      const phonEqExpr = firstPhonName
        ? sql`(m.${sql.identifier(sanitiseIdent(firstPhonName))} = (SELECT phon FROM q))`
        : sql`FALSE`;

      const phoneEqExpr = phoneField && input.phone
        ? sql`(e.${sql.identifier(sanitiseIdent(phoneField))} = ${input.phone})`
        : sql`FALSE`;

      const rows = await db.execute<{
        cos_sim: number | null;
        trgm_sim: number;
        phon_eq: boolean;
        phone_eq: boolean;
        alias_hit: boolean;
      }>(sql`
        WITH q AS (
          SELECT ${sql.identifier(SYS)}.samesake_normalise(${input.queryText}) AS norm,
                 ${sql.identifier(SYS)}.samesake_phonetic(${input.queryText}) AS phon
        )
        SELECT
          CASE WHEN m.${firstEmbCol} IS NOT NULL
            THEN 1 - (m.${firstEmbCol} <=> ${embLit}::vector)
            ELSE NULL END AS cos_sim,
          CASE WHEN m.name_normalised IS NOT NULL
            THEN similarity((SELECT norm FROM q), m.name_normalised)
            ELSE 0::real END AS trgm_sim,
          ${phonEqExpr} AS phon_eq,
          ${phoneEqExpr} AS phone_eq,
          EXISTS (
            SELECT 1 FROM ${sql.identifier(schema)}.name_alias na
            WHERE na.entity_kind = ${kind}
              AND na.entity_id = ${candidateIdNum}
              AND na.alias_normalised = (SELECT norm FROM q)
          ) AS alias_hit
        FROM ${sql.identifier(schema)}.${sql.identifier(`entity_${kind}`)} e
        LEFT JOIN ${sql.identifier(schema)}.${sql.identifier(`entity_${kind}_match`)} m
          ON m.${sql.identifier(`${kind}_id`)} = e.id
        WHERE e.id = ${candidateIdNum}
      `);

      if (rows.length === 0) throw new Error(`candidate ${input.candidateId} not found in match state`);
      const r = rows[0]!;
      const cos = r.cos_sim === null ? null : Number(r.cos_sim);
      const trgm = Number(r.trgm_sim);
      const combined = combine({
        phoneEq: r.phone_eq,
        cosSim: cos,
        trgmSim: trgm,
        phonEq: r.phon_eq,
        aliasHit: r.alias_hit,
      });

      const decisive: string[] = [];
      const baseInputs = { phoneEq: r.phone_eq, cosSim: cos, trgmSim: trgm, phonEq: r.phon_eq, aliasHit: r.alias_hit };
      if (combined >= AUTO_LINK) {
        for (const k of ["cosine", "trgm", "phonetic", "phone", "alias"] as const) {
          const without = { ...baseInputs };
          if (k === "cosine") without.cosSim = 0;
          if (k === "trgm") without.trgmSim = 0;
          if (k === "phonetic") without.phonEq = false;
          if (k === "phone") without.phoneEq = false;
          if (k === "alias") without.aliasHit = false;
          if (combine(without) < AUTO_LINK) decisive.push(k);
        }
      }

      return {
        query: { text: input.queryText, normalised: normaliseName(input.queryText) },
        candidate: { entityId: input.candidateId, name: candidateName },
        scores: {
          cosSim: {
            value: cos,
            weight: W.cosine,
            contribution: cos !== null ? W.cosine * Math.max(cos, 0) : 0,
          },
          trgmSim: { value: trgm, weight: W.trgm, contribution: W.trgm * Math.max(trgm, 0) },
          phonEq: { value: r.phon_eq, weight: W.phon, contribution: r.phon_eq ? W.phon : 0 },
          phoneEq: { value: r.phone_eq, weight: W.phone, contribution: r.phone_eq ? W.phone : 0 },
          aliasHit: { value: r.alias_hit, weight: W.alias, contribution: r.alias_hit ? W.alias : 0 },
        },
        combined,
        decision: combined >= AUTO_LINK ? "auto-link" : combined >= SUGGEST ? "suggest" : "below-threshold",
        decisiveChannels: decisive,
        thresholds: { autoLink: AUTO_LINK, suggest: SUGGEST },
      };
    },
  };
}

export type ExplainService = ReturnType<typeof makeExplainService>;
