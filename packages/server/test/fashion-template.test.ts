import { describe, expect, test } from "bun:test";
import {
  fashion,
  fashionTaxonomy,
  fashionEnums,
  fashionClassifySchema,
  fashionExtractSchema,
  fashionEnrichPipeline,
  fashionSearchFields,
  fashionSpaces,
  composeFashionEmbedDoc,
  fashionNlqSchema,
  collection,
  Channels,
} from "../../sdk/src/index.ts";

describe("fashion enrichment template", () => {
  test("taxonomy + enums cover the basics", () => {
    expect(fashionTaxonomy.map((c) => c.id)).toContain("dresses");
    expect(fashionTaxonomy.map((c) => c.id)).toContain("ethnic");
    expect(fashionEnums.colors).toContain("red");
    expect(fashionEnums.occasions).toContain("wedding guest");
  });

  test("classify schema (zod) validates category/gender/apparel flag", () => {
    const s = fashionClassifySchema();
    const shape = (s as unknown as { shape: Record<string, unknown> }).shape;
    expect(shape.category).toBeDefined();
    expect(shape.gender).toBeDefined();
    expect(shape.is_apparel_product).toBeDefined();
    expect(s.safeParse({ category: "dresses", product_type: "midi dress", gender: "women", is_apparel_product: true }).success).toBe(true);
    expect(s.safeParse({ category: "not-a-category", product_type: "x", gender: "women", is_apparel_product: true }).success).toBe(false);
  });

  test("extract schema (zod) is category-aware (dresses get neckline; bags don't)", () => {
    const dress = (fashionExtractSchema("dresses") as unknown as { shape: Record<string, unknown> }).shape;
    expect(dress.neckline).toBeDefined();
    expect(dress.colors).toBeDefined();
    expect(dress.search_document).toBeDefined();
    const bag = (fashionExtractSchema("bags") as unknown as { shape: Record<string, unknown> }).shape;
    expect(bag.neckline).toBeUndefined();
    expect(bag.details).toBeDefined();
  });

  test("embed-doc composer weaves attributes into one string", () => {
    const doc = composeFashionEmbedDoc(
      { title: "Red Mirage Dress" },
      { search_document: "A flowy red evening dress.", category: "dresses", product_type: "midi dress", gender: "women", colors: ["red"], occasions: ["party", "evening"], styles: ["romantic"], material: "chiffon" }
    );
    expect(doc).toContain("Red Mirage Dress");
    expect(doc).toContain("Colors: red");
    expect(doc).toContain("Occasions: party");
    expect(doc).toContain("Material: chiffon");
  });

  test("enrich pipeline is classify -> extract, extract gated to apparel", () => {
    const p = fashionEnrichPipeline();
    expect(p.stages.map((s) => s.name)).toEqual(["classify", "extract"]);
    const extract = p.stages[1]!;
    expect(typeof extract.condition).toBe("function");
    expect(extract.condition!({ data: {}, enriched: { is_apparel_product: true, category: "dresses" } })).toBe(true);
    expect(extract.condition!({ data: {}, enriched: { is_apparel_product: false, category: "other" } })).toBe(false);
  });

  test("enrich pipeline honors custom data keys", () => {
    const p = fashionEnrichPipeline({ titleKey: "name", imageKey: "img" });
    const imgs = p.stages[0]!.images!({ data: { img: "http://x/y.jpg" }, enriched: {} });
    expect(imgs).toEqual(["http://x/y.jpg"]);
    expect(p.stages[0]!.prompt({ data: { name: "Blue Shirt" }, enriched: {} })).toContain("Blue Shirt");
  });

  test("search fields resolve attributes from enriched.*", () => {
    const f = fashionSearchFields();
    expect(f.colors).toMatchObject({ type: "array", itemType: "enum", path: "enriched.colors" });
    expect(f.category).toMatchObject({ type: "enum", path: "enriched.category" });
    expect(f.price).toMatchObject({ type: "number", budget: true });
  });

  test("spaces include visual by default; opt out", () => {
    const s = fashionSpaces();
    expect(s.visual).toBeDefined();
    expect((s.visual as { kind: string }).kind).toBe("image");
    expect((s.price as { kind: string }).kind).toBe("number");
    expect(fashionSpaces({ visual: false }).visual).toBeUndefined();
  });

  test("extract/classify prompts use structured prompting (role, named rules, few-shot)", () => {
    const p = fashionEnrichPipeline();
    const extract = p.stages[1]!.prompt({ data: { title: "x" }, enriched: { category: "dresses" } });
    expect(extract).toContain("<role>");
    expect(extract).toContain("rule[color_base]");
    expect(extract).toContain("<examples>");
    expect(extract).toContain("highest-stakes");
    const classify = p.stages[0]!.prompt({ data: { title: "x" }, enriched: {} });
    expect(classify).toContain("<role>");
    expect(classify).toContain("is_apparel_product");
  });

  test("nlq schema (zod) requires semantic_query", () => {
    const s = fashionNlqSchema();
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ semantic_query: "red dress" }).success).toBe(true);
  });

  test("template assembles a valid collection end-to-end", () => {
    const c = collection("products", {
      fields: fashionSearchFields(),
      embeddings: { doc: { source: fashion.embedDocSource, model: "gemini-embedding-2", dim: 1536 } },
      spaces: fashionSpaces({ visual: false }),
      enrich: fashionEnrichPipeline(),
      search: {
        channels: [Channels.cosine({ embedding: "doc", weight: 1 })],
        combiner: "rrf",
        variantGroup: "brand",
        nlq: { instructions: fashion.nlq.instructions, schema: fashion.nlq.schema() },
      },
    });
    expect(c.name).toBe("products");
    expect(Object.keys(c.fields)).toContain("colors");
  });
});
