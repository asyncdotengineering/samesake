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

  test("embed-doc composer weaves graded attributes into one string", () => {
    const doc = composeFashionEmbedDoc(
      { title: "Red Mirage Dress" },
      {
        search_document: "A flowy red evening dress.",
        product_type: "midi dress",
        category: "dresses",
        gender: "women",
        colors: ["red"],
        occasions: ["party", "evening"],
        styles: ["romantic"],
        material: "chiffon",
      }
    );
    expect(doc).toContain("Red Mirage Dress");
    expect(doc).toContain("A flowy red evening dress");
    expect(doc).toContain("Type: midi dress");
    expect(doc).toContain("Occasions: party");
    expect(doc).not.toContain("Colors:");
    expect(doc).not.toContain("Material:");
    expect(doc).not.toContain("Category:");
  });

  test("test:embed-doc-no-hard-attrs — indexing embed_doc is graded-only", () => {
    const idx = fashion.indexing();
    const embedDoc = idx.surfaces.embed_doc.build({
      data: { title: "Crimson Wrap Maxi Dress" },
      enriched: {
        search_document: "A deep-red floor-length wrap dress for evening parties.",
        product_type: "maxi dress",
        category: "dresses",
        gender: "women",
        colors: ["red"],
        occasions: ["evening", "party"],
        styles: ["romantic", "formal"],
        material: "chiffon",
        fit: "a-line",
      },
    });
    expect(embedDoc).toContain("Crimson Wrap Maxi Dress");
    expect(embedDoc).toContain("deep-red floor-length wrap dress");
    expect(embedDoc).toContain("Occasions:");
    expect(embedDoc).toContain("Style:");
    expect(embedDoc).not.toMatch(/\bCategory:/);
    expect(embedDoc).not.toMatch(/\bColors:/);
    expect(embedDoc).not.toMatch(/\bMaterial:/);
    expect(embedDoc).not.toMatch(/\bFit:/);
    expect(embedDoc).not.toMatch(/\bfor women\b/i);
  });

  test("test:gate-cross-signal — title/tags category disagreeing with enriched category quarantines", () => {
    const idx = fashion.indexing();
    const verdict = idx.gate({
      data: {
        title: "Men's Leather Running Sneakers",
        raw_tags: ["footwear", "sneakers", "running"],
        raw_type: "sneakers",
      },
      enriched: {
        is_apparel_product: true,
        category: "dresses",
        product_type: "midi dress",
        gender: "men",
        confidence: 0.95,
        uncertain_fields: [],
      },
    });
    expect(verdict).toEqual({ index: false, reason: "cross-signal-disagree" });
  });

  test("test:fashion-compose-gate — graded embed_doc non-empty; non-apparel and low-confidence quarantined", () => {
    const idx = fashion.indexing();
    const embedDoc = idx.surfaces.embed_doc.build({
      data: { title: "Floral Sundress" },
      enriched: {
        search_document: "A bright floral cotton sundress for warm days.",
        product_type: "sundress",
        category: "dresses",
        gender: "women",
        confidence: 0.9,
        occasions: ["everyday"],
        styles: ["casual"],
      },
    });
    expect(embedDoc.length).toBeGreaterThan(20);
    expect(embedDoc).toContain("Floral Sundress");

    expect(idx.gate({ data: { title: "Gift Card" }, enriched: { is_apparel_product: false } })).toEqual({
      index: false,
      reason: "non-apparel",
    });
    expect(
      idx.gate({
        data: { title: "Maybe Dress" },
        enriched: { is_apparel_product: true, category: "dresses", confidence: 0.2 },
      })
    ).toEqual({ index: false, reason: "low-confidence" });
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
      indexing: fashion.indexing(),
      embeddings: { doc: { model: "gemini-embedding-2", dim: 1536 } },
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
