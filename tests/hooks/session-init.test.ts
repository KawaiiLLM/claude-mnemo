import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../src/db/database";
import { getExposedTurnIds, recordDeclinedNoteDebt } from "../../src/db/note-debt";
import {
  deriveProcessIdentityKeys,
  getMnemoSessionIdForProcessSession,
} from "../../src/db/process-session-map";
import { initializeSchema } from "../../src/db/schema";
import { getSessionByContentId } from "../../src/db/sessions";
import { upsertShadowNote } from "../../src/db/shadow-notes";
import { getTurn } from "../../src/db/turns";
import { upsertSession } from "../../src/db/sessions";
import { createPromptDispatchHandler } from "../../src/hooks/handlers/prompt-dispatch";
import { createSessionInitHandler } from "../../src/hooks/handlers/session-init";
import type { NormalizedHookInput } from "../../src/hooks/types";

function createInput(
  overrides: Partial<NormalizedHookInput> = {},
): NormalizedHookInput {
  return {
    eventName: "UserPromptSubmit",
    sessionId: "session-1",
    cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    prompt: "Initial prompt",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

function writeTranscript(lines: unknown[]): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-session-init-"));
  const path = join(directory, "session.jsonl");

  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );

  return { directory, path };
}

describe("handleSessionInitHook", () => {
  let db: Database;
  const transcriptDirectories: string[] = [];

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    for (const directory of transcriptDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }

    db.close();
  });

  test("first prompt creates session and active turn without extraction", async () => {
    const handler = createSessionInitHandler({
      db,
    });

    const result = await handler(
      createInput({
        prompt: "Diagnose the auth race",
      }),
    );

    const session = getSessionByContentId(db, "session-1");
    const turn = getTurn(db, session!.id, 1);

    // The current-turn address (裁决 25): this entry created the turn row, so
    // it is the one process that can announce the address without racing.
    expect(result).toEqual({
      continue: true,
      hookSpecificOutput: `mnemo current turn: S${session!.id}/T1`,
    });
    expect(session?.project).toBe("/Users/zhaoqixuan/Projects/claude-mnemo");
    expect(turn?.status).toBe("active");
    expect(turn?.userPrompt).toBe("Diagnose the auth race");
  });

  test("the current-turn line follows the number the transaction actually took", async () => {
    // A concurrent process grabs prompt number 2 inside the lock window; the
    // line must name the row this handler really created, not a stale count.
    const session = upsertSession(db, {
      contentSessionId: "session-1",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1000,
      updatedAtEpoch: 1000,
      completedAtEpoch: null,
    });
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'active', 'Existing prompt', 1000)`,
    ).run(session.id);

    const result = await createSessionInitHandler({ db })(
      createInput({ prompt: "second" }),
    );

    // T1 exists, has no note and no skip, so it is owed the moment T2 is
    // created (spec D1) — the owed suffix rides the very same line.
    expect(result.hookSpecificOutput).toBe(
      `mnemo current turn: S${session.id}/T2 · owed: S${session.id}/T1`,
    );
  });

  test("a subagent's prompt gets a pre-marked sidechain row and no current-turn line", async () => {
    // The address is an instruction to write a note, and a subagent has no
    // authority over the root session's ledger. Its row is born `undone` with
    // the pending tag — an active sidechain row would outrank the root turn in
    // prompt order for the whole delegation window and make the note tool
    // reject the root turn's own note.
    const result = await createSessionInitHandler({ db })(
      createInput({ agentId: "agent-123", prompt: "delegated work" }),
    );

    const session = getSessionByContentId(db, "session-1");
    const turn = getTurn(db, session!.id, 1);
    expect(turn?.userPrompt).toBe("delegated work");
    expect(turn?.status).toBe("undone");
    expect(
      db
        .query<{ tags: string }, [number]>(
          "SELECT tags FROM turns WHERE id = ?",
        )
        .get(turn!.id)?.tags,
    ).toBe('["subagent:pending"]');
    expect(result).toEqual({
      continue: true,
      suppressOutput: true,
    });
  });

  test("a prompt after a cd updates project but keeps the first transcript path", async () => {
    const handler = createSessionInitHandler({ db });
    const started =
      "/Users/me/.claude/projects/-Users-me-alpha/session-1.jsonl";

    await handler(
      createInput({ cwd: "/Users/me/alpha", transcriptPath: started }),
    );
    // Second prompt from a new cwd. Even if a later event carried a path
    // derived from the new cwd, the recorded one must not move — only `project`
    // may follow the cwd.
    await handler(
      createInput({
        cwd: "/Users/me/beta",
        prompt: "after cd",
        transcriptPath:
          "/Users/me/.claude/projects/-Users-me-beta/session-1.jsonl",
      }),
    );

    const session = getSessionByContentId(db, "session-1");
    expect(session?.project).toBe("/Users/me/beta");
    expect(session?.transcriptPath).toBe(started);
  });

  test("runs session creation and prompt-number selection through the bounded hook transaction runner", async () => {
    const transactionRunner = mock((runnerDb: Database, fn: () => unknown) => {
      expect(runnerDb).toBe(db);
      return fn();
    });
    const handler = createSessionInitHandler({
      db,
      runHookWriteTransaction: transactionRunner,
    });

    await handler(
      createInput({
        prompt: "Diagnose the auth race",
      }),
    );

    const session = getSessionByContentId(db, "session-1")!;
    expect(getTurn(db, session.id, 1)?.userPrompt).toBe("Diagnose the auth race");
    expect(transactionRunner).toHaveBeenCalledTimes(1);
  });

  test("chooses the next prompt number inside the hook transaction runner", async () => {
    const session = upsertSession(db, {
      contentSessionId: "session-1",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1000,
      updatedAtEpoch: 1000,
      completedAtEpoch: null,
    });
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'active', 'Existing prompt', 1000)`,
    ).run(session.id);

    const transactionRunner = mock((runnerDb: Database, fn: () => unknown) => {
      expect(runnerDb).toBe(db);
      db.query(
        `INSERT INTO turns (
          session_id, prompt_number, status, user_prompt, created_at_epoch
        ) VALUES (?, 2, 'active', 'Concurrent prompt', 1001)`,
      ).run(session.id);

      const result = fn();

      expect(getTurn(db, session.id, 2)?.userPrompt).toBe("Concurrent prompt");
      expect(getTurn(db, session.id, 3)?.userPrompt).toBe("Prompt after lock");
      return result;
    });
    const handler = createSessionInitHandler({
      db,
      now: () => 1002,
      runHookWriteTransaction: transactionRunner,
    });

    await handler(createInput({ prompt: "Prompt after lock" }));

    expect(transactionRunner).toHaveBeenCalledTimes(1);
    expect(getTurn(db, session.id, 3)?.status).toBe("active");
  });

  test("second prompt only inserts another active turn", async () => {
    const transcript = writeTranscript([
      { role: "user", content: [{ type: "text", text: "Diagnose the auth race" }] },
    ]);
    transcriptDirectories.push(transcript.directory);

    const handler = createSessionInitHandler({
      db,
    });

    await handler(
      createInput({
        prompt: "Diagnose the auth race",
      }),
    );

    await handler(
      createInput({
        prompt: "Fix it and add tests",
        transcriptPath: transcript.path,
      }),
    );

    const session = getSessionByContentId(db, "session-1")!;
    const firstTurn = getTurn(db, session.id, 1)!;
    const secondTurn = getTurn(db, session.id, 2)!;

    expect(firstTurn.assistantResponse).toBeNull();
    expect(firstTurn.status).toBe("active");
    expect(secondTurn.status).toBe("active");
  });

  test("does not do any transcript work even when previous turn is already extracted", async () => {
    const transcript = writeTranscript([
      { role: "user", content: [{ type: "text", text: "Add another change" }] },
    ]);
    transcriptDirectories.push(transcript.directory);

    const handler = createSessionInitHandler({
      db,
    });

    await handler(
      createInput({
        prompt: "Diagnose the auth race",
      }),
    );

    const session = getSessionByContentId(db, "session-1")!;
    db.query(
      `UPDATE turns
       SET status = 'extracted', assistant_response = 'done'
       WHERE session_id = ? AND prompt_number = 1`,
    ).run(session.id);

    await handler(
      createInput({
        prompt: "Add another change",
        transcriptPath: transcript.path,
      }),
    );
  });

  test("uses JSONL-derived numbering for adopted sessions", async () => {
    const transcript = writeTranscript([
      { role: "user", content: [{ type: "text", text: "First prompt" }] },
      { role: "user", content: [{ type: "text", text: "Second prompt" }] },
      { role: "user", content: [{ type: "text", text: "Third prompt" }] },
    ]);
    transcriptDirectories.push(transcript.directory);

    const session = upsertSession(db, {
      contentSessionId: "session-1",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1000,
      updatedAtEpoch: 1000,
      completedAtEpoch: null,
    });

    const handler = createSessionInitHandler({
      db,
      now: () => 1001,
    });

    await handler(
      createInput({
        prompt: "Fourth prompt",
        transcriptPath: transcript.path,
      }),
    );

    const insertedTurn = getTurn(db, session.id, 4);

    expect(insertedTurn?.promptNumber).toBe(4);
    expect(insertedTurn?.userPrompt).toBe("Fourth prompt");
  });

  test("uses matching JSONL numbering for normal tracked sessions", async () => {
    const firstTranscript = writeTranscript([
      { role: "user", content: [{ type: "text", text: "First prompt" }] },
      { role: "assistant", content: [{ type: "text", text: "First answer" }] },
      { role: "user", content: [{ type: "text", text: "Second prompt" }] },
    ]);
    transcriptDirectories.push(firstTranscript.directory);

    const handler = createSessionInitHandler({
      db,
      now: () => 2000,
    });

    await handler(
      createInput({
        prompt: "First tracked prompt",
      }),
    );

    await handler(
      createInput({
        prompt: "Second tracked prompt",
      }),
    );

    await handler(
      createInput({
        prompt: "Third tracked prompt",
        transcriptPath: firstTranscript.path,
      }),
    );

    const session = getSessionByContentId(db, "session-1")!;
    const thirdTurn = getTurn(db, session.id, 3);

    expect(thirdTurn?.promptNumber).toBe(3);
    expect(thirdTurn?.userPrompt).toBe("Third tracked prompt");
  });

  test("falls back to DB count when transcriptPath is unavailable", async () => {
    const transcript = writeTranscript([
      { role: "user", content: [{ type: "text", text: "Ignored one" }] },
      { role: "user", content: [{ type: "text", text: "Ignored two" }] },
      { role: "user", content: [{ type: "text", text: "Ignored three" }] },
    ]);
    transcriptDirectories.push(transcript.directory);

    const handler = createSessionInitHandler({
      db,
      now: () => 3000,
    });

    await handler(
      createInput({
        prompt: "First tracked prompt",
      }),
    );

    await handler(
      createInput({
        prompt: "Second tracked prompt",
      }),
    );

    await handler(
      createInput({
        prompt: "Third tracked prompt",
      }),
    );

    const session = getSessionByContentId(db, "session-1")!;
    const thirdTurn = getTurn(db, session.id, 3);

    expect(thirdTurn?.promptNumber).toBe(3);
    expect(thirdTurn?.userPrompt).toBe("Third tracked prompt");
  });

  test("uses db max plus one even when transcript count disagrees", async () => {
    const transcript = writeTranscript([
      { role: "user", content: [{ type: "text", text: "Only one parsed prompt" }] },
    ]);
    transcriptDirectories.push(transcript.directory);

    const session = upsertSession(db, {
      contentSessionId: "session-1",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 3500,
      updatedAtEpoch: 3500,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, ?, 'active', ?, ?)`,
    ).run(session.id, 47, "/markdown-writing 在审查一下文档", 3500);

    const handler = createSessionInitHandler({
      db,
      now: () => 3501,
    });

    await handler(
      createInput({
        prompt: "1. 4.1 可以删除切分描述 2-4 修正",
        transcriptPath: transcript.path,
      }),
    );

    expect(getTurn(db, session.id, 48)?.userPrompt).toBe(
      "1. 4.1 可以删除切分描述 2-4 修正",
    );
  });

  test("counts only real user prompts in nested Claude JSONL transcripts", async () => {
    const transcript = writeTranscript([
      {
        type: "user",
        promptId: "p1",
        permissionMode: "default",
        message: {
          role: "user",
          content: "First real prompt",
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "First answer" }],
        },
      },
      {
        type: "user",
        promptId: "task-1",
        message: {
          role: "user",
          content: "<task-notification>subagent finished</task-notification>",
        },
      },
      {
        type: "user",
        promptId: "p2",
        permissionMode: "default",
        message: {
          role: "user",
          content: "Second real prompt",
        },
      },
    ]);
    transcriptDirectories.push(transcript.directory);

    const session = upsertSession(db, {
      contentSessionId: "session-1",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 4000,
      updatedAtEpoch: 4000,
      completedAtEpoch: null,
    });

    const handler = createSessionInitHandler({
      db,
      now: () => 4001,
    });

    await handler(
      createInput({
        prompt: "Third real prompt",
        transcriptPath: transcript.path,
      }),
    );

    expect(getTurn(db, session.id, 3)?.userPrompt).toBe("Third real prompt");
  });

  test("marks prior sidechain turns undone and still inserts the new active turn", async () => {
    const transcript = writeTranscript([
      {
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        isSidechain: true,
        content: [{ type: "text", text: "Draft approach" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [{ type: "text", text: "Discarded branch" }],
      },
    ]);
    transcriptDirectories.push(transcript.directory);

    const session = upsertSession(db, {
      contentSessionId: "session-1",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 5000,
      updatedAtEpoch: 5000,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, content_prompt_id, status, user_prompt, assistant_response, created_at_epoch, updated_at_epoch
      ) VALUES (?, 1, 'p1', 'extracted', 'Draft approach', 'Discarded branch', 5000, 5000)`,
    ).run(session.id);

    const handler = createSessionInitHandler({
      db,
      now: () => 5001,
    });

    await handler(
      createInput({
        prompt: "Final approach",
        transcriptPath: transcript.path,
      }),
    );

    expect(getTurn(db, session.id, 1)?.status).toBe("undone");
    expect(getTurn(db, session.id, 1)?.tags).toContain("subagent:pending");
    expect(getTurn(db, session.id, 2)?.status).toBe("active");
    expect(getTurn(db, session.id, 2)?.userPrompt).toBe("Final approach");
  });
});

