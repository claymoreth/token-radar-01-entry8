// range.ts — seeded randomness, quantiles, intervals and coverage.
// Small helpers with no state of their own; the caller owns every stream.
// Nothing here touches the network or the filesystem.
export interface ResidualQuantiles {
  q10: number;
  q25: number;
  q75: number;
  q90: number;
}

// 32-bit FNV-1a over UTF-16 code units. Used only to seed the model from
// the snapshot's date and slugs, so the same snapshot always seeds the
// same streams. (The checksum hash in integrity.ts is a different
// function: UTF-8 bytes, hex output. Keep the two apart.)
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = hash ^ text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// mulberry32: a tiny deterministic generator. One stream, one call per
// draw, in the order the caller asks for draws — never call it for any
// other purpose, and never create a stream the spec does not name.
// Seeded streams are the only randomness in the whole entry; there is
// no unseeded randomness anywhere in the build.
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61));
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Linear-interpolation quantile over an ascending array. The caller
// always hands us a pre-sorted array; we never sort inside here.
export function quantile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const pos = q * (sortedValues.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

// The four quantiles of a residual sample, read off a sorted copy.
export function residualQuantiles(residuals: number[]): ResidualQuantiles {
  const sorted = residuals.slice().sort(function (a, b) {
    return a - b;
  });
  return {
    q10: quantile(sorted, 0.1),
    q25: quantile(sorted, 0.25),
    q75: quantile(sorted, 0.75),
    q90: quantile(sorted, 0.9),
  };
}

// Shift an implied value by the residual quantiles to get the board's
// P25–P75 and P10–P90 bounds. Bounds never fall below $1.
export function intervalBounds(
  impliedValueUsd: number,
  q: ResidualQuantiles,
): { p25: number; p75: number; p10: number; p90: number } {
  return {
    p25: Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q25))),
    p75: Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q75))),
    p10: Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q10))),
    p90: Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q90))),
  };
}

// Share of actual values that fall inside their matching interval,
// inclusive on both ends. Empty input scores 0, not NaN.
export function coverageFraction(
  actual: number[],
  lower: number[],
  upper: number[],
): number {
  if (actual.length === 0) return 0;
  let inside = 0;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] >= lower[i] && actual[i] <= upper[i]) inside += 1;
  }
  return inside / actual.length;
}
