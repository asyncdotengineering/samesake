---
"@samesake/core": minor
"@samesake/server": minor
---

Multilingual lexical leg. `CollectionDef.language` picks the Postgres FTS config (stemmer +
stopwords) for both the indexed `fts` generated column and query parsing — the hardcoded
`'english'` is gone. The fts column now normalises through `samesake_normalise`
(lowercase + unaccent + punctuation folding) and queries fold accents via `unaccent()`, so
`café` ≡ `cafe` in any language. `CollectionSearchDef.phonetic: true` (with
`createMatcher({ phonetic })`) adds a cross-script phonetic branch to the lexical leg: a new
`samesake_phonetic_tokens` system function feeds a generated `fts_phon` column (GIN-indexed) and
query-side codes are ORed into the candidate set — a Sinhala/Tamil query finds the
Latin-transliterated product. Changing `language` on an existing collection is flagged as a
destructive migration. Note: collections created before this release keep their un-normalised fts
column until recreated — accented documents in old tables may stop matching accented queries
(queries are now accent-folded); recreate the collection to align both sides. Multilingual golden
queries (`ml-01…ml-05`, Sinhala/Tamil/mixed-script) added to the fashion-lk eval set.
