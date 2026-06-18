import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// Host an uploaded image at a PUBLIC https URL via Cloudflare R2 (S3-compatible API). Required
// because samesake's enrich vision stage AND the visual-space index fetch the image via
// fetchRemoteImageSafe, which rejects data:/localhost/private URLs — the bytes must live at a
// real public URL that works both locally and on Vercel (serverless has no persistent FS).
//
// Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL
// (the bucket's public base — its r2.dev URL or a custom domain, e.g. https://pub-xxxx.r2.dev).
// The bucket must have public access enabled so samesake can fetch the image back.

let _client: S3Client | null = null;
function r2(): S3Client {
  if (_client) return _client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (+ R2_BUCKET, R2_PUBLIC_BASE_URL)."
    );
  }
  _client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _client;
}

export async function uploadPublicImage(
  name: string,
  bytes: Uint8Array,
  contentType: string
): Promise<string> {
  const bucket = process.env.R2_BUCKET;
  const publicBase = process.env.R2_PUBLIC_BASE_URL;
  if (!bucket || !publicBase) {
    throw new Error(
      "R2 is not configured — set R2_BUCKET and R2_PUBLIC_BASE_URL (the bucket's public r2.dev URL or custom domain)."
    );
  }
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "image";
  const key = `uploads/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
  await r2().send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from(bytes), ContentType: contentType })
  );
  return `${publicBase.replace(/\/$/, "")}/${key}`;
}
