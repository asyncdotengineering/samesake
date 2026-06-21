import type { RelevanceJudge } from "./judge.ts";

export interface HumanLabel {
  query: string;
  id: string;
  grade: 0 | 1 | 2;
}

export interface CalibrateOpts {
  relevanceFloor?: 1 | 2;
  minLabels?: number;
  trustF1Bar?: number;
}

export interface CalibrateJudgeResult {
  precision: number;
  recall: number;
  f1: number;
  kappa: number;
  n: number;
}

function binaryRelevant(grade: number, floor: number): boolean {
  return grade >= floor;
}

function cohensKappa(human: number[], pred: number[]): number {
  const n = human.length;
  if (n === 0) return 0;
  const categories = [0, 1, 2];
  let agree = 0;
  for (let i = 0; i < n; i++) {
    if (human[i] === pred[i]) agree += 1;
  }
  const po = agree / n;
  const pe = categories.reduce((sum, c) => {
    const ph = human.filter((h) => h === c).length / n;
    const pp = pred.filter((p) => p === c).length / n;
    return sum + ph * pp;
  }, 0);
  if (pe === 1) return 1;
  return (po - pe) / (1 - pe);
}

function prf1(human: boolean[], pred: boolean[]): { precision: number; recall: number; f1: number } {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < human.length; i++) {
    const h = human[i]!;
    const p = pred[i]!;
    if (p && h) tp += 1;
    else if (p) fp += 1;
    else if (h) fn += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

export async function calibrateJudge(
  judge: RelevanceJudge,
  humanLabels: HumanLabel[],
  opts: CalibrateOpts = {}
): Promise<CalibrateJudgeResult> {
  const minLabels = opts.minLabels ?? 5;
  if (humanLabels.length < minLabels) {
    throw new Error("insufficient calibration set");
  }
  const floor = opts.relevanceFloor ?? 1;

  const byQuery = new Map<string, HumanLabel[]>();
  for (const row of humanLabels) {
    const list = byQuery.get(row.query) ?? [];
    list.push(row);
    byQuery.set(row.query, list);
  }

  const humanGrades: number[] = [];
  const predGrades: number[] = [];

  for (const [query, labels] of byQuery) {
    const candidates = labels.map((l) => ({
      id: l.id,
      text: `id: ${l.id}`,
      data: {},
    }));
    const judged = await judge.grade(query, candidates);
    const byId = new Map(judged.map((j) => [j.id, j.grade]));
    for (const l of labels) {
      humanGrades.push(l.grade);
      predGrades.push(byId.get(l.id) ?? 0);
    }
  }

  const humanBin = humanGrades.map((g) => binaryRelevant(g, floor));
  const predBin = predGrades.map((g) => binaryRelevant(g, floor));
  const { precision, recall, f1 } = prf1(humanBin, predBin);
  const kappa = cohensKappa(humanGrades, predGrades);

  return { precision, recall, f1, kappa, n: humanLabels.length };
}

export function isJudgeTrusted(result: CalibrateJudgeResult, bar = 0.8): boolean {
  return result.f1 >= bar;
}
