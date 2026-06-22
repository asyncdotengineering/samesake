import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { indicPhonetic } from "../src/db/postgres/phonetic.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

// Golden test pinning the Indic-Soundex algorithm's cross-script equivalences before it
// is extracted into an opt-in provider. The invariant that matters is parity: the same
// name in Latin, Sinhala, and Tamil must hash to the same code. Exact codes are not asserted
// (they may evolve); equality is the contract. The function implements Sinhala/Tamil/Latin.
describeIf("indic phonetic (samesake_phonetic)", () => {
  let matcher: ReturnType<typeof createMatcher>;
  let db: ReturnType<typeof createDbFromUrl>["db"];
  let closeDb: () => Promise<void>;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      phonetic: indicPhonetic,
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async () => ({ semantic_query: "test" }),
    });
    await matcher.migrate();
    const h = createDbFromUrl(databaseUrl!);
    db = h.db;
    closeDb = h.close;
  });

  afterAll(async () => {
    await closeDb?.();
    await matcher.close();
  });

  const phon = async (s: string): Promise<string> => {
    const rows = (await db.execute(sql`SELECT public.samesake_phonetic(${s}) AS h`)) as unknown as Array<{ h: string }>;
    return rows[0]!.h;
  };

  test("same name hashes equal across Latin / Sinhala / Tamil", async () => {
    const amma = await phon("Amma");
    expect(await phon("අම්මා")).toBe(amma); // Sinhala
    expect(await phon("அம்மா")).toBe(amma); // Tamil
    expect(await phon("மாலதி")).toBe(await phon("Maaladhi")); // Tamil ≡ Latin
  });

  test("aspirated Latin transliterations collapse (dh→d, kh→k)", async () => {
    expect(await phon("Maaladhi")).toBe(await phon("Maaladi"));
  });

  test("distinct names hash differently", async () => {
    expect(await phon("Amma")).not.toBe(await phon("Rajan"));
  });

  test("apply rejects a phonetic entity when no provider is configured", async () => {
    const m = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async () => ({ semantic_query: "test" }),
      // no phonetic provider
    });
    await m.migrate();
    const slug = `t_${Math.random().toString(36).slice(2, 10)}`;
    await expect(
      m.apply(slug, {
        entities: [
          {
            name: "contact",
            fields: { name: { type: "string" } },
            phonetic: { name_phon: { source: "name", algorithm: "indic-soundex" } },
          },
        ],
        collections: [],
      } as unknown as Parameters<typeof m.apply>[1])
    ).rejects.toThrow(/phonetic provider/i);
    await m.close();
  });
});
