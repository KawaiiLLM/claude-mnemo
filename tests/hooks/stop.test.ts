import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSessionByContentId, upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
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

function getPendingQueueRows(db: Database): Array<{
  seq: number;
  kind: string;
  targetId: number;
  sessionDbId: number;
}> {
  return db
    .query<
      { seq: number; kind: string; targetId: number; sessionDbId: number },
      []
    >(
      `
        SELECT
          seq,
          kind,
          target_id AS targetId,
          session_db_id AS sessionDbId
        FROM pending_queue
        ORDER BY seq ASC
      `,
    )
    .all();
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
    const notifyWorkerWake = mock(async () => {});
    const handler = createStopHandler({
      db,
      workerClientDeps: { fetchImpl: notifyWorkerWake as unknown as typeof fetch },
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
    expect(getPendingQueueRows(db)).toEqual([]);
  });

  test("updates the latest turn, enqueues a turn-stop task, and notifies the worker", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'active', 'Pending work', 120)`,
    ).run(sessionId);

    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createStopHandler({
      db,
      now: () => 500,
      workerClientDeps: { fetchImpl },
    });

    const result = await handler(
      createInput({
        lastAssistantMessage: "Done <private>secret</private>",
      }),
    );

    const turn = getTurn(db, sessionId, 1)!;
    const queueRows = getPendingQueueRows(db);
    const session = getSessionByContentId(db, "session-stop")!;

    expect(result).toEqual({
      continue: true,
      exitCode: 0,
    });
    expect(turn.assistantResponse).toBe("Done ");
    expect(turn.status).toBe("active");
    expect(queueRows).toEqual([
      {
        seq: 1,
        kind: "turn-stop",
        targetId: turn.id,
        sessionDbId: sessionId,
      },
    ]);
    expect(session.updatedAtEpoch).toBe(500);
    expect(session.completedAtEpoch).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:37778/health");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://127.0.0.1:37778/wake");
  });

  test("does not enqueue the same turn-stop task twice for the current turn", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'active', 'Pending work', 120)`,
    ).run(sessionId);

    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createStopHandler({
      db,
      now: () => 500,
      workerClientDeps: { fetchImpl },
    });

    await handler(
      createInput({
        lastAssistantMessage: "Done once",
      }),
    );
    await handler(
      createInput({
        lastAssistantMessage: "Done twice",
      }),
    );

    const turn = getTurn(db, sessionId, 1)!;
    expect(getPendingQueueRows(db)).toEqual([
      {
        seq: 1,
        kind: "turn-stop",
        targetId: turn.id,
        sessionDbId: sessionId,
      },
    ]);
  });

  test("does nothing when the session has no turns", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createStopHandler({
      db,
      workerClientDeps: { fetchImpl },
    });

    const result = await handler(createInput());

    expect(result).toEqual({
      continue: true,
      exitCode: 0,
    });
    expect(getPendingQueueRows(db)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("continues when the stop hook session cannot be found", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createStopHandler({
      db,
      workerClientDeps: { fetchImpl },
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
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("recovers orphan active turns before enqueueing the current turn-stop task", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'active', 'First prompt', 120)`,
    ).run(sessionId);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 2, 'active', 'Second prompt', 121)`,
    ).run(sessionId);

    const transcriptDirectory = await Bun.$`mktemp -d`.text();
    const transcriptPath = `${transcriptDirectory.trim()}/session.jsonl`;
    await Bun.write(
      transcriptPath,
      [
        JSON.stringify({
          role: "user",
          content: [{ type: "text", text: "First prompt" }],
        }),
        JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "First answer" }],
        }),
        JSON.stringify({
          role: "user",
          content: [{ type: "text", text: "Second prompt" }],
        }),
        JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "Second answer" }],
        }),
      ].join("\n"),
    );

    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createStopHandler({
      db,
      now: () => 500,
      workerClientDeps: { fetchImpl },
    });

    const result = await handler(
      createInput({
        transcriptPath,
        lastAssistantMessage: "Second answer",
      }),
    );

    expect(result).toEqual({
      continue: true,
      exitCode: 0,
    });
    expect(getTurn(db, sessionId, 1)?.assistantResponse).toBe("First answer");
    expect(getTurn(db, sessionId, 2)?.assistantResponse).toBe("Second answer");
    expect(getPendingQueueRows(db)).toEqual([
      {
        seq: 1,
        kind: "turn-stop",
        targetId: getTurn(db, sessionId, 1)!.id,
        sessionDbId: sessionId,
      },
      {
        seq: 2,
        kind: "turn-stop",
        targetId: getTurn(db, sessionId, 2)!.id,
        sessionDbId: sessionId,
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await Bun.$`rm -rf ${transcriptDirectory.trim()}`;
  });
});
