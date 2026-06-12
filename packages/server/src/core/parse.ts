// Structured-parse service factory.
//
// Calls the consumer's parse function (ctx.parse) with samesake's product
// schema + default prompt, validates the result, and caches it. @samesake/server
// owns the schema (the SQL match function depends on its column shape) but is
// agnostic about HOW the consumer calls their LLM.
//
// Consumers can override the system prompt per-entity via ParseDef.instructions,
// useful for domain tuning (medications vs grocery vs hardware). The schema is
// always ParsedProductSchema.
import { z } from "zod";
import { createHash } from "node:crypto";
import type { MatcherCtx } from "../types.ts";
import { makeParseCacheService } from "../db/parse-cache.ts";

export const ParsedProductSchema = z.object({
  brand: z.string().nullable(),
  brand_normalised: z.string().nullable(),
  item: z.string(),
  item_canonical: z.string(),
  variant: z.string().nullable(),
  size_value: z.number().nullable(),
  size_unit: z.string().nullable(),
  internal_code: z.string().nullable(),
  namespace_prefix: z.string().nullable(),
  parser_confidence: z.number().min(0).max(1),
});
export type ParsedProduct = z.infer<typeof ParsedProductSchema>;

/**
 * Schema contract block — ALWAYS prepended to whatever prompt the consumer
 * supplies (or to the framework's own DEFAULT_PRODUCT_PARSE_BODY when no
 * override is given). The framework owns this; consumers don't restate it.
 *
 * Keep it short, schema-only, no domain content. Bumping this constitutes
 * a breaking-default change in @samesake/server (it shifts the parse-cache
 * key for every existing entity).
 */
export const PRODUCT_PARSE_SCHEMA_CONTRACT = `<schema_contract>
Return exactly this JSON shape:
{ brand, brand_normalised, item, item_canonical, variant, size_value,
  size_unit, internal_code, namespace_prefix, parser_confidence }
- 'item' preserves the input's ORIGINAL script verbatim
- 'item_canonical' is lowercase Latin (transliterate / translate ONLY for this field)
- 'brand_normalised' is lowercase Latin
- 'size_value' / 'size_unit' is product VARIANT SIZE, not transaction quantity
- Every field except 'item', 'item_canonical', and 'parser_confidence' is nullable.
  Use null when the field is genuinely absent — do not invent.
- 'parser_confidence' is calibrated 0-1:
    1.0     every applicable field clean
    0.7-0.9 optional fields uncertain; required clean
    0.4-0.6 significant uncertainty; only 'item' solid
    0.1-0.3 not a product name at all
</schema_contract>`;

/**
 * Minimal generic body used when the consuming entity does NOT supply a
 * parse.instructions override. Deliberately framework-only — no domain
 * examples, no language-specific rules, no currency conventions. The
 * Sri Lankan SME content, OCR digit-letter rules, Sinhala/Tamil
 * examples, etc. live in the CONSUMING APP's entity declaration via
 * the `parse.instructions` override. That separation is intentional;
 * see CHANGELOG 0.5.4 for the rationale.
 *
 * The parseService ALWAYS prepends PRODUCT_PARSE_SCHEMA_CONTRACT to the
 * final prompt, so consumer overrides need only carry domain context
 * (role + examples + extraction heuristics).
 */
export const DEFAULT_PRODUCT_PARSE_BODY = `<role>
You parse one retail / inventory product NAME (a single line) into the
structured record below. Faithful extraction is your only job — you do
not match, deduplicate, or judge.
</role>`;

/**
 * @deprecated Use PRODUCT_PARSE_SCHEMA_CONTRACT + your own role/examples
 * via the entity's parse.instructions override. Kept as an alias for
 * 0.4.x callers; will be removed in 0.7.x.
 */
export const DEFAULT_PRODUCT_PARSE_INSTRUCTIONS = DEFAULT_PRODUCT_PARSE_BODY;

export interface ParseOptions {
  model?: string;
  instructions?: string;
}

export function makeParseService(ctx: MatcherCtx) {
  const cache = makeParseCacheService(ctx);
  const { parse: userParse } = ctx;

  async function parseProductName(
    rawName: string,
    opts: ParseOptions = {}
  ): Promise<ParsedProduct> {
    // The framework's PRODUCT_PARSE_SCHEMA_CONTRACT is ALWAYS prepended.
    // Consumer overrides via opts.instructions provide only the
    // domain-specific body (role + examples + extraction heuristics).
    // This keeps "what fields go in/out" (framework) cleanly separated
    // from "how to read a Sri Lankan stockbook page" (app concern).
    const body = opts.instructions ?? DEFAULT_PRODUCT_PARSE_BODY;
    const instructions = `${PRODUCT_PARSE_SCHEMA_CONTRACT}\n\n${body}`;
    const model = opts.model ?? "<default>";
    // Cache key includes the model + a hash of the instructions so that
    // swapping the prompt per-entity invalidates the cache cleanly.
    const instructionsHash = createHash("sha1").update(instructions).digest("hex").slice(0, 8);
    const key = `parse:${model}:${instructionsHash}:${createHash("sha1").update(rawName).digest("hex")}`;

    const cached = await cache.getParseCache(key);
    if (cached) {
      const parsed = ParsedProductSchema.safeParse(cached);
      if (parsed.success) return parsed.data;
    }

    // Retry-with-backoff on transient consumer-side failures. Gemini under
    // load returns "model experiencing high demand" errors that resolve on
    // retry; without this loop, the caller (typically upsert.ts) gets one
    // shot and silently stores a NULL-parse row, which then becomes
    // un-matchable in production downstream because the brand_gate /
    // size_unit_gate channels in the generated SQL key off the parsed
    // fields. Backoff: 0.3s, 1s, 3s — total worst case ~4.3s.
    const RETRY_DELAYS_MS = [300, 1000, 3000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const object = await userParse({
          text: rawName,
          schema: ParsedProductSchema,
          instructions,
          model: opts.model,
        });
        const validated = ParsedProductSchema.parse(object);
        await cache.setParseCache(key, validated, `${model}:${instructionsHash}`);
        return validated;
      } catch (e) {
        lastErr = e;
        if (attempt < RETRY_DELAYS_MS.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
        }
      }
    }
    throw new Error(
      `parseProductName: failed after ${RETRY_DELAYS_MS.length + 1} attempts for ${JSON.stringify(rawName)}: ` +
      (lastErr instanceof Error ? lastErr.message : String(lastErr))
    );
  }

  return { parseProductName };
}

export type ParseService = ReturnType<typeof makeParseService>;
