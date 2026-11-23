// integrity.ts — proves the board on screen is the board that was
// computed. The dashboard recomputes these six numbers from the data
// file itself, so a stale or edited file shows up as a failed check
// instead of silently passing as the real board.
export interface IntegrityRow {
  slug: string;
  rank: number;
  impliedValueUsd: number;
  watchlist?: boolean;
}

export interface IntegritySnapshot {
  protocols: unknown[];
  watchlist: string[];
}

export interface Integrity {
  checksum: string;
  totalImplied: number;
  watchlistCovered: number;
  watchlistTotal: number;
  ledgerTotal: number;
  rows: number;
}

// 32-bit FNV-1a over UTF-8 bytes, returned as 8 lowercase hex digits.
// Check values: fnv1a("") is "811c9dc5", fnv1a("a") is "e40c292c".
// This is a DIFFERENT function from the number-returning fnv1a in
// range.ts (that one hashes UTF-16 code units and returns a number).
// Do not merge the two: they hash different byte streams.
export function fnv1a(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash = hash ^ bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// The canonical text the checksum is taken over: one line per row,
// "slug|rank|impliedValueUsd" with the implied value in JavaScript's
// default number-to-string form, lines joined by "\n", no trailing
// newline. Rows are sorted by rank first, so the input is stable.
export function checksumInput(rows: IntegrityRow[]): string {
  const sorted = rows.slice().sort(function (a, b) {
    return a.rank - b.rank;
  });
  return sorted
    .map(function (r) {
      return r.slug + "|" + r.rank + "|" + r.impliedValueUsd;
    })
    .join("\n");
}

// Build the six integrity numbers from the ranked rows and the snapshot:
// the checksum, the summed implied value, how many of the watchlist
// slugs the board covers, the watchlist size, the ledger size, and the
// row count. Field order is part of the output contract, and the total
// is rounded to cents so the JSON is stable across runs.
export function buildIntegrity(
  rows: IntegrityRow[],
  snapshot: IntegritySnapshot,
): Integrity {
  const watchlist = new Set(snapshot.watchlist);
  let covered = 0;
  for (let i = 0; i < rows.length; i++) {
    if (watchlist.has(rows[i].slug)) covered += 1;
  }
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    total += rows[i].impliedValueUsd;
  }
  return {
    checksum: fnv1a(checksumInput(rows)),
    totalImplied: Math.round(total * 100) / 100,
    watchlistCovered: covered,
    watchlistTotal: snapshot.watchlist.length,
    ledgerTotal: snapshot.protocols.length,
    rows: rows.length,
  };
}
