// odds.ts — token-odds logistic regression, written from scratch.
//
// Question: for a protocol with no token yet, how likely is DefiLlama
// to have a ticker RECORDED for it? The target is y = 1 when a ticker
// is recorded (gecko_id or symbol set), y = 0 when no token is recorded
// at all. That is a narrower claim than "the token will trade" — the
// README says so plainly — and the middle class (ticker recorded but
// no usable cap) is now IN the training set as y = 1, not excluded.
//
// The fit is full-batch gradient descent with a ridge penalty on every
// weight except the bias, numeric features standardised, family and
// category as separate ridge groups of raw 0/1 dummies. Nothing is
// hardcoded: every level, mean, scale and weight is fitted at run time.
export interface OddsRow {
  slug: string;
  listedAt: string | null;
  ageYears: number | null;
  lnTvl: number;
  growthRaw: number | null;
  lnChains: number;
  family: string;
  category: string;
  y: number;
}

export type OddsTermKept = "kept" | "tested, not kept" | "baseline";

export interface OddsTermEvidence {
  name: string;
  brier: number;
  wfBrier: number;
  kept: OddsTermKept;
}

export interface OddsEvidence {
  n: number;
  baseRate: number;
  baselineBrier: number;
  baselineWfBrier: number;
  finalBrier: number;
  finalWfBrier: number;
  walkForwardCorrect: number;
  terms: OddsTermEvidence[];
}

// The candidate groups, in selection order. The no-category variant
// (v8 delta 2) drops "category" from this list and nothing else.
export const ODDS_GROUPS = [
  "age",
  "lntvl",
  "growth",
  "family",
  "category",
  "lnch",
] as const;

export const ODDS_GROUPS_NOCAT = [
  "age",
  "lntvl",
  "growth",
  "family",
  "lnch",
] as const;

export type OddsGroup = (typeof ODDS_GROUPS)[number];

const GROUP_LABELS: Record<string, string> = {
  age: "age (years listed)",
  lntvl: "ln(TVL)",
  growth: "7-day TVL growth",
  family: "family (ridge 16, raw dummies)",
  category: "category (ridge 16, raw dummies)",
  lnch: "chain count (ln)",
};

interface OddsStats {
  meanAge: number;
  meanGrowth: number;
  catLevels: string[];
  famLevels: string[];
  means: number[];
  sds: number[];
}

interface OddsModel {
  groups: OddsGroup[];
  stats: OddsStats;
  weights: number[];
  baseRate: number;
}

// Sigmoid with a clamped input, so it can never overflow.
function sigmoid(z: number): number {
  const clamped = z < -30 ? -30 : z > 30 ? 30 : z;
  return 1 / (1 + Math.exp(-clamped));
}

// Raw design columns for one row, walking the groups in order. Family
// and category contribute one raw 0/1 dummy per level; numeric columns
// are standardised downstream, dummies are not.
function rawColumns(
  row: OddsRow,
  groups: readonly string[],
  stats: OddsStats,
): number[] {
  const cols: number[] = [];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (group === "age") {
      cols.push(row.ageYears !== null && row.ageYears !== undefined ? row.ageYears : stats.meanAge);
    } else if (group === "lntvl") {
      cols.push(row.lnTvl);
    } else if (group === "growth") {
      const raw = row.growthRaw !== null && row.growthRaw !== undefined ? row.growthRaw : stats.meanGrowth;
      cols.push(raw < -0.9 ? -0.9 : raw > 3 ? 3 : raw);
    } else if (group === "lnch") {
      cols.push(row.lnChains);
    } else if (group === "family") {
      for (let i = 0; i < stats.famLevels.length; i++) {
        cols.push(row.family === stats.famLevels[i] ? 1 : 0);
      }
    } else if (group === "category") {
      for (let i = 0; i < stats.catLevels.length; i++) {
        cols.push(row.category === stats.catLevels[i] ? 1 : 0);
      }
    }
  }
  return cols;
}

// Column metadata, aligned with the raw columns: whether the column is
// a raw dummy, and its ridge penalty (16 per dummy, 1 per numeric).
function columnInfo(
  groups: readonly string[],
  stats: OddsStats,
): { raw: boolean[]; penalty: number[] } {
  const raw: boolean[] = [];
  const penalty: number[] = [];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (group === "family") {
      for (let i = 0; i < stats.famLevels.length; i++) {
        raw.push(true);
        penalty.push(16);
      }
    } else if (group === "category") {
      for (let i = 0; i < stats.catLevels.length; i++) {
        raw.push(true);
        penalty.push(16);
      }
    } else {
      raw.push(false);
      penalty.push(1);
    }
  }
  return { raw: raw, penalty: penalty };
}

