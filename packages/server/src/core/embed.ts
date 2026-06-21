import { createHash } from "node:crypto";
import { eq, and, gt, sql } from "drizzle-orm";
import type { EmbedRequest, MatcherCtx } from "../types.ts";
import { callWithRetry } from "./policy.ts";

const CACHE_TTL_DAYS = 90;

function imageCacheMaterial(req: NonNullable<EmbedRequest["image"]>): string {
  if (req.url) {
    return createHash("sha1").update(req.url).digest("hex");
  }
  if (req.bytes?.length) {
    return createHash("sha1").update(req.bytes).digest("hex");
  }
  return "";
}

function cacheKey(model: string, dim: number, req: EmbedRequest): string {
  if (req.image) {
    const hash = imageCacheMaterial(req.image);
    return `${model}@${dim}:img:${hash}`;
  }
  const hash = createHash("sha1").update(req.text ?? "").digest("hex");
  return `${model}@${dim}:${hash}`;
}

function hasEmbedModality(req: EmbedRequest): boolean {
  const hasText = typeof req.text === "string" && req.text.length > 0;
  const hasImage =
    !!req.image &&
    (!!req.image.url || (req.image.bytes != null && req.image.bytes.length > 0));
  return hasText !== hasImage;
}

export const IMAGE_EMBED_CAPABILITY_ERROR =
  "createMatcher's `embed` does not handle image inputs, but a collection declared an s.image space.\n\n" +
  "Extend your embed function to accept optional `image: { url?, bytes?, mimeType? }` " +
  "(exactly one of text or image per request). Example using Gemini multimodal embedContent:\n\n" +
  "  createMatcher({\n" +
  "    /* ...db, apiKey... */\n" +
  "    embed: async ({ text, image, model, dim, taskType, inputType }) => {\n" +
  "      if (image) {\n" +
  "        const parts = image.bytes\n" +
  "          ? [{ inline_data: { mime_type: image.mimeType ?? \"image/jpeg\",\n" +
  "              data: Buffer.from(image.bytes).toString(\"base64\") } }]\n" +
  "          : [{ file_data: { file_uri: image.url } }];\n" +
  "        const res = await fetch(\n" +
  "          `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,\n" +
  "          { method: \"POST\", headers: { \"Content-Type\": \"application/json\",\n" +
  "              \"x-goog-api-key\": process.env.GEMINI_API_KEY! },\n" +
  "            body: JSON.stringify({ model: `models/${model}`, content: { parts },\n" +
  "              taskType: taskType ?? \"RETRIEVAL_DOCUMENT\", outputDimensionality: dim }) }\n" +
  "        );\n" +
  "        const { embedding } = await res.json();\n" +
  "        return embedding.values;\n" +
  "      }\n" +
  "      // ...existing text embed path\n" +
  "    },\n" +
  "  });\n\n" +
  "Or remove the s.image space from collections that do not need image embeddings.";

export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

export function parseVector(s: string): number[] {
  const inner = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s;
  return inner
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x));
}

export function makeEmbedService(ctx: MatcherCtx) {
  const { systemTables, embed: userEmbed } = ctx;
  const db = ctx.storage.db;
  const cache = systemTables.samesakeEmbedCache;

  async function embedQuery(req: EmbedRequest): Promise<number[]> {
    if (!hasEmbedModality(req)) {
      throw new Error("embed requires exactly one of text or image");
    }

    const key = cacheKey(req.model, req.dim, req);

    const cached = await db
      .select({ embedding: sql<string>`${cache.embedding}::text` })
      .from(cache)
      .where(and(eq(cache.cacheKey, key), gt(cache.expiresAt, sql`now()`)))
      .limit(1);
    if (cached[0]?.embedding) {
      ctx.observability.inc("embed_cache_hits");
      return parseVector(cached[0].embedding);
    }

    let vec: number[];
    try {
      ctx.observability.inc("embed_calls_total");
      const result = await callWithRetry(() => userEmbed(req), ctx.policy.embed);
      if (!Array.isArray(result)) {
        throw new Error(`returned ${typeof result}`);
      }
      vec = result;
    } catch (e) {
      if (req.image) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("s.image space")) {
          throw new Error(`${IMAGE_EMBED_CAPABILITY_ERROR}\n\nUnderlying error: ${msg}`);
        }
      }
      throw e;
    }

    if (!Array.isArray(vec) || vec.length !== req.dim) {
      throw new Error(
        `createMatcher.embed returned dim ${Array.isArray(vec) ? vec.length : typeof vec}, ` +
          `expected ${req.dim} (model="${req.model}"). Check your embed function's output shape.`
      );
    }

    const vecLit = toVectorLiteral(vec);
    const modelTag = `${req.model}@${req.dim}`;
    const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 24 * 3600 * 1000);
    await db
      .insert(cache)
      .values({ cacheKey: key, embedding: vecLit, model: modelTag, expiresAt })
      .onConflictDoUpdate({
        target: cache.cacheKey,
        set: { embedding: vecLit, model: modelTag, expiresAt },
      });

    return vec;
  }

  return { embedQuery };
}

export type EmbedService = ReturnType<typeof makeEmbedService>;
export type { EmbedRequest };
