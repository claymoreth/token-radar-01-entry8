// model.ts — the value model, the board builder, and the odds
// training rows.
//
// The board answers: if a protocol with no token issued one tomorrow,
// what would it be worth?
//   implied value = TVL x fitted multiple x token odds
// The multiple is fitted from the snapshot's own priced protocols; the
// odds come from lib/odds.ts; the intervals from lib/range.ts.
//
// v8 (radar-9) runs two honest experiments on top of the v7 model and
// adopts a change only when it wins on held-out tests:
//  1. Value model: try fitting on the dated priced rows only
//     (listed_at !== null, 95 of 128), judged on a COMMON test set
//     plus an undated-rows generalisation check.
//  2. Odds model: try dropping the category group, judged on both
//     Brier tests.
// Both experiments are reported in the evidence and the README,
// adopted or not.
import { fitOddsWithEvidence, fitOddsWithEvidenceWithGroups, ODDS_GROUPS_NOCAT, predictOdds } from "./odds.ts";
import type { OddsRow } from "./odds.ts";
import {
  coverageFraction,
  fnv1a,
  intervalBounds,
  mulberry32,
  quantile,
  residualQuantiles,
} from "./range.ts";
import type { ResidualQuantiles } from "./range.ts";
import { PARENT_PRODUCTS, parentScale } from "./parent.ts";

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface Factors {
  multiple: number;
  size: number;
  category: number;
}

export interface FarmPlanStep {
  n: number;
  title: string;
  text: string;
  cost: string;
  time: string;
}

export interface PeerRow {
  name: string;
  category: string | null;
  tvl: number;
  mcap: number;
  ratio: number;
  heldOut: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvlUsd: number;
  change7d: number | null;
  ageDays: number | null;
  watchlist: boolean;
  rank: number;
  impliedValueUsd: number;
  valueIfLaunches: number;
  tokenOdds: number;
  p25: number;
  p75: number;
  p10: number;
  p90: number;
  bootstrapLow: number;
  bootstrapHigh: number;
  bootstrapRankLow: number;
  bootstrapRankHigh: number;
  factors: Factors;
  verdict: string;
  netFees: number;
  netPerHour: number;
  dropUsd: number;
  feesUsd: number;
  handsOnHours: number;
  depositUsd: number;
  dropShare: number;
  horizonWeeks: number;
  farmSteps: string[];
  farmPlan: FarmPlanStep[];
  exitRule: string;
  peers: PeerRow[];
  parentFactor?: number;
  parentName?: string;
}

export interface ValueTermEvidence {
  name: string;
  loo: number;
  wf: number;
  kept: "kept" | "tested, not kept" | "baseline" | "must not help";
}

export interface OddsTermEvidence {
  name: string;
  brier: number;
  wfBrier: number;
  kept: "kept" | "tested, not kept" | "baseline";
}

export interface DatedExperiment {
  nPriced: number;
  nDated: number;
  nDatedGrowth: number;
  nGrowth: number;
  categoryLoo: number;
  categoryWf: number;
  categoryKeptOnDated: boolean;
  variantTerms: ValueTermEvidence[];
  standardCommonLoo: number;
  variantCommonLoo: number;
  standardCommonWf: number;
  variantCommonWf: number;
  standardUndatedMiss: number;
  variantUndatedMiss: number;
  adopted: boolean;
}

export interface Evidence {
  value: {
    n: number;
    baselineLoo: number;
    baselineWf: number;
    finalLoo: number;
    finalWf: number;
    terms: ValueTermEvidence[];
    trainingSet: string;
    datedExperiment: DatedExperiment;
  };
  odds: {
    n: number;
    baseRate: number;
    baselineBrier: number;
    baselineWfBrier: number;
    finalBrier: number;
    finalWfBrier: number;
    walkForwardCorrect: number;
    terms: OddsTermEvidence[];
    groupSet: string;
    alternateFinalBrier: number;
    alternateFinalWfBrier: number;
    alternateKept: string[];
    alternateTerms: OddsTermEvidence[];
  };
  range: {
    rows: { label: string; stated: number; loo: number; wf: number }[];
    note: string;
  };
}

export interface Board {
  model: string;
  as_of: string;
  rows: BoardRow[];
  multiples: { category: string; multiple: number; n: number }[];
  globalMultiple: number;
  liveCount: number;
  evidence: Evidence;
}

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort(function (a, b) {
    return a - b;
  });
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(listedAt + "T00:00:00Z");
  const end = Date.parse(asOf + "T00:00:00Z");
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86400000));
}

function familyOf(name: string, slug: string): string {
  const trimmed = name.trim();
  const first = trimmed === "" ? slug : trimmed.split(/\s+/)[0];
  return first.toLowerCase();
}

// ------------------------------------------------------------------
// Exclusions
// ------------------------------------------------------------------

const EXCLUDED_CATEGORIES = new Set([
  "CEX",
  "Liquid Staking",
  "Bridge",
  "Canonical Bridge",
  "Liquid Restaking",
  "Restaked BTC",
]);

const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = [
  "Binance",
  "Coinbase",
  "Bybit",
  "Kraken",
  "Bitget",
  "OKX",
  "Bitfinex",
  "Gemini",
];

