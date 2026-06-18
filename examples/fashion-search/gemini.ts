import type { EmbedFn, GenerateFn } from "@samesake/server";
import { fetchImageBytes } from "../../packages/server/src/core/fetch-image.ts";

const KEY = process.env.GEMINI_API_KEY;
const EMB_MODEL = "gemini-embedding-2";
const STAGE1_MODEL = "gemini-3.1-flash-lite";
const STAGE2_MODEL = "gemini-3.1-flash-lite";
const NLQ_MODEL = "gemini-3.1-flash-lite";
const DIM = 1536;

function resolveGenerateModel(model?: string): string {
  if (!model || model === "default" || model === "extract") return STAGE2_MODEL;
  if (model === "cheap" || model === "classify" || model === "nlq") return STAGE1_MODEL;
  if (model === NLQ_MODEL || model === STAGE1_MODEL || model === STAGE2_MODEL) return model;
  return model;
}

async function callGeminiGenerate(
  model: string,
  parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }>,
  schema: Record<string, unknown>,
  temperature = 0.1,
  retries = 8
): Promise<unknown> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": KEY! },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              temperature,
              responseMimeType: "application/json",
              // schemas now arrive as standard JSON Schema (the framework converts zod via
              // normalizeSchema), so use responseJsonSchema rather than the OpenAPI responseSchema.
              responseJsonSchema: schema,
            },
          }),
          signal: AbortSignal.timeout(120000),
        }
      );
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as {
        candidates: { content: { parts: { text: string }[] } }[];
      };
      return JSON.parse(data.candidates[0]!.content.parts[0]!.text);
    } catch (e) {
      if (i === retries - 1) throw e;
      const status = (e as { status?: number }).status;
      await new Promise((r) => setTimeout(r, (status === 429 ? 15000 : 4000) * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

async function callGeminiEmbed(
  parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }>,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
  dim: number,
  retries = 8
): Promise<number[]> {
  const url =
    taskType === "RETRIEVAL_QUERY"
      ? `https://generativelanguage.googleapis.com/v1beta/models/${EMB_MODEL}:embedContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${EMB_MODEL}:batchEmbedContents`;

  for (let i = 0; i < retries; i++) {
    try {
      const body =
        taskType === "RETRIEVAL_QUERY"
          ? {
              model: `models/${EMB_MODEL}`,
              content: { parts },
              taskType,
              outputDimensionality: dim,
            }
          : {
              requests: [
                {
                  model: `models/${EMB_MODEL}`,
                  content: { parts },
                  taskType,
                  outputDimensionality: dim,
                },
              ],
            };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": KEY! },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as {
        embedding?: { values: number[] };
        embeddings?: { values: number[] }[];
      };
      const v =
        taskType === "RETRIEVAL_QUERY"
          ? data.embedding!.values
          : data.embeddings![0]!.values;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    } catch (e) {
      if (i === retries - 1) throw e;
      const status = (e as { status?: number }).status;
      await new Promise((r) => setTimeout(r, (status === 429 ? 20000 : 5000) * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

async function embedImage(
  image: { url?: string; bytes?: Uint8Array; mimeType?: string },
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
  dim: number
): Promise<number[]> {
  let mimeType = image.mimeType ?? "image/jpeg";
  let dataB64: string;
  if (image.bytes?.length) {
    dataB64 = Buffer.from(image.bytes).toString("base64");
  } else if (image.url) {
    const fetched = await fetchImageBytes(image.url);
    if (!fetched) throw new Error(`failed to fetch image: ${image.url}`);
    mimeType = fetched.mimeType;
    dataB64 = Buffer.from(fetched.bytes).toString("base64");
  } else {
    throw new Error("image requires url or bytes");
  }
  return callGeminiEmbed(
    [{ inline_data: { mime_type: mimeType, data: dataB64 } }],
    taskType,
    dim
  );
}

export const geminiEmbed: EmbedFn = async ({ text, image, dim, taskType, inputType }) => {
  if (!KEY) throw new Error("GEMINI_API_KEY missing");
  const tt =
    taskType === "RETRIEVAL_QUERY" || inputType === "query"
      ? "RETRIEVAL_QUERY"
      : "RETRIEVAL_DOCUMENT";
  if (image) {
    if (dim > DIM) throw new Error(`expected dim <= ${DIM}, got ${dim}`);
    return embedImage(image, tt, dim);
  }
  if (!text) throw new Error("embed requires text or image");
  if (dim !== DIM) throw new Error(`expected dim ${DIM}, got ${dim}`);
  return callGeminiEmbed([{ text }], tt, dim);
};

export const geminiGenerate: GenerateFn = async ({ model, prompt, system, images, schema }) => {
  if (!KEY) throw new Error("GEMINI_API_KEY missing");
  const resolved =
    model === NLQ_MODEL || (!model && system) ? NLQ_MODEL : resolveGenerateModel(model);
  const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];
  for (const img of images ?? []) {
    const data = typeof img.data === "string" ? img.data : Buffer.from(img.data).toString("base64");
    parts.push({ inline_data: { mime_type: img.mimeType, data } });
  }
  const text = system ? `${system}\n\n${prompt}` : prompt;
  parts.push({ text });
  const temp = resolved === NLQ_MODEL || resolved === STAGE1_MODEL ? 0 : 0.1;
  return callGeminiGenerate(resolved, parts, schema, temp);
};

export { EMB_MODEL, STAGE1_MODEL, STAGE2_MODEL, NLQ_MODEL, DIM };
