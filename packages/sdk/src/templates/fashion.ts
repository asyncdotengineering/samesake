// Fashion commerce enrichment template — best-default catalog enrichment so consumers get
// genuine attribute extraction (category, colors, occasion, style, material, fit…) + a
// search-ready embed doc + fashion-aware NLQ without rewriting ~200 lines per project.
//
// Region-neutral and parametrized: pass the data keys your raw catalog uses. The LLM-facing
// schemas are declared with zod (field-level .describe() carries the instruction); the framework
// converts them to JSON Schema for your `generate` function via normalizeSchema.
//
// Mechanism (the pipeline runner, modes, RRF, etc.) already lives in core/server; this module
// is the declarative *content*: taxonomy, enums, two-stage schemas, prompts, embed-doc composer,
// and NLQ defaults.
import { z } from "zod";
import type { CollectionFieldDef, DerivedDocContext, IndexingDef, PipelineDef, SpaceDef, StageDef } from "../types.ts";

// ── Taxonomy + controlled vocabulary ────────────────────────────────────
export const fashionTaxonomy = [
  { id: "dresses", label: "Dresses & one-pieces", types: ["mini dress", "midi dress", "maxi dress", "shift dress", "wrap dress", "bodycon dress", "shirt dress", "gown", "jumpsuit", "romper", "frock", "abaya"] },
  { id: "tops", label: "Tops", types: ["t-shirt", "shirt", "blouse", "crop top", "tank top", "tube top", "tunic", "bodysuit", "polo", "sweatshirt", "hoodie"] },
  { id: "bottoms", label: "Bottoms", types: ["jeans", "trousers", "pants", "palazzo pants", "leggings", "shorts", "skirt", "culottes", "cargo pants", "sweatpants"] },
  { id: "outerwear", label: "Outerwear", types: ["blazer", "jacket", "denim jacket", "bomber", "coat", "trench coat", "cardigan", "kimono", "shrug", "vest"] },
  { id: "ethnic", label: "Ethnic & traditional", types: ["saree", "kandyan saree", "saree blouse", "kurta", "kurti", "lehenga", "salwar set", "shalwar", "sarong", "batik shirt", "dupatta"] },
  { id: "activewear", label: "Activewear", types: ["sports bra", "gym leggings", "training shorts", "track pants", "tracksuit", "jersey", "rash guard"] },
  { id: "swimwear", label: "Swimwear", types: ["bikini", "swimsuit", "swim shorts", "cover-up"] },
  { id: "sleep-lounge", label: "Sleep & lounge", types: ["pajama set", "nightdress", "robe", "lounge set", "lounge pants"] },
  { id: "underwear", label: "Underwear & shapewear", types: ["bra", "panties", "boxers", "briefs", "shapewear", "camisole"] },
  { id: "footwear", label: "Footwear", types: ["sneakers", "sandals", "heels", "flats", "boots", "slippers", "loafers"] },
  { id: "bags", label: "Bags", types: ["handbag", "tote", "crossbody bag", "clutch", "backpack", "wallet"] },
  { id: "jewelry", label: "Jewelry", types: ["necklace", "earrings", "bracelet", "ring", "anklet", "brooch"] },
  { id: "accessories", label: "Accessories", types: ["belt", "scarf", "hat", "cap", "sunglasses", "watch", "hair accessory", "tie"] },
  { id: "kids", label: "Kids & baby", types: ["kids dress", "kids t-shirt", "baby romper", "kids shorts", "school uniform"] },
  { id: "other", label: "Other / non-apparel", types: ["gift card", "fabric", "homeware", "unknown"] },
] as const;

