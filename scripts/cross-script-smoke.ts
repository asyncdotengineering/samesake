#!/usr/bin/env bun
// Cross-script phonetic + trigram smoke.
//
// Asserts the two load-bearing properties for cross-script same-name
// matching, which the baseline at docs/baselines/2026-05-20-cross-script-baseline.md
// names as production-blocking until both pass:
//
//   1. Tamil ↔ Latin phonetic keys converge for the canonical Sri Lankan
//      transliteration: 'Arun Sillarai' ≡ 'அருண் சில்லரை'. The previous
//      mapping (ச → C) failed this; the fix (ச → S) restores it.
//
//   2. Trigram similarity on phonetic signatures is meaningful (> 0.9 for
//      identical signatures, > 0.5 for one-char swap signatures) — this is
//      the cross-script bridge in the generated match_<kind> SQL: when the
//      original-text trigram is 0 because the scripts share no characters,
//      the phonetic-signature trigram carries the channel.
//
// Run against SAMESAKE_DATABASE_URL. Exits non-zero on any assertion fail.
import postgres from "postgres";

const url = process.env.SAMESAKE_DATABASE_URL;
if (!url) {
  console.error("SAMESAKE_DATABASE_URL not set");
  process.exit(2);
}

const sql = postgres(url, { prepare: false });

interface Case {
  label: string;
  a: string;
  b: string;
  predicate: "keys_equal" | "keys_differ" | "trgm_at_least";
  trgmFloor?: number;
}

const CASES: Case[] = [
  // ── Pair-equality cases — keys MUST match across scripts ──────────
  {
    label: "Sinhala ↔ Latin (Anuja Wiwarana)",
    a: "Anuja Wiwarana",  b: "අනූජ විවරණ",
    predicate: "keys_equal",
  },
  {
    label: "Sinhala ↔ Latin (Saman Perera)",
    a: "Saman Perera",    b: "සමන් පෙරේරා",
    predicate: "keys_equal",
  },
  {
    label: "Tamil ↔ Latin (Arun Sillarai) — the ச→S fix",
    a: "Arun Sillarai",   b: "அருண் சில்லரை",
    predicate: "keys_equal",
  },
  {
    label: "Tamil ↔ Latin (Maaladhi Kadai)",
    a: "Maaladhi Kadai",  b: "மாலதி கடை",
    predicate: "keys_equal",
  },

  // ── Pair-difference cases — distinct names MUST NOT collide ───────
  {
    label: "Distinct: Saman Perera ≠ Nimal Silva",
    a: "Saman Perera",    b: "Nimal Silva",
    predicate: "keys_differ",
  },
  {
    label: "Distinct: Arun Sillarai ≠ Maaladhi Kadai",
    a: "Arun Sillarai",   b: "Maaladhi Kadai",
    predicate: "keys_differ",
  },

  // ── Trigram-signature similarity — cross-script bridge ─────────────
  // Identical signatures (same phonetic key) → similarity > 0.9
  {
    label: "Trigram(phon('Anuja Wiwarana'), phon('අනූජ විවරණ')) ≥ 0.9",
    a: "Anuja Wiwarana",  b: "අනූජ විවරණ",
    predicate: "trgm_at_least", trgmFloor: 0.9,
  },
  {
    label: "Trigram(phon('Arun Sillarai'), phon('அருண் சில்லரை')) ≥ 0.9",
    a: "Arun Sillarai",   b: "அருண் சில்லரை",
    predicate: "trgm_at_least", trgmFloor: 0.9,
  },
];

let passed = 0, failed = 0;

for (const c of CASES) {
  const [{ a: ka, b: kb, trgm }] = await sql<{ a: string; b: string; trgm: number }[]>`
    SELECT public.samesake_phonetic(${c.a}) AS a,
           public.samesake_phonetic(${c.b}) AS b,
           similarity(public.samesake_phonetic(${c.a}), public.samesake_phonetic(${c.b}))::real AS trgm
  `;

  let ok = false; let detail = "";
  switch (c.predicate) {
    case "keys_equal":
      ok = ka === kb;
      detail = `phon(${JSON.stringify(c.a)})=${ka}  phon(${JSON.stringify(c.b)})=${kb}`;
      break;
    case "keys_differ":
      ok = ka !== kb;
      detail = `phon(${JSON.stringify(c.a)})=${ka}  phon(${JSON.stringify(c.b)})=${kb}`;
      break;
    case "trgm_at_least":
      ok = trgm >= (c.trgmFloor ?? 0);
      detail = `phon(${JSON.stringify(c.a)})=${ka}  phon(${JSON.stringify(c.b)})=${kb}  trgm=${trgm.toFixed(3)} (floor ${c.trgmFloor})`;
      break;
  }

  if (ok) { passed++; console.log(`  ✓  ${c.label}\n     ${detail}`); }
  else    { failed++; console.log(`  ✗  ${c.label}\n     ${detail}`); }
}

await sql.end({ timeout: 2 });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
