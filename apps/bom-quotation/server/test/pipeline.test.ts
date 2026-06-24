// Full-pipeline wiring test — no DB, no LLM, no real file. We stub the three external/LLM seams
// (parseDocument + extractLines + normalizeLines); the prefix strategy + buildQuotation run for
// real. So this pins the orchestration: a stubbed BOM flows parse→extract→normalize→price→quote
// to a priced quotation, deterministically. (The real extract/normalize mapping + the live
// matching layer stay covered by the `bun run quote` smoke.)
import { mock, describe, test, expect } from "bun:test";
import type { Matcher } from "../src/catalog.ts";
import type { CustomerRef, Company, RawBomLine, NormalizedBomLine } from "../../shared/types.ts";

const raw: RawBomLine[] = [
  { lineNo: 1, description: "3C 2.5sqmm Cu cable", qty: 100, unit: "m", code: null, source: "xlsx" },
  { lineNo: 2, description: "32A SP MCB", qty: 8, unit: "nos", code: null, source: "xlsx" },
];
const normalized: NormalizedBomLine[] = [
  { lineNo: 1, description: "3C 2.5sqmm Cu cable", source: "xlsx", normalized: "copper cable 3 core 2.5",
    qty: 100, unit: "m", unitFactor: 1, category: "cable", specs: { cores: 3, csaMm2: 2.5, conductor: "copper" }, notes: [] },
  { lineNo: 2, description: "32A SP MCB", source: "xlsx", normalized: "32A SP MCB",
    qty: 8, unit: "nos", unitFactor: 1, category: "breaker", specs: { ratingA: 32, poles: "SP" }, notes: [] },
];

mock.module("../src/pipeline/parse.ts", () => ({ parseDocument: async () => ({ kind: "xlsx", rows: [["x"]] }) }));
mock.module("../src/pipeline/extract.ts", () => ({ extractLines: async () => raw }));
mock.module("../src/pipeline/normalize.ts", () => ({ normalizeLines: async () => normalized }));

const { runPipeline } = await import("../src/pipeline/index.ts");
const { setActivePack, loadPackFromYaml } = await import("../src/rulepack/load.ts");

const customer: CustomerRef = { id: "c1", name: "Test", tier: "contractor-a" };
const company: Company = { name: "X", registration: "R", address: "A", phone: "P", email: "e@x", currency: "LKR", logoText: "X" };

describe("runPipeline — parse→extract→normalize→price→quote (prefix mode, stubbed LLM)", () => {
  test("a stubbed BOM flows end to end to a priced quotation", async () => {
    setActivePack(loadPackFromYaml("electrical-mep-prefix"));
    const { quotation, matched } = await runPipeline({} as Matcher, "ignored.xlsx", customer, company);

    expect(matched.length).toBe(2);
    expect(quotation.lines.length).toBe(2);
    // formula list prices flow through: cable 30*3 + 2.5*3*44 = 420; breaker 650 + 32*4 = 778
    expect(quotation.lines.find((l) => l.lineNo === 1)?.listPrice).toBe(420);
    expect(quotation.lines.find((l) => l.lineNo === 2)?.listPrice).toBe(778);
    expect(quotation.totals.grandTotal).toBeGreaterThan(0);
  });
});
