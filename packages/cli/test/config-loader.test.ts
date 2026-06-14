import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectConfig } from "../src/config-loader.ts";

const tmp = join(import.meta.dir, ".tmp-config-loader");
mkdirSync(tmp, { recursive: true });

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(name: string, source: string): string {
  const path = join(tmp, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.ts`);
  writeFileSync(path, source);
  return path;
}

describe("loadProjectConfig", () => {
  test("discovers SDK-branded direct entity and collection exports", async () => {
    const path = writeConfig(
      "direct",
      `
        import { collection, entity, f, fields } from "@samesake/core";
        export const account = entity("account", { fields: { name: fields.text() }, scopes: ["tenant"] });
        export const products = collection("products", { fields: { title: f.text() } });
      `
    );

    const loaded = await loadProjectConfig(path);
    expect(loaded.entities.map((d) => d.name)).toEqual(["account"]);
    expect(loaded.collections.map((d) => d.name)).toEqual(["products"]);
  });

  test("discovers SDK-branded definitions inside explicit project exports", async () => {
    const path = writeConfig(
      "explicit",
      `
        import { collection, entity, f, fields } from "@samesake/core";
        const account = entity("account", { fields: { name: fields.text() }, scopes: ["tenant"] });
        const products = collection("products", { fields: { title: f.text() } });
        export default { entities: [account], collections: [products] };
      `
    );

    const loaded = await loadProjectConfig(path);
    expect(loaded.project.entities?.map((d) => d.name)).toEqual(["account"]);
    expect(loaded.project.collections?.map((d) => d.name)).toEqual(["products"]);
  });

  test("rejects shape-compatible plain objects as definitions", async () => {
    const path = writeConfig(
      "mixed",
      `
        import { collection, entity, f, fields } from "@samesake/core";
        export const fakeEntity = { name: "fake_entity", fields: { name: { type: "text" } }, scopes: ["tenant"] };
        export const fakeCollection = { name: "fake_collection", fields: { title: { type: "text" } }, search: { channels: [] } };
        export const account = entity("account", { fields: { name: fields.text() }, scopes: ["tenant"] });
        export const products = collection("products", { fields: { title: f.text() } });
        export const project = { entities: [fakeEntity, account], collections: [fakeCollection, products] };
      `
    );

    const loaded = await loadProjectConfig(path);
    expect(loaded.entities.map((d) => d.name)).toEqual(["account"]);
    expect(loaded.collections.map((d) => d.name)).toEqual(["products"]);
  });
});
