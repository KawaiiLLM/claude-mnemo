/**
 * The maintenance cadence's two thresholds (ADR-0002; ticket 12's nudge
 * half): under `tooSoonUnder` turns since the segment's last touch, a fresh
 * write draws the too-soon reminder on `remember`'s receipt; at or beyond
 * `nudgeAtOrAbove`, the segment card's HEADER carries the nudge — session
 * side (T825: "每 20 轮还没更新，提醒一次"), so a session that never calls
 * `remember` at all still sees it at SessionStart and in `recall`. One pair,
 * not a caller-tunable knob — same reasoning as `NOTE_TOKEN_BUDGET` being
 * one shared constant rather than a value each call site restates.
 *
 * Lives here rather than in `mcp/remember.ts` because `mcp/segment-card.ts`
 * reads it too, and `remember` already imports the card renderer — the
 * reverse import would cycle.
 */
export const MAINTENANCE_CADENCE = {
  tooSoonUnder: 10,
  nudgeAtOrAbove: 20,
} as const;