function isExcludedName(p: Protocol): boolean {
  if (VERSION_SUFFIX.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  for (let i = 0; i < EXCHANGE_PREFIXES.length; i++) {
    if (p.name.startsWith(EXCHANGE_PREFIXES[i])) return true;
  }
  return false;
}

function isNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

function isBoardCandidate(p: Protocol): boolean {
  if (!isNoToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (isExcludedName(p)) return false;
  return true;
}

function isOddsExcluded(p: Protocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return true;
  return isExcludedName(p);
}

// ------------------------------------------------------------------
// Value-model internals
// ------------------------------------------------------------------

interface ModelRow {
  slug: string;
  listedAt: string | null;
  ageYears: number | null;
  lnTvl: number;
  growthRaw: number | null;
  growthShuffled: number | null;
  lnChains: number;
  family: string;
  category: string;
  y: number | null;
}

type FeatureKey = "lnTvl" | "growth" | "growthShuffled" | "age" | "lnChains";

type Stage =
  | { kind: "const"; name: string }
  | { kind: "ols"; key: FeatureKey; name: string }
  | { kind: "group"; key: "family" | "category"; lambda: number; name: string };

interface FitStats {
  meanGrowth: number;
  meanAge: number;
}

function fitStatsOf(train: ModelRow[]): FitStats {
  let growthSum = 0;
  let growthCount = 0;
  let ageSum = 0;
  let ageCount = 0;
  for (let i = 0; i < train.length; i++) {
    const r = train[i];
    if (r.growthRaw !== null && r.growthRaw !== undefined) {
      growthSum += r.growthRaw;
      growthCount += 1;
    }
    if (r.ageYears !== null && r.ageYears !== undefined) {
      ageSum += r.ageYears;
      ageCount += 1;
    }
  }
  return {
    meanGrowth: growthCount > 0 ? growthSum / growthCount : 0,
    meanAge: ageCount > 0 ? ageSum / ageCount : 0,
  };
}

function featureValue(row: ModelRow, key: FeatureKey, stats: FitStats): number {
  if (key === "lnTvl") return row.lnTvl;
  if (key === "growth") {
    const raw = row.growthRaw !== null && row.growthRaw !== undefined ? row.growthRaw : stats.meanGrowth;
    return raw < -0.9 ? -0.9 : raw > 3 ? 3 : raw;
  }
  if (key === "growthShuffled") {
    const raw = row.growthShuffled !== null && row.growthShuffled !== undefined ? row.growthShuffled : stats.meanGrowth;
    return raw < -0.9 ? -0.9 : raw > 3 ? 3 : raw;
  }
  if (key === "age") return row.ageYears !== null && row.ageYears !== undefined ? row.ageYears : stats.meanAge;
  return row.lnChains;
}

interface FittedStage {
  stage: Stage;
  intercept: number;
  slope: number;
  effects: Map<string, number>;
}

interface ValueModel {
  stages: FittedStage[];
  stats: FitStats;
}

// Fit the stages in order, each on the residuals of the ones before it.
function fitValueModel(train: ModelRow[], stages: Stage[]): ValueModel {
  const stats = fitStatsOf(train);
  const fitted: FittedStage[] = [];
  let residuals: number[] = train.map(function (r) {
    return r.y as number;
  });
  for (let s = 0; s < stages.length; s++) {
    const stage = stages[s];
    if (stage.kind === "const") {
      const a = median(residuals);
      fitted.push({ stage: stage, intercept: a, slope: 0, effects: new Map() });
      residuals = residuals.map(function (r) {
        return r - a;
      });
    } else if (stage.kind === "ols") {
      const xs = train.map(function (r) {
        return featureValue(r, stage.key, stats);
      });
      let xSum = 0;
      let rSum = 0;
      for (let i = 0; i < xs.length; i++) {
        xSum += xs[i];
        rSum += residuals[i];
      }
      const meanX = xs.length > 0 ? xSum / xs.length : 0;
      const meanR = residuals.length > 0 ? rSum / residuals.length : 0;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < xs.length; i++) {
        const dx = xs[i] - meanX;
        sxx += dx * dx;
        sxy += dx * (residuals[i] - meanR);
      }
      const slope = sxx > 0 ? sxy / sxx : 0;
      const intercept = meanR - slope * meanX;
      fitted.push({ stage: stage, intercept: intercept, slope: slope, effects: new Map() });
      residuals = residuals.map(function (r, i) {
        return r - (intercept + slope * xs[i]);
      });
    } else {
      const sums = new Map<string, number>();
      const counts = new Map<string, number>();
      for (let i = 0; i < train.length; i++) {
        const key = stage.key === "family" ? train[i].family : train[i].category;
        sums.set(key, (sums.get(key) || 0) + residuals[i]);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const effects = new Map<string, number>();
      sums.forEach(function (sum, key) {
        effects.set(key, sum / ((counts.get(key) || 0) + stage.lambda));
      });
      fitted.push({ stage: stage, intercept: 0, slope: 0, effects: effects });
      residuals = residuals.map(function (r, i) {
        const key = stage.key === "family" ? train[i].family : train[i].category;
        return r - (effects.get(key) ?? 0);
      });
    }
  }
  return { stages: fitted, stats: stats };
}

function predictValue(
  model: ValueModel,
  row: ModelRow,
): { total: number; sizePart: number; categoryPart: number } {
  let total = 0;
  let sizePart = 0;
  let categoryPart = 0;
  for (let i = 0; i < model.stages.length; i++) {
    const fitted = model.stages[i];
    const stage = fitted.stage;
    let add = 0;
    if (stage.kind === "const") {
      add = fitted.intercept;
    } else if (stage.kind === "ols") {
      add = fitted.intercept + fitted.slope * featureValue(row, stage.key, model.stats);
      if (stage.key === "lnTvl") sizePart += add;
    } else {
      const key = stage.key === "family" ? row.family : row.category;
      add = fitted.effects.get(key) ?? 0;
      categoryPart += add;
    }
    total += add;
  }
  return { total: total, sizePart: sizePart, categoryPart: categoryPart };
}

function missFactor(predicted: number[], actual: number[]): number {
  const diffs: number[] = [];
  for (let i = 0; i < predicted.length; i++) {
    const d = predicted[i] - actual[i];
    diffs.push(d < 0 ? -d : d);
  }
  return Math.exp(median(diffs));
}

// Leave-one-out predictions over a row set, in row order.
function looPredictions(rows: ModelRow[], stages: Stage[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const train: ModelRow[] = [];
    for (let j = 0; j < rows.length; j++) {
      if (j !== i) train.push(rows[j]);
    }
    const model = fitValueModel(train, stages);
    out.push(predictValue(model, rows[i]).total);
  }
  return out;
}

// Chronological walk-forward: sort by (listedAt, slug), split into 4
// near-equal blocks, train on blocks 0..k and predict block k+1.
function wfPredictions(
  dated: ModelRow[],
  stages: Stage[],
): { predicted: number[]; actual: number[] } {
  const sorted = dated.slice().sort(function (a, b) {
    if (a.listedAt === null || b.listedAt === null) return 0;
    if (a.listedAt < b.listedAt) return -1;
    if (a.listedAt > b.listedAt) return 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const n = sorted.length;
  const base = Math.floor(n / 4);
  const extra = n - base * 4;
  const blocks: ModelRow[][] = [];
  let start = 0;
  for (let b = 0; b < 4; b++) {
    const size = b < extra ? base + 1 : base;
    blocks.push(sorted.slice(start, start + size));
    start += size;
  }
  const predicted: number[] = [];
  const actual: number[] = [];
  for (let k = 0; k < 3; k++) {
    let train: ModelRow[] = [];
    for (let b = 0; b <= k; b++) train = train.concat(blocks[b]);
    const model = fitValueModel(train, stages);
    for (let i = 0; i < blocks[k + 1].length; i++) {
      predicted.push(predictValue(model, blocks[k + 1][i]).total);
      actual.push(blocks[k + 1][i].y as number);
    }
  }
  return { predicted: predicted, actual: actual };
}

// Walk-forward where the two models being compared may differ: fit
// model A (stagesA) and model B (stagesB) on the same blocks and
// predict the same next block with each.
function wfCompare(
  dated: ModelRow[],
  stagesA: Stage[],
  stagesB: Stage[],
): { predictedA: number[]; predictedB: number[]; actual: number[] } {
  const sorted = dated.slice().sort(function (a, b) {
    if (a.listedAt === null || b.listedAt === null) return 0;
    if (a.listedAt < b.listedAt) return -1;
    if (a.listedAt > b.listedAt) return 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const n = sorted.length;
  const base = Math.floor(n / 4);
  const extra = n - base * 4;
  const blocks: ModelRow[][] = [];
  let start = 0;
  for (let b = 0; b < 4; b++) {
    const size = b < extra ? base + 1 : base;
    blocks.push(sorted.slice(start, start + size));
    start += size;
  }
  const predictedA: number[] = [];
  const predictedB: number[] = [];
  const actual: number[] = [];
  for (let k = 0; k < 3; k++) {
    let train: ModelRow[] = [];
    for (let b = 0; b <= k; b++) train = train.concat(blocks[b]);
    const modelA = fitValueModel(train, stagesA);
    const modelB = fitValueModel(train, stagesB);
    for (let i = 0; i < blocks[k + 1].length; i++) {
      predictedA.push(predictValue(modelA, blocks[k + 1][i]).total);
      predictedB.push(predictValue(modelB, blocks[k + 1][i]).total);
      actual.push(blocks[k + 1][i].y as number);
    }
  }
  return { predictedA: predictedA, predictedB: predictedB, actual: actual };
}

// The stage list, in test order. The shuffled-growth control is tested
// last and NEVER added to the model.
const CONST_STAGE: Stage = { kind: "const", name: "flat median multiple" };
const SIZE_STAGE: Stage = { kind: "ols", key: "lnTvl", name: "size curve ln(TVL)" };
const FAMILY_STAGE: Stage = { kind: "group", key: "family", lambda: 8, name: "family effect (ridge)" };
const CATEGORY_STAGE: Stage = { kind: "group", key: "category", lambda: 64, name: "category effect (ridge 64)" };
const GROWTH_STAGE: Stage = { kind: "ols", key: "growth", name: "7-day TVL growth" };
const AGE_STAGE: Stage = { kind: "ols", key: "age", name: "age (years listed)" };
const CHAINS_STAGE: Stage = { kind: "ols", key: "lnChains", name: "chain count (ln)" };
const CONTROL_STAGE: Stage = { kind: "ols", key: "growthShuffled", name: "CONTROL shuffled growth" };
const TEST_STAGES: Stage[] = [SIZE_STAGE, FAMILY_STAGE, CATEGORY_STAGE, GROWTH_STAGE, AGE_STAGE, CHAINS_STAGE];

interface Selection {
  keptStages: Stage[];
  terms: ValueTermEvidence[];
  baseline: { loo: number; wf: number };
  current: { loo: number; wf: number };
}

// Sequential term selection on a row set: a stage is kept only when it
// lowers the miss on BOTH tests — leave-one-out AND chronological
// walk-forward — against the stages kept so far.
function selectStages(rows: ModelRow[], datedRows: ModelRow[]): Selection {
  const actuals = rows.map(function (r) {
    return r.y as number;
  });
  function evaluate(stages: Stage[]): { loo: number; wf: number } {
    const looPreds = looPredictions(rows, stages);
    const wf = wfPredictions(datedRows, stages);
    return {
      loo: missFactor(looPreds, actuals),
      wf: missFactor(wf.predicted, wf.actual),
    };
  }
  const keptStages: Stage[] = [CONST_STAGE];
  let current = evaluate(keptStages);
  const baseline = { loo: current.loo, wf: current.wf };
  const terms: ValueTermEvidence[] = [
    { name: "flat median multiple", loo: current.loo, wf: current.wf, kept: "baseline" },
  ];
  for (let i = 0; i < TEST_STAGES.length; i++) {
    const stage = TEST_STAGES[i];
    const candidate = keptStages.slice();
    candidate.push(stage);
    const score = evaluate(candidate);
    const helps = score.loo < current.loo && score.wf < current.wf;
    terms.push({
      name: stage.name,
      loo: score.loo,
      wf: score.wf,
      kept: helps ? "kept" : "tested, not kept",
    });
    if (helps) {
      keptStages.length = 0;
      for (let j = 0; j < candidate.length; j++) keptStages.push(candidate[j]);
      current = score;
    }
  }
  const controlScore = evaluate(keptStages.concat([CONTROL_STAGE]));
  terms.push({
    name: "CONTROL shuffled growth",
    loo: controlScore.loo,
    wf: controlScore.wf,
    kept: "must not help",
  });
  return { keptStages: keptStages, terms: terms, baseline: baseline, current: current };
}

// The LOO ratio lookup: for a priced peer, the leave-one-out model
// prediction over the peer's actual cap/TVL ratio. 1.00 means the model
// priced the peer exactly. A peer outside the fitted rows falls back
// to 1 — the model says nothing about it.
let looRatioBySlug = new Map<string, number>();

export function looRatioPredictor(): (peer: Protocol) => number {
  const snapshot = new Map(looRatioBySlug);
  return function predict(peer: Protocol): number {
    const actual =
      peer.mcap_usd !== null && peer.tvl_usd > 0 ? peer.mcap_usd / peer.tvl_usd : 0;
    const predicted = snapshot.get(peer.slug);
    if (actual <= 0 || predicted === undefined) return 1;
    return predicted / actual;
  };
}

// ------------------------------------------------------------------
// buildBoardModel — the main pipeline
// ------------------------------------------------------------------

export function buildBoardModel(snapshot: Snapshot): Board {
  // Step 1 — seed from the snapshot date and slugs, in snapshot order.
  const seed = fnv1a(
    snapshot.as_of + "|" + snapshot.protocols.map(function (p) {
      return p.slug;
    }).join(","),
  );

  // Step 2 — priced protocols: a cap exists, TVL is positive, and the
  // ratio is positive. A recorded cap of zero or less has no log ratio.
  const priced: Protocol[] = [];
  const allRatios: number[] = [];
  const ratiosByCategory = new Map<string, number[]>();
  for (let i = 0; i < snapshot.protocols.length; i++) {
    const p = snapshot.protocols[i];
    if (p.mcap_usd !== null && p.tvl_usd > 0 && p.mcap_usd / p.tvl_usd > 0) {
      priced.push(p);
      const ratio = p.mcap_usd / p.tvl_usd;
      allRatios.push(ratio);
      const key = p.category === null ? "Uncategorized" : p.category;
      if (!ratiosByCategory.has(key)) ratiosByCategory.set(key, []);
      ratiosByCategory.get(key)?.push(ratio);
    }
  }
  const globalMultiple = median(allRatios);

  // Step 3 — category multiples: the median ratio per category, clamped
  // to [0.05, 1], falling back to the global multiple for small groups.
  const multiples: { category: string; multiple: number; n: number }[] = [];
  const catEntries: { category: string; ratios: number[] }[] = [];
  ratiosByCategory.forEach(function (ratios, category) {
    catEntries.push({ category: category, ratios: ratios });
  });
  catEntries.sort(function (a, b) {
    if (b.ratios.length !== a.ratios.length) return b.ratios.length - a.ratios.length;
    return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
  });
  for (let i = 0; i < catEntries.length; i++) {
    const entry = catEntries[i];
    const med = median(entry.ratios);
    multiples.push({
      category: entry.category,
      multiple:
        entry.ratios.length >= 3
          ? Math.min(1, Math.max(0.05, med))
          : globalMultiple,
      n: entry.ratios.length,
    });
  }

  // Step 4 — value-model rows. Ordered by slug; the growth values are
  // shuffled with a seeded Fisher-Yates so the shuffled-growth control
  // is a real permutation of the same growths, not fresh noise.
  function rowBuilder(p: Protocol, shuffledGrowth: number | null): ModelRow {
    const age = ageDays(snapshot.as_of, p.listed_at);
    return {
      slug: p.slug,
      listedAt: p.listed_at,
      ageYears: age === null ? null : age / 365.25,
      lnTvl: Math.log(p.tvl_usd / 1e8),
      growthRaw: p.change_7d,
      growthShuffled: shuffledGrowth,
      lnChains: Math.log(Math.max(1, p.chains.length)),
      family: familyOf(p.name, p.slug),
      category: p.category === null ? "Uncategorized" : p.category,
      y:
        p.mcap_usd !== null && p.tvl_usd > 0
          ? Math.log(p.mcap_usd / p.tvl_usd)
          : null,
    };
  }
  const orderedPriced = priced.slice().sort(function (a, b) {
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  function shuffledRows(protocols: Protocol[]): ModelRow[] {
    const n = protocols.length;
    const shuffleRng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    const perm: number[] = [];
    for (let i = 0; i < n; i++) perm.push(i);
    for (let i = n - 1; i >= 1; i--) {
      const j = Math.floor(shuffleRng() * (i + 1));
      const tmp = perm[i];
      perm[i] = perm[j];
      perm[j] = tmp;
    }
    return protocols.map(function (p, i) {
      return rowBuilder(p, protocols[perm[i]].change_7d);
    });
  }
  const valueRows = shuffledRows(orderedPriced);
  const datedRows = valueRows.filter(function (r) {
    return r.listedAt !== null;
  });
  const actuals = valueRows.map(function (r) {
    return r.y as number;
  });

  // Step 5 — standard selection on all 128 priced rows.
  const standard = selectStages(valueRows, datedRows);

  // --- v8 DELTA 1: the dated-only variant -------------------------
  // The dated priced rows, with their own shuffled-growth values drawn
  // from the dated set itself. The hard filter is listed_at !== null —
  // no date cutoff, no manual selection.
  const datedProtocols = orderedPriced.filter(function (p) {
    return p.listed_at !== null;
  });
  const valueRowsDated = shuffledRows(datedProtocols);
  const variant = selectStages(valueRowsDated, valueRowsDated);
  const variantCategoryTerm = variant.terms.filter(function (t) {
    return t.name === "category effect (ridge 64)";
  })[0];
  const categoryKeptOnDated =
    variantCategoryTerm !== undefined && variantCategoryTerm.kept === "kept";

  // Common-set comparison: both models judged on the dated rows.
  // LOO: for each dated row, the standard model trains on all 128
  // priced rows minus that row; the variant trains on the dated rows
  // minus that row. Walk-forward: the same 4 chronological blocks over
  // the dated rows, each model fitted on blocks 0..k with its own kept
  // stages.
  const datedActuals = valueRowsDated.map(function (r) {
    return r.y as number;
  });
  const stdCommonLooPreds: number[] = [];
  const varCommonLooPreds: number[] = [];
  for (let i = 0; i < valueRowsDated.length; i++) {
    const slug = valueRowsDated[i].slug;
    const stdTrain = valueRows.filter(function (r) {
      return r.slug !== slug;
    });
    const varTrain = valueRowsDated.filter(function (r) {
      return r.slug !== slug;
    });
    const stdModel = fitValueModel(stdTrain, standard.keptStages);
    const varModel = fitValueModel(varTrain, variant.keptStages);
    stdCommonLooPreds.push(predictValue(stdModel, valueRowsDated[i]).total);
    varCommonLooPreds.push(predictValue(varModel, valueRowsDated[i]).total);
  }
  const standardCommonLoo = missFactor(stdCommonLooPreds, datedActuals);
  const variantCommonLoo = missFactor(varCommonLooPreds, datedActuals);
  const wfCmp = wfCompare(valueRowsDated, standard.keptStages, variant.keptStages);
  const standardCommonWf = missFactor(wfCmp.predictedA, wfCmp.actual);
  const variantCommonWf = missFactor(wfCmp.predictedB, wfCmp.actual);

  // Undated check: the variant never trains on the undated priced
  // rows, so they are a true out-of-sample set for it. The standard
  // model's undated miss is its own LOO predictions on those rows.
  const undatedRows = valueRows.filter(function (r) {
    return r.listedAt === null;
  });
  const undatedActuals = undatedRows.map(function (r) {
    return r.y as number;
  });
  const stdLooPreds = looPredictions(valueRows, standard.keptStages);
  const stdUndatedPreds: number[] = [];
  for (let i = 0; i < valueRows.length; i++) {
    if (valueRows[i].listedAt === null) stdUndatedPreds.push(stdLooPreds[i]);
  }
  const standardUndatedMiss = missFactor(stdUndatedPreds, undatedActuals);
  const variantFullModel = fitValueModel(valueRowsDated, variant.keptStages);
  const varUndatedPreds = undatedRows.map(function (r) {
    return predictValue(variantFullModel, r).total;
  });
  const variantUndatedMiss = missFactor(varUndatedPreds, undatedActuals);

  // Adoption: the variant must win BOTH common-set tests AND not lose
  // on the undated rows. Otherwise the standard 128-row fit stands and
  // the dated experiment is reported as tried-and-not-adopted.
  const variantAdopted =
    variantCommonLoo < standardCommonLoo &&
    variantCommonWf < standardCommonWf &&
    variantUndatedMiss <= standardUndatedMiss;

  const datedExperiment: DatedExperiment = {
    nPriced: valueRows.length,
    nDated: valueRowsDated.length,
    nDatedGrowth: valueRowsDated.filter(function (r) {
      return r.growthRaw !== null;
    }).length,
    nGrowth: valueRows.filter(function (r) {
      return r.growthRaw !== null;
    }).length,
    categoryLoo: variantCategoryTerm !== undefined ? variantCategoryTerm.loo : 0,
    categoryWf: variantCategoryTerm !== undefined ? variantCategoryTerm.wf : 0,
    categoryKeptOnDated: categoryKeptOnDated,
    variantTerms: variant.terms,
    standardCommonLoo: standardCommonLoo,
    variantCommonLoo: variantCommonLoo,
    standardCommonWf: standardCommonWf,
    variantCommonWf: variantCommonWf,
    standardUndatedMiss: standardUndatedMiss,
    variantUndatedMiss: variantUndatedMiss,
    adopted: variantAdopted,
  };

  // The adopted fit drives everything downstream; the other fit is
  // kept only as the experiment record above.
  const activeRows = variantAdopted ? valueRowsDated : valueRows;
  const activeDated = variantAdopted ? valueRowsDated : datedRows;
  const activeSelection = variantAdopted ? variant : standard;
  const activeActuals = activeRows.map(function (r) {
    return r.y as number;
  });
  const keptStages = activeSelection.keptStages;
  const valueTerms = activeSelection.terms;
  const baseline = activeSelection.baseline;
  const current = activeSelection.current;

  // Step 6 — final fit and residuals on the adopted rows.
  const finalValueModel = fitValueModel(activeRows, keptStages);
  const finalLooPreds = looPredictions(activeRows, keptStages);
  const looResiduals = activeActuals.map(function (y, i) {
    return y - finalLooPreds[i];
  });
  const finalWf = wfPredictions(activeDated, keptStages);
  const wfResiduals = finalWf.actual.map(function (y, i) {
    return y - finalWf.predicted[i];
  });
  const looQuantiles: ResidualQuantiles = residualQuantiles(looResiduals);
  const wfQuantiles: ResidualQuantiles = residualQuantiles(wfResiduals);

  // Step 7 — LOO ratio lookup from the adopted rows.
  looRatioBySlug = new Map(
    activeRows.map(function (row, i) {
      return [row.slug, Math.exp(finalLooPreds[i])] as [string, number];
    }),
  );

  // Step 8 — interval honesty (coverage), in ratio space.
  const looActualRatios = activeActuals.map(function (y) {
    return Math.exp(y);
  });
  const looPredRatios = finalLooPreds.map(function (p) {
    return Math.exp(p);
  });
  const looCover50 = coverageFraction(
    looActualRatios,
    looPredRatios.map(function (p) {
      return p * Math.exp(looQuantiles.q25);
    }),
    looPredRatios.map(function (p) {
      return p * Math.exp(looQuantiles.q75);
    }),
  );
  const looCover80 = coverageFraction(
    looActualRatios,
    looPredRatios.map(function (p) {
      return p * Math.exp(looQuantiles.q10);
    }),
    looPredRatios.map(function (p) {
      return p * Math.exp(looQuantiles.q90);
    }),
  );
  const wfActualRatios = finalWf.actual.map(function (y) {
    return Math.exp(y);
  });
  const wfPredRatios = finalWf.predicted.map(function (p) {
    return Math.exp(p);
  });
  const wfCover50 = coverageFraction(
    wfActualRatios,
    wfPredRatios.map(function (p) {
      return p * Math.exp(wfQuantiles.q25);
    }),
    wfPredRatios.map(function (p) {
      return p * Math.exp(wfQuantiles.q75);
    }),
  );
  const wfCover80 = coverageFraction(
    wfActualRatios,
    wfPredRatios.map(function (p) {
      return p * Math.exp(wfQuantiles.q10);
    }),
    wfPredRatios.map(function (p) {
      return p * Math.exp(wfQuantiles.q90);
    }),
  );

  // Step 9 — odds training rows. Ticker RECORDED is the target: y = 1
  // when DefiLlama records a ticker (gecko_id or symbol), y = 0 when
  // no token is recorded at all. The middle class is in, as y = 1.
  const oddsRows: OddsRow[] = [];
  for (let i = 0; i < snapshot.protocols.length; i++) {
    const p = snapshot.protocols[i];
    if (isOddsExcluded(p)) continue;
    const age = ageDays(snapshot.as_of, p.listed_at);
    oddsRows.push({
      slug: p.slug,
      listedAt: p.listed_at,
      ageYears: age === null ? null : age / 365.25,
      lnTvl: Math.log(p.tvl_usd / 1e8),
      growthRaw: p.change_7d,
      lnChains: Math.log(Math.max(1, p.chains.length)),
      family: familyOf(p.name, p.slug),
      category: p.category === null ? "Uncategorized" : p.category,
      y: p.gecko_id !== null || p.symbol !== null ? 1 : 0,
    });
  }
  // --- v8 DELTA 2: the odds group experiment ----------------------
  // Run the selection twice on the same rows: the full six-group list
  // and the same list without category. The no-category set is adopted
  // only when its final Brier is lower on BOTH tests.
  const fullOdds = fitOddsWithEvidence(oddsRows);
  const noCatOdds = fitOddsWithEvidenceWithGroups(oddsRows, ODDS_GROUPS_NOCAT);
  const noCatAdopted =
    noCatOdds.evidence.finalBrier < fullOdds.evidence.finalBrier &&
    noCatOdds.evidence.finalWfBrier < fullOdds.evidence.finalWfBrier;
  const oddsResult = noCatAdopted ? noCatOdds : fullOdds;
  const oddsModel = oddsResult.model;
  const oddsEvidence = oddsResult.evidence;
  const keptOddsGroups = oddsModel.groups.slice();

  // Step 10 — board drafts.
  const watchlist = new Set(snapshot.watchlist);
  const candidates = snapshot.protocols.filter(function (p) {
    return isBoardCandidate(p);
  });
  interface Draft {
    protocol: Protocol;
    implied: number;
    valueIfLaunches: number;
    odds: number;
    fittedMultiple: number;
    sizeFactor: number;
    categoryFactor: number;
    boardFeature: ModelRow;
    bootLow: number;
    bootHigh: number;
    bootRankLow: number;
    bootRankHigh: number;
  }
  const drafts: Draft[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    const boardFeature = rowBuilder(p, null);
    const oddsFeature: OddsRow = {
      slug: p.slug,
      listedAt: p.listed_at,
      ageYears: boardFeature.ageYears,
      lnTvl: boardFeature.lnTvl,
      growthRaw: p.change_7d,
      lnChains: boardFeature.lnChains,
      family: boardFeature.family,
      category: boardFeature.category,
      y: 0,
    };
    const pred = predictValue(finalValueModel, boardFeature);
    const fittedMultiple = Math.exp(pred.total);
    const odds = predictOdds(oddsModel, oddsFeature);
    const valueIfLaunches = Math.max(1, Math.round(p.tvl_usd * fittedMultiple));
    const implied = Math.max(1, Math.round(p.tvl_usd * fittedMultiple * odds));
    drafts.push({
      protocol: p,
      implied: implied,
      valueIfLaunches: valueIfLaunches,
      odds: odds,
      fittedMultiple: fittedMultiple,
      sizeFactor: Math.exp(pred.sizePart),
      categoryFactor: Math.exp(pred.categoryPart),
      boardFeature: boardFeature,
      bootLow: implied,
      bootHigh: implied,
      bootRankLow: 0,
      bootRankHigh: 0,
    });
  }

  // Step 11 — bootstrap: 200 refits, sampling the adopted rows with
  // replacement. Odds are held fixed; the bootstrap measures the
  // multiple's wobble. The parent discount is applied inside the
  // refits, so the rank range is measured on the discounted board.
  const bootRng = mulberry32(seed);
  const bootCount = 200;
  const bootImplied: number[][] = [];
  const bootRanks: number[][] = [];
  for (let i = 0; i < drafts.length; i++) {
    bootImplied.push([]);
    bootRanks.push([]);
  }
  for (let b = 0; b < bootCount; b++) {
    const resample: ModelRow[] = [];
    for (let i = 0; i < activeRows.length; i++) {
      resample.push(activeRows[Math.floor(bootRng() * activeRows.length)]);
    }
    const bootModel = fitValueModel(resample, keptStages);
    const bootValues: number[] = [];
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      const bootPred = predictValue(bootModel, d.boardFeature);
      bootValues.push(
        Math.max(1, Math.round(d.protocol.tvl_usd * Math.exp(bootPred.total) * d.odds)),
      );
    }
    for (let i = 0; i < drafts.length; i++) bootImplied[i].push(bootValues[i]);
    const rankedValues = bootValues.map(function (v, i) {
      return PARENT_PRODUCTS[drafts[i].protocol.slug] !== undefined
        ? parentScale(v)
        : v;
    });
    const order: number[] = [];
    for (let i = 0; i < drafts.length; i++) order.push(i);
    order.sort(function (a, b) {
      if (rankedValues[b] !== rankedValues[a]) return rankedValues[b] - rankedValues[a];
      if (drafts[b].protocol.tvl_usd !== drafts[a].protocol.tvl_usd)
        return drafts[b].protocol.tvl_usd - drafts[a].protocol.tvl_usd;
      return drafts[a].protocol.slug < drafts[b].protocol.slug
        ? -1
        : drafts[a].protocol.slug > drafts[b].protocol.slug
          ? 1
          : 0;
    });
    order.forEach(function (draftIndex, place) {
      bootRanks[draftIndex].push(place + 1);
    });
  }
  for (let i = 0; i < drafts.length; i++) {
    const sortedImplied = bootImplied[i].slice().sort(function (a, b) {
      return a - b;
    });
    const sortedRanks = bootRanks[i].slice().sort(function (a, b) {
      return a - b;
    });
    drafts[i].bootLow = quantile(sortedImplied, 0.05);
    drafts[i].bootHigh = quantile(sortedImplied, 0.95);
    drafts[i].bootRankLow = Math.round(quantile(sortedRanks, 0.05));
    drafts[i].bootRankHigh = Math.round(quantile(sortedRanks, 0.95));
  }

  // Step 12 — rank and nudge: sort by implied, then TVL, then slug;
  // nudge any tie down by $1 so implied values strictly decrease.
  drafts.sort(function (a, b) {
    if (b.implied !== a.implied) return b.implied - a.implied;
    if (b.protocol.tvl_usd !== a.protocol.tvl_usd)
      return b.protocol.tvl_usd - a.protocol.tvl_usd;
    return a.protocol.slug < b.protocol.slug ? -1 : a.protocol.slug > b.protocol.slug ? 1 : 0;
  });
  for (let i = 1; i < drafts.length; i++) {
    if (drafts[i].implied >= drafts[i - 1].implied) {
      drafts[i].implied = drafts[i - 1].implied - 1;
    }
  }

  // Step 13 — rows, in the exact field order the output contract needs.
  const rows: BoardRow[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const p = d.protocol;
    const bounds = intervalBounds(d.implied, looQuantiles);
    rows.push({
      slug: p.slug,
      name: p.name,
      category: p.category === null ? "Uncategorized" : p.category,
      chains: p.chains,
      tvlUsd: p.tvl_usd,
      change7d: p.change_7d,
      ageDays: ageDays(snapshot.as_of, p.listed_at),
      watchlist: watchlist.has(p.slug),
      rank: i + 1,
      impliedValueUsd: d.implied,
      valueIfLaunches: d.valueIfLaunches,
      tokenOdds: d.odds,
      p25: bounds.p25,
      p75: bounds.p75,
      p10: bounds.p10,
      p90: bounds.p90,
      bootstrapLow: Math.max(1, Math.round(Math.min(d.bootLow, d.implied))),
      bootstrapHigh: Math.max(1, Math.round(Math.max(d.bootHigh, d.implied))),
      bootstrapRankLow: d.bootRankLow,
      bootstrapRankHigh: d.bootRankHigh,
      factors: {
        multiple: d.fittedMultiple,
        size: d.sizeFactor,
        category: d.categoryFactor,
      },
      verdict: "MARGINAL",
      netFees: 0,
      netPerHour: 0,
      dropUsd: 0,
      feesUsd: 0,
      handsOnHours: 0,
      depositUsd: 0,
      dropShare: 0,
      horizonWeeks: 0,
      farmSteps: [
        "Placeholder langkah farm 1 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
        "Placeholder langkah farm 2 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
        "Placeholder langkah farm 3 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
        "Placeholder langkah farm 4 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
        "Placeholder langkah farm 5 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
        "Placeholder langkah farm 6 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
      ],
      farmPlan: [],
      exitRule: "",
      peers: [],
    });
  }

  // Step 14 — evidence and return.
  const evidence: Evidence = {
    value: {
      n: activeRows.length,
      baselineLoo: baseline.loo,
      baselineWf: baseline.wf,
      finalLoo: current.loo,
      finalWf: current.wf,
      terms: valueTerms,
      trainingSet: variantAdopted
        ? "dated priced rows only (listed_at !== null)"
        : "all priced rows",
      datedExperiment: datedExperiment,
    },
    odds: {
      n: oddsEvidence.n,
      baseRate: oddsEvidence.baseRate,
      baselineBrier: oddsEvidence.baselineBrier,
      baselineWfBrier: oddsEvidence.baselineWfBrier,
      finalBrier: oddsEvidence.finalBrier,
      finalWfBrier: oddsEvidence.finalWfBrier,
      walkForwardCorrect: oddsEvidence.walkForwardCorrect,
      terms: oddsEvidence.terms,
      groupSet: noCatAdopted ? "no-category (age, ln(TVL), 7-day growth, family, chain count)" : "full (age, ln(TVL), 7-day growth, family, category, chain count)",
      alternateFinalBrier: noCatAdopted
        ? fullOdds.evidence.finalBrier
        : noCatOdds.evidence.finalBrier,
      alternateFinalWfBrier: noCatAdopted
        ? fullOdds.evidence.finalWfBrier
        : noCatOdds.evidence.finalWfBrier,
      alternateKept: (noCatAdopted ? fullOdds.model.groups : noCatOdds.model.groups).slice(),
      alternateTerms: (noCatAdopted ? fullOdds.evidence.terms : noCatOdds.evidence.terms).slice(),
    },
    range: {
      rows: [
        { label: "P25–P75", stated: 0.5, loo: looCover50, wf: wfCover50 },
        { label: "P10–P90", stated: 0.8, loo: looCover80, wf: wfCover80 },
      ],
      note: "Intervals are the implied value shifted by the quantiles of the value model's own held-out log residuals (LOO residuals for the board bounds). Coverage is the share of priced protocols whose real cap fell inside the interval: LOO over all priced rows, walk-forward over the dated rows with a walk-forward prediction.",
    },
  };
  return {
    model: "radar-9",
    as_of: snapshot.as_of,
    rows: rows,
    multiples: multiples,
    globalMultiple: globalMultiple,
    liveCount: activeRows.length,
    evidence: evidence,
  };
}
