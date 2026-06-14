// Minimal Gemini text embedding for samesake (bring-your-own-model).
const KEY = () => process.env.GEMINI_API_KEY ?? "";

export async function geminiEmbed({ text, dim }: { text?: string; dim: number }): Promise<number[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=${KEY()}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "models/gemini-embedding-2",
        content: { parts: [{ text: text ?? "" }] },
        outputDimensionality: dim,
      }),
    }
  );
  if (!res.ok) throw new Error(`gemini embed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { embedding?: { values: number[] } };
  if (!data.embedding?.values) throw new Error("gemini embed: no values");
  return data.embedding.values;
}
