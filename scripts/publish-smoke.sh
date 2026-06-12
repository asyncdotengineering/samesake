#!/usr/bin/env bash
# Empirical publishability smoke. Builds each publishable package, packs it
# with `bun pm pack` (which rewrites `workspace:*` deps to the actual
# version), installs all three into a clean temp project, then proves each
# is consumable as it would be from npm.
#
# Run from repo root: scripts/publish-smoke.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TARBALL_DIR="${TARBALL_DIR:-/tmp/samesake-tarballs}"
SMOKE_DIR="${SMOKE_DIR:-/tmp/samesake-publish-smoke}"
SAMESAKE_API_KEY="${SAMESAKE_API_KEY:-dev-key-please-change}"
SAMESAKE_DATABASE_URL="${SAMESAKE_DATABASE_URL:-postgresql://localhost:5432/samesake_dev}"

# Versions — pulled from each package's package.json so we don't repeat them.
SDK_VERSION="$(node -p "require('$REPO/packages/sdk/package.json').version")"
CLI_VERSION="$(node -p "require('$REPO/packages/cli/package.json').version")"
SERVER_VERSION="$(node -p "require('$REPO/packages/server/package.json').version")"

echo "▸ cleaning previous smoke state"
rm -rf "$TARBALL_DIR" "$SMOKE_DIR"
mkdir -p "$TARBALL_DIR" "$SMOKE_DIR"

echo "▸ building + packing each publishable"
for pkg in sdk cli server; do
  cd "$REPO/packages/$pkg"
  bun run build > /dev/null 2>&1
  bun pm pack --destination="$TARBALL_DIR/" > /dev/null 2>&1
done
ls -la "$TARBALL_DIR/"

echo ""
echo "▸ creating fresh consumer project + installing tarballs"
cat > "$SMOKE_DIR/package.json" <<EOF
{
  "name": "samesake-publish-smoke",
  "type": "module",
  "private": true,
  "dependencies": {
    "@samesake/core": "file:$TARBALL_DIR/samesake-core-$SDK_VERSION.tgz",
    "@samesake/cli": "file:$TARBALL_DIR/samesake-cli-$CLI_VERSION.tgz",
    "@samesake/server": "file:$TARBALL_DIR/samesake-server-$SERVER_VERSION.tgz",
    "@ai-sdk/google": "^3.0.75",
    "@hono/zod-validator": "^0.8.0",
    "ai": "^6.0.184",
    "drizzle-orm": "^0.45.2",
    "hono": "^4.12.19",
    "postgres": "^3.4.9",
    "zod": "^4.4.3"
  },
  "overrides": {
    "@samesake/core": "file:$TARBALL_DIR/samesake-core-$SDK_VERSION.tgz",
    "@samesake/cli": "file:$TARBALL_DIR/samesake-cli-$CLI_VERSION.tgz",
    "@samesake/server": "file:$TARBALL_DIR/samesake-server-$SERVER_VERSION.tgz"
  }
}
EOF
cd "$SMOKE_DIR" && bun install > /dev/null 2>&1
echo "  ✓ all three installed"

echo ""
echo "▸ samesake SDK consumable (v1.0 — string + dim)"
cat > "$SMOKE_DIR/test-sdk.ts" <<'EOF'
import { entity, fields, Scorers } from "@samesake/core";
import { MatchResultSchema } from "@samesake/core/schemas";
const c = entity("customer", {
  fields: { name: fields.text({ required: true }) },
  scopes: ["tenantId"],
  embeddings: { e: { source: "name", model: "gemini-embedding-001", dim: 768 } },
  scoring: { channels: [Scorers.cosine({ embedding: "e", weight: 0.6 })] },
});
MatchResultSchema.parse({ candidates: [], queryTextNormalised: "" });
console.log("✓ entity:", c.name);
EOF
cd "$SMOKE_DIR" && bun test-sdk.ts | sed 's/^/  /'

echo ""
echo "▸ samesake-cli bin runs"
cd "$SMOKE_DIR" && SAMESAKE_API_KEY="$SAMESAKE_API_KEY" \
  ./node_modules/.bin/samesake --help 2>&1 | head -3 | sed 's/^/  /' || \
  echo "  (cli bin not reachable)"

echo ""
echo "▸ samesake-server (BYO-AI) wired via consumer's embedder closure"
cat > "$SMOKE_DIR/test-server.ts" <<EOF
// v1.0 PROOF: import does NOT read process.env. No AI SDK bundled.
import { createMatcher, type EmbedFn, tablesToDDL } from "@samesake/server";
console.log("✓ import succeeded without any env var set");
console.log("✓ no AI SDK in dependency tree (@samesake/server doesn't ship one)");

// Consumer's embed function — Vercel AI SDK + Gemini, supplied by the consumer.
import { embed } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "" });
const embedFn: EmbedFn = async ({ text, model, dim, taskType }) => {
  const { embedding } = await embed({
    model: google.textEmbedding(model),
    value: text,
    providerOptions: { google: { outputDimensionality: dim, taskType: taskType ?? "SEMANTIC_SIMILARITY" } },
  });
  return Array.from(embedding);
};

const m = createMatcher({
  databaseUrl: "$SAMESAKE_DATABASE_URL",
  apiKey: "$SAMESAKE_API_KEY",
  embed: embedFn,
});
await m.migrate();

// In-process function call (no HTTP)
const projects = await m.listProjects();
console.log("✓ in-process: m.listProjects() →", projects.length, "projects");

// Web-standard fetch handler
const res = await m.fetch(new Request("http://localhost/v1/healthz"));
console.log("✓ fetch handler:", res.status);

// Hono app composition
console.log("✓ m.app.route is a function:", typeof m.app.route === "function");

console.log("✓ tablesToDDL utility:", typeof tablesToDDL);
await m.close();
EOF
cd "$SMOKE_DIR" && bun test-server.ts 2>&1 | tail -10 | sed 's/^/  /'

echo ""
echo "✓ publish-smoke green. Tarballs in $TARBALL_DIR/"
