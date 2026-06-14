import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { collection, entity, f, fields, isCollectionDef, isEntityDef } from "../src/index.ts";

describe("collection() compile-time safety", () => {
  test("@ts-expect-error catches undeclared embedding reference", () => {
    const sdkRoot = join(import.meta.dir, "..");
    const r = spawnSync("bunx", ["tsc", "--noEmit", "-p", "tsconfig.json"], {
      cwd: sdkRoot,
      encoding: "utf8",
    });
    if (r.status !== 0) {
      console.error(r.stdout, r.stderr);
    }
    expect(r.status).toBe(0);
  });
});

describe("definition type guards", () => {
  test("identify SDK-created entity and collection definitions", () => {
    const account = entity("account", {
      fields: { name: fields.text() },
      scopes: ["tenant"],
    });
    const products = collection("products", {
      fields: { title: f.text() },
    });

    expect(isEntityDef(account)).toBe(true);
    expect(isCollectionDef(products)).toBe(true);
    expect(isCollectionDef(account)).toBe(false);
    expect(isEntityDef(products)).toBe(false);
  });

  test("reject shape-compatible plain objects", () => {
    expect(
      isEntityDef({
        name: "account",
        fields: { name: { type: "text" } },
        scopes: ["tenant"],
      })
    ).toBe(false);
    expect(
      isCollectionDef({
        name: "products",
        fields: { title: { type: "text" } },
        search: { channels: [] },
      })
    ).toBe(false);
  });

  test("brand is non-enumerable", () => {
    const account = entity("account", {
      fields: { name: fields.text() },
      scopes: ["tenant"],
    });
    expect(JSON.stringify(account)).toContain('"name":"account"');
    expect(Object.getOwnPropertySymbols(account).length).toBe(1);
    expect(Object.keys(account)).toEqual(["fields", "scopes", "name"]);
  });
});
