// A Rule Pack is the entire per-company domain as serializable data: which attributes
// exist, how to canonicalize trade shorthand, how to match, and how to price — either
// against a catalog or straight from attribute rules. Authored as YAML, validated here,
// stored in the DB as JSON. See issue #60 + ADR-0003.
import { z } from "zod";

export const AttributeDef = z.object({
  key: z.string(),
  type: z.enum(["number", "enum", "string"]),
  label: z.string(),
  /** allowed values for enum attributes (e.g. poles: SP/DP/TP/TPN/4P) */
  values: z.array(z.string()).optional(),
});

/** A prefix/attribute pricing rule (catalog-less mode): when these attributes match,
 *  price each unit by `perUnit` — a number, or a safe formula over attribute keys. */
export const PrefixRule = z.object({
  label: z.string().optional(),
  when: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])),
  perUnit: z.union([z.number(), z.string()]),
});

const Tier = z.object({ label: z.string(), discount: z.number() });
const QtyBreak = z.object({ category: z.string(), minQty: z.number(), extraDiscount: z.number() });
const Tax = z.object({ label: z.string(), rate: z.number() });

export const PricingDef = z.object({
  strategy: z.enum(["catalog", "prefix-rules"]),
  tiers: z.record(z.string(), Tier),
  categoryMarkup: z.record(z.string(), z.number()).default({}),
  brandMargin: z.record(z.string(), z.number()).default({}),
  qtyBreaks: z.array(QtyBreak).default([]),
  taxes: z.array(Tax),
  priceDecimals: z.number().default(2),
  validityDays: z.number().default(14),
  /** required when strategy = prefix-rules; first matching rule wins */
  rules: z.array(PrefixRule).default([]),
});

export const RulePackSchema = z
  .object({
    vertical: z.string(),
    attributes: z.array(AttributeDef),
    /** group -> { lowercased variant : canonical }. `poles` drives the gate's
     *  canonicalization; the whole map seeds the normalization prompt. */
    synonyms: z.record(z.string(), z.record(z.string(), z.string())).default({}),
    /** stated unit -> multiplier to the canonical unit (coil: 100) */
    units: z.record(z.string(), z.number()).default({}),
    matching: z.object({
      hard: z.array(z.string()),
      weights: z.object({ cosine: z.number(), trigram: z.number() }),
      autoLink: z.number(),
      suggest: z.number(),
    }),
    pricing: PricingDef,
  })
  .refine((p) => p.pricing.strategy !== "prefix-rules" || p.pricing.rules.length > 0, {
    message: "prefix-rules strategy requires pricing.rules",
    path: ["pricing", "rules"],
  });

export type RulePack = z.infer<typeof RulePackSchema>;
export type PrefixRuleT = z.infer<typeof PrefixRule>;
