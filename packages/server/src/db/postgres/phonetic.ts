// Opt-in Indic-Soundex phonetic provider: a cross-script (Sinhala / Tamil / Latin) hash so
// the same name matches across scripts. Pass to createMatcher({ phonetic: indicPhonetic }) to
// enable phoneticEq matching; NOT installed by default. Supply your own PhoneticProvider for a
// different scheme. The algorithm is pinned by test/indic-phonetic.test.ts.

export interface PhoneticProvider {
  /** identifier for diagnostics */
  name: string;
  /** the `samesake_phonetic(text) -> text` CREATE FUNCTION DDL, qualified by the system schema */
  ddl: (schema: string) => string;
}

export const indicPhonetic: PhoneticProvider = {
  name: "indic-soundex",
  ddl: (s: string) =>
    `
    CREATE OR REPLACE FUNCTION ${s}.samesake_phonetic(input text)
    RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
    DECLARE
      s text;
    BEGIN
      s := lower(coalesce(input, ''));

      -- Aspirate-strip: in Latin transliterations of Sinhala/Tamil names, 'h'
      -- after d/t/k/p/g/b/c/j marks aspiration of the preceding consonant and
      -- has no separate phonetic class here (Tamil க has no 'kh' counterpart).
      -- Dropping it makes 'Maaladhi' ≡ 'Maaladi' so the Latin form lines up with
      -- the native Tamil/Sinhala spelling (e.g. 'மாலதி'). Word-initial 'h' and
      -- the 'sh' digraph are unaffected. (Scope: Sinhala/Tamil/Latin only — there
      -- is no Devanagari/other-Indic-script coverage despite the "Indic" name.)
      s := regexp_replace(s, '([dtkpgbcj])h', '\\1', 'g');

      -- Same 8-letter alphabet across scripts so 'Amma' ≡ 'අම්මා' ≡ 'அம்மா'.
      -- SINHALA
      s := translate(s, 'කඛගඝ',     'KKKK');
      s := translate(s, 'චඡජඣ',     'CCCC');
      s := translate(s, 'ටඨඩඪතථදධ', 'TTTTTTTT');
      s := translate(s, 'පඵබභ',     'PPPP');
      s := translate(s, 'සශෂ',      'SSS');
      s := translate(s, 'මනණඞඤං',   'NNNNNN');
      s := translate(s, 'ය',        'Y');
      s := translate(s, 'ර',        'R');
      s := translate(s, 'ලළ',       'LL');
      s := translate(s, 'වහ',       'VV');

      -- TAMIL
      -- NOTE: Tamil ச maps to S, not C, to align with how it is actually
      -- pronounced (and transliterated to Latin) in Sri Lankan and modern
      -- Indian Tamil — e.g. 'சில்' is romanised 'sil-', not 'chil-'. Tamil
      -- ஜ stays in the C class to align with Latin 'j' (which also → C).
      -- This is the load-bearing change for Tamil↔Latin same-name parity.
      s := translate(s, 'க',        'K');
      s := translate(s, 'ஞஙணநனம',   'NNNNNN');
      s := translate(s, 'ச',        'S');
      s := translate(s, 'ஜ',        'C');
      s := translate(s, 'டத',       'TT');
      s := translate(s, 'ற',        'R');
      s := translate(s, 'ப',        'P');
      s := translate(s, 'ஸஶஷ',      'SSS');
      s := translate(s, 'ய',        'Y');
      s := translate(s, 'ர',        'R');
      s := translate(s, 'லளழ',      'LLL');
      s := translate(s, 'வஹ',       'VV');

      -- LATIN
      s := translate(s, 'kgqx',     'KKKK');
      s := translate(s, 'cj',       'CC');
      s := translate(s, 'bp',       'PP');
      s := translate(s, 'dtf',      'TTT');
      s := translate(s, 'vwh',      'VVV');
      s := translate(s, 'mn',       'NN');
      s := translate(s, 'r',        'R');
      s := translate(s, 'l',        'L');
      s := translate(s, 'y',        'Y');
      s := translate(s, 'sz',       'SS');

      s := regexp_replace(s, '[^KCTPSNRLYVH]', '', 'g');
      s := regexp_replace(s, '(.)\\1+', '\\1', 'g');

      RETURN s;
    END;
    $fn$;`,
};
