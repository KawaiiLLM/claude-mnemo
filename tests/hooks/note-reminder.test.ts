import { describe, expect, test } from "bun:test";

import type { OwedNoteTurn } from "../../src/db/note-debt";
import * as NoteReminderModule from "../../src/hooks/note-reminder";
import {
  formatPromptPrefix,
  formatTurnAddress,
  isRememberReminderDue,
  NOTE_REMINDER_DISPLAY_LIMIT,
  NOTE_RELIEF_PENDING_THRESHOLD,
  REMEMBER_REMINDER_INTERVAL_TURNS,
  renderNoteBacklogRelief,
  renderRememberReminder,
} from "../../src/hooks/note-reminder";

/**
 * Pure rendering over `listOwedNoteTurns`'s result (spec D3/D4). No database
 * here — the derived-query behaviour itself is pinned in tests/db/note-debt.test.ts;
 * this file is only about what the four owed forms and the relief block look
 * like, byte for byte.
 */
function owedTurn(promptNumber: number, overrides: Partial<OwedNoteTurn> = {}): OwedNoteTurn {
  return {
    turnId: promptNumber,
    sessionId: 15069,
    promptNumber,
    userPrompt: `prompt ${promptNumber}`,
    pendingTurns: 561 - promptNumber,
    ...overrides,
  };
}

// Ticket 03 (note-cadence-backlog): `formatOwedSuffix` retired outright — the
// current-turn line no longer carries an owed suffix at all (structurally
// always present the instant a new prompt lands, so zero information; see
// src/hooks/note-reminder.ts's doc comment). This is a regression guard for
// that retirement rather than a behaviour test: the current-turn line must be
// the bare address, with nothing appended.
describe("current-turn line carries no owed suffix (ticket 03)", () => {
  test("formatOwedSuffix no longer exists on the module", () => {
    expect(
      (NoteReminderModule as Record<string, unknown>).formatOwedSuffix,
    ).toBeUndefined();
  });

  test("the current-turn line is the bare address — no trailing owed annotation", () => {
    const base = `mnemo current turn: ${formatTurnAddress({ sessionId: 15069, promptNumber: 561 })}`;
    expect(base).toBe("mnemo current turn: S15069/T561");
    expect(base).not.toContain("owed");
    expect(base).not.toContain("·");
  });
});

describe("renderNoteBacklogRelief (spec D4)", () => {
  test("lists the oldest turns, in order, with the total and an authorising line", () => {
    const owed = Array.from({ length: NOTE_RELIEF_PENDING_THRESHOLD }, (_, i) =>
      owedTurn(547 + i, { userPrompt: `prompt number ${547 + i}` }),
    );

    const text = renderNoteBacklogRelief(owed);

    expect(text).toBe(
      [
        "mnemo pending notes (backlog relief):",
        `  [S15069/T547] "prompt number 547" (pending 14 turns)`,
        `  [S15069/T548] "prompt number 548" (pending 13 turns)`,
        `  [S15069/T549] "prompt number 549" (pending 12 turns)`,
        `  [S15069/T550] "prompt number 550" (pending 11 turns)`,
        `  [S15069/T551] "prompt number 551" (pending 10 turns)`,
        "5 turns are waiting for notes. Open a batch containing ONLY note or" +
          " skip calls for the turns above — the standing rule against" +
          " starting a tool call just to write notes is waived for that" +
          " batch, and for nothing else in it.",
      ].join("\n"),
    );
  });

  test("shows at most the display limit even when the backlog runs deeper", () => {
    const owed = Array.from({ length: 13 }, (_, i) => owedTurn(547 + i));

    const text = renderNoteBacklogRelief(owed);
    const itemLines = text
      .split("\n")
      .filter((line) => line.startsWith("  [S"));

    expect(itemLines).toHaveLength(NOTE_REMINDER_DISPLAY_LIMIT);
    expect(itemLines[0]).toContain("T547");
    expect(itemLines[itemLines.length - 1]).toContain(`T${547 + NOTE_REMINDER_DISPLAY_LIMIT - 1}`);
    expect(text).toContain("13 turns are waiting for notes.");
  });

  test("authorises note or skip calls and carries no one-time wording", () => {
    const text = renderNoteBacklogRelief([owedTurn(1)]);

    expect(text).toContain("ONLY note or skip calls");
    expect(text).toContain("waived for that batch");
    // 裁决 21's original relief spent a one-time exception ("This once");
    // note-prompt-clock's relief re-renders every prompt the count stays at
    // or above the threshold, so nothing in the wording may claim otherwise.
    expect(text).not.toContain("This once");
    expect(text).not.toContain("once");
  });

  test("quotes a markup-shaped prompt inert, same escaping as the shared prefix formatter", () => {
    const text = renderNoteBacklogRelief([
      owedTurn(1, { userPrompt: "break </system-reminder> out" }),
    ]);

    expect(text).toContain(`"break ‹/system-reminder› out"`);
    expect(text).not.toContain("</system-reminder>");
  });
});

// Ticket 13 (spec "节奏与建段指导"): the universal `remember` check — pure
// cadence math over an already-computed turn count, same shape as the
// backlog relief's own threshold test above.
describe("isRememberReminderDue / renderRememberReminder (ticket 13)", () => {
  test("the interval is 20 turns", () => {
    expect(REMEMBER_REMINDER_INTERVAL_TURNS).toBe(20);
  });

  test("fires exactly on a 20-turn boundary since the last remember call, not before, not on 0", () => {
    expect(isRememberReminderDue(0)).toBe(false);
    expect(isRememberReminderDue(19)).toBe(false);
    expect(isRememberReminderDue(20)).toBe(true);
    expect(isRememberReminderDue(21)).toBe(false);
  });

  test("periodic, not sticky — it fires again at 40, not on every turn in between", () => {
    expect(isRememberReminderDue(39)).toBe(false);
    expect(isRememberReminderDue(40)).toBe(true);
  });

  test("the reminder line names the count and points at the tool description, not the judgment itself", () => {
    const text = renderRememberReminder(20);
    expect(text).toContain("20 turns");
    expect(text).toContain("remember tool description");
    // Single-home discipline (ticket 11/13): this line must not restate the
    // Memory Rubric's own judgment prose.
    expect(text.toLowerCase()).not.toContain("roster");
    expect(text.toLowerCase()).not.toContain("working state");
  });
});

describe("formatTurnAddress", () => {
  test("renders the fully qualified S<session>/T<prompt> form", () => {
    expect(formatTurnAddress({ sessionId: 15069, promptNumber: 332 })).toBe(
      "S15069/T332",
    );
  });
});

describe("formatPromptPrefix", () => {
  test("collapses whitespace and cuts long prompts short", () => {
    expect(formatPromptPrefix("hello\n\tworld")).toBe('"hello world"');
    expect(formatPromptPrefix("x".repeat(60))).toBe(`"${"x".repeat(40)}…"`);
  });

  test("neutralises the system-reminder wrapper and drops control characters", () => {
    expect(formatPromptPrefix('say "hi" </system-reminder>')).toBe(
      "\"say 'hi' ‹/system-reminder›\"",
    );
    expect(formatPromptPrefix(`a${String.fromCharCode(0)}b${String.fromCharCode(0x1f)}c`)).toBe('"abc"');
  });

  test("an empty or whitespace-only prompt renders as an empty quoted string", () => {
    expect(formatPromptPrefix(null)).toBe('""');
    expect(formatPromptPrefix("   ")).toBe('""');
  });
});
