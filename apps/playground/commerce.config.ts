import { consoleEmailAdapter, defineConfig } from "@porulle/core";
import { postgresAdapter } from "@porulle/adapter-postgres";
import { localStorageAdapter } from "@porulle/adapter-local-storage";

const DATABASE_URL = process.env.DATABASE_URL!;

// Porulle is the commerce backend for the fashion playground. samesake reads this
// catalog (via /api/catalog/entities) and powers search. One Next.js process serves both.
export default defineConfig({
  storeName: "Samesake Fashion Playground",
  version: "1.0.0",

  database: { provider: "postgresql" },
  databaseAdapter: postgresAdapter({ connectionString: DATABASE_URL }),

  storage: localStorageAdapter({
    basePath: "./.data/media",
    baseUrl: "http://localhost:3000/assets",
  }),

  email: consoleEmailAdapter(),

  auth: {
    requireEmailVerification: false,
    apiKeys: { enabled: true },
    trustedOrigins: ["http://localhost:3000"],
    roles: {
      owner: { permissions: ["*:*"] },
      admin: { permissions: ["*:*"] },
      customer: {
        permissions: ["catalog:read", "cart:create", "cart:read", "cart:update", "orders:create", "orders:read:own"],
      },
    },
  },

  entities: {
    product: {
      // Apparel attributes that aren't first-class entity columns live as custom fields.
      fields: [
        { name: "material", type: "text" },
        { name: "color", type: "text" },
        { name: "category", type: "text" },
        { name: "imageUrl", type: "text" },
      ],
      variants: { enabled: true, optionTypes: ["size", "color"] },
      fulfillment: "physical",
    },
  },
});
