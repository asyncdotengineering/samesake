// Runnable version of the "Build a search experience" guide, end to end on Postgres.
// Requires SAMESAKE_DATABASE_URL (a Postgres with pgvector). Proves the guide's claim:
// searching "light dress for a beach wedding under 15000" returns the ivory linen dress
// and EXCLUDES the 28,000 sequin dress — because the budget is a hard filter, not a score.
import { samesake } from "@samesake/postgres";
import { products } from "./catalog.ts";
import { stubEmbed, stubGenerate } from "./stubs.ts";

const QUERY = "light dress for a beach wedding under 15000";

export interface HarnessResult {
  ids: string[];
  ivoryReturned: boolean;
  sequinExcluded: boolean;
  hits: { id: string; price: number; score: number }[];
}

export async function runHarness(url = process.env.SAMESAKE_DATABASE_URL): Promise<HarnessResult> {
  if (!url) throw new Error("SAMESAKE_DATABASE_URL is required (a Postgres with pgvector)");

  // Isolate this run in its own schema so it never collides with other data.
  const schema = `bse_${Math.random().toString(36).slice(2, 10)}`;
  const app = samesake({
    url,
    schema,
    collection: products,
    models: { embed: stubEmbed, generate: stubGenerate },
  });

  try {
    await app.migrate();

    await app.enrich.upsert([
      { id: "1", data: { title: "ivory linen slip dress", brand: "atelier", price: 12900, color: "ivory", available: true } },
      { id: "2", data: { title: "black sequin party dress", brand: "luxe", price: 28000, color: "black", available: true } },
    ]);
    await app.enrich.enrich();

    const { hits } = await app.search(QUERY, { filters: { available: true }, limit: 10 });

    const rows = hits.map((h) => ({
      id: String(h.id),
      price: Number((h as Record<string, unknown>).price),
      score: Number(h.score),
    }));
    const ids = rows.map((r) => r.id);
    return {
      ids,
      ivoryReturned: ids.includes("1"),
      sequinExcluded: !ids.includes("2"),
      hits: rows,
    };
  } finally {
    await app.close?.();
  }
}

if (import.meta.main) {
  const r = await runHarness();
  console.log(JSON.stringify({ query: QUERY, ...r }, null, 2));
  console.log(
    r.ivoryReturned && r.sequinExcluded
      ? "\nOK: ivory linen dress returned, 28,000 sequin dress excluded by the budget."
      : "\nMISMATCH: the guide's claim did not hold — see hits above.",
  );
}
