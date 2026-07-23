import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "es2022",
  // Consumers bring this (type-only import, erased at runtime).
  external: ["@samesake/core"],
});
