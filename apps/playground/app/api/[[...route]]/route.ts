import { handle } from "hono/vercel";
import { createServer } from "@porulle/core";
import config from "@/commerce.config";

// Porulle commerce backend, embedded as a catch-all under /api/*.
// The specific /api/search and /api/products routes take precedence over this.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lazily build the Hono app on first request (not at module load / build time),
// so the build never opens a DB connection and serverless cold-starts stay clean.
let appPromise: Promise<Awaited<ReturnType<typeof createServer>>["app"]> | null = null;
function getApp() {
  if (!appPromise) appPromise = createServer(config as never).then((s) => s.app);
  return appPromise;
}

async function proxy(req: Request): Promise<Response> {
  const app = await getApp();
  return handle(app)(req);
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