/**
 * The owed suffix and the backlog relief (note-prompt-clock spec D1/D3/D4/D9):
 * computed and rendered by THIS entry, inside the same transaction that
 * creates the current turn — there is no separate reminder pass, no
 * classification, and (per D9) no second UserPromptSubmit process that
 * touches any of it.
 */
describe("owed-notes injection (spec D3/D4/D9)", () => {
  let db: Database;
  let sessionId: number;

  function seedSession(): void {
    sessionId = upsertSession(db, {
      contentSessionId: "session-1",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1000,
      updatedAtEpoch: 1000,
      completedAtEpoch: null,
    }).id;
  }

  /** A finished, un-answered turn — owed the moment a later prompt exists. */
  function addOwedTurn(promptNumber: number, prompt = `prompt ${promptNumber}`): number {
    return db
      .query<{ id: number }, [number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, ?, 'active', ?, 1000) RETURNING id`,
      )
      .get(sessionId, promptNumber, prompt)!.id;
  }

  function addNotedTurn(promptNumber: number): number {
    const turnId = addOwedTurn(promptNumber, `noted prompt ${promptNumber}`);
    upsertShadowNote(db, {
      turnId,
      title: `write+fixture: turn ${promptNumber}`,
      content: "…",
      nowEpoch: 1000,
    });
    return turnId;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    seedSession();
  });

  afterEach(() => {
    db.close();
  });

  test("zero owed turns: the current-turn line is unchanged, byte for byte", async () => {
    const result = await createSessionInitHandler({ db })(createInput());

    expect(result.hookSpecificOutput).toBe(
      `mnemo current turn: S${sessionId}/T1`,
    );
  });

  test("one owed turn: the address is appended", async () => {
    addOwedTurn(1);

    const result = await createSessionInitHandler({ db })(
      createInput({ prompt: "second" }),
    );

    expect(result.hookSpecificOutput).toBe(
      `mnemo current turn: S${sessionId}/T2 · owed: S${sessionId}/T1`,
    );
  });

  test("two owed turns: the newest address plus the older count", async () => {
    addOwedTurn(1);
    addOwedTurn(2);

    const result = await createSessionInitHandler({ db })(
      createInput({ prompt: "third" }),
    );

    expect(result.hookSpecificOutput).toBe(
      `mnemo current turn: S${sessionId}/T3 · owed: S${sessionId}/T2 +1 older`,
    );
  });

  test("five or more owed turns: the owed suffix AND a relief block listing the oldest five", async () => {
    for (let promptNumber = 1; promptNumber <= 5; promptNumber += 1) {
      addOwedTurn(promptNumber, `prompt number ${promptNumber}`);
    }

    const result = await createSessionInitHandler({ db })(
      createInput({ prompt: "sixth" }),
    );

    expect(result.hookSpecificOutput).toBe(
      [
        `mnemo current turn: S${sessionId}/T6 · owed: S${sessionId}/T5 +4 older`,
        [
          "mnemo pending notes (backlog relief):",
          `  [S${sessionId}/T1] "prompt number 1" (pending 5 turns)`,
          `  [S${sessionId}/T2] "prompt number 2" (pending 4 turns)`,
          `  [S${sessionId}/T3] "prompt number 3" (pending 3 turns)`,
          `  [S${sessionId}/T4] "prompt number 4" (pending 2 turns)`,
          `  [S${sessionId}/T5] "prompt number 5" (pending 1 turn)`,
          "5 turns are waiting for notes. Open a batch containing ONLY note or" +
            " skip calls for the turns above — the standing rule against" +
            " starting a tool call just to write notes is waived for that" +
            " batch, and for nothing else in it.",
        ].join("\n"),
      ].join("\n\n"),
    );
  });

  test("the relief block re-renders on every prompt while the count stays at or above five", async () => {
    for (let promptNumber = 1; promptNumber <= 6; promptNumber += 1) {
      addOwedTurn(promptNumber);
    }
    const handler = createSessionInitHandler({ db });

    // T7's own prompt: six prior turns owed, still ≥ 5 — the relief fires.
    const first = await handler(createInput({ prompt: "seventh" }));
    expect(first.hookSpecificOutput).toContain("(backlog relief)");

    // Nothing was answered, so it fires again on T8's prompt too — there is
    // no claim and no re-arm window, only the count itself.
    const second = await handler(createInput({ prompt: "eighth" }));
    expect(second.hookSpecificOutput).toContain("(backlog relief)");
  });

  test("writing even one note drops the count below the threshold and the relief stops", async () => {
    const debts: number[] = [];
    for (let promptNumber = 1; promptNumber <= 5; promptNumber += 1) {
      debts.push(addOwedTurn(promptNumber));
    }
    upsertShadowNote(db, {
      turnId: debts[0]!,
      title: "write+relief: the first debt gets answered",
      content: "…",
      nowEpoch: 1100,
    });

    const result = await createSessionInitHandler({ db })(
      createInput({ prompt: "sixth" }),
    );

    // Four left — below the five-turn threshold, so no relief block, and the
    // owed suffix names only what remains.
    expect(result.hookSpecificOutput).not.toContain("backlog relief");
    expect(result.hookSpecificOutput).toBe(
      `mnemo current turn: S${sessionId}/T6 · owed: S${sessionId}/T5 +3 older`,
    );
  });

  test("a skip removes the turn from the owed count the same way a note does", async () => {
    for (let promptNumber = 1; promptNumber <= 5; promptNumber += 1) {
      addOwedTurn(promptNumber);
    }
    recordDeclinedNoteDebt(
      db,
      { id: db.query<{ id: number }, [number, number]>(
          "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
        ).get(sessionId, 1)!.id,
        sessionId,
        promptNumber: 1,
      },
      1100,
    );

    const result = await createSessionInitHandler({ db })(
      createInput({ prompt: "sixth" }),
    );

    expect(result.hookSpecificOutput).not.toContain("backlog relief");
  });

  test("a compact marker row is never owed and never shown", async () => {
    db.query<unknown, [number]>(
      `INSERT INTO turns (session_id, prompt_number, status, title, type, created_at_epoch)
       VALUES (?, 1, 'extracted', '/compact', 'compact', 1000)`,
    ).run(sessionId);

    const result = await createSessionInitHandler({ db })(
      createInput({ prompt: "second" }),
    );

    expect(result.hookSpecificOutput).toBe(
      `mnemo current turn: S${sessionId}/T2`,
    );
  });

  test("a rolled-back turn is never owed", async () => {
    db.query<unknown, [number]>(
      `INSERT INTO turns (session_id, prompt_number, status, was_rolled_back, user_prompt, created_at_epoch)
       VALUES (?, 1, 'active', 1, 'reverted attempt', 1000)`,
    ).run(sessionId);

    const result = await createSessionInitHandler({ db })(
      createInput({ prompt: "second" }),
    );

    expect(result.hookSpecificOutput).toBe(
      `mnemo current turn: S${sessionId}/T2`,
    );
  });

  test("a sidechain (undone) row is never owed", async () => {
    db.query<unknown, [number]>(
      `INSERT INTO turns (session_id, prompt_number, status, tags, user_prompt, created_at_epoch)
       VALUES (?, 1, 'undone', '["subagent:pending"]', 'delegated work', 1000)`,
    ).run(sessionId);

    const result = await createSessionInitHandler({ db })(
      createInput({ prompt: "second" }),
    );

    expect(result.hookSpecificOutput).toBe(
      `mnemo current turn: S${sessionId}/T2`,
    );
  });

  test("a subagent prompt gets no owed suffix and no relief block — suppressOutput wins outright", async () => {
    for (let promptNumber = 1; promptNumber <= 6; promptNumber += 1) {
      addOwedTurn(promptNumber);
    }

    const result = await createSessionInitHandler({ db })(
      createInput({ agentId: "agent-123", prompt: "delegated work" }),
    );

    expect(result).toEqual({ continue: true, suppressOutput: true });
  });

  test("the addresses actually shown are recorded as exposed, so a later note may cite them", async () => {
    for (let promptNumber = 1; promptNumber <= 6; promptNumber += 1) {
      addOwedTurn(promptNumber);
    }

    await createSessionInitHandler({ db })(createInput({ prompt: "seventh" }));

    // The relief's oldest five (T1..T5) plus the owed suffix's newest (T6).
    const exposed = getExposedTurnIds(db, sessionId, "injection");
    const turnIdByPrompt = (promptNumber: number) =>
      db
        .query<{ id: number }, [number, number]>(
          "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
        )
        .get(sessionId, promptNumber)!.id;
    for (let promptNumber = 1; promptNumber <= 6; promptNumber += 1) {
      expect(exposed.has(turnIdByPrompt(promptNumber))).toBe(true);
    }
  });

  test("prompt-dispatch, the sibling UserPromptSubmit entry, never renders owed or relief text — session-init is the sole writer (spec D9)", async () => {
    for (let promptNumber = 1; promptNumber <= 6; promptNumber += 1) {
      addOwedTurn(promptNumber);
    }

    const result = await createPromptDispatchHandler()(
      createInput({ prompt: "seventh" }),
    );

    expect(result.hookSpecificOutput ?? "").not.toContain("owed:");
    expect(result.hookSpecificOutput ?? "").not.toContain("backlog relief");
    expect(result.hookSpecificOutput ?? "").not.toContain("mnemo current turn");
  });

  test("no N/N-1 race: session-init alone creates the turn and computes owed from the number it just took", async () => {
    // Both UserPromptSubmit entries run in Claude Code's Promise.all; the old
    // relief handler used to read `getLatestTurn` independently and could
    // therefore disagree with session-init about which turn was "current".
    // prompt-dispatch touches no database at all now (see the test above), so
    // there is nothing left for it to disagree with — session-init's own
    // count is authoritative by construction, not by a race it wins.
    addOwedTurn(1);
    addOwedTurn(2);

    const sessionInitResult = await createSessionInitHandler({ db })(
      createInput({ prompt: "third" }),
    );
    const promptDispatchResult = await createPromptDispatchHandler()(
      createInput({ prompt: "third" }),
    );

    expect(sessionInitResult.hookSpecificOutput).toBe(
      `mnemo current turn: S${sessionId}/T3 · owed: S${sessionId}/T2 +1 older`,
    );
    expect(promptDispatchResult.hookSpecificOutput ?? "").not.toContain("owed");
  });
});

describe("process-session identity map (spec D1)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function mappedSessions(env: NodeJS.ProcessEnv): Array<number | null> {
    // Asserts through the same derivation the production reader uses, so the
    // test never depends on how a key is spelled — only on the two halves
    // agreeing about it.
    return deriveProcessIdentityKeys(env).map((key) =>
      getMnemoSessionIdForProcessSession(db, key),
    );
  }

  test("records the session under every identity key its environment yields", async () => {
    const env = {
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/52426.sock",
      CLAUDE_CODE_SESSION_ID: "conversation-id",
    };
    const handler = createSessionInitHandler({ db, env });

    await handler(createInput());

    const session = getSessionByContentId(db, "session-1");
    expect(mappedSessions(env)).toEqual([session!.id, session!.id]);
    // Two distinct rows, not one: the keys are namespaced by source, so they
    // cannot collapse into each other in the map's single key column.
    expect(
      db.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM process_session_map",
      ).get()!.n,
    ).toBe(2);
  });

  test("an environment with no recognised variable writes nothing and changes nothing else", async () => {
    const handler = createSessionInitHandler({ db, env: {} });

    const result = await handler(createInput());

    // The rest of the hook's work (the session row, the pending turn, the
    // current-turn line) must be unaffected by the miss.
    const session = getSessionByContentId(db, "session-1");
    expect(session).not.toBeNull();
    expect(getTurn(db, session!.id, 1)).not.toBeNull();
    expect(result.hookSpecificOutput).toBe(`mnemo current turn: S${session!.id}/T1`);
    // No row at all — not an empty-string key, and not a key for a variable
    // this environment does not hold.
    expect(
      db.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM process_session_map",
      ).get()!.n,
    ).toBe(0);
  });

  test("a session variable that moves mid-session leaves both values pointing at the session", async () => {
    // Same content session (`session-1`, spec D1's mnemo-session key) across
    // two prompts, with the session variable holding a different value on the
    // second — a `/clear` reassigns it in place, and each hook is a fresh child
    // that reads whatever is current. Neither row is retired: the reading
    // process may still be holding either value in its own spawn-time snapshot.
    const before = { CLAUDE_CODE_SESSION_ID: "id-before" };
    const after = { CLAUDE_CODE_SESSION_ID: "id-after" };

    await createSessionInitHandler({ db, env: before })(
      createInput({ prompt: "before" }),
    );
    await createSessionInitHandler({ db, env: after })(
      createInput({ prompt: "after" }),
    );

    const session = getSessionByContentId(db, "session-1");
    expect(mappedSessions(before)).toEqual([session!.id]);
    expect(mappedSessions(after)).toEqual([session!.id]);
  });
});
