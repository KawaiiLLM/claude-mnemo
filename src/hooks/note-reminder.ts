import type { OpenNoteDebt } from "../db/note-debt";

/**
 * The pending-notes reminder (spec D2 附). English by 裁决 16, except the quoted
 * user prompt, which keeps its original language because it is a quotation.
 */

/** Display cap, not a queue cap: the ledger may hold more than it shows. */
export const NOTE_REMINDER_DISPLAY_LIMIT = 5;

/**
 * At this many pending notes the closing line stops authorising a skip (D2's
 * wording ladder: 1–2 routine, 3–4 authorisation withdrawn, beyond that the
 * 50-turn aging rule is what actually clears the backlog).
 */
export const NOTE_REMINDER_ESCALATION_THRESHOLD = 3;

const PROMPT_PREFIX_CHARACTERS = 40;

export interface NoteReminderView {
  writable: OpenNoteDebt[];
  rolledBack: OpenNoteDebt[];
  /** Every open writable debt, not just the displayed ones. */
  writableTotal: number;
}

/**
 * Pick what a single reminder shows: the oldest debts first, writable ones and
 * rolled-back notices capped separately so a run of rollbacks cannot crowd out
 * the debts the agent actually has to write.
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

  return {
    writable: writable.slice(0, displayLimit),
    rolledBack: rolledBack.slice(0, displayLimit),
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

export function renderNoteReminder(view: NoteReminderView): string {
  const lines = ["<system-reminder>mnemo pending notes:"];

  for (const debt of view.writable) {
    lines.push(
      `  [${formatTurnAddress(debt)}] ${formatPromptPrefix(debt.userPrompt)} ${pendingSuffix(debt.pendingTurns)}`,
    );
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

  lines.push("</system-reminder>");
  return lines.join("\n");
}
