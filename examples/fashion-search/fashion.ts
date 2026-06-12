export const CATEGORIES = [
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

export const ENUMS = {
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

const CATEGORY_ATTRS: Record<string, Record<string, unknown>> = {
  dresses: {
    neckline: { type: "STRING", enum: ENUMS.neckline },
    length: { type: "STRING", enum: ENUMS.length },
    sleeve_length: { type: "STRING", enum: ENUMS.sleeve_length },
    silhouette: { type: "STRING", enum: ["a-line", "bodycon", "shift", "wrap", "fit-and-flare", "slip", "tiered", "mermaid", "straight", "unknown"] },
    details: { type: "ARRAY", items: { type: "STRING" }, description: "construction details: ruffled, smocked, tiered, cutout, lace, slit, belted, puff sleeve…" },
  },
  tops: {
    neckline: { type: "STRING", enum: ENUMS.neckline },
    sleeve_length: { type: "STRING", enum: ENUMS.sleeve_length },
    top_length: { type: "STRING", enum: ["cropped", "regular", "longline", "tunic", "unknown"] },
    strap_type: { type: "STRING", enum: ["spaghetti", "halter", "wide", "none", "unknown"] },
    details: { type: "ARRAY", items: { type: "STRING" } },
  },
  bottoms: {
    leg_cut: { type: "STRING", enum: ["skinny", "straight", "wide-leg", "flared", "bootcut", "cargo", "palazzo", "culotte", "pencil", "pleated", "a-line", "wrap", "unknown"] },
    rise: { type: "STRING", enum: ["high", "mid", "low", "elasticated", "drawstring", "unknown"] },
    length: { type: "STRING", enum: ENUMS.length },
    details: { type: "ARRAY", items: { type: "STRING" }, description: "wash, distressing, pleats, pockets, slit…" },
  },
  outerwear: {
    length: { type: "STRING", enum: ENUMS.length },
    closure: { type: "STRING", enum: ["zip", "buttons", "open", "belt", "snap", "unknown"] },
    lapel: { type: "STRING", enum: ["notch", "peak", "shawl", "collarless", "hooded", "unknown"] },
    details: { type: "ARRAY", items: { type: "STRING" } },
  },
  ethnic: {
    work: { type: "STRING", enum: ["zari", "embroidery", "sequin", "beadwork", "printed", "handloom", "plain", "unknown"], description: "embellishment/work" },
    border_type: { type: "STRING", description: "saree border description, or unknown" },
    set_composition: { type: "STRING", description: "e.g. saree+blouse, kurta+pant+dupatta, single piece" },
    drape_style: { type: "STRING", enum: ["kandyan", "indian", "ready-to-wear", "n/a", "unknown"] },
    details: { type: "ARRAY", items: { type: "STRING" } },
  },
  footwear: {
    heel_height: { type: "STRING", enum: ["flat", "low", "mid", "high", "platform", "unknown"] },
    toe_shape: { type: "STRING", enum: ["round", "pointed", "square", "open", "peep", "unknown"] },
    closure: { type: "STRING", enum: ["lace-up", "slip-on", "strap", "buckle", "zip", "unknown"] },
    details: { type: "ARRAY", items: { type: "STRING" } },
  },
};

const GENERIC_ATTRS = {
  neckline: { type: "STRING", enum: ENUMS.neckline },
  sleeve_length: { type: "STRING", enum: ENUMS.sleeve_length },
  length: { type: "STRING", enum: ENUMS.length },
  details: { type: "ARRAY", items: { type: "STRING" } },
};

const NO_ATTRS = { details: { type: "ARRAY", items: { type: "STRING" } } };

export function categoryAttrBlock(categoryId: string): Record<string, unknown> {
  if (CATEGORY_ATTRS[categoryId]) return CATEGORY_ATTRS[categoryId]!;
  if (["bags", "jewelry", "accessories", "other"].includes(categoryId)) return NO_ATTRS;
  return GENERIC_ATTRS;
}

export function stage1Schema(): Record<string, unknown> {
  return {
    type: "OBJECT",
    properties: {
      category: { type: "STRING", enum: CATEGORIES.map((c) => c.id) },
      product_type: { type: "STRING", description: `specific type, prefer one of the known types for the category (e.g. ${CATEGORIES.slice(0, 5).map((c) => c.types[0]).join(", ")}); free text allowed for unlisted types` },
      gender: { type: "STRING", enum: ENUMS.gender },
      is_apparel_product: { type: "BOOLEAN", description: "false for gift cards, homeware, fabric yardage etc." },
    },
    required: ["category", "product_type", "gender", "is_apparel_product"],
  };
}

export function stage2Schema(categoryId: string): Record<string, unknown> {
  return {
    type: "OBJECT",
    properties: {
      colors: { type: "ARRAY", items: { type: "STRING", enum: ENUMS.colors }, description: "primary color first" },
      raw_color: { type: "STRING", description: "the seller's marketing color name verbatim if stated, else empty" },
      pattern: { type: "STRING", enum: ENUMS.pattern },
      material: { type: "STRING", enum: ENUMS.materials, description: "from text when stated; from image only as a guess" },
      fit: { type: "STRING", enum: ENUMS.fit },
      occasions: { type: "ARRAY", items: { type: "STRING", enum: ENUMS.occasions }, description: "1-3 best occasions" },
      styles: { type: "ARRAY", items: { type: "STRING", enum: ENUMS.styles }, description: "1-3 styles DERIVED from objective attributes, not guessed from brand copy" },
      modesty: { type: "STRING", enum: ENUMS.modesty },
      ...categoryAttrBlock(categoryId),
      search_document: { type: "STRING", description: "2-3 sentence natural description for a shopper-facing search index: what it is, how it looks, what to wear it for. No marketing fluff." },
      confidence: { type: "NUMBER", description: "0-1 overall confidence in the extraction" },
      uncertain_fields: { type: "ARRAY", items: { type: "STRING" }, description: "attribute names you are unsure about" },
    },
    required: ["colors", "pattern", "occasions", "styles", "search_document", "confidence"],
  };
}

export const PARSE_INSTRUCTIONS = `You are cataloging a product for a Sri Lankan fashion search engine.
Extract attributes from the IMAGE primarily; the title/description are noisy seller copy — use them for facts a photo cannot show (material, set composition).
Rules: use ONLY the allowed enum values; use "unknown" when not visible rather than guessing; colors must be base colors (navy, not midnight-blue — put the marketing name in raw_color); styles must follow from what you can see (e.g. bohemian = floral + flowy + relaxed), never from brand copy; extract fine construction details (puff sleeve, flared, ruffled) even if they seem minor.`;

export function composeEmbedDoc(
  p: { title: string },
  a: Record<string, unknown>
): string {
  const parts = [
    `${p.title}.`,
    a.search_document || "",
    `Category: ${a.category}, type: ${a.product_type}, for ${a.gender}.`,
    Array.isArray(a.colors) && a.colors.length ? `Colors: ${(a.colors as string[]).join(", ")}.` : "",
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

export function nlqSchema(): Record<string, unknown> {
  return {
    type: "OBJECT",
    properties: {
      category: { type: "STRING", enum: [...CATEGORIES.map((c) => c.id), "any"] },
      gender: { type: "STRING", enum: [...ENUMS.gender, "any"] },
      colors: { type: "ARRAY", items: { type: "STRING", enum: ENUMS.colors } },
      exclude_colors: { type: "ARRAY", items: { type: "STRING", enum: ENUMS.colors } },
      occasions: { type: "ARRAY", items: { type: "STRING", enum: ENUMS.occasions } },
      exclude_patterns: { type: "ARRAY", items: { type: "STRING", enum: ENUMS.pattern } },
      exclude_terms: { type: "ARRAY", items: { type: "STRING" }, description: "negated attributes/styles, e.g. bodycon, skinny" },
      max_price: { type: "NUMBER", description: "LKR; 0 if none stated" },
      min_price: { type: "NUMBER", description: "LKR; 0 if none stated" },
      semantic_query: { type: "STRING", description: "the descriptive intent to match semantically, stripped of price/negation constraints; never empty" },
    },
    required: ["semantic_query"],
  };
}

export const NLQ_INSTRUCTIONS = `Parse a fashion shopper's search query (Sri Lanka, prices in LKR; "rupees"/"rs" = LKR).
Map EXPLICIT constraints to filters only when clearly stated: price limits, negations ("not bodycon", "no prints"), colors, gender, occasion.
Do NOT invent filters the shopper didn't state. Category only when unambiguous.
Budget words without a number ("cheap", "affordable", "budget") -> price_budget_hint=cheap; ("luxury", "high-end", "premium") -> premium. An explicit number always wins over the hint.
Sri Lankan cultural vocabulary (map to filters AND enrich the semantic_query with the translation):
- "poya" / "poya day" / "temple wear" -> colors=[white], occasions include festive, modest styling; semantic_query: "white modest outfit for temple or poya day".
- "kandyan" -> ethnic category, semantic_query mentions "kandyan osariya saree".
- "avurudu" / "new year" (Sinhala-Tamil New Year) -> occasions festive; semantic_query mentions "avurudu festive traditional wear".
- "osariya"=kandyan saree drape; "sarama"/"sarong" -> ethnic, gender men; "redda hatte"=traditional skirt+blouse; "salwar"/"shalwar"/"churidar"/"kurti" -> ethnic; "frock" (LK English) = dress; "office wear abaya" -> modest dress.
- Transliterations: "saree"="sari"; "gauma"=dress/frock (Sinhala); "kalisama"=trousers; "kamisaya"=shirt.
semantic_query: rewrite the remaining descriptive intent as a rich product description fragment (e.g. "office wear for women" -> "professional office workwear for women, formal tailored clothing").`;
