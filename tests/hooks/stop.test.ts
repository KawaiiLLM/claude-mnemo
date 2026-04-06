import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSessionByContentId, upsertSession } from "../../src/db/sessions";
import { getPendingTurns, getTurn } from "../../src/db/turns";
import { createStopHandler } from "../../src/hooks/handlers/stop";
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
      description: "Stop hook coverage",
      insight: null,
      startedAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("guards stop_hook_active to avoid infinite loops", async () => {
    const forkMnemosyne = mock(async () => {});
    const extractAssistantResponse = mock(() => "");
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      extractAssistantResponse,
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

  test("backfills all pending turns, marks undo as stale, and completes the session", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, assistant_response, title, created_at_epoch
      ) VALUES (?, 1, 'extracted', 'Diagnose auth', 'Old response', 'Diagnose auth', 120)`,
    ).run(sessionId);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 2, 'pending', 'Investigate logs', 130)`,
    ).run(sessionId);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 3, 'pending', 'Fix auth', 140)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => {});
    const extractAssistantResponse = mock((path: string, promptPrefix: string) => {
      if (promptPrefix === "Diagnose auth") {
        return "New response";
      }

      if (promptPrefix === "Investigate logs") {
        return `from transcript: ${path}`;
      }

      return "";
    });
    const stderrWrite = mock(() => true);
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      extractAssistantResponse,
      stderr: { write: stderrWrite },
      now: () => 500,
    });

    const result = await handler(
      createInput({
        transcriptPath: "/tmp/session.jsonl",
        lastAssistantMessage: "Final answer from stop hook",
      }),
    );

    const extractedTurn = getTurn(db, sessionId, 1)!;
    const secondPendingTurn = getTurn(db, sessionId, 2)!;
    const lastPendingTurn = getTurn(db, sessionId, 3)!;
    const session = getSessionByContentId(db, "session-stop")!;

    expect(result).toEqual({
      continue: true,
      exitCode: 0,
    });
    expect(extractedTurn.status).toBe("stale");
    expect(secondPendingTurn.assistantResponse).toBe("from transcript: /tmp/session.jsonl");
    expect(lastPendingTurn.assistantResponse).toBe("Final answer from stop hook");
    expect(getPendingTurns(db, sessionId).map((turn) => turn.promptNumber)).toEqual([
      1,
      2,
      3,
    ]);
    expect(forkMnemosyne).toHaveBeenCalledTimes(1);
    expect(forkMnemosyne.mock.calls[0]?.[0]?.prompt).toContain(
      '#1 [stale]: "Diagnose auth"',
    );
    expect(forkMnemosyne.mock.calls[0]?.[0]?.prompt).toContain(
      '#2 [pending]: "Investigate logs"',
    );
    expect(forkMnemosyne.mock.calls[0]?.[0]?.prompt).toContain(
      '#3 [pending]: "Fix auth"',
    );
    expect(extractAssistantResponse).toHaveBeenCalledWith(
      "/tmp/session.jsonl",
      "Investigate logs",
      2,
    );
    expect(extractAssistantResponse).toHaveBeenCalledWith(
      "/tmp/session.jsonl",
      "Diagnose auth",
      1,
    );
    expect(extractAssistantResponse).not.toHaveBeenCalledWith(
      "/tmp/session.jsonl",
      "Fix auth",
      3,
    );
    expect(session.completedAtEpoch).toBe(500);
    expect(stderrWrite).toHaveBeenCalled();
  });

  test("handles missing transcript by falling back without crashing", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', 'Only pending turn', 120)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => {});
    const extractAssistantResponse = mock(() => "");
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      extractAssistantResponse,
      stderr: { write: mock(() => true) },
    });

    const result = await handler(
      createInput({
        transcriptPath: "/tmp/missing.jsonl",
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(forkMnemosyne).toHaveBeenCalledTimes(1);
    expect(getTurn(db, sessionId, 1)?.assistantResponse).toBe("");
  });
});
