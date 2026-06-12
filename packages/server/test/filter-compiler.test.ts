import { describe, expect, test } from "bun:test";
import { collection, f, Channels } from "@samesake/core";
import { buildFilterSql } from "../src/core/search.ts";
import { testProductsCollection } from "./fixtures.ts";

const def = testProductsCollection;

describe("buildFilterSql", () => {
  test("shorthand eq on text", () => {
    const r = buildFilterSql({ brand: "nike" }, def, { soft: true }, 4);
    expect(r.where).toBe("brand = $4");
    expect(r.params).toEqual(["nike"]);
  });

  test("shorthand array overlap", () => {
    const r = buildFilterSql({ colors: ["red"] }, def, { soft: true }, 4);
    expect(r.where).toBe("colors && $4::text[]");
    expect(r.params).toEqual([["red"]]);
  });

  test("$gt and $lte on number", () => {
    const r = buildFilterSql({ price: { $gt: 10, $lte: 100 } }, def, { soft: true }, 4);
    expect(r.where).toBe("price > $4::numeric AND price <= $5::numeric");
    expect(r.params).toEqual([10, 100]);
  });

  test("$in operator", () => {
    const r = buildFilterSql({ category: { $in: ["shoes", "bags"] } }, def, { soft: true }, 4);
    expect(r.where).toBe("category = ANY($4::text[])");
    expect(r.params).toEqual([["shoes", "bags"]]);
  });

  test("$nin operator", () => {
    const r = buildFilterSql({ brand: { $nin: ["x"] } }, def, { soft: true }, 4);
    expect(r.where).toBe("(brand IS NULL OR NOT (brand = ANY($4::text[])))");
    expect(r.params).toEqual([["x"]]);
  });

  test("$ne operator", () => {
    const r = buildFilterSql({ brand: { $ne: "adidas" } }, def, { soft: true }, 4);
    expect(r.where).toBe("(brand IS NULL OR brand <> $4)");
    expect(r.params).toEqual(["adidas"]);
  });

  test("$contains on text", () => {
    const r = buildFilterSql({ brand: { $contains: "nik" } }, def, { soft: true }, 4);
    expect(r.where).toBe("brand ILIKE '%' || $4 || '%'");
    expect(r.params).toEqual(["nik"]);
  });

  test("$not regex-escapes value", () => {
    const r = buildFilterSql({ brand: { $not: "a+b" } }, def, { soft: true }, 4);
    expect(r.where).toBe("(brand IS NULL OR brand !~* $4)");
    expect(r.params).toEqual(["a\\+b"]);
  });

  test("unknown field lists valid filterable fields", () => {
    expect(() => buildFilterSql({ title: "x" }, def, { soft: true }, 4)).toThrow(
      /Unknown filter field "title".*brand, category, colors, price, tag/
    );
  });

  test("param index offset", () => {
    const r = buildFilterSql(
      { brand: "nike", price: { $gte: 50 } },
      def,
      { soft: true },
      7
    );
    expect(r.where).toBe("brand = $7 AND price >= $8::numeric");
    expect(r.params).toEqual(["nike", 50]);
  });

  test("excludeSoft drops soft fields", () => {
    const r = buildFilterSql(
      { colors: ["red"], brand: "nike" },
      def,
      { soft: true, excludeSoft: true },
      4
    );
    expect(r.where).toBe("brand = $4");
    expect(r.softFieldsUsed).toEqual([]);
  });

  test("soft fields tracked when soft pass", () => {
    const r = buildFilterSql({ colors: ["red"] }, def, { soft: true }, 4);
    expect(r.softFieldsUsed).toEqual(["colors"]);
  });
});

describe("buildFilterSql alsoMatch (regression: 42P18 duplicate param index)", () => {
  const gdef = collection("g", {
    fields: {
      title: f.text({ searchable: true }),
      gender: f.enum(["women", "men", "kids"], { filterable: true, alsoMatch: ["unisex"] }),
    },
    search: { channels: [Channels.fts({ fields: ["title"], weight: 1 })] },
  });

  test("shorthand gender uses two distinct param indexes", () => {
    const r = buildFilterSql({ gender: "men" }, gdef, { soft: true }, 4);
    expect(r.where).toBe("(gender = $4 OR gender = ANY($5::text[]))");
    expect(r.params).toEqual(["men", ["unisex"]]);
  });

  test("$eq gender uses two distinct param indexes at a non-default startIndex", () => {
    const r = buildFilterSql({ gender: { $eq: "women" } }, gdef, { soft: true }, 7);
    expect(r.where).toBe("(gender = $7 OR gender = ANY($8::text[]))");
    expect(r.params).toEqual(["women", ["unisex"]]);
  });
});
