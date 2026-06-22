// Variant-suggestion: group same brand + item_canonical into clusters.
// Only meaningful for entities with `parse:` declared.
import { sql, type SQL } from "drizzle-orm";
import type { MatcherCtx } from "../types.ts";
import type { ProjectsService } from "./projects.ts";
import type { SchemaGen } from "./schema-gen.ts";
import { sanitiseIdent } from "./schema-gen.ts";

type VariantGroupRow = {
  group_brand: string;
  group_item: string;
  members: Array<{
    id: string;
    name: string;
    variant: string | null;
    size_value: number | null;
    size_unit: string | null;
  }>;
  member_count: number;
};

export interface VariantInput {
  project: string;
  kind: string;
  scope: Record<string, string>;
  minClusterSize?: number;
  limit?: number;
}

export interface VariantSuggestion {
  proposedBase: {
    brand: string | null;
    itemCanonical: string;
    suggestedName: string;
  };
  detectedAxes: Array<{
    axis: "size" | "variant";
    distinctValues: string[];
  }>;
  members: Array<{
    entityId: string;
    name: string;
    variant: string | null;
    size: { value: number | null; unit: string | null };
  }>;
  totalCount: number;
}

export function makeVariantsService(
  ctx: MatcherCtx,
  projectsService: ProjectsService,
  schemaGen: SchemaGen
) {
  const db = ctx.storage.db;

  return {
    async runVariants(input: VariantInput): Promise<{ suggestions: VariantSuggestion[] }> {
      const schema = schemaGen.projectSchemaName(input.project);
      const kind = sanitiseIdent(input.kind);
      const minClusterSize = input.minClusterSize ?? 3;
      const limit = input.limit ?? 50;

      const entity = await projectsService.getEntityDef(input.project, input.kind);
      if (!entity || !entity.parse) {
        return { suggestions: [] };
      }

      const nameField =
        Object.keys(entity.fields).find((f) => f.toLowerCase() === "name") ??
        Object.keys(entity.fields)[0]!;
      const nameCol = sql.identifier(sanitiseIdent(nameField));

      const scopeKeys = Object.keys(input.scope);
      const scopeFragments: SQL[] = scopeKeys.map(
        (k) => sql`e.${sql.identifier(sanitiseIdent(`scope_${k}`))} = ${input.scope[k]}`
      );
      const scopeWhere: SQL = scopeFragments.length === 0
        ? sql`TRUE`
        : sql.join(scopeFragments, sql` AND `);

      const entityTable = sql`${sql.identifier(schema)}.${sql.identifier(`entity_${kind}`)}`;
      const matchTable = sql`${sql.identifier(schema)}.${sql.identifier(`entity_${kind}_match`)}`;
      const fkCol = sql.identifier(`${kind}_id`);

      const groups = await db.execute<VariantGroupRow>(sql`
        SELECT
          COALESCE(m.brand_normalised, '__null__') AS group_brand,
          m.item_canonical AS group_item,
          jsonb_agg(jsonb_build_object(
            'id', e.id::text,
            'name', e.${nameCol},
            'variant', m.variant,
            'size_value', m.size_value,
            'size_unit', m.size_unit
          )) AS members,
          COUNT(*)::int AS member_count
        FROM ${entityTable} e
        JOIN ${matchTable} m ON m.${fkCol} = e.id
        WHERE ${scopeWhere}
          AND m.item_canonical IS NOT NULL
        GROUP BY COALESCE(m.brand_normalised, '__null__'), m.item_canonical
        HAVING COUNT(*) >= ${minClusterSize}
        ORDER BY member_count DESC
        LIMIT ${limit}
      `);

      return {
        suggestions: groups.map((g) => {
          const brand = g.group_brand === "__null__" ? null : g.group_brand;
          const variants = [...new Set(g.members.map((m) => m.variant).filter((v): v is string => !!v))];
          const sizes = [
            ...new Set(
              g.members
                .filter((m) => m.size_value !== null)
                .map((m) => `${m.size_value}${m.size_unit ?? ""}`)
            ),
          ];
          const axes: Array<{ axis: "size" | "variant"; distinctValues: string[] }> = [];
          if (variants.length >= 2) axes.push({ axis: "variant", distinctValues: variants });
          if (sizes.length >= 2) axes.push({ axis: "size", distinctValues: sizes });

          const suggestedName = brand
            ? `${brand[0]!.toUpperCase()}${brand.slice(1)} ${g.group_item}`
            : g.group_item;

          return {
            proposedBase: { brand, itemCanonical: g.group_item, suggestedName },
            detectedAxes: axes,
            members: g.members.map((m) => ({
              entityId: m.id,
              name: m.name,
              variant: m.variant,
              size: { value: m.size_value, unit: m.size_unit },
            })),
            totalCount: Number(g.member_count),
          };
        }),
      };
    },
  };
}

export type VariantsService = ReturnType<typeof makeVariantsService>;
