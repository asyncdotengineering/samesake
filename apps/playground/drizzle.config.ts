/// <reference types="node" />
import { defineConfig } from "drizzle-kit";

// Porulle ships its Drizzle schema compiled in @porulle/core/dist. The kernel barrel
// re-exports every core table (auth, catalog, inventory, cart, orders, pricing, ...),
// and drizzle-kit resolves re-exports — so one file covers the whole schema.
export default defineConfig({
  dialect: "postgresql",
  schema: ["./node_modules/@porulle/core/dist/kernel/database/schema.js"],
  out: "./drizzle",
  dbCredentials: { url: process.env.SAMESAKE_DATABASE_URL! },
});
