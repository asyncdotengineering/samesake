export type Grade = 0 | 1 | 2;

export interface GoldenConstraints {
  max_price?: number;
  exclude_colors?: string[];
  gender?: string;
  category?: string;
}

export interface ConstraintHit {
  id: string;
  price?: number;
  colors?: string[];
  gender?: string;
  category?: string;
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

function normColor(c: string): string {
  return c.toLowerCase().trim();
}

function hitViolatesConstraints(hit: ConstraintHit, constraints?: GoldenConstraints): boolean {
  if (!constraints) return false;
  if (constraints.max_price != null && hit.price != null && hit.price > constraints.max_price) {
    return true;
  }
  if (constraints.exclude_colors?.length && hit.colors?.length) {
    const excluded = new Set(constraints.exclude_colors.map(normColor));
    if (hit.colors.some((c) => excluded.has(normColor(c)))) return true;
  }
  if (constraints.gender && hit.gender && normColor(hit.gender) !== normColor(constraints.gender)) {
    return true;
  }
  if (constraints.category && hit.category && normColor(hit.category) !== normColor(constraints.category)) {
    return true;
  }
  return false;
}

export function constraintViolations(hits: ConstraintHit[], constraints?: GoldenConstraints): number {
  if (!constraints) return 0;
  return hits.filter((h) => hitViolatesConstraints(h, constraints)).length;
}
