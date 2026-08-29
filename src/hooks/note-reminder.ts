import type { OwedNoteTurn } from "../db/note-debt";

/**
 * Rendering for the prompt-clock ledger's owed set (spec D3/D4; ticket 03
 * note-cadence-backlog), plus (ticket 13, spec "节奏与建段指导") the
 * universal `remember` cadence reminder — a different fact (segment
 * maintenance, not note debt) that rides the identical channel for the
 * identical structural reason: `session-init` is the one UserPromptSubmit
 * process that knows the new turn's number without racing, so it is the only
 * process allowed to render anything that depends on turn counts.
 *
 * Everything here is a pure function over already-computed counts — no
 * database access, no state of its own. `session-init` calls these inside the
 * same write transaction that creates the current turn (spec D9) and is the
 * ONLY caller; `prompt-dispatch` renders none of this any more.
 *
 * Ticket 03 retired the per-prompt owed SUFFIX this file used to render onto
 * the current-turn line (`formatOwedSuffix`, gone) — the backlog-relief block
 * below is the only owed-set rendering left. A structural fact killed it, not
 * a preference: `listOwedNoteTurns` defines "ended" as "a later prompt
 * exists", and the contract forbids noting a turn still in progress, so the
 * turn immediately before this one is unconditionally owed the instant a new
 * prompt lands — a suffix that appears every single time restates the
 * contract, not the state.
 */

/** Display cap for the backlog relief — a queue may hold more than this shows. */
export const NOTE_REMINDER_DISPLAY_LIMIT = 5;

/**
 * Backlog relief's only gate (spec D4): a count of writable owed turns. There
 * is no second gate any more — no dry-turn streak, no claim, no re-arm. The
 * condition is its own limit: writing even one note or skip drops the count,
 * and the block stops appearing the next prompt it does.
 */
export const NOTE_RELIEF_PENDING_THRESHOLD = 5;

const PROMPT_PREFIX_CHARACTERS = 40;

export function formatTurnAddress(debt: {
  sessionId: number;
  promptNumber: number;
}): string {
  return `S${debt.sessionId}/T${debt.promptNumber}`;
}

/**
 * Anything left in the C0 range once whitespace has been collapsed: NUL, the
 * escape character, the rest of the terminal control set. `\s` already took the
 * tabs and newlines, so nothing here is a word separator and dropping them
 * cannot join two words together.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/gu;

/**
 * The prompt prefix exists so the agent can recognise the turn without counting
 * back through the conversation. Collapsed to one line and cut short: it is a
 * label, not the content.
 *
 * It is also the only part of the rendering that somebody else wrote, quoted
 * into text the model reads as system context — Claude Code wraps this file's
 * output in a `<system-reminder>` element. So the quotation is made inert
 * before it is framed: angle brackets become their single-guillemet lookalikes,
 * because a prompt containing `</system-reminder>` would otherwise close the
 * wrapper early and leave everything after it reading as instruction rather than
 * quotation; double quotes become single ones so they cannot close the quotation
 * either; and control characters are dropped. The character budget is applied
 * last, after every substitution, so neutralising can never push a prefix past
 * it.
 */
