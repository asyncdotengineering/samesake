import type { Scope } from "@samesake/core";
import type { VocabProvider } from "@samesake/query";
import type { DB } from "./d1.ts";

export function d1Vocab(db: DB): VocabProvider {
  return async (field: string, _scope?: Scope) => {
    const rows = db.prepare(
      `SELECT value FROM vocab WHERE field = ? ORDER BY count DESC, value ASC LIMIT 1000`,
    ).all(field) as Array<{ value: string }>;
    return rows.map((row) => row.value);
  };
}