// Fit-time statistics: the imputation means, the family levels that
// appear at least twice (alphabetical), every category level
// (alphabetical), and the per-column mean and population standard
// deviation. Raw dummy columns are then overridden to mean 0, sd 1,
// so the design matrix passes the 0/1 values through unchanged.
function fitStats(rows: OddsRow[], groups: readonly string[]): OddsStats {
  let ageSum = 0;
  let ageCount = 0;
  let growthSum = 0;
  let growthCount = 0;
  const famCounts = new Map<string, number>();
  const catSet = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.ageYears !== null && r.ageYears !== undefined) {
      ageSum += r.ageYears;
      ageCount += 1;
    }
    if (r.growthRaw !== null && r.growthRaw !== undefined) {
      growthSum += r.growthRaw;
      growthCount += 1;
    }
    famCounts.set(r.family, (famCounts.get(r.family) || 0) + 1);
    catSet.add(r.category);
  }
  const famLevels: string[] = [];
  famCounts.forEach(function (count, fam) {
    if (count >= 2) famLevels.push(fam);
  });
  famLevels.sort();
  const catLevels = Array.from(catSet).sort();
  const stats: OddsStats = {
    meanAge: ageCount > 0 ? ageSum / ageCount : 0,
    meanGrowth: growthCount > 0 ? growthSum / growthCount : 0,
    catLevels: catLevels,
    famLevels: famLevels,
    means: [],
    sds: [],
  };
  // Build the raw matrix once and read the column statistics off it,
  // accumulating each column's sum over the rows in index order — the
  // same order a per-column pass would use, without rebuilding the
  // columns once per column.
  const matrix: number[][] = [];
  for (let i = 0; i < rows.length; i++) matrix.push(rawColumns(rows[i], groups, stats));
  const d = rows.length > 0 ? matrix[0].length : 0;
  const means: number[] = [];
  const sds: number[] = [];
  for (let j = 0; j < d; j++) {
    let sum = 0;
    for (let i = 0; i < rows.length; i++) sum += matrix[i][j];
    const mean = rows.length > 0 ? sum / rows.length : 0;
    let varSum = 0;
    for (let i = 0; i < rows.length; i++) {
      const diff = matrix[i][j] - mean;
      varSum += diff * diff;
    }
    const variance = rows.length > 0 ? varSum / rows.length : 0;
    means.push(mean);
    sds.push(variance > 1e-12 ? Math.sqrt(variance) : 1);
  }
  const info = columnInfo(groups, stats);
  for (let j = 0; j < d; j++) {
    if (info.raw[j]) {
      means[j] = 0;
      sds[j] = 1;
    }
  }
  stats.means = means;
  stats.sds = sds;
  return stats;
}

// Standardised design matrix: (value - mean) / sd per column.
function designMatrix(
  rows: OddsRow[],
  groups: readonly string[],
  stats: OddsStats,
): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rawColumns(rows[i], groups, stats);
    const row: number[] = [];
    for (let j = 0; j < raw.length; j++) {
      row.push((raw[j] - stats.means[j]) / stats.sds[j]);
    }
    out.push(row);
  }
  return out;
}

// Full-batch gradient descent, learning rate 0.15, at most 1000
// iterations, stopping early when the largest step falls below 1e-9.
// The bias (weights[0]) is unpenalised; every other weight carries its
// column's ridge penalty divided by n.
function fitLogistic(x: number[][], y: number[], penalties: number[]): number[] {
  const n = x.length;
  const d = n > 0 ? x[0].length : 0;
  const w: number[] = [];
  for (let j = 0; j < d + 1; j++) w.push(0);
  const lr = 0.15;
  for (let iter = 0; iter < 1000; iter++) {
    const grad: number[] = [];
    for (let j = 0; j < d + 1; j++) grad.push(0);
    for (let i = 0; i < n; i++) {
      let z = w[0];
      for (let j = 0; j < d; j++) z += w[j + 1] * x[i][j];
      const err = sigmoid(z) - y[i];
      grad[0] += err;
      for (let j = 0; j < d; j++) grad[j + 1] += err * x[i][j];
    }
    let largest = 0;
    for (let j = 0; j < d + 1; j++) {
      const penalty = j === 0 ? 0 : (penalties[j - 1] * w[j]) / n;
      const step = lr * (grad[j] / n + penalty);
      w[j] -= step;
      const abs = step < 0 ? -step : step;
      if (abs > largest) largest = abs;
    }
    if (largest < 1e-9) break;
  }
  return w;
}