export const fashionEnums = {
  gender: ["women", "men", "unisex", "kids"],
  colors: ["black", "white", "ivory", "beige", "brown", "tan", "grey", "silver", "gold", "red", "maroon", "pink", "purple", "lavender", "blue", "navy", "teal", "green", "olive", "mint", "yellow", "mustard", "orange", "peach", "multicolor"],
  pattern: ["solid", "floral", "striped", "checked", "polka dot", "animal", "abstract", "batik", "embroidered", "graphic", "tie-dye", "colorblock", "other"],
  fit: ["slim", "regular", "relaxed", "oversized", "bodycon", "a-line", "tailored", "unknown"],
  occasions: ["everyday", "office", "party", "wedding guest", "festive", "beach", "vacation", "gym", "lounge", "evening"],
  styles: ["casual", "formal", "bohemian", "minimalist", "streetwear", "vintage", "romantic", "edgy", "preppy", "y2k", "modest", "classic", "sporty"],
  materials: ["cotton", "linen", "denim", "silk", "satin", "chiffon", "georgette", "knit", "jersey", "polyester", "viscose", "rayon", "lace", "leather", "velvet", "crepe", "wool", "blend", "unknown"],
  modesty: ["modest", "moderate", "revealing"],
  length: ["cropped", "mini", "knee", "midi", "maxi", "ankle", "full", "regular", "longline", "unknown"],
  sleeve_length: ["sleeveless", "cap", "short", "elbow", "three-quarter", "long", "unknown"],
  neckline: ["v-neck", "round", "crew", "square", "halter", "off-shoulder", "one-shoulder", "sweetheart", "collared", "boat", "cowl", "high neck", "strapless", "unknown"],
} as const;

// ── Per-category fine attributes (stage 2 extension), as zod field maps ──
// Field-level .describe() IS the instruction to the model (Mastra pattern). Optional fields
// become not-required in the converted JSON Schema.
const zEnum = (vals: readonly string[]) => z.enum(vals as unknown as [string, ...string[]]);
type ZShape = Record<string, z.ZodTypeAny>;

const CATEGORY_ATTRS: Record<string, () => ZShape> = {
  dresses: () => ({
    neckline: zEnum(fashionEnums.neckline).optional(),
    length: zEnum(fashionEnums.length).optional(),
    sleeve_length: zEnum(fashionEnums.sleeve_length).optional(),
    silhouette: zEnum(["a-line", "bodycon", "shift", "wrap", "fit-and-flare", "slip", "tiered", "mermaid", "straight", "unknown"]).optional(),
    details: z.array(z.string()).optional().describe("construction details: ruffled, smocked, tiered, cutout, lace, slit, belted, puff sleeve…"),
  }),
  tops: () => ({
    neckline: zEnum(fashionEnums.neckline).optional(),
    sleeve_length: zEnum(fashionEnums.sleeve_length).optional(),
    top_length: zEnum(["cropped", "regular", "longline", "tunic", "unknown"]).optional(),
    strap_type: zEnum(["spaghetti", "halter", "wide", "none", "unknown"]).optional(),
    details: z.array(z.string()).optional(),
  }),
  bottoms: () => ({
    leg_cut: zEnum(["skinny", "straight", "wide-leg", "flared", "bootcut", "cargo", "palazzo", "culotte", "pencil", "pleated", "a-line", "wrap", "unknown"]).optional(),
    rise: zEnum(["high", "mid", "low", "elasticated", "drawstring", "unknown"]).optional(),
    length: zEnum(fashionEnums.length).optional(),
    details: z.array(z.string()).optional().describe("wash, distressing, pleats, pockets, slit…"),
  }),
  outerwear: () => ({
    length: zEnum(fashionEnums.length).optional(),
    closure: zEnum(["zip", "buttons", "open", "belt", "snap", "unknown"]).optional(),
    lapel: zEnum(["notch", "peak", "shawl", "collarless", "hooded", "unknown"]).optional(),
    details: z.array(z.string()).optional(),
  }),
  ethnic: () => ({
    work: zEnum(["zari", "embroidery", "sequin", "beadwork", "printed", "handloom", "plain", "unknown"]).optional().describe("embellishment/work"),
    border_type: z.string().optional().describe("saree border description, or unknown"),
    set_composition: z.string().optional().describe("e.g. saree+blouse, kurta+pant+dupatta, single piece"),
    drape_style: zEnum(["kandyan", "indian", "ready-to-wear", "n/a", "unknown"]).optional(),
    details: z.array(z.string()).optional(),
  }),
  footwear: () => ({
    heel_height: zEnum(["flat", "low", "mid", "high", "platform", "unknown"]).optional(),
    toe_shape: zEnum(["round", "pointed", "square", "open", "peep", "unknown"]).optional(),
    closure: zEnum(["lace-up", "slip-on", "strap", "buckle", "zip", "unknown"]).optional(),
    details: z.array(z.string()).optional(),
  }),
};
const GENERIC_ATTRS = (): ZShape => ({
  neckline: zEnum(fashionEnums.neckline).optional(),
  sleeve_length: zEnum(fashionEnums.sleeve_length).optional(),
  length: zEnum(fashionEnums.length).optional(),
  details: z.array(z.string()).optional(),
});
const NO_ATTRS = (): ZShape => ({ details: z.array(z.string()).optional() });

