import type { Scope } from "@samesake/core";
import type { VocabProvider } from "@samesake/query";
import type { PostgresAdapter } from "./adapter.ts";
import { ident } from "./ident.ts";
import type { CollectionBackendOptions } from "./types.ts";

export function pgVocab(adapter: PostgresAdapter, options: CollectionBackendOptions): VocabProvider {
  return async (field: string, scope?: Scope): Promise<string[]> => {
    ident(field, "vocabulary field");
    const census = `${options.table}_vocab`;
    const params: unknown[] = [field];
    const scopeSql = Object.entries(scope ?? options.scope ?? {})
      .map(([name, value]) => {
        params.push(value);
        return ` AND scope_${ident(name)} = $${params.length}`;
      })
      .join("");
    const rows = await adapter.query(
      `SELECT value FROM ${census} WHERE field = $1${scopeSql} ORDER BY count DESC, value ASC LIMIT 1000`,
      params
    );
    return rows.map((row) => String(row.value));
  };
}
