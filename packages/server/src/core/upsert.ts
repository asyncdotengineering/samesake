import { sql, type SQL } from "drizzle-orm";
import type { EntityDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import type { EmbedService } from "./embed.ts";
import type { ParseService } from "./parse.ts";
import type { SchemaGen } from "./schema-gen.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { toVectorLiteral } from "./embed.ts";
import { resolveSource } from "./source.ts";
import type { ParsedProduct } from "./parse.ts";

export interface UpsertItem {
  id?: string;
  scope: Record<string, string>;
  data: Record<string, unknown>;
}

export interface UpsertContext {
  project: string;
  entity: EntityDef;
}

export function makeUpsertService(
  ctx: MatcherCtx,
  embedService: EmbedService,
  parseService: ParseService,
  schemaGen: SchemaGen
) {
  const db = ctx.storage.db;
  const SYS = ctx.schema;

  async function upsertOne(
    uctx: UpsertContext,
    item: UpsertItem
  ): Promise<{ id: string }> {
    const schema = schemaGen.projectSchemaName(uctx.project);
    const kind = sanitiseIdent(uctx.entity.name!);

    const nameField =
      Object.keys(uctx.entity.fields).find((f) => f.toLowerCase() === "name") ??
      Object.keys(uctx.entity.fields)[0]!;
    const nameValue = String(item.data[nameField] ?? "");

    const entityPairs: Array<[string, unknown]> = [];
    if (item.id) entityPairs.push(["external_id", item.id]);
    for (const s of uctx.entity.scopes) {
      entityPairs.push([sanitiseIdent(`scope_${s}`), item.scope[s] ?? ""]);
    }
    for (const [k, v] of Object.entries(item.data)) {
      entityPairs.push([sanitiseIdent(k), v]);
    }

    const entityTable = sql`${sql.identifier(schema)}.${sql.identifier(`entity_${kind}`)}`;
    const colFragments: SQL[] = entityPairs.map(([c]) => sql`${sql.identifier(c)}`);
    const valFragments: SQL[] = entityPairs.map(([, v]) => sql`${v}`);
    const setFragments: SQL[] = entityPairs
      .filter(([c]) => c !== "external_id")
      .map(([c]) => sql`${sql.identifier(c)} = EXCLUDED.${sql.identifier(c)}`);

    const onConflict: SQL = item.id
      ? sql`ON CONFLICT (external_id) DO UPDATE SET ${sql.join(setFragments, sql`, `)}, updated_at = now()`
      : sql``;

    const inserted = await db.execute<{ id: bigint }>(sql`
      INSERT INTO ${entityTable} (${sql.join(colFragments, sql`, `)})
      VALUES (${sql.join(valFragments, sql`, `)})
      ${onConflict}
      RETURNING id
    `);
    const id = inserted[0]!.id;

    // For parse-shape entities the brand_gate / size_unit_gate / item_canonical
    // embedding all depend on the parsed result. A silent fallback to
    // parsed=null would store a row with NULL brand/item/size — that row is
    // then un-matchable by any of those channels downstream. So we let the
    // error propagate. parseService already retries with backoff for transient
    // failures; if it throws here, the caller (seed / API route) should
    // surface it (or retry) rather than persist a half-populated row.
    let parsed: ParsedProduct | null = null;
    if (uctx.entity.parse) {
      parsed = await parseService.parseProductName(nameValue, {
        model: uctx.entity.parse.model,
        instructions: uctx.entity.parse.instructions,
      });
    }

    const mergedData = parsed ? { ...item.data, ...parsed } : item.data;

    const embedValues: Record<string, number[]> = {};
    if (uctx.entity.embeddings) {
      for (const [name, def] of Object.entries(uctx.entity.embeddings)) {
        const sourceText = resolveSource(def.source, mergedData);
        if (sourceText && sourceText.trim()) {
          const vec = await embedService.embedQuery({
            text: sourceText,
            model: def.model,
            dim: def.dim,
            taskType: def.taskType,
            inputType: "document",
          });
          embedValues[name] = vec;
        }
      }
    }

    const phonValues: Record<string, string> = {};
    if (uctx.entity.phonetic) {
      for (const [name, def] of Object.entries(uctx.entity.phonetic)) {
        const text = resolveSource(def.source, mergedData);
        const r = await db.execute<{ h: string }>(
          sql`SELECT ${sql.identifier(SYS)}.samesake_phonetic(${text}) AS h`
        );
        if (r[0]) phonValues[name] = r[0].h;
      }
    }

    const fkCol = `${kind}_id`;
    const firstEmbModel = uctx.entity.embeddings
      ? (() => {
          const def = Object.values(uctx.entity.embeddings!)[0]!;
          return `${def.model}@${def.dim}`;
        })()
      : null;

    const matchCols: SQL[] = [
      sql`${sql.identifier(fkCol)}`,
      sql`name_normalised`,
      sql`embedding_model`,
      sql`embedded_at`,
    ];
    const matchVals: SQL[] = [
      sql`${id}`,
      sql`${sql.identifier(SYS)}.samesake_normalise(${nameValue})`,
      sql`${firstEmbModel}`,
      sql`now()`,
    ];

    if (uctx.entity.parse && parsed) {
      const parseColumns: Array<[string, unknown]> = [
        ["brand", parsed.brand],
        ["brand_normalised", parsed.brand_normalised],
        ["item", parsed.item],
        ["item_canonical", parsed.item_canonical],
        ["variant", parsed.variant],
        ["size_value", parsed.size_value],
        ["size_unit", parsed.size_unit],
        ["internal_code", parsed.internal_code],
        ["namespace_prefix", parsed.namespace_prefix],
        ["parser_confidence", parsed.parser_confidence],
      ];
      for (const [col, val] of parseColumns) {
        matchCols.push(sql`${sql.identifier(col)}`);
        matchVals.push(sql`${val}`);
      }
    }

    for (const [name, vec] of Object.entries(embedValues)) {
      matchCols.push(sql`${sql.identifier(sanitiseIdent(name))}`);
      matchVals.push(sql`${toVectorLiteral(vec)}::vector`);
    }
    for (const [name, hash] of Object.entries(phonValues)) {
      matchCols.push(sql`${sql.identifier(sanitiseIdent(name))}`);
      matchVals.push(sql`${hash}`);
    }

    const matchSetFragments = matchCols
      .map((c, i) => ({ c, i }))
      .filter((_, i) => i !== 0)
      .map(({ c }) => sql`${c} = EXCLUDED.${c}`);

    const matchTable = sql`${sql.identifier(schema)}.${sql.identifier(`entity_${kind}_match`)}`;

    await db.execute(sql`
      INSERT INTO ${matchTable} (${sql.join(matchCols, sql`, `)})
      VALUES (${sql.join(matchVals, sql`, `)})
      ON CONFLICT (${sql.identifier(fkCol)}) DO UPDATE SET ${sql.join(matchSetFragments, sql`, `)}
    `);

    return { id: String(id) };
  }

  async function upsertBatch(
    uctx: UpsertContext,
    items: UpsertItem[]
  ): Promise<{ ids: string[] }> {
    const ids: string[] = [];
    for (const it of items) {
      const r = await upsertOne(uctx, it);
      ids.push(r.id);
    }
    return { ids };
  }

  return { upsertOne, upsertBatch };
}

export type UpsertService = ReturnType<typeof makeUpsertService>;
