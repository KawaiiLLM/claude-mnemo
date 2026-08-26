import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../src/db/database";
import { recordDeclinedNoteDebt } from "../../src/db/note-debt";
import {
  deriveProcessIdentityKeys,
  getMnemoSessionIdForProcessSession,
} from "../../src/db/process-session-map";
import { initializeSchema } from "../../src/db/schema";
import { attachSegmentToSession, createSegment } from "../../src/db/segments";
import { getSessionByContentId, touchSessionRememberActivity } from "../../src/db/sessions";
import { upsertShadowNote } from "../../src/db/shadow-notes";
import { getTurn } from "../../src/db/turns";
import { upsertSession } from "../../src/db/sessions";
import { REMEMBER_REMINDER_INTERVAL_TURNS } from "../../src/hooks/note-reminder";
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
    // created (spec D1) — but ticket 03 retired the owed suffix, so a single
    // below-threshold debt leaves the line bare; the number itself is what
    // this test pins.
    expect(result.hookSpecificOutput).toBe(
      `mnemo current turn: S${session.id}/T2`,
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
 * The backlog-relief block (note-prompt-clock spec D1/D3/D4/D9; ticket 03
 * note-cadence-backlog): computed and rendered by THIS entry, inside the same
 * transaction that creates the current turn — there is no separate reminder
 * pass, no classification, and (per D9) no second UserPromptSubmit process
 * that touches any of it.
 *
 * Ticket 03 retired the current-turn line's owed SUFFIX outright (see
 * src/hooks/note-reminder.ts's doc comment: it was structurally present
 * every single time, so it carried zero information). Below threshold
 * (< 5), an owed turn now produces NO visible signal at all — the relief
 * block at >= 5 is the only owed-set rendering left, unchanged from before.
 */
