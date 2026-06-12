#!/usr/bin/env bun
if (!process.env.SAMESAKE_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.SAMESAKE_DATABASE_URL = process.env.DATABASE_URL;
}
if (!process.env.SAMESAKE_API_KEY) {
  process.env.SAMESAKE_API_KEY = process.env.API_KEY ?? "dev-key-please-change";
}
if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}
import { z } from "zod";
import { createMatcher, createDbFromUrl } from "@samesake/server";
import { makeGeminiEmbedder, makeGeminiParser } from "./embedder.ts";

(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

const Env = z.object({
  SAMESAKE_DATABASE_URL: z.string().url(),
  SAMESAKE_API_KEY: z.string().min(8),
  SAMESAKE_PORT: z.coerce.number().int().positive().default(3030),
  SAMESAKE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]+$/i).default("public"),
  SAMESAKE_PROJECT_PREFIX: z.string().regex(/^[a-z_][a-z0-9_]+$/i).default("project_"),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
});

const env = Env.parse(process.env);

const matcherDbHandle = createDbFromUrl(env.SAMESAKE_DATABASE_URL);

const matcher = createMatcher({
  db: matcherDbHandle.db,
  apiKey: env.SAMESAKE_API_KEY,
  schema: env.SAMESAKE_SCHEMA,
  projectPrefix: env.SAMESAKE_PROJECT_PREFIX,
  embed: makeGeminiEmbedder(env.GOOGLE_GENERATIVE_AI_API_KEY),
  parse: makeGeminiParser(env.GOOGLE_GENERATIVE_AI_API_KEY),
  migrate: "eager",
});

const app = matcher.app;

const IS_SERVERLESS =
  process.env.SAMESAKE_SERVERLESS === "1" ||
  !!process.env.VERCEL ||
  !!process.env.CF_PAGES;

if (!IS_SERVERLESS) {
  Bun.serve({ port: env.SAMESAKE_PORT, fetch: app.fetch });
  console.log(`[samesake] matcher listening on http://localhost:${env.SAMESAKE_PORT}`);
}

export default { fetch: app.fetch };
