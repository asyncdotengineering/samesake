import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native/server-only deps out of the bundler; Porulle + samesake + drizzle/postgres
  // must run as real Node modules in route handlers.
  serverExternalPackages: [
    "@porulle/core",
    "@porulle/adapter-postgres",
    "@porulle/adapter-local-storage",
    "@samesake/core",
    "@samesake/server",
    "drizzle-orm",
    "postgres",
    "better-auth",
  ],
};

export default nextConfig;
