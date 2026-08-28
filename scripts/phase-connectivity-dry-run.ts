#!/usr/bin/env bun
/**
 * Phase-connectivity ticket 01 — prerequisite 3: "Dry-run with the FINAL
 * predicate on real windows before arming". READ-ONLY, always: opens the
 * production database with `readonly: true` (the same hard-readonly
 * contract `src/cli/lane-check-cli.ts` uses), never writes a byte.
 *
 * Runs the shipped predicate (`shared/phase-connectivity.ts` +
 * `db/basis-reachability-load.ts`, gate OFF) over a handful of real,
 * DONE settlement windows and reports: violation hit rate, path-length
 * distribution for passes, basis-type distribution, and the compound-exit
 * share. These numbers are the dry-run deliverable the arming decision
 * reads — this script computes and prints them, it does not judge them.
 *
 *   bun scripts/phase-connectivity-dry-run.ts [--db <path>] [--jobs <id,id,...>]
 */
import { Database } from "bun:sqlite";
import { resolveDatabasePath } from "../src/shared/paths";
import {
  closureAsPhaseConnectivityInput,
  loadBasisReachabilityClosure,
  selectLandingTurnIds,
} from "../src/db/basis-reachability-load";
import { evaluatePhaseConnectivity, type PhaseConnectivityFinding } from "../src/shared/phase-connectivity";

interface WindowRow {
  jobId: number;
  sessionId: number;
  contentSessionId: string;
  windowStart: number;
  windowEnd: number;
}

function parseArgs(argv: readonly string[]): { dbPath?: string; jobIds?: number[] } {
  const out: { dbPath?: string; jobIds?: number[] } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--db") {
      out.dbPath = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--jobs") {
      out.jobIds = (argv[i + 1] ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
      i += 1;
    }
  }
  return out;
}

/** Five representative DONE windows, spread across the job-id range (early -> late), unless the caller names explicit ids. */
function pickRepresentativeWindows(db: Database, explicitIds?: number[]): WindowRow[] {
  const idFilter = explicitIds && explicitIds.length > 0 ? `AND j.id IN (${explicitIds.join(",")})` : "";
  const all = db
    .query<WindowRow, []>(
      `SELECT j.id AS jobId, j.session_id AS sessionId, s.content_session_id AS contentSessionId,
              j.window_start AS windowStart, j.window_end AS windowEnd
       FROM note_settlement_jobs j
       JOIN sessions s ON s.id = j.session_id
       WHERE j.status = 'done' ${idFilter}
       ORDER BY j.id ASC`,
    )
    .all();
  if (explicitIds && explicitIds.length > 0) {
    return all;
  }
  if (all.length <= 5) {
    return all;
  }
  const picks: WindowRow[] = [];
  for (let i = 0; i < 5; i += 1) {
    const index = Math.round((i * (all.length - 1)) / 4);
    picks.push(all[index]!);
  }
  return picks;
}

function windowTurnIds(db: Database, sessionId: number, windowStart: number, windowEnd: number): number[] {
  return db
    .query<{ id: number }, [number, number, number]>(
      `SELECT id FROM turns WHERE session_id = ? AND prompt_number BETWEEN ? AND ? ORDER BY prompt_number ASC`,
    )
    .all(sessionId, windowStart, windowEnd)
    .map((row) => row.id);
}

/** The segment(s) a landing turn's own address lives in, purely for the report's own era-context column — never fed into the predicate. */
function segmentIdsForTurn(db: Database, turnId: number): number[] {
  return db
    .query<{ segmentId: number }, [number]>(`SELECT segment_id AS segmentId FROM segment_members WHERE turn_id = ?`)
    .all(turnId)
    .map((row) => row.segmentId);
}

interface WindowReport {
  window: WindowRow;
  landingCount: number;
  findings: PhaseConnectivityFinding[];
  segmentSpread: number[];
}

