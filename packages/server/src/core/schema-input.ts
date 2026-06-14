import { z } from "zod";

// A schema declared on an enrich stage or NLQ config may be a zod schema or a
// plain JSON Schema object. This is the single point where that polymorphism is
// resolved: zod schemas are converted to JSON Schema; plain objects pass through
// untouched (and by reference, so stage cache keys stay stable). The resulting
// JSON Schema is what gets handed to the consumer's `generate` function.
//
// A genuine zod schema instance carries the internal `_zod` marker that
// `z.toJSONSchema` reads. We detect on that rather than on `~standard`, because
// zod's `toJSONSchema` OUTPUT is itself a Standard Schema (vendor "zod", with a
// `validate` fn) yet lacks `_zod` — so a converted object must NOT be re-converted.
// Detecting `_zod` keeps normalizeSchema idempotent and works across zod copies.
type StandardSchema = { "~standard": { vendor?: string; validate: unknown } };

function isZodSchema(x: unknown): x is z.ZodType {
  return !!x && typeof x === "object" && "_zod" in x;
}

function isStandardSchema(x: unknown): x is StandardSchema {
  return (
    !!x &&
    typeof x === "object" &&
    "~standard" in x &&
    typeof (x as StandardSchema)["~standard"]?.validate === "function"
  );
}

export function normalizeSchema(input: unknown): Record<string, unknown> {
  if (isZodSchema(input)) {
    return z.toJSONSchema(input) as Record<string, unknown>;
  }
  if (isStandardSchema(input) && input["~standard"].vendor !== "zod") {
    throw new Error(
      `samesake can auto-convert zod schemas to JSON Schema; got a "${input["~standard"].vendor}" ` +
        `Standard Schema. Pass a plain JSON Schema object instead.`
    );
  }
  return (input ?? {}) as Record<string, unknown>;
}
