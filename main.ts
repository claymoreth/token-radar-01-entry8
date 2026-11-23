// main.ts — the entry runner: model → parent discount → farm →
// accounting → integrity → board.json / data.js / dossier.json.
//
// Node 22, standard library only, no network. Deterministic: the same
// snapshot always yields the same bytes. Run it from inside the entry
// directory:
//   mkdir -p out && RADAR_INPUT=<snapshot> RADAR_OUTPUT=out node main.ts
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoardModel, looRatioPredictor } from "./lib/model.ts";
import { addFarm } from "./lib/farm.ts";
import { buildAccounting } from "./lib/accounting.ts";
import { buildIntegrity } from "./lib/integrity.ts";
import { PARENT_FACTOR, PARENT_PRODUCTS, parentScale } from "./lib/parent.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const TEXT_MAX_BYTES = 65536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4194304 };

// The entry directory: MAKEFUN_BOT_DIR when set, else the directory of
// this script. dashboard/ and screenshots/ are resolved from it, never
// from process.cwd() alone.
const ENTRY_DIR =
  process.env.MAKEFUN_BOT_DIR !== undefined && process.env.MAKEFUN_BOT_DIR !== ""
    ? process.env.MAKEFUN_BOT_DIR
    : fileURLToPath(new URL(".", import.meta.url));

// Read one --name value / --name=value argument.
function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) return argv[i + 1];
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

