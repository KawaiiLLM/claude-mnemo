import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSessionByContentId, upsertSession } from "../../src/db/sessions";
import { getPendingTurns, getTurn } from "../../src/db/turns";
import { createStopHandler } from "../../src/hooks/handlers/stop";
import * as transcriptParser from "../../src/shared/transcript-parser";
import type { NormalizedHookInput } from "../../src/hooks/types";

function createInput(
  overrides: Partial<NormalizedHookInput> = {},
): NormalizedHookInput {
  return {
    eventName: "Stop",
    sessionId: "session-stop",
    cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

function writeTranscript(lines: unknown[]): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-stop-"));
  const path = join(directory, "session.jsonl");
  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );

  return { directory, path };
}

describe("handleStopHook", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "session-stop",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Stop handler session",
      content: "Stop hook coverage",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("guards stop_hook_active to avoid infinite loops", async () => {
    const forkMnemosyne = mock(async () => {});
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: mock(() => true) },
    });

    const result = await handler(
      createInput({
        stopHookActive: true,
      }),
    );

    expect(result).toEqual({
      continue: true,
      exitCode: 0,
    });
    expect(forkMnemosyne).not.toHaveBeenCalled();
  });

  test("returns asyncWork, finishes sync work first, and claims turns before extraction runs", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', 'Pending work', 120)`,
    ).run(sessionId);

    const stderrWrite = mock(() => true);
    let syncStateObservedAtFork = false;
    const forkMnemosyne = mock(async () => {
      const session = getSessionByContentId(db, "session-stop");
      syncStateObservedAtFork =
        session?.completedAtEpoch === 500 &&
        session?.updatedAtEpoch === 500 &&
        stderrWrite.mock.calls.length === 1;
    });

    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: stderrWrite },
      now: () => 500,
    });

    const result = await handler(createInput());
    const claimedTurn = getTurn(db, sessionId, 1);
    const session = getSessionByContentId(db, "session-stop");

    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(typeof result.asyncWork).toBe("function");
    expect(forkMnemosyne).not.toHaveBeenCalled();
    expect(claimedTurn?.status).toBe("extracting_pending");
    expect(getPendingTurns(db, sessionId)).toEqual([]);
    expect(session?.completedAtEpoch).toBe(500);
    expect(session?.updatedAtEpoch).toBe(500);
    expect(stderrWrite).toHaveBeenCalledWith(
      "Mnemosyne: 1 turns queued for extraction\n",
    );
    expect(syncStateObservedAtFork).toBe(false);

    await result.asyncWork?.();

    expect(forkMnemosyne).toHaveBeenCalledTimes(1);
    expect(syncStateObservedAtFork).toBe(true);
  });

  test("builds the stop prompt before claiming turns", async () => {
    const transcript = writeTranscript([
      {
        role: "user",
        isSidechain: true,
        content: [{ type: "text", text: "Draft approach" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "src/draft.ts" } },
          { type: "text", text: "Draft response" },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Investigate logs" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } },
          { type: "text", text: "Replay-compatible response" },
        ],
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, assistant_response, title, created_at_epoch
      ) VALUES (?, 1, 'extracted', 'Draft approach', 'Draft response', 'Draft approach', 120)`,
    ).run(sessionId);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 2, 'pending', 'Investigate logs', 130)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => {});
    const stderrWrite = mock(() => true);
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: stderrWrite },
      now: () => 500,
    });

    const result = await handler(
      createInput({
        transcriptPath: transcript.path,
      }),
    );

    const extractedTurn = getTurn(db, sessionId, 1)!;
    const secondPendingTurn = getTurn(db, sessionId, 2)!;
    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(typeof result.asyncWork).toBe("function");
    expect(extractedTurn.status).toBe("extracting_stale");
    expect(extractedTurn.toolCallCount).toBeNull();
    expect(secondPendingTurn.assistantResponse).toBe("Replay-compatible response");
    expect(secondPendingTurn.toolCallCount).toBe(1);
    expect(getPendingTurns(db, sessionId)).toEqual([]);
    expect(forkMnemosyne).not.toHaveBeenCalled();

    await result.asyncWork?.();

    expect(forkMnemosyne).toHaveBeenCalledTimes(1);
    const prompt = String(forkMnemosyne.mock.calls[0]?.[0]?.prompt);
    expect(prompt).toContain(`[S${sessionId}] Stop handler session`);
    expect(prompt).toContain("/Users/zhaoqixuan/Projects/claude-mnemo");
    expect(prompt).toContain("Stop hook coverage");
    expect(prompt).toContain("[T1] Draft approach");
    expect(prompt).toContain("[stale]");
    expect(prompt).toContain('[T2] "Investigate logs"');
    expect(prompt).toContain("[pending]");
    expect(stderrWrite).toHaveBeenCalled();

    rmSync(transcript.directory, { recursive: true, force: true });
  });

  test("does not return asyncWork when there is nothing to claim", async () => {
    const stderrWrite = mock(() => true);
    const forkMnemosyne = mock(async () => {});
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: stderrWrite },
      now: () => 500,
    });

    const result = await handler(createInput());
    const session = getSessionByContentId(db, "session-stop");

    expect(result).toEqual({
      continue: true,
      exitCode: 0,
    });
    expect(result.asyncWork).toBeUndefined();
    expect(session?.completedAtEpoch).toBe(500);
    expect(session?.updatedAtEpoch).toBe(500);
    expect(stderrWrite).toHaveBeenCalledWith(
      "Mnemosyne: 0 turns queued for extraction\n",
    );
    expect(forkMnemosyne).not.toHaveBeenCalled();
  });

  test("backfills content_prompt_id from nested transcript entries before async extraction", async () => {
    const transcript = writeTranscript([
      {
        type: "user",
        promptId: "p1",
        permissionMode: "default",
        message: {
          role: "user",
          content: "Draft approach",
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Draft response" }],
        },
      },
      {
        type: "user",
        promptId: "p2",
        permissionMode: "default",
        message: {
          role: "user",
          content: "Investigate logs",
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Replay-compatible response" }],
        },
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', 'Draft approach', 120)`,
    ).run(sessionId);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 2, 'pending', 'Investigate logs', 130)`,
    ).run(sessionId);

    const handler = createStopHandler({
      db,
      forkMnemosyne: mock(async () => {}),
      stderr: { write: mock(() => true) },
      now: () => 500,
    });

    const result = await handler(
      createInput({
        transcriptPath: transcript.path,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(getTurn(db, sessionId, 1)?.contentPromptId).toBe("p1");
    expect(getTurn(db, sessionId, 2)?.contentPromptId).toBe("p2");

    rmSync(transcript.directory, { recursive: true, force: true });
  });

  test("handles missing transcript by falling back without crashing", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', 'Only pending turn', 120)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => {});
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: mock(() => true) },
    });

    const result = await handler(
      createInput({
        transcriptPath: "/tmp/missing.jsonl",
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(typeof result.asyncWork).toBe("function");
    expect(forkMnemosyne).not.toHaveBeenCalled();
    expect(getTurn(db, sessionId, 1)?.assistantResponse).toBe("");

    await result.asyncWork?.();

    expect(forkMnemosyne).toHaveBeenCalledTimes(1);
  });

  test("marks the last extracted turn stale when it was undone before exit", async () => {
    const transcript = writeTranscript([
      {
        role: "user",
        isSidechain: true,
        content: [{ type: "text", text: "Undone turn" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [{ type: "text", text: "Old response" }],
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, assistant_response, created_at_epoch
      ) VALUES (?, 1, 'extracted', 'Undone turn', 'Old response', 120)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => {});
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: mock(() => true) },
    });

    const result = await handler(
      createInput({
        transcriptPath: transcript.path,
      }),
    );

    expect(getTurn(db, sessionId, 1)?.status).toBe("extracting_stale");
    expect(typeof result.asyncWork).toBe("function");
    expect(forkMnemosyne).not.toHaveBeenCalled();

    await result.asyncWork?.();

    expect(forkMnemosyne).toHaveBeenCalledTimes(1);

    rmSync(transcript.directory, { recursive: true, force: true });
  });

  test("prefers content_prompt_id over positional matching when detecting undo", async () => {
    const transcript = writeTranscript([
      {
        type: "user",
        promptId: "real-1",
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
        promptId: "real-2",
        permissionMode: "default",
        isSidechain: true,
        message: {
          role: "user",
          content: "Second real prompt",
        },
      },
      {
        type: "assistant",
        isSidechain: true,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Second answer changed after undo" }],
        },
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        content_prompt_id,
        status,
        user_prompt,
        assistant_response,
        created_at_epoch
      ) VALUES (?, ?, ?, 'extracted', ?, ?, ?)`,
    ).run(
      sessionId,
      2,
      "real-2",
      "Second real prompt",
      "Old persisted answer",
      120,
    );

    const handler = createStopHandler({
      db,
      forkMnemosyne: mock(async () => {}),
      stderr: { write: mock(() => true) },
      now: () => 500,
    });

    const result = await handler(
      createInput({
        transcriptPath: transcript.path,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(getTurn(db, sessionId, 2)?.status).toBe("extracting_stale");

    rmSync(transcript.directory, { recursive: true, force: true });
  });

  test("recovered stalled turns are backfilled before they are claimed again", async () => {
    const transcript = writeTranscript([
      {
        role: "user",
        content: [{ type: "text", text: "Recovered pending turn" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "src/recovered.ts" },
          },
          { type: "text", text: "Recovered response" },
        ],
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        created_at_epoch,
        updated_at_epoch
      ) VALUES (?, 1, 'extracting_pending', 'Recovered pending turn', 120, 100)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => {});
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: mock(() => true) },
      now: () => 500,
    });

    const result = await handler(
      createInput({
        transcriptPath: transcript.path,
      }),
    );

    const recoveredTurn = getTurn(db, sessionId, 1);

    expect(typeof result.asyncWork).toBe("function");
    expect(recoveredTurn?.assistantResponse).toBe("Recovered response");
    expect(recoveredTurn?.toolCallCount).toBe(1);
    expect(recoveredTurn?.status).toBe("extracting_pending");
    expect(getPendingTurns(db, sessionId)).toEqual([]);

    await result.asyncWork?.();

    const prompt = String(forkMnemosyne.mock.calls[0]?.[0]?.prompt);
    expect(prompt).toContain('[T1] "Recovered pending turn"');
    expect(prompt).toContain("[pending]");

    rmSync(transcript.directory, { recursive: true, force: true });
  });

  test("parses the replay transcript once per stop event", async () => {
    const transcript = writeTranscript([
      {
        role: "user",
        content: [{ type: "text", text: "Investigate logs" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Replay-compatible response" }],
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', 'Investigate logs', 130)`,
    ).run(sessionId);

    const parseReplayTranscriptSpy = spyOn(
      transcriptParser,
      "parseReplayTranscript",
    );
    const handler = createStopHandler({
      db,
      forkMnemosyne: mock(async () => {}),
      stderr: { write: mock(() => true) },
    });

    await handler(
      createInput({
        transcriptPath: transcript.path,
      }),
    );

    expect(parseReplayTranscriptSpy).toHaveBeenCalledTimes(1);

    parseReplayTranscriptSpy.mockRestore();
    rmSync(transcript.directory, { recursive: true, force: true });
  });

  test("continues when the stop hook has no session id", async () => {
    const forkMnemosyne = mock(async () => {});
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: mock(() => true) },
    });

    const result = await handler(
      createInput({
        sessionId: undefined,
      }),
    );

    expect(result).toEqual({
      continue: true,
      exitCode: 0,
    });
    expect(forkMnemosyne).not.toHaveBeenCalled();
  });

  test("continues when the stop hook session cannot be found", async () => {
    const forkMnemosyne = mock(async () => {});
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: mock(() => true) },
    });

    const result = await handler(
      createInput({
        sessionId: "missing-session",
      }),
    );

    expect(result).toEqual({
      continue: true,
      exitCode: 0,
    });
    expect(forkMnemosyne).not.toHaveBeenCalled();
  });
});
