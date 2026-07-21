import postgres from "postgres";
import type { PostgresAdapterOptions } from "./types.ts";

export interface PgExecutor {
  unsafe(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  begin<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T>;
  end(options?: { timeout?: number }): Promise<void>;
}

export class PostgresAdapter {
  readonly client: PgExecutor;
  #pgvectorVersion: [number, number] | null | undefined;

  constructor(client: PgExecutor) {
    this.client = client;
  }

  query(query: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    return this.client.unsafe(query, params);
  }

  async pgvectorVersion(): Promise<[number, number] | null> {
    if (this.#pgvectorVersion !== undefined) return this.#pgvectorVersion;
    const rows = await this.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
    const raw = rows[0]?.extversion;
    const match = typeof raw === "string" ? raw.match(/^(\d+)\.(\d+)/) : null;
    this.#pgvectorVersion = match ? [Number(match[1]), Number(match[2])] : null;
    return this.#pgvectorVersion;
  }

  async withSettings(
    settings: string[],
    query: string,
    params: unknown[] = []
  ): Promise<Record<string, unknown>[]> {
    if (!settings.length) return this.query(query, params);
    return this.client.begin(async (tx) => {
      for (const setting of settings) await tx.unsafe(setting);
      return tx.unsafe(query, params);
    });
  }

  async migrate(): Promise<void> {
    await this.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await this.query("CREATE EXTENSION IF NOT EXISTS unaccent");
  }

  close(): Promise<void> {
    return this.client.end({ timeout: 5 });
  }
}

export function createPostgresAdapter(options: PostgresAdapterOptions): PostgresAdapter {
  if (!options.url.trim()) throw new Error("@samesake/postgres: url is required");
  const client = postgres(options.url, {
    max: options.maxConnections ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
    types: { bigint: postgres.BigInt },
  });
  return new PostgresAdapter(client as unknown as PgExecutor);
}
