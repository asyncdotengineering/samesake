import { describe, expect, test } from "bun:test";
import { buildApp } from "../src/app-builder.ts";

function makeApp(runMigrationsOnRequest: boolean) {
  let migrationCalls = 0;
  const app = buildApp({
    apiKey: "test-api-key",
    runMigrationsOnRequest,
    ensureMigrations: async () => {
      migrationCalls += 1;
    },
    observability: {
      count: () => {},
      observe: () => {},
      metrics: () => ({
        counters: {},
        histograms: {},
      }),
    } as never,
    storage: {} as never,
    services: {
      projects: {
        listProjects: async () => [],
      },
    } as never,
  });
  return {
    app,
    migrationCalls: () => migrationCalls,
  };
}

describe("HTTP migration strategy", () => {
  test("manual mode does not run migrations before request handling", async () => {
    const { app, migrationCalls } = makeApp(false);

    const response = await app.request("/v1/projects", {
      headers: { Authorization: "Bearer test-api-key" },
    });

    expect(response.status).toBe(200);
    expect(migrationCalls()).toBe(0);
  });

  test("lazy/default mode runs migrations before request handling", async () => {
    const { app, migrationCalls } = makeApp(true);

    const response = await app.request("/v1/projects", {
      headers: { Authorization: "Bearer test-api-key" },
    });

    expect(response.status).toBe(200);
    expect(migrationCalls()).toBe(1);
  });
});
