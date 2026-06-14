import { z } from "zod";

// A schema declared on an enrich stage or NLQ config may be a zod schema or a
// plain JSON Schema object. This is the single point where that polymorphism is
// resolved: zod schemas are converted to JSON Schema; plain objects pass through
// untouched (and by reference, so stage cache keys stay stable). The resulting
// JSON Schema is what gets handed to the consumer's `generate` function.
type StandardSchemaLike = { "~standard"?: { vendor?: string } };

export function normalizeSchema(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && "~standard" in input) {
    const vendor = (input as StandardSchemaLike)["~standard"]?.vendor;
    if (vendor === "zod") {
      return z.toJSONSchema(input as z.ZodType) as Record<string, unknown>;
    }
    throw new Error(
      `samesake can auto-convert zod schemas to JSON Schema; got a "${vendor}" Standard Schema. ` +
        `Pass a plain JSON Schema object instead.`
    );
  }
  return (input ?? {}) as Record<string, unknown>;
}
