import { put } from "@vercel/blob";

// Host an uploaded image at a PUBLIC https URL. This is required because samesake's enrich
// vision stage AND the visual-space index fetch the image via fetchRemoteImageSafe, which
// rejects data:/localhost/private URLs — so the bytes must live at a real public URL that
// works both locally and on Vercel (serverless has no persistent FS).
//
// Vercel Blob first. To move to Cloudflare R2 / S3, swap this one function (e.g. PutObject to
// a public bucket and return its public URL) — nothing else changes.
export async function uploadPublicImage(
  name: string,
  bytes: Uint8Array,
  contentType: string
): Promise<string> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is not set — required to host uploaded images on Vercel Blob. " +
        "Set it in your env (locally: `vercel env pull`) or swap lib/blob.ts to R2/S3."
    );
  }
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "image";
  const { url } = await put(`uploads/${safe}`, Buffer.from(bytes), {
    access: "public",
    contentType,
    addRandomSuffix: true,
  });
  return url;
}
