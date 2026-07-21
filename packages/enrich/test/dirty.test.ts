import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { contentHash, selectDirty, type RawRow } from "../src/index.ts";

// The exact material string the hash joins with "|", computed independently of
// contentHash() so a drift in field order, defaults, or join char is caught.
// title | description | price | image_url | available | raw_type | JSON.stringify(raw_tags)
function materialOf(p: {
  title: string;
  description: string | null;
  price: number | null;
  image_url: string | null;
  available: boolean;
  raw_type: string | null;
  raw_tags: string[];
  imageVersion?: string | null;
}): string {
  const parts = [
    p.title,
    p.description,
    p.price,
    p.image_url,
    p.available,
    p.raw_type,
    JSON.stringify(p.raw_tags),
  ];
  if (p.imageVersion) parts.push(p.imageVersion);
  return parts.join("|");
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

describe("contentHash — byte-identical to pre-move server function", () => {
  test("golden: {title:'Red Dress', price:1990, raw_tags:['a','b']} → known sha1", () => {
    const data = { title: "Red Dress", price: 1990, raw_tags: ["a", "b"] };
    const h = contentHash(data);

    // Captured from the exact material string:
    //   "Red Dress" | null | 1990 | null | false | null | ["a","b"]
    // join → "Red Dress||1990||false||[\"a\",\"b\"]"
    expect(h).toBe("5acffbeaf5567a7c09c4f6994ee1c5f19ef45e07");

    // And it must equal sha1 of the material string built independently above.
    expect(h).toBe(
      sha1(
        materialOf({
          title: "Red Dress",
          description: null,
          price: 1990,
          image_url: null,
          available: false,
          raw_type: null,
          raw_tags: ["a", "b"],
        })
      )
    );
  });

  test("image_version token is appended when present (changes the hash)", () => {
    const base = { title: "Dress", price: 50, raw_tags: [] };
    const without = contentHash(base);
    const withV1 = contentHash({ ...base, image_version: "v1" });
    const withV2 = contentHash({ ...base, image_version: "v2" });
    expect(withV1).not.toBe(without);
    expect(withV1).not.toBe(withV2);
    expect(withV1).toBe(
      sha1(
        materialOf({
          title: "Dress",
          description: null,
          price: 50,
          image_url: null,
          available: false,
          raw_type: null,
          raw_tags: [],
          imageVersion: "v1",
        })
      )
    );
  });
});

describe("selectDirty", () => {
  const rows: RawRow[] = [
    { id: "a", data: { title: "A", price: 10, raw_tags: ["x"] } },
    { id: "b", data: { title: "B", price: 20, raw_tags: [] } },
    { id: "c", data: { title: "C", price: 30, raw_tags: ["y"] } },
  ];
  // Baseline: every row's current hash returned as the prior hash → nothing dirty.
  const baseline = new Map(rows.map((r) => [r.id, contentHash(r.data)]));

  test("unchanged batch (priorHash === current hash) → []", () => {
    expect(selectDirty(rows, (id) => baseline.get(id))).toEqual([]);
  });

  test("one edited field → exactly that row", () => {
    const edited: RawRow[] = [
      rows[0]!,
      { id: "b", data: { title: "B-edited", price: 20, raw_tags: [] } },
      rows[2]!,
    ];
    const dirty = selectDirty(edited, (id) => baseline.get(id));
    expect(dirty.map((r) => r.id)).toEqual(["b"]);
  });

  test("absent prior hash (undefined) → row is dirty", () => {
    const newRows: RawRow[] = [
      ...rows,
      { id: "d", data: { title: "D", price: 40, raw_tags: [] } },
    ];
    const dirty = selectDirty(newRows, (id) => baseline.get(id));
    expect(dirty.map((r) => r.id)).toEqual(["d"]);
  });
});
