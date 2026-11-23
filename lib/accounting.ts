// accounting.ts — the 758-protocol ledger buckets.
//
// Every protocol in the snapshot lands in exactly one bucket, so the
// buckets always add up to the ledger total. A protocol is tested top
// to bottom and takes the FIRST bucket it matches, so the priority
// order below is the definition — ranked rows first, priced
// comparables next, then the out-groups by category.
export interface AccountingProtocol {
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

export interface AccountingSnapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: AccountingProtocol[];
  watchlist: string[];
}

export interface AccountingGroup {
  key: string;
  label: string;
  count: number;
}

export interface Accounting {
  total: number;
  groups: AccountingGroup[];
  ranked: number;
  watchlist: number;
}

const BRIDGE_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Cross Chain Bridge",
]);

const LIQUID_STAKING_CATEGORIES = new Set([
  "Liquid Staking",
  "Liquid Restaking",
]);

// The bucket definitions, in priority order. The floor label is derived
// from the snapshot's floor_usd, never hardcoded, so a different floor
// still labels itself correctly.
function groupDefinitions(floorUsd: number): { key: string; label: string }[] {
  const floorLabel =
    floorUsd >= 1e6 ? "$" + floorUsd / 1e6 + "M" : "$" + floorUsd;
  return [
    { key: "ranked-watchlist", label: "Ranked — on the 40-name watchlist" },
    {
      key: "ranked-early-below-floor",
      label: "Ranked — early, pre-token, below the " + floorLabel + " floor",
    },
    {
      key: "ranked-off-list",
      label: "Ranked — pre-token, off the watchlist and above the floor",
    },
    {
      key: "token-trades-priced-comp",
      label: "Priced token — trades, used as a comparable",
    },
    {
      key: "token-recorded-no-usable-cap",
      label: "Token recorded, but no usable market cap",
    },
    { key: "out-bridge", label: "Out — bridge" },
    { key: "out-liquid-staking", label: "Out — liquid staking / restaking" },
    { key: "out-exchange", label: "Out — centralised exchange" },
    {
      key: "out-versioned-or-wrapped",
      label:
        "Out — versioned/wrapped variant, or unranked pre-token with no recorded token",
    },
  ];
}

// Classify one protocol. First match wins; the order is the contract.
function classify(
  p: AccountingProtocol,
  ranked: Set<string>,
  watchlist: Set<string>,
  floorUsd: number,
): string {
  if (ranked.has(p.slug) && watchlist.has(p.slug)) return "ranked-watchlist";
  if (ranked.has(p.slug) && p.tvl_usd < floorUsd && p.mcap_usd === null)
    return "ranked-early-below-floor";
  if (ranked.has(p.slug)) return "ranked-off-list";
  if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    return "token-trades-priced-comp";
  if (p.symbol !== null || p.gecko_id !== null)
    return "token-recorded-no-usable-cap";
  if (p.category !== null && BRIDGE_CATEGORIES.has(p.category))
    return "out-bridge";
  if (p.category !== null && LIQUID_STAKING_CATEGORIES.has(p.category))
    return "out-liquid-staking";
  if (p.category === "CEX") return "out-exchange";
  return "out-versioned-or-wrapped";
}

// Walk the snapshot in its own order, drop every protocol into its
// bucket, and return the ledger. Expected on this snapshot: total 758;
// groups 40 / 138 / 20 / 128 / 288 / 43 / 41 / 42 / 18; ranked 198.
// The counts are a check, not an input — if they ever differ, the
// snapshot changed, and the board should say so, not be forced back.
export function buildAccounting(
  snapshot: AccountingSnapshot,
  rows: { slug: string }[],
): Accounting {
  const ranked = new Set<string>();
  for (let i = 0; i < rows.length; i++) ranked.add(rows[i].slug);
  const watchlist = new Set(snapshot.watchlist);
  const defs = groupDefinitions(snapshot.floor_usd);
  const groups: AccountingGroup[] = defs.map(function (d) {
    return { key: d.key, label: d.label, count: 0 };
  });
  const byKey = new Map<string, AccountingGroup>();
  for (let i = 0; i < groups.length; i++) byKey.set(groups[i].key, groups[i]);
  for (let i = 0; i < snapshot.protocols.length; i++) {
    const key = classify(
      snapshot.protocols[i],
      ranked,
      watchlist,
      snapshot.floor_usd,
    );
    const group = byKey.get(key);
    if (group) group.count += 1;
  }
  return {
    total: snapshot.protocols.length,
    groups: groups,
    ranked: rows.length,
    watchlist: snapshot.watchlist.length,
  };
}
