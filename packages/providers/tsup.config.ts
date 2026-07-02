import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/ai-sdk.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "es2022",
  // Consumers bring these ("ai" only for the ./ai-sdk subpath).
  external: ["@samesake/server", "zod", "ai"],
});
