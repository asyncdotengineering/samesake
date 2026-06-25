#!/usr/bin/env node
/**
 * @samesake/mcp — a stdio MCP server that turns any deployed samesake matcher into agent tools.
 *
 * It's a thin, version-decoupled HTTP client: point it at a deployment (SAMESAKE_URL) with a
 * project key (SAMESAKE_API_KEY) and it exposes samesake's hybrid search + the grounded
 * agent-commerce tools to Claude Desktop, Cursor, or any MCP client. No DB access, no samesake
 * code imported — just the public /v1 API.
 *
 *   SAMESAKE_URL=https://matcher.example.com \
 *   SAMESAKE_API_KEY=sk_proj_… \
 *   SAMESAKE_PROJECT=shop SAMESAKE_COLLECTION=products \
 *   npx -y @samesake/mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SAMESAKE_URL = process.env.SAMESAKE_URL?.replace(/\/+$/, "");
const API_KEY = process.env.SAMESAKE_API_KEY;
const DEFAULT_PROJECT = process.env.SAMESAKE_PROJECT;
const DEFAULT_COLLECTION = process.env.SAMESAKE_COLLECTION;
const CHARACTER_LIMIT = 25_000;

/** A samesake API error carrying the HTTP status so handlers can give actionable messages. */
class SamesakeError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`samesake ${status}: ${body.slice(0, 300)}`);
  }
}

function resolveTarget(project?: string, collection?: string): { project: string; collection: string } {
  const p = project ?? DEFAULT_PROJECT;
  const c = collection ?? DEFAULT_COLLECTION;
  if (!p) throw new Error("No project — pass `project` or set SAMESAKE_PROJECT.");
  if (!c) throw new Error("No collection — pass `collection` or set SAMESAKE_COLLECTION.");
  return { project: p, collection: c };
}

/** POST JSON to a samesake /v1 endpoint with bearer auth. The one place auth + transport live. */
async function callSamesake<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SAMESAKE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(prune(body)),
  });
  if (!res.ok) throw new SamesakeError(res.status, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

/** Drop undefined keys so optional args don't become explicit nulls in the request body. */
function prune(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: { [key: string]: unknown }; isError?: boolean };

/** Uniform success result: structured data for clients + a truncated text rendering for context. */
function ok(data: unknown): ToolResult {
  let text = JSON.stringify(data, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    text = text.slice(0, CHARACTER_LIMIT) + `\n… [truncated at ${CHARACTER_LIMIT} chars — narrow with filters or a lower limit]`;
  }
  return { content: [{ type: "text", text }], structuredContent: data as Record<string, unknown> };
}

/** Map an error to an actionable message instead of a stack trace. */
function fail(err: unknown): ToolResult {
  let text: string;
  if (err instanceof SamesakeError) {
    text =
      err.status === 401
        ? "Error 401: bad SAMESAKE_API_KEY (needs a project key for this project)."
        : err.status === 404
          ? "Error 404: project or collection not found — check the project/collection names."
          : `Error ${err.status}: ${err.body.slice(0, 300)}`;
  } else {
    text = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { content: [{ type: "text", text }], isError: true };
}

const target = {
  project: z.string().optional().describe("Project slug (defaults to SAMESAKE_PROJECT)"),
  collection: z.string().optional().describe("Collection name (defaults to SAMESAKE_COLLECTION)"),
};

const server = new McpServer({ name: "samesake-mcp-server", version: "0.1.0" });

server.registerTool(
  "samesake_search",
  {
    title: "Search a samesake collection",
    description:
      "Hybrid (keyword + semantic) search over a samesake collection, with structured filters and " +
      "facet aggregations. Use for 'find X', 'X under $200', faceted browsing, or nearest-neighbour " +
      "(mode='similar'). Returns ranked hits and, if requested, per-field facet counts. Read-only.",
    inputSchema: {
      query: z.string().describe("Natural-language query / intent, e.g. 'lightweight waterproof jacket'"),
      ...target,
      filters: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Field filters, e.g. { \"price\": { \"$lte\": 200 }, \"category\": \"Footwear\" }"),
      facets: z.array(z.string()).optional().describe("Field names to aggregate counts for, e.g. [\"brand\",\"price\"]"),
      mode: z.enum(["intent", "similar"]).optional().describe("intent = hybrid retrieval (default); similar = nearest-neighbour"),
      limit: z.number().int().min(1).max(100).optional().describe("Max hits to return (default 20)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ query, project, collection, filters, facets, mode, limit }) => {
    try {
      const { project: p, collection: c } = resolveTarget(project, collection);
      const data = await callSamesake(`/v1/projects/${p}/collections/${c}/search`, { q: query, filters, facets, mode, limit });
      return ok(data);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "samesake_find_products",
  {
    title: "Find grounded product candidates for a shopper intent",
    description:
      "Agent-commerce retrieval: returns grounded, purchasable product candidates for a shopper intent, " +
      "with freshness and verification metadata. Stops before cart/checkout/payment. Use constraintMode " +
      "'strict' to require hard constraints be met, 'best_effort' to relax. Read-only.",
    inputSchema: {
      intent: z.string().describe("Shopper intent, e.g. 'a warm waterproof jacket under $200 for hiking'"),
      ...target,
      constraints: z.record(z.string(), z.unknown()).optional().describe("Hard/soft constraints, e.g. { \"price\": { \"$lte\": 200 } }"),
      constraintMode: z.enum(["best_effort", "strict"]).optional().describe("strict = enforce constraints; best_effort = relax (default)"),
      limit: z.number().int().min(1).max(50).optional().describe("Max candidates (default 10)"),
      explain: z.boolean().optional().describe("Include per-candidate retrieval explanation"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ intent, project, collection, constraints, constraintMode, limit, explain }) => {
    try {
      const { project: p, collection: c } = resolveTarget(project, collection);
      const data = await callSamesake(`/v1/projects/${p}/collections/${c}/agent/find-products`, {
        intent,
        constraints,
        constraintMode,
        limit,
        explain,
      });
      return ok(data);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "samesake_find_similar",
  {
    title: "Find products similar to a reference",
    description:
      "Find products similar to a reference product (by id) or a reference image (by URL), using the same " +
      "retrieval engine. Provide productId or imageUrl. Read-only.",
    inputSchema: {
      ...target,
      productId: z.string().optional().describe("Reference product id to find lookalikes of"),
      imageUrl: z.string().optional().describe("Reference image URL to find visually similar products"),
      constraints: z.record(z.string(), z.unknown()).optional().describe("Constraints to apply, e.g. { \"price\": { \"$lte\": 200 } }"),
      limit: z.number().int().min(1).max(50).optional().describe("Max candidates (default 10)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ project, collection, productId, imageUrl, constraints, limit }) => {
    try {
      if (!productId && !imageUrl) throw new Error("Provide productId or imageUrl.");
      const { project: p, collection: c } = resolveTarget(project, collection);
      const data = await callSamesake(`/v1/projects/${p}/collections/${c}/agent/find-similar-products`, {
        productId,
        image: imageUrl ? { url: imageUrl } : undefined,
        constraints,
        limit,
      });
      return ok(data);
    } catch (err) {
      return fail(err);
    }
  },
);

async function main(): Promise<void> {
  if (!SAMESAKE_URL || !API_KEY) {
    console.error("ERROR: SAMESAKE_URL and SAMESAKE_API_KEY are required.");
    process.exit(1);
  }
  await server.connect(new StdioServerTransport());
  console.error(`samesake-mcp-server → ${SAMESAKE_URL}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
