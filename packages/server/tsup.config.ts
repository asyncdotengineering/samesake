import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "es2022",
  // Mark workspace deps as externals — consumers bring them.
  external: ["@samesake/core", "@samesake/enrich", "hono", "drizzle-orm", "postgres", "ai", "@ai-sdk/google", "@hono/zod-validator", "zod"],
});
