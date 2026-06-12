import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, entity, fields, f, Channels, IdentError } from "@samesake/core";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

describe("identifier validation at SDK factories", () => {
  test("collection rejects invalid name", () => {
    expect(() =>
      collection("a-b", { fields: { x: f.text() }, search: { channels: [] } })
    ).toThrow(IdentError);
  });

  test("entity rejects invalid name", () => {
    expect(() =>
      entity("Bad-Name", {
        fields: { name: fields.text({ required: true }) },
        scopes: ["tenant"],
        scoring: { channels: [] },
      })
    ).toThrow(IdentError);
  });

  test("collection rejects case-insensitive field collision", () => {
    expect(() =>
      collection("products", {
        fields: { Foo: f.text(), foo: f.text() },
        search: { channels: [] },
      })
    ).toThrow(IdentError);
  });
});

describeIf("identifier validation at apply", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let matcher: ReturnType<typeof createMatcher>;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
    });
    await matcher.migrate();
  });

  afterAll(async () => {
    if (matcher) await matcher.close();
  });

  test("apply rejects invalid collection name in raw config", async () => {
    await expect(
      matcher.apply(projectSlug, {
        entities: [],
        collections: [
          {
            name: "a-b",
            fields: { t: f.text({ searchable: true }) },
            search: { channels: [{ kind: "fts", fields: ["t"], weight: 1 }] },
          },
        ],
      })
    ).rejects.toThrow(/invalid_identifier|invalid/);
  });

  test("apply rejects overly long collection name", async () => {
    const longName = "a" + "b".repeat(70);
    await expect(
      matcher.apply(projectSlug, {
        entities: [],
        collections: [
          {
            name: longName,
            fields: { t: f.text({ searchable: true }) },
            search: { channels: [] },
          },
        ],
      })
    ).rejects.toThrow(/invalid_identifier|exceeds max length/);
  });

  test("apply rejects entity name collision via sanitization bypass", async () => {
    const slug = `t_${Math.random().toString(36).slice(2, 10)}`;
    await matcher.apply(slug, {
      entities: [],
      collections: [
        collection("valid_one", {
          fields: { t: f.text({ searchable: true }) },
          search: { channels: [Channels.fts({ fields: ["t"], weight: 1 })] },
        }),
      ],
    });
    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS project_${slug} CASCADE`));
    await close();

    await expect(
      matcher.apply(slug, {
        entities: [
          {
            name: "a_b",
            fields: { name: fields.text({ required: true }) },
            scopes: ["tenant"],
            scoring: { channels: [] },
          },
          {
            name: "a-b",
            fields: { name: fields.text({ required: true }) },
            scopes: ["tenant"],
            scoring: { channels: [] },
          },
        ],
        collections: [],
      })
    ).rejects.toThrow(/invalid_identifier|invalid/);
  });
});
