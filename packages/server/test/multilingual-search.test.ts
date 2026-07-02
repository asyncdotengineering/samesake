import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels } from "@samesake/core";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { indicPhonetic } from "../src/db/postgres/phonetic.ts";
import { ftsLanguage } from "../src/core/collections-schema-gen.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

describe("ftsLanguage validation", () => {
  test("defaults to english and rejects injection-shaped configs", () => {
    expect(ftsLanguage({ name: "x" })).toBe("english");
    expect(ftsLanguage({ name: "x", language: "german" })).toBe("german");
    expect(() => ftsLanguage({ name: "x", language: "english'; DROP TABLE t;--" })).toThrow(
      "invalid language"
    );
  });
});

// Deterministic embed: constant vector — the semantic leg never distinguishes
// docs, so every assertion below isolates the LEXICAL leg.
const flatEmbed = async ({ dim }: { text?: string; dim: number }) => {
  const v = new Array<number>(dim).fill(1);
  const norm = Math.sqrt(dim);
  return v.map((x) => x / norm);
};

// fts-only channel so results exist iff the lexical leg matched.
function lexOnly(name: string, opts: { language?: string; phonetic?: boolean }) {
  return collection(name, {
    ...(opts.language ? { language: opts.language } : {}),
    fields: { title: f.text({ searchable: true }) },
    embeddings: { doc: { source: "$title", model: "stub", dim: 8 } },
    search: {
      channels: [Channels.fts({ fields: ["title"], weight: 1 })],
      combiner: "rrf",
      ...(opts.phonetic ? { phonetic: true } : {}),
    },
  });
}

describeIf("multilingual lexical leg", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  const spanish = lexOnly("prod_es", { language: "spanish" });
  const english = lexOnly("prod_en", {}); // control: english stemmer
  const phonetic = lexOnly("prod_ph", { language: "simple", phonetic: true });

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "multilingual-test-key",
      migrate: "eager",
      phonetic: indicPhonetic,
      embed: flatEmbed,
    });
    await matcher.migrate();
    const applied = await matcher.apply(projectSlug, {
      entities: [],
      collections: [spanish, english, phonetic],
    });
    schemaName = applied.schema;

    const seed = async (coll: string, titles: Record<string, string>) => {
      await matcher.pushDocuments(
        projectSlug,
        coll,
        Object.entries(titles).map(([id, title]) => ({ id, data: { title } }))
      );
      const { indexed } = await matcher.index(projectSlug, coll);
      expect(indexed).toBe(Object.keys(titles).length);
    };

    await seed("prod_es", {
      es1: "vestido rojo elegante",
      es2: "camisa blanca de lino",
      es3: "café con leche taza", // accent-folding probe
    });
    await seed("prod_en", {
      en1: "vestido rojo elegante", // same doc under the english stemmer (control)
      en2: "red evening dress",
    });
    await seed("prod_ph", {
      ph1: "amma spice mix", // Latin transliteration of අම්මා
      ph2: "red running shoes",
    });
  }, 120000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    await matcher.close();
  });

  test("configurable stemmer: spanish gender inflection matches (english control does not)", async () => {
    // spanish stemmer conflates rojo/roja/rojos/rojas → roj, so the feminine
    // query "roja" matches "vestido rojo". (Plural "-s" is a bad probe — the
    // english stemmer strips that too.)
    const es = await matcher.search(projectSlug, "prod_es", { q: "roja", limit: 5 });
    expect(es.hits.map((h) => h.id)).toContain("es1");
    // english stemmer: roja ≠ rojo — same doc, same query, no lexical match.
    const en = await matcher.search(projectSlug, "prod_en", { q: "roja", limit: 5 });
    expect(en.hits.map((h) => h.id)).not.toContain("en1");
  });

  test("accent folding both directions: cafe ≡ café", async () => {
    const plain = await matcher.search(projectSlug, "prod_es", { q: "cafe", limit: 5 });
    expect(plain.hits.map((h) => h.id)).toContain("es3");
    const accented = await matcher.search(projectSlug, "prod_es", { q: "café", limit: 5 });
    expect(accented.hits.map((h) => h.id)).toContain("es3");
  });

  test("cross-script phonetic: Sinhala අම්මා finds the Latin transliteration", async () => {
    const res = await matcher.search(projectSlug, "prod_ph", { q: "අම්මා", limit: 5 });
    expect(res.hits.map((h) => h.id)).toContain("ph1");
  });

  test("phonetic leg off: the same cross-script query finds nothing", async () => {
    const res = await matcher.search(projectSlug, "prod_en", { q: "අම්මා", limit: 5 });
    expect(res.hits.length).toBe(0);
  });

  test("changing language on an existing collection is a destructive migration", async () => {
    const changed = lexOnly("prod_es", { language: "german" });
    await expect(
      matcher.apply(projectSlug, { entities: [], collections: [changed] })
    ).rejects.toThrow(/destructive/);
  });
});
