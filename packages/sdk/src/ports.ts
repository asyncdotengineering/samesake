// Scope — the tenancy primitive shared across the enrich and query domains.
// Kept in @samesake/core as pure data. The domain ports themselves are NOT here:
// EnrichStore + the dedup CandidateProvider live in @samesake/enrich, and
// Retriever + VocabProvider live in @samesake/query, each alongside the domain
// that gives it meaning and its native types — so @samesake/core carries no
// parallel port hierarchy. Every backend implementer already depends on those
// packages (via createEnricher / createSearch), so ownership there adds no
// coupling.

export type Scope = Record<string, string>;
