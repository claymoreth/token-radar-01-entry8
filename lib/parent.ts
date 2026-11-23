// parent.ts — the 20 parent-product lines and the x0.48 factor.
//
// A parent product's line keeps 48% of its fitted value: the line is a
// slice of a larger product, so the board prices the slice, not the
// whole parent. The list is a fixed data table ported from the v4
// entry; each value is the v4 description of the line, not a parent
// name. Matching is by exact slug, case-sensitive — no substring or
// name matching, so a lookalike slug never gets discounted by accident.
export const PARENT_FACTOR = 0.48;

export const PARENT_PRODUCTS: Record<string, string> = {
  "arcus-perps": "Arcus perps desk",
  "avant-avusd": "Avant avUSD stablecoin",
  "azverse-perps": "AZverse perps desk",
  "bitfi-basis": "BitFi basis-trading product",
  "cian-yield-layer": "CIAN yield product",
  "circle-gateway": "Circle cross-chain product",
  "defi-saver-asset-management": "DeFi Saver asset-management product",
  "extended-perps": "Extended perps desk",
  "figure-markets-exchange": "Figure Markets exchange arm",
  "figure-markets-prime": "Figure Markets prime arm",
  "ipor-fusion": "IPOR Fusion vault product",
  "loopscale-lending": "Loopscale lending product",
  "mellow-core": "Mellow core vault product",
  "nado-spot": "Nado spot product",
  "polymarket-international": "Polymarket international arm",
  "sentora-curator": "Sentora curator product",
  "solv-strategies": "Solv strategy product",
  "stellar-defi-hub": "Stellar DeFi hub product",
  "theo-network-thusd": "Theo Network thUSD stablecoin",
  "usdcx": "Circle USDCx wrapped product",
};

// Scale a dollar value by the parent factor, rounding to whole dollars
// and never below $1. Applied to an implied value and to every bound
// derived from it, so the discounted row stays internally consistent.
// The same helper runs in the bootstrap rank ranges, so the range the
// reader sees is measured on the discounted board, not the raw fit.
export function parentScale(v: number): number {
  return Math.max(1, Math.round(v * PARENT_FACTOR));
}