export function fashionCategoryAttrBlock(categoryId: string): ZShape {
  const build = CATEGORY_ATTRS[categoryId];
  if (build) return build();
  if (["bags", "jewelry", "accessories", "other"].includes(categoryId)) return NO_ATTRS();
  return GENERIC_ATTRS();
}

// ── Stage schemas (zod; the framework converts to JSON Schema for your generate fn) ──
export function fashionClassifySchema(): z.ZodType {
  return z.object({
    category: zEnum(fashionTaxonomy.map((c) => c.id)).describe("the single best taxonomy id for this garment"),
    product_type: z.string().describe(`specific type, prefer a known type for the category (e.g. ${fashionTaxonomy.slice(0, 5).map((c) => c.types[0]).join(", ")}); free text allowed`),
    gender: zEnum(fashionEnums.gender).describe("intended wearer; 'unisex' when not gendered"),
    is_apparel_product: z.boolean().describe("false for non-wearables (gift cards, homeware, fabric yardage) — these skip attribute extraction"),
  });
}

export function fashionExtractSchema(categoryId: string): z.ZodType {
  return z.object({
    colors: z.array(zEnum(fashionEnums.colors)).describe("rule[color_base]: BASE colours only (red, navy, beige), primary colour first; marketing names go in raw_color"),
    raw_color: z.string().optional().describe("the seller's marketing colour name verbatim if stated (e.g. crimson, midnight, blush), else empty"),
    pattern: zEnum(fashionEnums.pattern).describe("dominant visible pattern; 'solid' if plain"),
    material: zEnum(fashionEnums.materials).optional().describe("from text when stated; from the image only as a low-confidence guess; else 'unknown'"),
    fit: zEnum(fashionEnums.fit).optional().describe("how it sits on the body; 'unknown' if not visible"),
    occasions: z.array(zEnum(fashionEnums.occasions)).describe("1-3 best occasions to wear it"),
    styles: z.array(zEnum(fashionEnums.styles)).describe("rule[style_derive]: 1-3 styles derived from VISIBLE attributes (floral+flowy→bohemian), never from brand copy"),
    modesty: zEnum(fashionEnums.modesty).optional().describe("coverage level"),
    ...fashionCategoryAttrBlock(categoryId),
    search_document: z.string().describe("rule[search_document]: 2-3 plain shopper-facing sentences — what it is, how it looks, what to wear it for. No marketing fluff."),
    confidence: z.number().describe("0.9+ = clear photo & obvious attributes; 0.5-0.7 = partial/ambiguous; <0.4 = mostly inferred"),
    uncertain_fields: z.array(z.string()).optional().describe("names of attributes you are unsure about (rule[unknown_over_guess])"),
  });
}

