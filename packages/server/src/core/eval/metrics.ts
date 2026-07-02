/** ESCI gain: 3=Exact, 2=Substitute (soft positive), 1=Complement, 0=Irrelevant. */
export type Grade = 0 | 1 | 2 | 3;

type ConstraintValue = string | number | boolean | string[] | number[];

/**
 * Golden-query constraints in the same operator vocabulary as search filters:
 * `{ price: { "$lte": 5000 }, colors: { "$exclude": ["black"] }, gender: "women" }`.
 * A bare scalar means `$eq`; a bare array means `$in`. Fields resolve against the
 * hit's declared columns first, then the raw document data — nothing is hardcoded.
 */
export type GoldenConstraints = Record<
  string,
  ConstraintValue | Partial<Record<ConstraintOperator, ConstraintValue>>
>;

export type ConstraintOperator =
  | "$eq"
  | "$ne"
  | "$gt"
  | "$gte"
  | "$lt"
  | "$lte"
  | "$in"
  | "$nin"
  | "$contains"
  | "$exclude";

export interface ConstraintHit {
  id: string;
  value(field: string): unknown;
}

export function ndcgAtK(grades: number[], k: number): number {
  const dcg = grades.slice(0, k).reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  const ideal = [...grades].sort((a, b) => b - a).slice(0, k)
    .reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export function mrr(grades: number[], floor: number): number {
  const i = grades.findIndex((g) => g >= floor);
  return i < 0 ? 0 : 1 / (i + 1);
}

export function hitAtK(grades: number[], floor: number, k: number): number {
  return grades.slice(0, k).some((g) => g >= floor) ? 1 : 0;
}

export function nullRate(flags: boolean[]): number {
  if (flags.length === 0) return 0;
  return flags.filter(Boolean).length / flags.length;
}

function norm(v: unknown): string {
  return String(v).toLowerCase().trim();
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

function numeric(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function opViolated(hitValue: unknown, op: ConstraintOperator, expected: ConstraintValue): boolean {
  // A missing value can't violate — constraint checks measure contradictions, not coverage.
  if (hitValue == null || hitValue === "") return false;
  switch (op) {
    case "$eq":
      return asList(hitValue).every((h) => norm(h) !== norm(expected));
    case "$ne":
      return asList(hitValue).some((h) => norm(h) === norm(expected));
    case "$gt": {
      const h = numeric(hitValue);
      const e = numeric(expected);
      return h !== null && e !== null && !(h > e);
    }
    case "$gte": {
      const h = numeric(hitValue);
      const e = numeric(expected);
      return h !== null && e !== null && !(h >= e);
    }
    case "$lt": {
      const h = numeric(hitValue);
      const e = numeric(expected);
      return h !== null && e !== null && !(h < e);
    }
    case "$lte": {
      const h = numeric(hitValue);
      const e = numeric(expected);
      return h !== null && e !== null && !(h <= e);
    }
    case "$in": {
      const allowed = new Set(asList(expected).map(norm));
      return !asList(hitValue).some((h) => allowed.has(norm(h)));
    }
    case "$nin":
    case "$exclude": {
      const banned = new Set(asList(expected).map(norm));
      return asList(hitValue).some((h) => banned.has(norm(h)));
    }
    case "$contains":
      return !asList(expected).every((e) => asList(hitValue).map(norm).includes(norm(e)));
  }
}

function clauseEntries(
  clause: ConstraintValue | Partial<Record<ConstraintOperator, ConstraintValue>>
): Array<[ConstraintOperator, ConstraintValue]> {
  if (Array.isArray(clause)) return [["$in", clause]];
  if (typeof clause === "object" && clause !== null) {
    return Object.entries(clause) as Array<[ConstraintOperator, ConstraintValue]>;
  }
  return [["$eq", clause]];
}

export function hitViolatesConstraints(hit: ConstraintHit, constraints?: GoldenConstraints): boolean {
  if (!constraints) return false;
  for (const [field, clause] of Object.entries(constraints)) {
    const value = hit.value(field);
    for (const [op, expected] of clauseEntries(clause)) {
      if (opViolated(value, op, expected)) return true;
    }
  }
  return false;
}

export function constraintViolations(hits: ConstraintHit[], constraints?: GoldenConstraints): number {
  if (!constraints) return 0;
  return hits.filter((h) => hitViolatesConstraints(h, constraints)).length;
}