describe("owed-notes injection (spec D3/D4/D9, ticket 03)", () => {
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

  test("one owed turn: no signal at all — the current-turn line stays bare", async () => {
    addOwedTurn(1);

    const result = await createSessionInitHandler({ db })(
      createInput({ prompt: "second" }),
    );

    expect(result.hookSpecificOutput).toBe(
      `mnemo current turn: S${sessionId}/T2`,
    );
  });

  // Ticket 03 acceptance criterion: "0 条、4 条积压无提醒" — four owed turns,
  // one short of the threshold, produce no visible signal anywhere: no owed
  // suffix (retired) and no relief block (below NOTE_RELIEF_PENDING_THRESHOLD).
  test("four owed turns (one short of the threshold): no signal at all", async () => {
    for (let promptNumber = 1; promptNumber <= 4; promptNumber += 1) {
      addOwedTurn(promptNumber);
    }

    const result = await createSessionInitHandler({ db })(
      createInput({ prompt: "fifth" }),
    );

    expect(result.hookSpecificOutput).toBe(
      `mnemo current turn: S${sessionId}/T5`,
    );
  });

  test("five or more owed turns: the current-turn line stays bare, and a relief block lists the oldest five", async () => {
    for (let promptNumber = 1; promptNumber <= 5; promptNumber += 1) {
      addOwedTurn(promptNumber, `prompt number ${promptNumber}`);
    }

    const result = await createSessionInitHandler({ db })(
      createInput({ prompt: "sixth" }),
    );

    expect(result.hookSpecificOutput).toBe(
      [
        `mnemo current turn: S${sessionId}/T6`,
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

    // Four left — below the five-turn threshold, so no relief block, and (per
    // ticket 03) no owed suffix either: the current-turn line is bare.
    expect(result.hookSpecificOutput).not.toContain("backlog relief");
    expect(result.hookSpecificOutput).toBe(
      `mnemo current turn: S${sessionId}/T6`,
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
       VALUES (?, 1, 'extracted', '/compact', '["compact"]', 1000)`,
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

  test("a subagent prompt gets no relief block — suppressOutput wins outright", async () => {
    for (let promptNumber = 1; promptNumber <= 6; promptNumber += 1) {
      addOwedTurn(promptNumber);
    }

    const result = await createSessionInitHandler({ db })(
      createInput({ agentId: "agent-123", prompt: "delegated work" }),
    );

    expect(result).toEqual({ continue: true, suppressOutput: true });
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

  test("no N/N-1 race: session-init alone creates the turn and computes the relief block from the number it just took", async () => {
    // Both UserPromptSubmit entries run in Claude Code's Promise.all; the old
    // relief handler used to read `getLatestTurn` independently and could
    // therefore disagree with session-init about which turn was "current".
    // prompt-dispatch touches no database at all now (see the test above), so
    // there is nothing left for it to disagree with — session-init's own
    // count is authoritative by construction, not by a race it wins.
    for (let promptNumber = 1; promptNumber <= 5; promptNumber += 1) {
      addOwedTurn(promptNumber);
    }

    const sessionInitResult = await createSessionInitHandler({ db })(
      createInput({ prompt: "sixth" }),
    );
    const promptDispatchResult = await createPromptDispatchHandler()(
      createInput({ prompt: "sixth" }),
    );

    expect(sessionInitResult.hookSpecificOutput).toContain(
      `mnemo current turn: S${sessionId}/T6`,
    );
    expect(sessionInitResult.hookSpecificOutput).toContain("backlog relief");
    expect(promptDispatchResult.hookSpecificOutput ?? "").not.toContain(
      "backlog relief",
    );
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

// Ticket 13 (spec "节奏与建段指导"): the universal `remember` check — every
// session, attached to a segment or not, gets a one-line reminder at its
// REMEMBER_REMINDER_INTERVAL_TURNS-th turn since its last successful
// `remember` call (or, absent one, since the session began). Both acceptance
// variants (零挂靠/挂靠) share one mechanism: the reminder is computed purely
// from `sessions.last_remember_turn_id` and the turn count, never from whether
// a segment is attached — so a session that attaches a segment through a
// path OTHER than `remember` (a raw DB write here, matching how a pre-existing
// attachment would look) proves the attach itself carries no exemption.
describe("universal remember cadence reminder (ticket 13)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  /**
   * Runs the handler `count` times. The strictly-increasing epoch itself
   * lives in the `now` closure the caller passed to `createSessionInitHandler`
   * — this helper only drives the call count.
   */
  async function runTurns(
    handler: ReturnType<typeof createSessionInitHandler>,
    count: number,
  ) {
    let result;
    for (let index = 0; index < count; index += 1) {
      result = await handler(createInput({ prompt: `turn ${index + 1}` }));
    }
    return result!;
  }

  test("a session with zero attachments, never calling remember, gets the reminder exactly at its 20th turn", async () => {
    let epoch = 1000;
    const handler = createSessionInitHandler({ db, now: () => epoch++ });

    const nineteenth = await runTurns(handler, REMEMBER_REMINDER_INTERVAL_TURNS - 1);
    expect(nineteenth.hookSpecificOutput ?? "").not.toContain("remember check");

    const twentieth = await handler(createInput({ prompt: "turn 20" }));
    expect(twentieth.hookSpecificOutput).toContain(
      `mnemo remember check: ${REMEMBER_REMINDER_INTERVAL_TURNS} turns since your last remember call`,
    );
  });

  test("an attached session, never calling remember itself, gets the reminder just the same — attachment carries no exemption", async () => {
    let epoch = 1000;
    const handler = createSessionInitHandler({ db, now: () => epoch++ });

    // Turn 1 creates the session; attach a segment to it directly (not
    // through `remember`, so `last_remember_turn_id` stays untouched) before
    // running the remaining 19 turns.
    await handler(createInput({ prompt: "turn 1" }));
    const session = getSessionByContentId(db, "session-1")!;
    const segment = createSegment(db, { title: "an attached segment", nowEpoch: epoch });
    attachSegmentToSession(db, session.id, segment.id, epoch);

    // TWO turns more than the old fixture ran, both for stated reasons. The
    // per-field debt is measured from the segment's own creation (ticket 02),
    // and this segment is attached after turn 1, which costs one; the stamp
    // anchor is an epoch and this fixture advances one epoch per turn, so the
    // turn sharing the segment's own second is not counted, which costs the
    // other. That second one is the bounded undercount
    // `readSegmentFieldFreshness` documents as harmless under a THRESHOLD
    // test — visible here as a one-turn delay, never a skipped window.
    let result;
    for (let index = 1; index <= REMEMBER_REMINDER_INTERVAL_TURNS + 1; index += 1) {
      result = await handler(createInput({ prompt: `turn ${index + 1}` }));
    }

    // memory-guidance ticket 02 (D5, one channel two states): attachment
    // still carries no exemption — what changed is WHICH line arrives. An
    // attached session gets the per-field maintenance reminder for its own
    // segment; the generic "since your last remember call" line is now
    // reserved for the session with nothing attached, which is the only
    // state where no per-field reading exists at all.
    expect(result!.hookSpecificOutput).toContain(`[E${segment.id}] mnemo segment maintenance:`);
    expect(result!.hookSpecificOutput).not.toContain("mnemo remember check:");
  });

  // D5, ruled in memory-guidance ticket 02: ONE maintenance channel, two
  // states — never both lines, and never neither when something is owed.
  // Two channels sharing this slot would dilute each other, which is the
  // thing the ticket forbids "两套并存了事".
  test("exactly one maintenance line is ever produced, whichever state applies", async () => {
    let epoch = 1000;
    const handler = createSessionInitHandler({ db, now: () => epoch++ });

    // Unattached: the generic line, and no per-field line — there are no
    // stamps to read, which is the whole reason the generic one survives.
    await runTurns(handler, REMEMBER_REMINDER_INTERVAL_TURNS - 1);
    const unattached = await handler(createInput({ prompt: "boundary" }));
    expect(unattached.hookSpecificOutput).toContain("mnemo remember check:");
    expect(unattached.hookSpecificOutput).not.toContain("mnemo segment maintenance:");

    // Attached: the per-field line, and no generic line.
    const session = getSessionByContentId(db, "session-1")!;
    const segment = createSegment(db, { title: "attached", nowEpoch: 900 });
    attachSegmentToSession(db, session.id, segment.id, epoch);
    const attached = await handler(createInput({ prompt: "after attach" }));
    expect(attached.hookSpecificOutput).toContain("mnemo segment maintenance:");
    expect(attached.hookSpecificOutput).not.toContain("mnemo remember check:");
  });

  test("a remember call resets the clock — the next 20-turn boundary counts from there, not from session start", async () => {
    let epoch = 1000;
    const handler = createSessionInitHandler({ db, now: () => epoch++ });

    await runTurns(handler, 15);
    const session = getSessionByContentId(db, "session-1")!;
    touchSessionRememberActivity(db, session.id);
    // No epoch dance needed any more (0.12.1): the anchor is the session's
    // MAX turn row id, and every later turn's id is strictly greater
    // regardless of shared seconds.

    // 15 more turns after the remember call: total turns since session start
    // is 30, well past 20, but only 15 have passed since the reset — no
    // reminder yet.
    let result;
    for (let index = 0; index < 15; index += 1) {
      result = await handler(createInput({ prompt: `after-remember ${index + 1}` }));
    }
    expect(result!.hookSpecificOutput ?? "").not.toContain("remember check");

    // 5 more (20 since the remember call) fires it.
    for (let index = 0; index < 5; index += 1) {
      result = await handler(createInput({ prompt: `boundary ${index + 1}` }));
    }
    expect(result!.hookSpecificOutput).toContain("mnemo remember check: 20 turns");
  });
});
