import type { OpenNoteDebt } from "../db/note-debt";

/**
 * The backlog-relief injection's rendering (spec D2 附). English by 裁决 16,
 * except the quoted user prompt, which keeps its original language because it
 * is a quotation.
 *
 * This module used to render the per-debt reminder too. 裁决 25 abolished it:
 * the current turn's note is written against the address line `session-init`
 * injects, during the turn itself, so the only list-bearing text left is the
 * relief below.
 */

/**
 * Display cap, not a queue cap: the ledger may hold more than it shows.
 */
export const NOTE_REMINDER_DISPLAY_LIMIT = 5;

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
  /** Every open writable debt, not just the displayed ones. */
  writableTotal: number;
}

/**
 * Pick what a single relief shows: the oldest writable debts first, never more
 * than `displayLimit` item lines. Rolled-back debts never take a slot — they
 * close silently at reconcile (裁决 25), and this injection is a work list.
 */
export function selectNoteReminderItems(
  open: OpenNoteDebt[],
  displayLimit = NOTE_REMINDER_DISPLAY_LIMIT,
): NoteReminderView {
  const writable = open
    .filter((debt) => !debt.wasRolledBack)
    .sort((left, right) => left.promptNumber - right.promptNumber);

  return {
    writable: writable.slice(0, Math.max(0, displayLimit)),
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
 * It is also the only part of a reminder that somebody else wrote, quoted into
 * text the model reads as system context — Claude Code wraps this file's output
 * in a `<system-reminder>` element on both paths. So the quotation is made inert
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

function pendingSuffix(pendingTurns: number): string {
  return pendingTurns === 1
    ? "(pending 1 turn)"
    : `(pending ${pendingTurns} turns)`;
}

/**
 * One item line. The address format is what the agent is told to cite with, so
 * a second copy of this string would be a second citation dialect the moment
 * either drifts.
 */
function formatDebtLine(debt: OpenNoteDebt): string {
  return `  [${formatTurnAddress(debt)}] ${formatPromptPrefix(debt.userPrompt)} ${pendingSuffix(debt.pendingTurns)}`;
}

/**
 * The backlog-relief injection (裁决 21) — the only pending-notes list left
 * (裁决 25), and the only text allowed to authorise a dedicated note batch.
 *
 * It is made safe by two things at once: it fires only from a rare state (a
 * deep backlog that several finished turns have failed to drain, so the
 * current-turn protocol is demonstrably not keeping up), and its wording spends
 * that exception on note calls explicitly and on nothing else. Without the
 * second half the injection would simply reproduce the failure it was carved
 * out of.
 *
 * Rolled-back debts never appear here: they close silently at reconcile, and
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