function main(): void {
  let input =
    argValue("--input") !== undefined
      ? (argValue("--input") as string)
      : process.env.RADAR_INPUT !== undefined && process.env.RADAR_INPUT !== ""
        ? process.env.RADAR_INPUT
        : "/input/snapshot.json";
  const output =
    argValue("--output") !== undefined
      ? (argValue("--output") as string)
      : process.env.RADAR_OUTPUT !== undefined && process.env.RADAR_OUTPUT !== ""
        ? process.env.RADAR_OUTPUT
        : process.env.MAKEFUN_OUTPUT_DIR !== undefined &&
            process.env.MAKEFUN_OUTPUT_DIR !== ""
          ? process.env.MAKEFUN_OUTPUT_DIR
          : "/output";

  // A directory means its snapshot.json.
  if (existsSync(input) && statSync(input).isDirectory()) {
    input = join(input, "snapshot.json");
  }
  if (!existsSync(input)) {
    console.error("input snapshot not found: " + input);
    process.exit(2);
  }
  const snapshot = JSON.parse(readFileSync(input, "utf8"));
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    !Array.isArray(snapshot.protocols) ||
    !Array.isArray(snapshot.watchlist)
  ) {
    console.error("input snapshot has no protocols/watchlist arrays: " + input);
    process.exit(2);
  }

  // Build the board, then apply the parent discount: scale the implied
  // value and every bound derived from it, tag the row, re-sort, nudge
  // ties down by $1, and re-assign ranks 1..N.
  const board = buildBoardModel(snapshot);
  const detected: { slug: string; name: string; parent: string }[] = [];
  const missing: string[] = [];
  const rowBySlug = new Map<string, (typeof board.rows)[number]>();
  for (let i = 0; i < board.rows.length; i++) {
    rowBySlug.set(board.rows[i].slug, board.rows[i]);
  }
  for (let i = 0; i < board.rows.length; i++) {
    const row = board.rows[i];
    const parent = PARENT_PRODUCTS[row.slug];
    if (parent !== undefined) {
      row.parentFactor = PARENT_FACTOR;
      row.parentName = parent;
      row.impliedValueUsd = parentScale(row.impliedValueUsd);
      row.p25 = parentScale(row.p25);
      row.p75 = parentScale(row.p75);
      row.p10 = parentScale(row.p10);
      row.p90 = parentScale(row.p90);
      row.bootstrapLow = parentScale(row.bootstrapLow);
      row.bootstrapHigh = parentScale(row.bootstrapHigh);
      detected.push({ slug: row.slug, name: row.name, parent: parent });
    }
  }
  for (let i = 0; i < Object.keys(PARENT_PRODUCTS).length; i++) {
    const slug = Object.keys(PARENT_PRODUCTS)[i];
    if (!rowBySlug.has(slug)) missing.push(slug);
  }
  board.rows.sort(function (a, b) {
    if (b.impliedValueUsd !== a.impliedValueUsd)
      return b.impliedValueUsd - a.impliedValueUsd;
    if (b.tvlUsd !== a.tvlUsd) return b.tvlUsd - a.tvlUsd;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (let i = 1; i < board.rows.length; i++) {
    if (board.rows[i].impliedValueUsd >= board.rows[i - 1].impliedValueUsd) {
      board.rows[i].impliedValueUsd = board.rows[i - 1].impliedValueUsd - 1;
    }
  }
  for (let i = 0; i < board.rows.length; i++) {
    board.rows[i].rank = i + 1;
  }

  // Farm economics, then the ledger and the integrity numbers.
  addFarm(board.rows, snapshot, looRatioPredictor());
  const accounting = buildAccounting(snapshot, board.rows);
  const integrity = buildIntegrity(board.rows, snapshot);
  const out = {
    ...board,
    floorUsd: snapshot.floor_usd,
    accounting: accounting,
    integrity: integrity,
  };
  const json = JSON.stringify(out, null, 2);

  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "board.json"), json + "\n", "utf8");
  writeFileSync(join(output, "data.js"), "window.RADAR = " + json + ";\n", "utf8");

  // Copy dashboard/ and screenshots/ (regular files only, skipping
  // dotfiles) into the output directory, and count what was copied.
  let copiedDashboard = 0;
  let copiedScreenshots = 0;
  const dashboardDir = join(ENTRY_DIR, "dashboard");
  const screenshotsDir = join(ENTRY_DIR, "screenshots");
  if (existsSync(dashboardDir)) {
    mkdirSync(join(output, "dashboard"), { recursive: true });
    const files = readdirSync(dashboardDir);
    for (let i = 0; i < files.length; i++) {
      const name = files[i];
      if (name.startsWith(".")) continue;
      const src = join(dashboardDir, name);
      if (!statSync(src).isFile()) continue;
      copyFileSync(src, join(output, "dashboard", name));
      copiedDashboard += 1;
    }
  }
  if (existsSync(screenshotsDir)) {
    mkdirSync(join(output, "screenshots"), { recursive: true });
    const files = readdirSync(screenshotsDir);
    for (let i = 0; i < files.length; i++) {
      const name = files[i];
      if (name.startsWith(".")) continue;
      const src = join(screenshotsDir, name);
      if (!statSync(src).isFile()) continue;
      copyFileSync(src, join(output, "screenshots", name));
      copiedScreenshots += 1;
    }
  }

  // The dossier needs at least one screenshot; without one, warn and
  // skip it rather than writing a dossier with no images. The
  // screenshots are the only part of the output that is not computed
  // from the snapshot — they are real renders of this dashboard.
  if (copiedScreenshots === 0) {
    console.error("warning: no screenshots copied, skipping dossier.json");
  } else {
    const dossier = buildDossier(output, {
      text_max_bytes: TEXT_MAX_BYTES,
      screenshots: SCREENSHOT_CAPS,
      dashboard: DASHBOARD_CAPS,
    });
    writeFileSync(join(output, "dossier.json"), dossier);
  }

  // Run log: the numbers a reader can check against the board.
  const watchlistCovered = board.rows.filter(function (r) {
    return r.watchlist;
  }).length;
  console.log("protocols: " + snapshot.protocols.length);
  console.log("watchlist: " + snapshot.watchlist.length);
  console.log(
    "rows: " + board.rows.length + " (" + watchlistCovered + " of watchlist covered)",
  );
  if (board.rows.length > 0) {
    console.log(
      "rank 1: " +
        board.rows[0].name +
        " implied $" +
        board.rows[0].impliedValueUsd.toLocaleString("en-US"),
    );
  }
  console.log(
    "parent rows x" +
      PARENT_FACTOR +
      ": " +
      detected.length +
      (detected.length > 0
        ? " (" +
          detected
            .map(function (d) {
              return d.slug;
            })
            .join(", ") +
          ")"
        : ""),
  );
  if (missing.length > 0) {
    console.log("missing parent slugs: " + missing.join(", "));
  }
  console.log(
    "files written: board.json, data.js, " +
      copiedDashboard +
      " dashboard files, " +
      copiedScreenshots +
      " screenshots" +
      (copiedScreenshots > 0 ? ", dossier.json" : ""),
  );
}

main();
