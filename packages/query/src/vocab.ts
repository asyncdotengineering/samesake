// Vocabulary-grounding types + the pure open-vocab field finder shared by query
// understanding. The DB-backed candidate lookup / value grounding stay in
// @samesake/server (they need a sql handle); the value-vocabulary TYPES and the
// pure def introspection live here so the query brain can describe grounded
// parsing without depending on the store. Server re-imports these.
import type { CollectionDef } from "@samesake/core";

export type VocabCandidates = Record<string, Array<{ value: string; count: number }>>;

export type VocabLookup = { available: boolean; candidates: VocabCandidates };

// GroundedValueDecision is owned by @samesake/core (constraint-trace already consumes
// it from there); re-export so query + server resolve one canonical type.
export type { GroundedValueDecision } from "@samesake/core";

export function openVocabFieldNames(def: CollectionDef): string[] {
  return Object.entries(def.fields)
    .filter(([, field]) => field.type === "text" && field.filterable)
    .map(([name]) => name);
}
