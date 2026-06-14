import type { EmbedFn } from "@samesake/server";

// gemini-embedding-2 is multimodal: it embeds text AND images into the same space,
// so a text query and a product image are directly comparable (cross-modal search).
// samesake passes `image` (fetched bytes) for image spaces, or `text` for text spaces;
// `dim` drives outputDimensionality (1536 for the text doc space, 768 for the visual space).
const KEY = () => process.env.GEMINI_API_KEY ?? "";

export const geminiEmbed: EmbedFn = async ({ text, image, dim }) => {
  let part: { text?: string; inline_data?: { mime_type: string; data: string } };

  if (image && (image.bytes || image.url)) {
    let b64: string;
    if (image.bytes) b64 = Buffer.from(image.bytes).toString("base64");
    else {
      const r = await fetch(image.url!);
      if (!r.ok) throw new Error(`image fetch ${r.status} for embed`);
      b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
    }
    part = { inline_data: { mime_type: image.mimeType ?? "image/jpeg", data: b64 } };
  } else {
    part = { text: text ?? "" };
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=${KEY()}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "models/gemini-embedding-2",
        content: { parts: [part] },
        outputDimensionality: dim,
      }),
    }
  );
  if (!res.ok) throw new Error(`gemini embed ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = (await res.json()) as { embedding?: { values: number[] } };
  if (!data.embedding?.values) throw new Error("gemini embed: no values");
  return data.embedding.values;
};
