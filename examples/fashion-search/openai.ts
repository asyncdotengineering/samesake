// Cross-family eval judge (OpenAI) — enrichment runs on Gemini, so the relevance judge must
// come from a different model family (samesake rejects same-family enrich+judge).
import type { GenerateFn } from "@samesake/server";

const KEY = process.env.OPENAI_API_KEY;
export const JUDGE_MODEL = "gpt-4.1-mini";

type JsonSchema = Record<string, unknown>;

// OpenAI strict structured outputs require additionalProperties:false and every property required.
function strictify(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema };
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    const props = Object.fromEntries(
      Object.entries(out.properties as Record<string, JsonSchema>).map(([k, v]) => [k, strictify(v)])
    );
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  if (out.type === "array" && out.items && typeof out.items === "object") {
    out.items = strictify(out.items as JsonSchema);
  }
  return out;
}

export const openaiGenerate: GenerateFn = async ({ model, prompt, system, schema }) => {
  if (!KEY) throw new Error("OPENAI_API_KEY missing");
  const resolved = model && model.startsWith("gpt") ? model : JUDGE_MODEL;
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: resolved,
          temperature: 0,
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: prompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "out", strict: true, schema: strictify(schema as JsonSchema) },
          },
        }),
        signal: AbortSignal.timeout(120000),
      });
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      return JSON.parse(data.choices[0]!.message.content);
    } catch (e) {
      if (i === 5) throw e;
      const status = (e as { status?: number }).status;
      await new Promise((r) => setTimeout(r, (status === 429 ? 12000 : 3000) * (i + 1)));
    }
  }
  throw new Error("unreachable");
};