export function fitOdds(
  rows: OddsRow[],
  groups: readonly string[],
  baseRate: number,
): OddsModel {
  const stats = fitStats(rows, groups);
  const x = designMatrix(rows, groups, stats);
  const weights = fitLogistic(
    x,
    rows.map(function (r) {
      return r.y;
    }),
    columnInfo(groups, stats).penalty,
  );
  return { groups: groups as OddsGroup[], stats: stats, weights: weights, baseRate: baseRate };
}

// Predict one row's ticker-recorded probability, clipped to [0.02, 0.98]
// — a protocol is never priced as certainly tokenless or certainly
// tokenised.
export function predictOdds(model: OddsModel, row: OddsRow): number {
  const raw = rawColumns(row, model.groups, model.stats);
  let z = model.weights[0];
  for (let j = 0; j < raw.length; j++) {
    const x = (raw[j] - model.stats.means[j]) / model.stats.sds[j];
    z += model.weights[j + 1] * x;
  }
  const p = sigmoid(z);
  if (p < 0.02) return 0.02;
  if (p > 0.98) return 0.98;
  return p;
}

export function brierScore(predicted: number[], actual: number[]): number {
  if (predicted.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < predicted.length; i++) {
    const diff = predicted[i] - actual[i];
    sum += diff * diff;
  }
  return sum / predicted.length;
}

// Chronological expanding folds: 4 consecutive blocks, folds train on
// blocks 0..k and test on block k+1. Exported for the value model too.
export function expandingFolds<T>(sortedRows: T[]): { train: T[]; test: T[] }[] {
  const n = sortedRows.length;
  const chunks = 4;
  const base = Math.floor(n / chunks);
  const extra = n - base * chunks;
  const blocks: T[][] = [];
  let start = 0;
  for (let b = 0; b < chunks; b++) {
    const size = b < extra ? base + 1 : base;
    blocks.push(sortedRows.slice(start, start + size));
    start += size;
  }
  const folds: { train: T[]; test: T[] }[] = [];
  for (let k = 0; k < 3; k++) {
    let train: T[] = [];
    for (let b = 0; b <= k; b++) train = train.concat(blocks[b]);
    folds.push({ train: train, test: blocks[k + 1] });
  }
  return folds;
}

