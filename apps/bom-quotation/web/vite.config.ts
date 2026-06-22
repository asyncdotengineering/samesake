import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig({
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [tanstackStart(), viteReact()],
});
