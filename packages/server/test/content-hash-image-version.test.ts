import { describe, expect, test } from "bun:test";
import { computeContentHash } from "../src/connectors/normalize.ts";

describe("test:content-hash-image-version", () => {
  const base = {
    title: "Silk Dress",
    description: null,
    price: 120,
    image_url: "https://cdn.example.com/dress.jpg",
    available: true,
    raw_type: null,
    raw_tags: [] as string[],
  };

  test("same image_url + new image_version → different content_hash", () => {
    const h1 = computeContentHash({ ...base, image_version: "v1" });
    const h2 = computeContentHash({ ...base, image_version: "v2" });
    expect(h1).not.toBe(h2);
  });

  test("identical inputs → identical content_hash", () => {
    const a = computeContentHash({ ...base, image_version: "v1" });
    const b = computeContentHash({ ...base, image_version: "v1" });
    expect(a).toBe(b);
  });

  test("no image validator → unchanged hash vs base fields only", () => {
    const without = computeContentHash(base);
    const withEmpty = computeContentHash({ ...base, image_version: "" });
    expect(without).toBe(withEmpty);
  });
});
