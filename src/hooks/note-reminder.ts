import type { OpenNoteDebt } from "../db/note-debt";

/**
 * The pending-notes reminder (spec D2 附). English by 裁决 16, except the quoted
 * user prompt, which keeps its original language because it is a quotation.
 */

/**
 * Display cap, not a queue cap: the ledger may hold more than it shows. It caps
 * the WHOLE item list — writable debts and rolled-back notices together — so a
 * reminder is at most five item lines however the two mix.
 */
export const NOTE_REMINDER_DISPLAY_LIMIT = 5;

/**
 * At this many pending notes the closing line stops authorising a skip (D2's
 * wording ladder: 1–2 routine, 3–4 authorisation withdrawn, beyond that the
 * 50-turn aging rule is what actually clears the backlog).
 */
export const NOTE_REMINDER_ESCALATION_THRESHOLD = 3;

/**
 * Backlog relief (裁决 21). Both gates are five, and both are deliberately
 * coarse: the injection is the single sanctioned exception to "never start a
 * tool call just to write a note", so it is safe only while it stays rare.
 * `NOTE_RELIEF_PENDING_THRESHOLD` is a count of open writable debts;
 * `NOTE_RELIEF_DRY_TURNS` is how many finished turns must pass with no note
 * written and no relief fired before the next one may fire.
 */
export const NOTE_RELIEF_PENDING_THRESHOLD = 5;
export const NOTE_RELIEF_DRY_TURNS = 5;

const PROMPT_PREFIX_CHARACTERS = 40;

export interface NoteReminderView {
  writable: OpenNoteDebt[];
  rolledBack: OpenNoteDebt[];
  /** Every open writable debt, not just the displayed ones. */
  writableTotal: number;
}

/**
 * Pick what a single reminder shows: the oldest debts first, writable ones
 * before rolled-back notices, and never more than `displayLimit` lines in total.
 *
 * The budget is shared rather than one cap per kind. Two caps of five made a
 * mixed backlog render ten item lines — twice the interruption the limit exists
 * to bound — and a reminder is a foreign paragraph inserted into somebody
 * else's work, so its size is the constraint the split has to live inside.
 * Writable debts take the slots first because they are the ones that need an
 * action; a rolled-back notice only needs to be seen once, and it closes its
 * debt the moment it renders, so it drains as fast as it gets shown.
 */
export function selectNoteReminderItems(
  open: OpenNoteDebt[],
  displayLimit = NOTE_REMINDER_DISPLAY_LIMIT,
): NoteReminderView {
  const ordered = [...open].sort((left, right) =>
    left.promptNumber - right.promptNumber,
  );
  const writable = ordered.filter((debt) => !debt.wasRolledBack);
  const rolledBack = ordered.filter((debt) => debt.wasRolledBack);
  const shownWritable = writable.slice(0, Math.max(0, displayLimit));

  return {
    writable: shownWritable,
    rolledBack: rolledBack.slice(
      0,
      Math.max(0, displayLimit - shownWritable.length),
    ),
    writableTotal: writable.length,
  };
}

export function formatTurnAddress(debt: {
  sessionId: number;
  promptNumber: number;
}): string {
  return `S${debt.sessionId}/T${debt.promptNumber}`;
}

/**
 * The prompt prefix exists so the agent can recognise the turn without counting
 * back through the conversation. Collapsed to one line and cut short: it is a
 * label, not the content.
 */
export function formatPromptPrefix(userPrompt: string | null): string {
  const collapsed = (userPrompt ?? "")
    .replace(/\s+/gu, " ")
    .replace(/"/gu, "'")
    .trim();
  if (collapsed === "") {
    return '""';
  }

  const characters = Array.from(collapsed);
  return characters.length > PROMPT_PREFIX_CHARACTERS
    ? `"${characters.slice(0, PROMPT_PREFIX_CHARACTERS).join("")}…"`
    : `"${collapsed}"`;
}

function pendingSuffix(pendingTurns: number): string {
  return pendingTurns === 1
    ? "(pending 1 turn)"
    : `(pending ${pendingTurns} turns)`;
}

/**
 * One item line, shared by every path that lists a debt. The address format is
 * what the agent is told to cite with, so a second copy of this string would be
 * a second citation dialect the moment either drifts.
 */
function formatDebtLine(debt: OpenNoteDebt): string {
  return `  [${formatTurnAddress(debt)}] ${formatPromptPrefix(debt.userPrompt)} ${pendingSuffix(debt.pendingTurns)}`;
}

export function renderNoteReminder(view: NoteReminderView): string {
  // No <system-reminder> wrapper here: Claude Code already wraps PostToolUse
  // additionalContext in one, and nesting the tag would render doubled.
  const lines = ["mnemo pending notes:"];

  for (const debt of view.writable) {
    lines.push(formatDebtLine(debt));
  }

  for (const debt of view.rolledBack) {
    lines.push(
      `  [${formatTurnAddress(debt)}] rolled back — no note needed.`,
    );
  }

  const oldest = view.writable[0];
  if (!oldest) {
    lines.push("No notes are due.");
  } else if (view.writableTotal >= NOTE_REMINDER_ESCALATION_THRESHOLD) {
    lines.push(
      "Write the pending notes in this batch; skipping is no longer authorized.",
    );
  } else {
    lines.push(
      `Append note(turn:"${formatTurnAddress(oldest)}", ...) at the end of this batch; skip if busy.`,
    );
  }

  return lines.join("\n");
}

/**
 * The backlog-relief injection (裁决 21) — the one reminder that arrives at the
 * start of a turn instead of on a tool result.
 *
 * Prompting at turn start was ruled out for the ordinary reminder because it
 * misleads the agent into opening tool calls it did not need. This path is the
 * sanctioned exception and it is made safe by two things at once: it fires only
 * from a rare state (a deep backlog that several finished turns have failed to
 * drain, so the piggyback channel is demonstrably not working), and its wording
 * spends that exception on note calls explicitly and on nothing else. Without
 * the second half the injection would simply reproduce the failure it was
 * carved out of.
 *
 * Rolled-back notices never appear here: announcing one closes its debt, and
 * this path may not write debt transitions (R2#P2-6). Callers pass writable
 * debts only.
 */
export function renderNoteBacklogRelief(view: NoteReminderView): string {
  // No <system-reminder> wrapper, same as the reminder: Claude Code wraps
  // UserPromptSubmit additionalContext in one before it reaches the model.
  const lines = ["mnemo pending notes (backlog relief):"];

  for (const debt of view.writable) {
    lines.push(formatDebtLine(debt));
  }

  lines.push(
    `${view.writableTotal} turns are waiting for notes. This once, after you answer, append a dedicated batch containing ONLY note calls for the turns above — the standing rule against starting a tool call just to write notes is waived for this batch only, and for nothing else in it.`,
  );

  return lines.join("\n");
}
