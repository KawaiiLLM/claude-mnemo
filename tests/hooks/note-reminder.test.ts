import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { getNoteDebt, reconcileNoteDebt } from "../../src/db/note-debt";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { upsertShadowNote } from "../../src/db/shadow-notes";
import { createNoteReminderHandler } from "../../src/hooks/handlers/note-reminder";
import { createResultDispatchHandler } from "../../src/hooks/handlers/result-dispatch";
import type { NormalizedHookInput } from "../../src/hooks/types";

describe("pending-notes reminder (synchronous PostToolUse entry)", () => {
  let db: Database;
  let sessionId: number;
  let dataRoot: string;

  function createInput(
    overrides: Partial<NormalizedHookInput> = {},
  ): NormalizedHookInput {
    return {
      eventName: "PostToolUse",
      sessionId: "session-reminder",
      cwd: "/tmp/project",
      toolName: "Read",
      toolInput: { file_path: "src/auth.ts" },
      toolResponse: "line 1",
      stopHookActive: false,
      raw: {},
      ...overrides,
    };
  }

  function addTurn(
    promptNumber: number,
    options: { prompt?: string; rolledBack?: boolean } = {},
  ): number {
    return db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           was_rolled_back, created_at_epoch
         ) VALUES (?, ?, 'active', ?, ?, 100)
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.prompt ?? `prompt ${promptNumber}`,
        options.rolledBack ? 1 : 0,
      )!.id;
  }

  function addObservation(turnId: number, toolName: string): void {
    db.query(
      `INSERT INTO observations (
         turn_id, tool_name, excluded_from_extraction, created_at_epoch
       ) VALUES (?, ?, 0, 100)`,
    ).run(turnId, toolName);
  }

  /** A finished turn that owes a note, plus the ledger entry for it. */
  function addWorkingTurn(promptNumber: number, prompt?: string): number {
    const turnId = addTurn(promptNumber, { prompt });
    addObservation(turnId, "Edit");
    reconcileNoteDebt(db, {
      sessionId,
      nowEpoch: 200,
      completedTurnId: turnId,
    });
    return turnId;
  }

  function debtSnapshot(): unknown {
    return db
      .query<unknown, []>("SELECT * FROM note_debt ORDER BY turn_id")
      .all();
  }

  function exposureRows(): Array<{
    rideTurnId: number;
    exposedTurnId: number;
    source: string;
  }> {
    return db
      .query<
        { rideTurnId: number; exposedTurnId: number; source: string },
        []
      >(
        `SELECT ride_turn_id AS rideTurnId,
                exposed_turn_id AS exposedTurnId,
                source
         FROM note_id_exposures
         ORDER BY ride_turn_id, exposed_turn_id`,
      )
      .all();
  }

  function handler() {
    return createNoteReminderHandler({ db, now: () => 500 });
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-reminder-"));
    sessionId = upsertSession(db, {
      contentSessionId: "session-reminder",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  test("renders the pending list in the D2 form, once per turn", async () => {
    const owing = addWorkingTurn(1, "下一turn无工具,但是可以等到后面的批次再补写");
    addTurn(2);

    const first = await handler()(createInput());
    const second = await handler()(createInput({ toolName: "Bash" }));

    expect(first.hookSpecificOutput).toBe(
      [
        "<system-reminder>mnemo pending notes:",
        `  [S${sessionId}/T1] "下一turn无工具,但是可以等到后面的批次再补写" (pending 1 turn)`,
        `Append note(turn:"S${sessionId}/T1", ...) at the end of this batch; skip if busy.`,
        "</system-reminder>",
      ].join("\n"),
    );
    // At most one reminder per turn, however many tool results the batch has.
    expect(second.hookSpecificOutput).toBeUndefined();
    expect(exposureRows()).toEqual([
      { rideTurnId: 2, exposedTurnId: owing, source: "reminder" },
    ]);
  });

  test("the reminder never carries async work", async () => {
    addWorkingTurn(1);
    addTurn(2);

    const result = await handler()(createInput());

    // `additionalContext` and `asyncWork` are mutually exclusive in the runner,
    // so the entry that answers with text must never claim the worker wake.
    expect(result.asyncWork).toBeUndefined();
    expect(result.continue).toBe(true);
  });

  test("rendering the reminder does not touch the debt ledger", async () => {
    addWorkingTurn(1);
    addTurn(2);
    const before = debtSnapshot();

    await handler()(createInput());

    expect(debtSnapshot()).toEqual(before);
  });

  test("a turn with no tool calls, or only mnemo's own, is never listed", async () => {
    const chat = addTurn(1);
    const housekeeping = addTurn(2);
    addObservation(housekeeping, "mcp__mnemo__recall");
    addObservation(housekeeping, "mcp__plugin_claude-mnemo_mnemo__timeline");
    addTurn(3);
    reconcileNoteDebt(db, { sessionId, nowEpoch: 200 });

    const result = await handler()(createInput());

    expect(getNoteDebt(db, chat)).toBeNull();
    expect(getNoteDebt(db, housekeeping)).toBeNull();
    expect(result).toEqual({ continue: true });
  });

  // Both mount shapes. The reminder must not ride the result of the very call
  // it asked for, or every note would ask for the next one.
  for (const toolName of [
    "mcp__mnemo__note",
    "mcp__plugin_claude-mnemo_mnemo__note",
  ] as const) {
    test(`${toolName} results carry no reminder`, async () => {
      addWorkingTurn(1);
      addTurn(2);

      const result = await handler()(createInput({ toolName }));

      expect(result).toEqual({ continue: true });
      expect(exposureRows()).toEqual([]);
    });
  }

  test("skipping is not punished with repeats until the list grows", async () => {
    const owing = addWorkingTurn(1);
    addTurn(2);
    const first = await handler()(createInput());

    // The agent skipped. A new turn, nothing new in the ledger: silence.
    const third = addTurn(3);
    const quiet = await handler()(createInput());

    // That turn did real work and ended: a genuinely new debt, so it reminds
    // again — and the un-written first debt rides along.
    addObservation(third, "Edit");
    addTurn(4);
    reconcileNoteDebt(db, { sessionId, nowEpoch: 400 });
    const afterGrowth = await handler()(createInput());

    expect(first.hookSpecificOutput).toContain(`[S${sessionId}/T1]`);
    expect(quiet.hookSpecificOutput).toBeUndefined();
    expect(afterGrowth.hookSpecificOutput).toContain(`[S${sessionId}/T3]`);
    expect(getNoteDebt(db, owing)?.status).toBe("pending");
  });

  test("a written note drops out of the list at the next reconcile", async () => {
    const owing = addWorkingTurn(1);
    const second = addWorkingTurn(2);
    const third = addTurn(3);
    await handler()(createInput());

    upsertShadowNote(db, {
      turnId: owing,
      title: "implement+note-debt: ledger closes on write",
      content: "…",
      nowEpoch: 300,
    });
    // The asynchronous side owns the closure; the reminder path only reads.
    reconcileNoteDebt(db, { sessionId, nowEpoch: 310 });

    addObservation(third, "Edit");
    addTurn(4);
    reconcileNoteDebt(db, { sessionId, nowEpoch: 320 });
    const next = await handler()(createInput());

    expect(getNoteDebt(db, owing)?.status).toBe("noted");
    expect(next.hookSpecificOutput).toContain(`[S${sessionId}/T2]`);
    expect(next.hookSpecificOutput).toContain(`[S${sessionId}/T3]`);
    expect(next.hookSpecificOutput).not.toContain(`[S${sessionId}/T1]`);
    expect(getNoteDebt(db, second)?.status).toBe("pending");
  });

  test("a rolled-back turn is announced once, then closed", async () => {
    const rolledBack = addTurn(1, { prompt: "try the risky refactor" });
    addObservation(rolledBack, "Edit");
    reconcileNoteDebt(db, {
      sessionId,
      nowEpoch: 200,
      completedTurnId: rolledBack,
    });
    db.query("UPDATE turns SET was_rolled_back = 1 WHERE id = ?").run(rolledBack);
    addTurn(2);

    const announced = await handler()(createInput());
    reconcileNoteDebt(db, { sessionId, nowEpoch: 320 });
    addTurn(3);
    const afterwards = await handler()(createInput());

    expect(announced.hookSpecificOutput).toBe(
      [
        "<system-reminder>mnemo pending notes:",
        `  [S${sessionId}/T1] rolled back — no note needed.`,
        "No notes are due.",
        "</system-reminder>",
      ].join("\n"),
    );
    expect(getNoteDebt(db, rolledBack)).toMatchObject({
      status: "skipped",
      reason: "rolled-back",
    });
    expect(afterwards.hookSpecificOutput).toBeUndefined();
  });

  test("shows the oldest five and withdraws the skip authorisation from three", async () => {
    for (let promptNumber = 1; promptNumber <= 7; promptNumber += 1) {
      addWorkingTurn(promptNumber, `prompt number ${promptNumber}`);
    }
    addTurn(8);

    const result = await handler()(createInput());
    const lines = (result.hookSpecificOutput ?? "").split("\n");

    expect(lines.filter((line) => line.startsWith("  ["))).toHaveLength(5);
    expect(lines).toContain(`  [S${sessionId}/T1] "prompt number 1" (pending 7 turns)`);
    expect(lines).toContain(`  [S${sessionId}/T5] "prompt number 5" (pending 3 turns)`);
    expect(result.hookSpecificOutput).not.toContain(`[S${sessionId}/T6]`);
    expect(lines.at(-2)).toBe(
      "Write the pending notes in this batch; skipping is no longer authorized.",
    );
    // Only what was rendered counts as exposed — P2's citation check reads this
    // ledger as "ids the writer was shown", not "ids that existed".
    expect(exposureRows().map((row) => row.exposedTurnId)).toHaveLength(5);
  });

  test("two pending notes keep the routine wording", async () => {
    addWorkingTurn(1);
    addWorkingTurn(2);
    addTurn(3);

    const result = await handler()(createInput());

    expect(result.hookSpecificOutput).toContain("skip if busy.");
    expect(result.hookSpecificOutput).not.toContain("no longer authorized");
  });

  test("a subagent's tool results carry no reminder", async () => {
    addWorkingTurn(1);
    addTurn(2);

    const result = await handler()(createInput({ agentId: "child-agent-7" }));

    expect(result).toEqual({ continue: true });
    expect(exposureRows()).toEqual([]);
  });

  test("an aged debt is dropped by the reader before it is closed", async () => {
    addWorkingTurn(1);
    for (let promptNumber = 2; promptNumber <= 53; promptNumber += 1) {
      addTurn(promptNumber);
    }

    const result = await handler()(createInput());

    expect(result).toEqual({ continue: true });
  });

  test("result-dispatch carries the reminder alongside the rule digest", async () => {
    addWorkingTurn(1);
    addTurn(2);

    const dispatch = createResultDispatchHandler({
      db,
      dataRoot,
      now: () => 500,
    });
    const result = await dispatch(createInput());

    expect(result.hookSpecificOutput).toContain("mnemo pending notes:");
    expect(result.asyncWork).toBeUndefined();
  });
});
