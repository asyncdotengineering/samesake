import { getMatcher, products, PROJECT, COLLECTION } from "@/lib/samesake";
import { readExtractedAttrs } from "@/lib/extracted-attrs";
import { uploadPublicImage } from "@/lib/blob";

// Batch upload → enrich → index → searchable. Runs the samesake fashion pipeline end-to-end:
// host each image publicly, push as products, enrich (classify+extract), index, then return
// the LLM-extracted attributes so the UI can show what the pipeline derived.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "expected multipart/form-data" }, { status: 400 });
  }
  const files = form.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
  const brand = String(form.get("brand") ?? "").trim() || "uploaded";
  if (!files.length) return Response.json({ error: "no images uploaded" }, { status: 400 });
  if (files.length > 20) return Response.json({ error: "max 20 images per batch" }, { status: 400 });

  // 1) host each image at a public URL (the enrich vision stage + visual index fetch it).
  const docs: { id: string; data: Record<string, unknown> }[] = [];
  try {
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const url = await uploadPublicImage(file.name, bytes, file.type || "image/jpeg");
      const id = `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const title = file.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim() || "uploaded product";
      docs.push({ id, data: { title, brand, price: 0, available: true, image_url: url } });
    }
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "image hosting failed" }, { status: 500 });
  }

  // 2) push → enrich (classify + extract, image-aware) → index.
  const matcher = getMatcher();
  await matcher.migrate();
  const applied = await matcher.apply(PROJECT, { entities: [], collections: [products] });
  await matcher.pushDocuments(PROJECT, COLLECTION, docs);
  for (let i = 0; i < 5; i++) {
    const e = await matcher.enrich(PROJECT, COLLECTION, { concurrency: 4, limit: docs.length });
    if (e.enriched === 0) break;
  }
  while ((await matcher.index(PROJECT, COLLECTION, { limit: 50 })).indexed > 0) {}

  // 3) return the extracted attributes (now also searchable in the storefront).
  const productsOut = await readExtractedAttrs(applied.schema, docs.map((d) => d.id));
  return Response.json({ count: productsOut.length, products: productsOut });
}