export const FASHION_EXTRACT_INSTRUCTIONS = `<role>
You are a fashion merchandiser cataloging ONE product for a visual search engine.
Extract the structured attributes a shopper would filter or search by.
</role>

<inputs>
You receive the product title + seller tags/description (noisy marketing copy) and, when available, the product IMAGE. Prefer the IMAGE for anything visible (colour, pattern, silhouette, neckline, sleeve, fit, length); use text only for facts a photo cannot show (material, set composition).
</inputs>

<priority>
category, colors, gender and occasions drive hard filtering and ranking — these are the highest-stakes fields, get them right. If you cannot tell, list the field in uncertain_fields instead of guessing.
</priority>

<rules>
- rule[enums_only]: use ONLY the allowed enum values for each field; never invent a value.
- rule[unknown_over_guess]: if an attribute is not visible or stated, use "unknown" (or omit) — do not guess.
- rule[color_base]: colors are BASE colours only (red, navy, beige, olive…), primary colour first. Put the seller's marketing colour name verbatim in raw_color (e.g. title "Crimson" → colors:["red"], raw_color:"crimson"; "midnight" → colors:["navy"], raw_color:"midnight").
- rule[style_derive]: styles must follow from what you SEE, never from brand copy — floral+flowy+relaxed → bohemian; tailored+structured → formal; cropped+logo+boxy → streetwear.
- rule[details]: capture fine construction details even if minor (puff sleeve, ruffled, tiered, cutout, slit, belted, smocked).
- rule[search_document]: 2-3 plain sentences a shopper understands — what it is, how it looks, what to wear it for. No marketing fluff.
- confidence: 0.9+ = clear photo, attributes obvious; 0.5-0.7 = partial/ambiguous; <0.4 = mostly inferred. List every shaky attribute in uncertain_fields.
</rules>

<examples>
<example>
<input>Title "Crimson Wrap Maxi Dress" · tags: occasion wear · image: deep-red floor-length wrap dress, V-neck, long flutter sleeves, flowy</input>
<output>{"colors":["red"],"raw_color":"crimson","pattern":"solid","material":"unknown","fit":"a-line","occasions":["evening","party"],"styles":["romantic","formal"],"neckline":"v-neck","length":"maxi","sleeve_length":"long","silhouette":"wrap","details":["wrap","flutter sleeve"],"search_document":"A deep-red floor-length wrap dress with a V-neck and flowing sleeves, made for evening parties and formal occasions.","confidence":0.9,"uncertain_fields":["material"]}</output>
<rationale>rule[color_base]: "Crimson" → red + raw_color. material not visible → "unknown" + flagged.</rationale>
</example>
<example>
<input>Title "Heritage Linen Stripe Short Sleeve Shirt - Slate" · desc: men's breathable linen · image: grey-and-white vertically striped short-sleeve button shirt</input>
<output>{"colors":["grey","white"],"raw_color":"slate","pattern":"striped","material":"linen","fit":"regular","occasions":["everyday","vacation"],"styles":["casual","classic"],"neckline":"collared","sleeve_length":"short","search_document":"A grey-and-white striped short-sleeve linen shirt, light and breathable for everyday and warm-weather wear.","confidence":0.85,"uncertain_fields":[]}</output>
<rationale>material stated in text → "linen". rule[style_derive]: striped+linen+relaxed → casual/classic, not brand copy.</rationale>
</example>
</examples>`;

// ── Two-stage enrich pipeline (classify → extract) ──────────────────────
export interface FashionEnrichOptions {
  /** Raw-catalog data keys. Defaults match common Shopify-style fields. */
  titleKey?: string;
  descriptionKey?: string;
  tagsKey?: string;
  typeKey?: string;
  imageKey?: string;
  /** Model identifiers passed to your `generate` fn. Default to semantic tokens you can map. */
  classifyModel?: string;
  extractModel?: string;
}

function strOf(v: unknown): string {
  return v == null ? "" : Array.isArray(v) ? v.slice(0, 12).map(String).join(", ") : String(v);
}

