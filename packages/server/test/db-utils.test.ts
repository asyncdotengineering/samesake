import { describe, expect, test } from "bun:test";
import { collectionTableName, entityTableName } from "../src/core/db-utils.ts";

describe("canonical DB table-name utilities", () => {
  test("preserves entity table naming", () => {
    expect(entityTableName("products")).toBe("products");
    expect(entityTableName("Product Catalog")).toBe("product_catalog");
  });

  test("preserves collection table naming", () => {
    expect(collectionTableName("project_acme", "products")).toBe("project_acme.c_products");
    expect(collectionTableName("Project Acme", "Product Catalog")).toBe(
      "project_acme.c_product_catalog"
    );
  });
});
