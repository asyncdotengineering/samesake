import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  // CLIs only need one format; ESM keeps the bundle slimmer.
  format: ["esm"],
  // No .d.ts — the CLI is an executable, not an importable API.
  dts: false,
  clean: true,
  sourcemap: false,
  target: "es2022",
  // Node-compatible shebang so `bunx samesake` and `npx samesake` both work.
  banner: { js: "#!/usr/bin/env node" },
});
