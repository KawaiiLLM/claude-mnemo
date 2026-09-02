/**
 * 05a measurement — the THREE WINDOWS settled under 0.29.0, elected under each
 * candidate. These are the first windows whose NEW edges will be written as
 * `use`, so they are where a `use` weight ruling first bites.
 *
 * The surface is `electMilestones` itself — the shared core BOTH milestone
 * views delegate to — scoped to exactly the window's 50 turns, because neither
 * view's own entry point takes a prompt RANGE. `budget` is
 * `DEFAULT_TIMELINE_PAGE_SIZE` (30), the constant both call sites pass. The
 * "elected set" reported is the top TEN by election rank, which is the order in
 * which a token-budget fitter admits rows.
 *
 * Usage: bun run windows.ts <db>
 */
import { Database } from "bun:sqlite";

import { getRelationEdgesAmongTurns, getRolledBackCiterIds } from "../../../../src/db/memory-edges";
import { loadLaneTagsForTurns } from "../../../../src/db/lane-checker-load";
import {
  electMilestones,
  type MilestoneTurnInput,
} from "../../../../src/shared/milestone-election";
import { CANDIDATES } from "./candidates";

const WINDOWS: { label: string; sessionId: number; from: number; to: number }[] = [
  { label: "S15069/T2302-2351", sessionId: 15069, from: 2302, to: 2351 },
  { label: "S23566/T101-150", sessionId: 23566, from: 101, to: 150 },
  { label: "S18993/T101-150", sessionId: 18993, from: 101, to: 150 },
];
const SEATS = 10;

const db = new Database(process.argv[2]);

interface TurnRow {
  id: number;
  sessionId: number;
  promptNumber: number;
  type: string | null;
  status: string;
  createdAtEpoch: number;
  wasRolledBack: number;
  title: string | null;
}

const loadTurns = (ids: readonly number[]): TurnRow[] =>
  ids.length === 0
    ? []
    : db
        .query<TurnRow, number[]>(
          `SELECT id, session_id AS sessionId, prompt_number AS promptNumber, type, status,
                  created_at_epoch AS createdAtEpoch, was_rolled_back AS wasRolledBack, title
             FROM turns WHERE id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(...ids);

const parseType = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
};

for (const window of WINDOWS) {
  const windowRows = db
    .query<TurnRow, [number, number, number]>(
      `SELECT id, session_id AS sessionId, prompt_number AS promptNumber, type, status,
              created_at_epoch AS createdAtEpoch, was_rolled_back AS wasRolledBack, title
         FROM turns WHERE session_id = ? AND prompt_number BETWEEN ? AND ? ORDER BY prompt_number`,
    )
    .all(window.sessionId, window.from, window.to);
  const windowIds = windowRows.map((row) => row.id);
  const edges = getRelationEdgesAmongTurns(db, windowIds);
  const rolledBackCiterIds = getRolledBackCiterIds(db, windowIds);
  const laneTags = loadLaneTagsForTurns(db, windowIds);
  const windowIdSet = new Set(windowIds);
  const externalIds = [
    ...new Set(edges.flatMap((edge) => [edge.citingId, edge.citedId])),
  ].filter((id) => !windowIdSet.has(id));
  const externalTags = loadLaneTagsForTurns(db, externalIds);
  const toInput = (row: TurnRow, eligible: boolean): MilestoneTurnInput => ({
    id: row.id,
    type: parseType(row.type),
    laneTags: (eligible ? laneTags : externalTags).get(row.id) ?? [],
    order: [row.sessionId, row.promptNumber] as const,
    createdAtEpoch: row.createdAtEpoch,
    wasRolledBack: row.wasRolledBack === 1,
    skipped: row.status === "skipped",
    ...(eligible ? {} : { eligible: false }),
  });
  const turns = [
    ...windowRows.map((row) => toInput(row, true)),
    ...loadTurns(externalIds).map((row) => toInput(row, false)),
  ];
  const titleOf = new Map(
    [...windowRows, ...loadTurns(externalIds)].map(
      (row) => [row.id, `S${row.sessionId}/T${row.promptNumber} ${row.title ?? ""}`] as const,
    ),
  );

  console.log(`\n########## ${window.label} — ${windowRows.length} turns, ${edges.length} edges`);
  const seats: Record<string, number[]> = {};
  for (const [id, candidate] of Object.entries(CANDIDATES)) {
    const { candidates } = electMilestones(turns, edges, 30, rolledBackCiterIds, candidate.parameters);
    const inWindow = candidates.filter((row) => windowIdSet.has(row.id));
    seats[id] = inWindow.slice(0, SEATS).map((row) => row.id);
    const tiers = inWindow.reduce<Record<number, number>>((acc, row) => {
      acc[row.tier] = (acc[row.tier] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `  ${id.padEnd(3)} tiers ${JSON.stringify(tiers)}  ${candidate.label}`,
    );
  }
  const base = new Set(seats.A);
  for (const id of Object.keys(CANDIDATES)) {
    if (id === "A") continue;
    const cur = new Set(seats[id]!);
    const added = seats[id]!.filter((turnId) => !base.has(turnId));
    const dropped = seats.A!.filter((turnId) => !cur.has(turnId));
    console.log(`  --- ${id} vs A: +${added.length} / -${dropped.length}`);
    for (const turnId of added) console.log(`      + ${titleOf.get(turnId)}`);
    for (const turnId of dropped) console.log(`      - ${titleOf.get(turnId)}`);
  }
  console.log(`  A's ${SEATS} seats:`);
  for (const turnId of seats.A!) console.log(`      · ${titleOf.get(turnId)}`);
}
db.close();
