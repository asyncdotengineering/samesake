import type { GenerateFn } from "@samesake/server";

// Minimal Gemini structured-generation for samesake NLQ (parses intent + budgets
// like "under 3000" into hard filters). Bring-your-own-model.
const MODEL = "gemini-3.1-flash-lite";
const KEY = () => process.env.GEMINI_API_KEY ?? "";

export const geminiGenerate: GenerateFn = async ({ prompt, system, schema, images }) => {
  const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];
  for (const img of images ?? []) {
    const data = typeof img.data === "string" ? img.data : Buffer.from(img.data).toString("base64");
    parts.push({ inline_data: { mime_type: img.mimeType, data } });
  }
  parts.push({ text: system ? `${system}\n\n${prompt}` : prompt });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": KEY() },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        ...(schema ? { responseSchema: schema } : {}),
      },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`gemini generate ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { candidates: { content: { parts: { text: string }[] } }[] };
  return JSON.parse(data.candidates[0]!.content.parts[0]!.text);
};
