import type { EmbedFn, GenerateFn } from "@samesake/server";

// BYO model wiring for the matcher. @samesake/server ships no AI SDK; this file is
// where we pick the stack. Per the recipe's constraints:
//   - embeddings  -> gemini-embedding-2   (text doc vectors for products + brands)
//   - NLQ/generate -> gemini-3.1-flash-lite (parses "less than $200" into a hard filter)
// Swap providers by editing only this file.
const KEY = () => process.env.GEMINI_API_KEY ?? "";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Light spacing between embed calls. The project quota for gemini-embedding-2 is high
// (20K RPM), so this is just smoothing; any residual 429 (e.g. a shared base-model pool)
// is absorbed by fetchWithRetry's backoff. Override with EMBED_MIN_INTERVAL_MS.
const EMBED_MIN_INTERVAL_MS = Number(process.env.EMBED_MIN_INTERVAL_MS ?? 120);
let embedGate: Promise<void> = Promise.resolve();
function throttleEmbed(): Promise<void> {
  const prev = embedGate;
  embedGate = prev.then(() => sleep(EMBED_MIN_INTERVAL_MS));
  return prev;
}

// Retry on transient/rate-limit responses. Gemini's embed endpoint enforces a
// per-minute quota, and bulk indexing trips it; back off and retry instead of failing.
async function fetchWithRetry(url: string, init: RequestInit, label: string, tries = 8): Promise<Response> {
  let delay = 4000;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok || ![429, 500, 503].includes(res.status) || attempt >= tries) return res;
    await sleep(delay);
    delay = Math.min(delay * 2, 60000);
  }
}

// gemini-embedding-2 over plain text; `dim` drives outputDimensionality (1536 here).
export const geminiEmbed: EmbedFn = async ({ text, dim }) => {
  await throttleEmbed();
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=${KEY()}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "models/gemini-embedding-2",
        content: { parts: [{ text: text ?? "" }] },
        outputDimensionality: dim,
      }),
    },
    "embed"
  );
  if (!res.ok) throw new Error(`gemini embed ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = (await res.json()) as { embedding?: { values: number[] } };
  if (!data.embedding?.values) throw new Error("gemini embed: no values");
  return data.embedding.values;
};

// Structured generation for samesake NLQ. gemini-3.1-flash-lite only.
const GENERATE_MODEL = "gemini-3.1-flash-lite";

export const geminiGenerate: GenerateFn = async ({ prompt, system, schema }) => {
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${GENERATE_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": KEY() },
      body: JSON.stringify({
        contents: [{ parts: [{ text: system ? `${system}\n\n${prompt}` : prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          ...(schema ? { responseJsonSchema: schema } : {}),
        },
      }),
    },
    "generate"
  );
  if (!res.ok) throw new Error(`gemini generate ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { candidates: { content: { parts: { text: string }[] } }[] };
  return JSON.parse(data.candidates[0]!.content.parts[0]!.text);
};