export function fashionEnrichPipeline(opts: FashionEnrichOptions = {}): PipelineDef {
  const titleKey = opts.titleKey ?? "title";
  const descKey = opts.descriptionKey ?? "description";
  const tagsKey = opts.tagsKey ?? "tags";
  const typeKey = opts.typeKey ?? "product_type";
  const imageKey = opts.imageKey ?? "image_url";
  const classifyModel = opts.classifyModel ?? "classify";
  const extractModel = opts.extractModel ?? "extract";

  const images = (ctx: { data: Record<string, unknown> }) => {
    const u = ctx.data[imageKey];
    return u ? [String(u)] : [];
  };

  const classify: StageDef = {
    name: "classify",
    model: classifyModel,
    images,
    prompt: (ctx) =>
      `<role>Classify ONE product into the fashion catalog taxonomy. Use the IMAGE when present.</role>
<rules>
- category: the single best taxonomy id for the garment.
- product_type: the specific type (e.g. "midi dress", "denim jacket", "saree"); free text allowed.
- gender: women / men / unisex / kids.
- is_apparel_product: false for non-wearables (gift cards, fabric yardage, homeware) → these skip attribute extraction.
</rules>
Title: ${strOf(ctx.data[titleKey])}
Store type/categories: ${strOf(ctx.data[typeKey]) || "n/a"}
Tags: ${strOf(ctx.data[tagsKey]) || "n/a"}`,
    schema: () => fashionClassifySchema(),
  };

  const extract: StageDef = {
    name: "extract",
    model: extractModel,
    condition: (ctx) => ctx.enriched.is_apparel_product === true && ctx.enriched.category !== "other",
    images,
    prompt: (ctx) => {
      const hasImage = !!ctx.data[imageKey];
      return `${FASHION_EXTRACT_INSTRUCTIONS}\n\nProduct (category: ${strOf(ctx.enriched.category)}, type: ${strOf(ctx.enriched.product_type)}):\nTitle: ${strOf(ctx.data[titleKey])}\nStore type/categories: ${strOf(ctx.data[typeKey]) || "n/a"}\nTags: ${strOf(ctx.data[tagsKey])}\nDescription: ${strOf(ctx.data[descKey]).slice(0, 800) || "n/a"}${hasImage ? "" : "\n(NO IMAGE AVAILABLE - extract from text only, mark uncertain fields)"}`;
    },
    schema: (ctx) => fashionExtractSchema(String(ctx.enriched.category ?? "other")),
  };

  return { stages: [classify, extract] };
}

// PLACEHOLDER — tune via the offline eval gate (examples/fashion-search/eval-judge.ts + runEval);
// see apps/docs/src/content/docs/guides/eval-gate.mdx. Requires GEMINI_API_KEY for empirical sweep.
export const FASHION_CONFIDENCE_FLOOR = 0.5;

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v) return [v];
  return [];
}

function intersects(a: string[], b: string[]): boolean {
  const set = new Set(a.map((v) => v.toLowerCase()));
  return b.some((v) => set.has(v.toLowerCase()));
}

function inferCategoryFromText(text: string): string | null {
  const lower = text.toLowerCase();
  for (const cat of fashionTaxonomy) {
    if (lower.includes(cat.id) || lower.includes(cat.id.replace("-", " "))) return cat.id;
    for (const t of cat.types) {
      if (lower.includes(t)) return cat.id;
    }
  }
  return null;
}

function crossSignalAgrees(ctx: DerivedDocContext): boolean {
  const title = String(ctx.data.title ?? "");
  const tags = asArray(ctx.data.raw_tags ?? ctx.data.tags).join(" ");
  const rawType = String(ctx.data.raw_type ?? ctx.data.product_type ?? "");
  const fromText = inferCategoryFromText([title, tags, rawType].filter(Boolean).join(" "));
  const fromEnriched = String(ctx.enriched.category ?? "");
  if (!fromText || !fromEnriched) return true;
  return fromText === fromEnriched;
}