export function formatPromptPrefix(userPrompt: string | null): string {
  const collapsed = (userPrompt ?? "")
    .replace(/\s+/gu, " ")
    .replace(CONTROL_CHARACTERS, "")
    .replace(/"/gu, "'")
    .replace(/</gu, "‹")
    .replace(/>/gu, "›")
    .trim();
  if (collapsed === "") {
    return '""';
  }

  const characters = Array.from(collapsed);
  return characters.length > PROMPT_PREFIX_CHARACTERS
    ? `"${characters.slice(0, PROMPT_PREFIX_CHARACTERS).join("")}…"`
    : `"${collapsed}"`;
}

// ---------------------------------------------------------------------------
// Ticket 13 (spec "节奏与建段指导"): the universal `remember` check. Every
// session — attached to a segment or not — gets a one-line reminder once
// every REMEMBER_REMINDER_INTERVAL_TURNS turns, counted since its last
// successful `remember` call (any verb; `mcp/remember.ts`'s own
// `touchSessionRememberActivity` stamps `sessions.last_remember_turn_id`) or,
// absent one, since the session began. This retires the segment card's own
// header nudge (`MAINTENANCE_CADENCE.nudgeAtOrAbove`, `mcp/segment-card.ts`):
// that nudge only ever reached a session with the card already in view
// (SessionStart, or `recall` on an ATTACHED segment) — silent for exactly the
// session that most needs it, the one that has never attached or created
// anything.
//
// Periodic, not sticky-until-resolved (unlike the backlog relief above): "每
// 20 turn 一次" fires once per 20-turn window (turn 20, 40, 60, ...) rather
// than on every single turn once the threshold is crossed — there is no
// standing debt here the way an unwritten note is one, only a periodic
// nudge to check.
// ---------------------------------------------------------------------------

export const REMEMBER_REMINDER_INTERVAL_TURNS = 20;

/** Whether this prompt lands on a `REMEMBER_REMINDER_INTERVAL_TURNS` boundary since the last `remember` call. */
export function isRememberReminderDue(turnsSinceRemember: number): boolean {
  return (
    turnsSinceRemember > 0 &&
    turnsSinceRemember % REMEMBER_REMINDER_INTERVAL_TURNS === 0
  );
}

/**
 * The reminder line itself — terse, pointing at the tool description rather
 * than restating what to check (the Memory Rubric / `remember`'s own
 * `.describe()` carry that judgment; a second copy here would be a second
 * home for it).
 */
export function renderRememberReminder(turnsSinceRemember: number): string {
  return `mnemo remember check: ${turnsSinceRemember} turns since your last remember call — see the remember tool description for what to check.`;
}

// ---------------------------------------------------------------------------
// staged-settlement ticket 09 (spec §Lane threshold, USER RULING
// [S15069/T1998]): the lane-count pressure reminder. A task's declared-lane
// count is a MEMBER-TAXONOMY problem, not a settlement one — settlement's own
// write authority is unconstrained by it (spec: "Settlement is never
// constrained by the count") — so the fix this reminder pushes for is always
// a MERGE the user approves, never something the agent decides on its own.
// The gate is a plain count read (`countDeclaredLanesForSegment`,
// db/lanes.ts, `idx_lanes_segment`), the same shape `session-init`'s other
// per-attachment reads already take; nothing here touches the database.
// ---------------------------------------------------------------------------

/** Exact threshold (spec: "50 declared lanes per task"). At/over fires; under is silent. */
export const LANE_THRESHOLD_DECLARED_LANE_COUNT = 50;

/** `true` at/over the threshold, never under it. */
export function isLaneThresholdReached(declaredLaneCount: number): boolean {
  return declaredLaneCount >= LANE_THRESHOLD_DECLARED_LANE_COUNT;
}

/**
 * Names the task address and the count against the threshold, then states
 * the two obligations the spec pins: propose a merge plan through
 * `AskUserQuestion`, and never consolidate lanes without that answer coming
 * back — the reminder text is where this ticket's whole teaching lives (it
 * does not touch the Memory Rubric).
 */
export function renderLaneThresholdReminder(
  segmentId: number,
  declaredLaneCount: number,
): string {
  return (
    `mnemo lane threshold: E${segmentId} has ${declaredLaneCount} declared lanes, ` +
    `at or over the threshold of ${LANE_THRESHOLD_DECLARED_LANE_COUNT} — propose a lane-merge plan ` +
    "to the user via AskUserQuestion before declaring or using more lanes here; do not consolidate " +
    "lanes on your own authority, only on the user's answer."
  );
}

function pendingSuffix(pendingTurns: number): string {
  return pendingTurns === 1
    ? "(pending 1 turn)"
    : `(pending ${pendingTurns} turns)`;
}

/**
 * One item line for the backlog relief. The address format is what the agent
 * is told to cite with, so a second copy of this string would be a second
 * citation dialect the moment either drifts.
 */
function formatDebtLine(turn: OwedNoteTurn): string {
  return `  [${formatTurnAddress(turn)}] ${formatPromptPrefix(turn.userPrompt)} ${pendingSuffix(turn.pendingTurns)}`;
}

/**
 * The backlog-relief block (spec D4) — appended once `owed.length >=
 * NOTE_RELIEF_PENDING_THRESHOLD`, showing the oldest `displayLimit` turns.
 * There is no one-shot claim: this re-renders on every prompt for as long as
 * the count stays at or above the threshold (spec D3's "逐 prompt 重渲染直至
 * <5"), and it authorises a batch for exactly as long as that holds.
 */
export function renderNoteBacklogRelief(
  owed: readonly OwedNoteTurn[],
  displayLimit: number = NOTE_REMINDER_DISPLAY_LIMIT,
): string {
  const lines = ["mnemo pending notes (backlog relief):"];

  for (const turn of owed.slice(0, displayLimit)) {
    lines.push(formatDebtLine(turn));
  }

  lines.push(
    `${owed.length} turns are waiting for notes. Open a batch containing ONLY` +
      " note or skip calls for the turns above — the standing rule against" +
      " starting a tool call just to write notes is waived for that batch," +
      " and for nothing else in it.",
  );

  return lines.join("\n");
}