function runWindow(db: Database, window: WindowRow): WindowReport {
  const turnIds = windowTurnIds(db, window.sessionId, window.windowStart, window.windowEnd);
  const landingIds = selectLandingTurnIds(db, turnIds);
  const closure = loadBasisReachabilityClosure(db, landingIds);
  const { types, graph } = closureAsPhaseConnectivityInput(closure);
  const findings = evaluatePhaseConnectivity(landingIds, types, graph);
  const segmentSpread = [...new Set(landingIds.flatMap((id) => segmentIdsForTurn(db, id)))].sort((a, b) => a - b);
  return { window, landingCount: landingIds.length, findings, segmentSpread };
}

function summarize(reports: readonly WindowReport[]): void {
  const allFindings = reports.flatMap((r) => r.findings);
  const total = allFindings.length;
  const violations = allFindings.filter((f) => f.outcome === "unreached").length;
  const compound = allFindings.filter((f) => f.outcome === "compound").length;
  const reached = allFindings.filter((f) => f.outcome === "reached");

  console.log("=".repeat(78));
  console.log("PHASE CONNECTIVITY DRY RUN — ticket 01, gate OFF, read-only");
  console.log("=".repeat(78));
  console.log(`Windows examined: ${reports.length}`);
  console.log(`Total landing turns judged: ${total}`);
  console.log("");

  for (const report of reports) {
    const w = report.window;
    console.log(
      `-- job #${w.jobId}  session ${w.contentSessionId} (S${w.sessionId})  ` +
        `window T${w.windowStart}-T${w.windowEnd}  segments touched: [${report.segmentSpread.join(",")}]`,
    );
    console.log(`   landing turns: ${report.landingCount}`);
    for (const finding of report.findings) {
      if (finding.outcome === "compound") {
        console.log(`     [compound] turn #${finding.turnId} — own basis word "${finding.basisWord}"`);
      } else if (finding.outcome === "reached") {
        console.log(
          `     [reached]  turn #${finding.turnId} -> #${finding.basisTurnId} (${finding.hops} hop(s), ` +
            `basis "${finding.basisWord}")`,
        );
      } else {
        console.log(`     [VIOLATION] turn #${finding.turnId} — no basis reachable`);
      }
    }
  }

  console.log("");
  console.log("-".repeat(78));
  console.log("AGGREGATE NUMBERS (the dry-run deliverable)");
  console.log("-".repeat(78));

  if (total === 0) {
    console.log("No landing turns in any examined window — nothing to report.");
    return;
  }

  console.log(`1. VIOLATION HIT RATE: ${violations}/${total} = ${((violations / total) * 100).toFixed(1)}%`);
  console.log(`2. COMPOUND-EXIT SHARE: ${compound}/${total} = ${((compound / total) * 100).toFixed(1)}%`);

  console.log(`3. PATH-LENGTH DISTRIBUTION for REACHED (non-compound) passes (${reached.length} of them):`);
  const hopCounts = new Map<number, number>();
  for (const finding of reached) {
    hopCounts.set(finding.hops!, (hopCounts.get(finding.hops!) ?? 0) + 1);
  }
  for (const hops of [...hopCounts.keys()].sort((a, b) => a - b)) {
    console.log(`     ${hops} hop(s): ${hopCounts.get(hops)}`);
  }

  console.log("4. BASIS-TYPE DISTRIBUTION (compound + reached, which basis word resolved the walk):");
  const basisCounts = new Map<string, number>();
  for (const finding of [...reached, ...allFindings.filter((f) => f.outcome === "compound")]) {
    const word = finding.basisWord ?? "(none)";
    basisCounts.set(word, (basisCounts.get(word) ?? 0) + 1);
  }
  for (const word of [...basisCounts.keys()].sort()) {
    console.log(`     ${word}: ${basisCounts.get(word)}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolveDatabasePath(args.dbPath);
  console.log(`Opening (readonly): ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const windows = pickRepresentativeWindows(db, args.jobIds);
    const reports = windows.map((window) => runWindow(db, window));
    summarize(reports);
  } finally {
    db.close();
  }
}

main();