// Ten-fold Brier over slug order: fold f holds out every 10th row.
// The indexOf lookup places each prediction in its own slot.
function tenFoldBrier(rows: OddsRow[], groups: readonly string[]): number {
  const ordered = rows.slice().sort(function (a, b) {
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const predicted: number[] = [];
  for (let i = 0; i < ordered.length; i++) predicted.push(0);
  for (let fold = 0; fold < 10; fold++) {
    const train: OddsRow[] = [];
    const test: OddsRow[] = [];
    for (let i = 0; i < ordered.length; i++) {
      if (i % 10 !== fold) train.push(ordered[i]);
      else test.push(ordered[i]);
    }
    if (test.length === 0) continue;
    let ySum = 0;
    for (let i = 0; i < train.length; i++) ySum += train[i].y;
    const baseRate = train.length > 0 ? ySum / train.length : 0;
    const model = fitOdds(train, groups, baseRate);
    for (let i = 0; i < test.length; i++) {
      predicted[ordered.indexOf(test[i])] = predictOdds(model, test[i]);
    }
  }
  return brierScore(
    predicted,
    ordered.map(function (r) {
      return r.y;
    }),
  );
}

// Walk-forward Brier over the dated rows, in listing order. A call is
// "right" when thresholding the prediction at the overall base rate
// matches the actual label.
function walkForwardBrier(
  rows: OddsRow[],
  groups: readonly string[],
): { brier: number; correct: number; n: number; predicted: number[]; actual: number[] } {
  const dated = rows
    .filter(function (r) {
      return r.listedAt !== null;
    })
    .slice()
    .sort(function (a, b) {
      if (a.listedAt === null || b.listedAt === null) return 0;
      if (a.listedAt < b.listedAt) return -1;
      if (a.listedAt > b.listedAt) return 1;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  const predicted: number[] = [];
  const actual: number[] = [];
  const folds = expandingFolds(dated);
  for (let f = 0; f < folds.length; f++) {
    const fold = folds[f];
    let ySum = 0;
    for (let i = 0; i < fold.train.length; i++) ySum += fold.train[i].y;
    const baseRate = fold.train.length > 0 ? ySum / fold.train.length : 0;
    const model = fitOdds(fold.train, groups, baseRate);
    for (let i = 0; i < fold.test.length; i++) {
      predicted.push(predictOdds(model, fold.test[i]));
      actual.push(fold.test[i].y);
    }
  }
  let ySum = 0;
  for (let i = 0; i < rows.length; i++) ySum += rows[i].y;
  const baseRate = rows.length > 0 ? ySum / rows.length : 0;
  let right = 0;
  for (let i = 0; i < predicted.length; i++) {
    if ((predicted[i] > baseRate ? 1 : 0) === actual[i]) right += 1;
  }
  return {
    brier: brierScore(predicted, actual),
    correct: predicted.length > 0 ? right / predicted.length : 0,
    n: actual.length,
    predicted: predicted,
    actual: actual,
  };
}

// Baseline walk-forward: each fold predicts its training base rate.
function baselineWalkForwardBrier(rows: OddsRow[]): number {
  const dated = rows
    .filter(function (r) {
      return r.listedAt !== null;
    })
    .slice()
    .sort(function (a, b) {
      if (a.listedAt === null || b.listedAt === null) return 0;
      if (a.listedAt < b.listedAt) return -1;
      if (a.listedAt > b.listedAt) return 1;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  const predicted: number[] = [];
  const actual: number[] = [];
  const folds = expandingFolds(dated);
  for (let f = 0; f < folds.length; f++) {
    const fold = folds[f];
    let ySum = 0;
    for (let i = 0; i < fold.train.length; i++) ySum += fold.train[i].y;
    const rate = fold.train.length > 0 ? ySum / fold.train.length : 0;
    for (let i = 0; i < fold.test.length; i++) {
      predicted.push(rate);
      actual.push(fold.test[i].y);
    }
  }
  return brierScore(predicted, actual);
}

// Sequential selection over an explicit group list: a group is kept
// only when it lowers the Brier score on BOTH held-out tests —
// ten-fold cross-validation AND chronological walk-forward — against
// the groups kept so far. A group that helps one and hurts the other
// is reported "tested, not kept", never used.
export function fitOddsWithEvidenceWithGroups(
  rows: OddsRow[],
  groupList: readonly string[],
): { model: OddsModel; evidence: OddsEvidence } {
  let ySum = 0;
  for (let i = 0; i < rows.length; i++) ySum += rows[i].y;
  const baseRate = rows.length > 0 ? ySum / rows.length : 0;
  const baselineBrier = brierScore(
    rows.map(function () {
      return baseRate;
    }),
    rows.map(function (r) {
      return r.y;
    }),
  );
  const baselineWfBrier = baselineWalkForwardBrier(rows);
  const terms: OddsTermEvidence[] = [
    {
      name: "intercept-only (base rate)",
      brier: baselineBrier,
      wfBrier: baselineWfBrier,
      kept: "baseline",
    },
  ];
  const kept: OddsGroup[] = [];
  let bestBrier = baselineBrier;
  let bestWfBrier = baselineWfBrier;
  let finalBrier = baselineBrier;
  let finalWfBrier = baselineWfBrier;
  let finalCorrect = 0;
  for (let g = 0; g < groupList.length; g++) {
    const group = groupList[g] as OddsGroup;
    const candidate: OddsGroup[] = kept.slice();
    candidate.push(group);
    const brier = tenFoldBrier(rows, candidate);
    const wf = walkForwardBrier(rows, candidate);
    const helps = brier < bestBrier && wf.brier < bestWfBrier;
    terms.push({
      name: GROUP_LABELS[group],
      brier: brier,
      wfBrier: wf.brier,
      kept: helps ? "kept" : "tested, not kept",
    });
    if (helps) {
      kept.length = 0;
      for (let i = 0; i < candidate.length; i++) kept.push(candidate[i]);
      bestBrier = brier;
      bestWfBrier = wf.brier;
      finalBrier = brier;
      finalWfBrier = wf.brier;
      finalCorrect = wf.correct;
    }
  }
  if (kept.length === 0) {
    finalCorrect = walkForwardBrier(rows, []).correct;
  }
  const model = fitOdds(rows, kept, baseRate);
  const evidence: OddsEvidence = {
    n: rows.length,
    baseRate: baseRate,
    baselineBrier: baselineBrier,
    baselineWfBrier: baselineWfBrier,
    finalBrier: finalBrier,
    finalWfBrier: finalWfBrier,
    walkForwardCorrect: finalCorrect,
    terms: terms,
  };
  return { model: model, evidence: evidence };
}

// The full six-group selection, as specified.
export function fitOddsWithEvidence(
  rows: OddsRow[],
): { model: OddsModel; evidence: OddsEvidence } {
  return fitOddsWithEvidenceWithGroups(rows, ODDS_GROUPS);
}
