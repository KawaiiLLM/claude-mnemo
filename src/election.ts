/**
 * Election tiers (ADR-0003) — settlement's replacement for absolute 0-4
 * grading: a 差额选举 (competitive election) across a settlement window,
 * ranking by one criterion, under seat ceilings that are ceilings, never
 * targets.
 *
 * The 2026-08-04 null-result experiments found absolute in-band scoring
 * carrying no ordering signal (93-100% tie groups); this replaces it with a
 * relative rank a window's own turns compete for, so a flat window elects
 * fewer rather than inflating everyone toward the same score.
 */

export const ELECTION_TIERS = ["A", "B", "C"] as const;
export type ElectionTier = (typeof ELECTION_TIERS)[number];

export function isElectionTier(value: unknown): value is ElectionTier {
  return (
    typeof value === "string" &&
    (ELECTION_TIERS as readonly string[]).includes(value)
  );
}

/** floor(10%·N) A seats (ADR-0003: 5 at N=50). */
export const ELECTION_A_SEAT_SHARE = 0.1;
/** floor(30%·N) B seats (ADR-0003: 15 at N=50). */
export const ELECTION_B_SEAT_SHARE = 0.3;

/**
 * Seats are CEILINGS, never targets: `floor(share * windowTurns)`. A flat or
 * sparse window elects fewer than this — the ceiling is only ever a maximum,
 * never a quota a validator pads a window up to.
 */
export function electionSeatCeiling(share: number, windowTurns: number): number {
  return Math.floor(share * windowTurns);
}

/** The one-line ranking criterion settlement elects a window's turns by (ADR-0003). */
export const ELECTION_RANKING_CRITERION =
  "How much does this task's future depend on this turn?";

/**
 * The settlement prompt's replacement for the old 0-4 rubric (duty 1,
 * `worker/note-settlement-prompt.ts`) — the one-line criterion plus the
 * ceilings, nothing else. Percentages are computed from the same constants
 * `electionSeatCeiling` uses, so the prompt can never drift from the code
 * that actually enforces it.
 */
export const ELECTION_RANKING_RUBRIC = `   - tier: for a turn from THIS session's new era, OPTIONAL "A", "B" or "C" —
     rank by one criterion: ${ELECTION_RANKING_CRITERION} A is the smallest,
     most load-bearing set; B is next; C is everything else, and naming no
     tier at all also means C — most turns are C. Seats are CEILINGS, never
     targets: at most floor(${Math.round(ELECTION_A_SEAT_SHARE * 100)}%·N) A
     and floor(${Math.round(ELECTION_B_SEAT_SHARE * 100)}%·N) B across this
     whole window (N = every turn in the window). A flat or sparse window
     elects fewer than the ceiling — never pad up to it. \`commit\` refuses a
     window that stages more than a tier's ceiling, naming the ceiling and
     the count staged; re-rank and re-stage rather than expecting a
     mechanical demotion to fix it for you.
   - For a turn from BEFORE this session's era (a legacy turn), state
     \`grade\` (0-4) instead of \`tier\` — never both on the same turn.`;