// Graded/compositional embed text only — hard attrs stay in filters/spaces (REQ-11b).
export function composeFashionEmbedDoc(p: { title: string }, a: Record<string, unknown>): string {
  const parts = [
    `${p.title}.`,
    (a.search_document as string) || "",
    a.product_type ? `Type: ${a.product_type}.` : "",
    a.pattern && a.pattern !== "solid" ? `Pattern: ${a.pattern}.` : "",
    Array.isArray(a.occasions) && a.occasions.length ? `Occasions: ${(a.occasions as string[]).join(", ")}.` : "",
    Array.isArray(a.styles) && a.styles.length ? `Style: ${(a.styles as string[]).join(", ")}.` : "",
    Array.isArray(a.details) && a.details.length ? `Details: ${(a.details as string[]).slice(0, 6).join(", ")}.` : "",
    a.modesty === "modest" ? "Modest coverage." : "",
  ];
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

export function composeFashionRerankDoc(p: { title: string }, a: Record<string, unknown>): string {
  const parts = [
    `${p.title}.`,
    (a.search_document as string) || "",
    `Category: ${a.category}, type: ${a.product_type}, for ${a.gender}.`,
    Array.isArray(a.colors) && a.colors.length ? `Colors: ${(a.colors as string[]).join(", ")}.` : "",
    a.raw_color ? `Color name: ${a.raw_color}.` : "",
    a.pattern && a.pattern !== "solid" ? `Pattern: ${a.pattern}.` : "",
    a.material && a.material !== "unknown" ? `Material: ${a.material}.` : "",
    a.fit && a.fit !== "unknown" ? `Fit: ${a.fit}.` : "",
    Array.isArray(a.occasions) && a.occasions.length ? `Occasions: ${(a.occasions as string[]).join(", ")}.` : "",
    Array.isArray(a.styles) && a.styles.length ? `Style: ${(a.styles as string[]).join(", ")}.` : "",
    Array.isArray(a.details) && a.details.length ? `Details: ${(a.details as string[]).slice(0, 6).join(", ")}.` : "",
    a.modesty === "modest" ? "Modest coverage." : "",
  ];
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

export function fashionIndexing(opts: { titleKey?: string } = {}): IndexingDef {
  const titleKey = opts.titleKey ?? "title";
  return {
    surfaces: {
      embed_doc: {
        kind: "dense",
        embedding: "doc",
        build: ({ data, enriched }) => composeFashionEmbedDoc({ title: String(data[titleKey] ?? "") }, enriched),
      },
      rerank_doc: {
        kind: "rerank",
        build: ({ data, enriched }) => composeFashionRerankDoc({ title: String(data[titleKey] ?? "") }, enriched),
      },
      fts_doc: {
        kind: "fts",
        build: ({ data, enriched }) =>
          [data[titleKey], enriched.product_type, enriched.raw_color, ...(asArray(enriched.styles))].filter(Boolean).join(" "),
      },
    },
    gate: ({ data, enriched }) => {
      if (enriched.is_apparel_product === false) return { index: false, reason: "non-apparel" };
      if (enriched.category === "other") return { index: false, reason: "category-other" };
      if (Number(enriched.confidence ?? 1) < FASHION_CONFIDENCE_FLOOR) return { index: false, reason: "low-confidence" };
      if (intersects(asArray(enriched.uncertain_fields), ["category", "gender", "colors"])) {
        return { index: false, reason: "uncertain-load-bearing" };
      }
      if (!crossSignalAgrees({ data, enriched })) return { index: false, reason: "cross-signal-disagree" };
      return { index: true };
    },
  };
}

// ── Fashion-aware NLQ defaults (region-neutral) ─────────────────────────
export function fashionNlqSchema(): z.ZodType {
  // Every constraint field is `.nullable()` (not `.optional()`) so the model is forced
  // to emit it — value or null — instead of silently dropping it; operational
  // descriptions tell the model exactly how to map natural language to each field.
  return z.object({
    category: zEnum([...fashionTaxonomy.map((c) => c.id), "any"]).nullable().describe("Product category, only when unambiguous; else null."),
    gender: zEnum([...fashionEnums.gender, "any"]).nullable().describe("Target gender if stated; else null."),
    colors: z.array(zEnum(fashionEnums.colors)).nullable().describe("Colors the shopper explicitly wants, e.g. 'red dress' -> ['red']; else null."),
    exclude_colors: z.array(zEnum(fashionEnums.colors)).nullable().describe("Colors explicitly excluded, e.g. 'not black' -> ['black']; else null."),
    occasions: z.array(zEnum(fashionEnums.occasions)).nullable().describe("Occasions/use explicitly stated, e.g. 'for a wedding'; else null."),
    styles: z.array(zEnum(fashionEnums.styles)).nullable().describe("Style / aesthetic. Map cultural & mood references to the closest styles: 'quiet luxury'->['minimalist','classic']; 'old money'->['classic','preppy']; 'y2k'->['y2k']; 'cottagecore'->['romantic','bohemian']; 'clean girl'/'coastal grandmother'->['minimalist','classic']; 'boho'->['bohemian']; 'streetwear'->['streetwear']. else null."),
    exclude_patterns: z.array(zEnum(fashionEnums.pattern)).nullable().describe("Patterns excluded, e.g. 'no prints'; else null."),
    exclude_terms: z.array(z.string()).nullable().describe("Negated attributes/styles, e.g. ['bodycon','skinny']; else null."),
    max_price: z.number().nullable().describe("Upper price bound as a plain number; strip currency + commas. Map 'under/below/less than/up to N' -> N. null if no upper bound."),
    min_price: z.number().nullable().describe("Lower price bound as a plain number. Map 'over/above/more than/at least/from N' -> N. 'between A and B' sets min=A and max=B. null if no lower bound."),
    price_budget_hint: zEnum(["cheap", "premium"]).nullable().describe("Vague budget words with NO number: 'cheap/affordable/budget'->'cheap'; 'luxury/high-end/premium'->'premium'. An explicit price number always wins. null for an AESTHETIC like 'quiet luxury' (that's a style, not a price)."),
    semantic_query: z.string().describe("The remaining descriptive intent, STRIPPED of every constraint mapped above (price, color, gender, negation), rewritten as a rich product-description fragment. Never empty; never echoes price/constraint words. e.g. 'red shoes under 3000' -> 'shoes'."),
  });
}

export const FASHION_NLQ_INSTRUCTIONS = `Parse a fashion shopper's search query into structured filters and a clean semantic_query.

- Map EXPLICIT constraints to filters only when clearly stated: price bounds, colors, gender, occasion, negations ("not bodycon", "no prints"). Do NOT invent filters the shopper didn't state. Set category only when unambiguous.
- Price: "under/below/less than/up to N" -> max_price=N; "over/above/at least/from N" -> min_price=N; "between A and B" -> min_price=A and max_price=B. Strip currency symbols and commas.
- Budget words without a number ("cheap", "affordable", "budget") -> price_budget_hint=cheap; ("luxury", "high-end", "premium") -> premium. An explicit number always wins.
- styles/aesthetics: when the query names a fashion AESTHETIC or cultural reference ("quiet luxury", "old money", "y2k", "cottagecore", "coastal grandmother", "clean girl", "streetwear", "boho"), set styles to the closest values AND expand semantic_query into the concrete look (silhouette, palette, materials) it implies — never leave a known aesthetic only as raw words. Note: "quiet luxury" is an aesthetic (styles), not a price signal.
- semantic_query: the remaining descriptive intent, STRIPPED of every constraint mapped above (price, color, gender, negation), rewritten as a rich product-description fragment. Never empty; never echo the price/constraint words.

<examples>
<example><input>men's shoes under 3000</input><output>{"gender":"men","max_price":3000,"min_price":null,"colors":null,"semantic_query":"men's shoes"}</output></example>
<example><input>silver watch over 6000</input><output>{"min_price":6000,"max_price":null,"colors":["silver"],"semantic_query":"wristwatch"}</output></example>
<example><input>red dress for a wedding under 5000</input><output>{"colors":["red"],"occasions":["wedding"],"max_price":5000,"semantic_query":"dress for a wedding"}</output></example>
<example><input>office wear for women, nothing bodycon</input><output>{"gender":"women","exclude_terms":["bodycon"],"semantic_query":"professional tailored office workwear for women"}</output></example>
<example><input>quiet luxury</input><output>{"styles":["minimalist","classic"],"semantic_query":"understated tailored minimalist clothing in neutral tones and premium materials, no logos"}</output></example>
<example><input>old money aesthetic</input><output>{"styles":["classic","preppy"],"semantic_query":"timeless preppy tailored heritage pieces in navy, beige and cream"}</output></example>
</examples>`;

// Standard fashion search fields. Declared attributes resolve from enriched.* (filled by the
// enrich pipeline). Override paths/keys as your raw catalog requires.
export function fashionSearchFields(opts: { brandPath?: string } = {}): Record<string, CollectionFieldDef> {
  const enumF = (values: readonly string[], extra: Partial<CollectionFieldDef> = {}): CollectionFieldDef =>
    ({ type: "enum", values: [...values], ...extra } as CollectionFieldDef);
  const arrEnumF = (values: readonly string[], extra: Partial<CollectionFieldDef> = {}): CollectionFieldDef =>
    ({ type: "array", itemType: "enum", values: [...values], ...extra } as CollectionFieldDef);
  return {
    title: { type: "text", searchable: true, path: "title" },
    brand: { type: "text", filterable: true, facet: true, path: opts.brandPath ?? "vendor" },
    price: { type: "number", filterable: true, budget: true },
    available: { type: "boolean", filterable: true },
    category: enumF(fashionTaxonomy.map((c) => c.id), { filterable: true, facet: true, path: "enriched.category" }),
    product_type: { type: "text", filterable: true, path: "enriched.product_type" },
    gender: enumF(fashionEnums.gender, { filterable: true, alsoMatch: ["unisex"], path: "enriched.gender" } as Partial<CollectionFieldDef>),
    colors: arrEnumF(fashionEnums.colors, { filterable: true, soft: true, facet: true, path: "enriched.colors" }),
    occasions: arrEnumF(fashionEnums.occasions, { filterable: true, soft: true, path: "enriched.occasions" }),
    styles: arrEnumF(fashionEnums.styles, { filterable: true, soft: true, path: "enriched.styles" }),
    pattern: enumF(fashionEnums.pattern, { filterable: true, path: "enriched.pattern" }),
    material: enumF(fashionEnums.materials, { filterable: true, path: "enriched.material" }),
    fit: enumF(fashionEnums.fit, { filterable: true, path: "enriched.fit" }),
    image_url: { type: "text" },
  };
}

// Visual + price + category + freshness spaces (no `style` text-space — that duplicates the
// cosine doc channel and would blow pgvector's 2000-d HNSW limit; see CHANGELOG).
export function fashionSpaces(opts: { visual?: boolean; priceMax?: number } = {}): Record<string, SpaceDef> {
  const spaces: Record<string, SpaceDef> = {
    price: { kind: "number", field: "price", mode: "closer", dims: 8, min: 0, max: opts.priceMax ?? 50000, scale: "log" } as SpaceDef,
    freshness: { kind: "recency", field: "ingested_at", halfLifeDays: 60, dims: 8 } as SpaceDef,
    category: { kind: "categorical", field: "category", values: fashionTaxonomy.map((c) => c.id), dims: 32 } as SpaceDef,
  };
  if (opts.visual !== false) {
    spaces.visual = { kind: "image", source: "$image_url", model: "gemini-embedding-2", dim: 768, taskType: "RETRIEVAL_DOCUMENT" } as SpaceDef;
  }
  return spaces;
}

// ── Enrichment-accuracy eval defaults ───────────────────────────────────
/** One scorable attribute for enrichment-accuracy eval. Structurally matches @samesake/server's
 * `AttrSpec` (kept dependency-free here so the SDK does not import the server). */
export interface EnrichEvalAttr {
  name: string;
  kind: "single" | "multi";
  /** Values that mean "no value" beyond ""/null/missing. Defaults to ["unknown"] in the scorer. */
  empty?: string[];
}

/**
 * Default attribute specs for scoring fashion enrichment accuracy via `matcher.evaluateEnrichment`.
 * The controlled, gate/filter-critical attributes the classify+extract pipeline is expected to get
 * right. `is_apparel_product` has no "unknown" state (true/false are both real), so its empty-set is
 * []. Baked into the template (like fashion.fields/spaces/nlq) so consumers score without hand-rolling.
 */
export function fashionEvalAttributes(): EnrichEvalAttr[] {
  return [
    { name: "category", kind: "single" },
    { name: "gender", kind: "single" },
    { name: "colors", kind: "multi" },
    { name: "pattern", kind: "single" },
    { name: "is_apparel_product", kind: "single", empty: [] },
  ];
}

/** Grouped namespace — `import { fashion } from "@samesake/core"`. */
export const fashion = {
  taxonomy: fashionTaxonomy,
  enums: fashionEnums,
  fields: fashionSearchFields,
  spaces: fashionSpaces,
  enrichPipeline: fashionEnrichPipeline,
  indexing: fashionIndexing,
  classifySchema: fashionClassifySchema,
  extractSchema: fashionExtractSchema,
  extractInstructions: FASHION_EXTRACT_INSTRUCTIONS,
  nlq: { instructions: FASHION_NLQ_INSTRUCTIONS, schema: fashionNlqSchema },
  evalAttributes: fashionEvalAttributes,
};
