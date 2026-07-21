// @samesake/query — the store-agnostic search query brain. This slice ships the
// ports + plan contract; the brain modules (nlq, aspect planning, cutoff,
// ranking, rerank) and createSearch land in the following sub-slices.
export type { Retriever, VocabProvider } from "./ports.ts";
export type { RetrievalPlan, RankedRow } from "./plan.ts";
