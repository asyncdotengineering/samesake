import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDbFromUrl } from "../src/db/client.ts";
import { PostgresAdapter } from "../src/db/storage-adapter.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

// Pins the atomicity guarantee that applyProject relies on: a throw inside the
// transaction rolls back every statement (no partially-applied DDL).
describeIf("StorageAdapter.transaction", () => {
  let handle: ReturnType<typeof createDbFromUrl>;
  let adapter: PostgresAdapter;
  const tbl = `tx_test_${Math.random().toString(36).slice(2, 8)}`;

  const exists = async (): Promise<boolean> => {
    const rows = (await handle.db.execute(
      sql.raw(`SELECT to_regclass('public.${tbl}') AS t`)
    )) as unknown as Array<{ t: string | null }>;
    return rows[0]!.t != null;
  };

  beforeAll(() => {
    handle = createDbFromUrl(databaseUrl!);
    adapter = new PostgresAdapter(handle);
  });
  afterAll(async () => {
    await handle.db.execute(sql.raw(`DROP TABLE IF EXISTS public.${tbl}`));
    await handle.close();
  });

  test("rolls back all statements when the function throws", async () => {
    await expect(
      adapter.transaction(async (tx) => {
        await tx.execute(sql.raw(`CREATE TABLE public.${tbl} (id int)`));
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await exists()).toBe(false);
  });

  test("commits when the function returns", async () => {
    await adapter.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE TABLE public.${tbl} (id int)`));
    });
    expect(await exists()).toBe(true);
  });
});
