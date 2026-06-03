import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  getSession,
  getSessionByContentId,
  upsertSession,
} from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { queueItemExistsForTurn } from "../../src/db/pending-queue";
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

  test("updates the latest turn, enqueues a turn-stop task, and defers worker wake to asyncWork", async () => {
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

    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(typeof result.asyncWork).toBe("function");
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
    expect(fetchImpl).not.toHaveBeenCalled();

    await result.asyncWork?.();

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

    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(typeof result.asyncWork).toBe("function");
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
    expect(fetchImpl).not.toHaveBeenCalled();

    await result.asyncWork?.();

    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await Bun.$`rm -rf ${transcriptDirectory.trim()}`;
  });

  test("populates transcriptLineStart for the current turn from the transcript", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'active', 'Current prompt', 120)`,
    ).run(sessionId);

    const transcriptDirectory = await Bun.$`mktemp -d`.text();
    const transcriptPath = `${transcriptDirectory.trim()}/session.jsonl`;
    await Bun.write(
      transcriptPath,
      [
        JSON.stringify({
          uuid: "u0",
          type: "system",
          subtype: "turn_start",
          content: "preface",
        }),
        JSON.stringify({
          uuid: "u1",
          type: "user",
          promptId: "pid-current",
          permissionMode: "default",
          message: {
            role: "user",
            content: "Current prompt",
          },
        }),
        JSON.stringify({
          uuid: "u2",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Transcript answer" }],
          },
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
        lastAssistantMessage: "Hook answer",
      }),
    );

    expect(result.continue).toBe(true);
    expect(getTurn(db, sessionId, 1)?.assistantResponse).toBe("Hook answer");
    expect(getTurn(db, sessionId, 1)?.contentPromptId).toBe("pid-current");
    expect(getTurn(db, sessionId, 1)?.transcriptLineStart).toBe(2);

    await Bun.$`rm -rf ${transcriptDirectory.trim()}`;
  });

  test("populates safe replay fields for orphan turns during stop recovery without binding prompt ids", async () => {
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
          uuid: "u0",
          type: "user",
          promptId: "pid-1",
          permissionMode: "default",
          message: {
            role: "user",
            content: "First prompt",
          },
        }),
        JSON.stringify({
          uuid: "u1",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "First answer" }],
          },
        }),
        JSON.stringify({
          uuid: "u2",
          type: "user",
          promptId: "pid-2",
          permissionMode: "default",
          message: {
            role: "user",
            content: "Second prompt",
          },
        }),
        JSON.stringify({
          uuid: "u3",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Second answer" }],
          },
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

    expect(result.continue).toBe(true);
    expect(getTurn(db, sessionId, 1)?.assistantResponse).toBe("First answer");
    expect(getTurn(db, sessionId, 1)?.toolCallCount).toBe(0);
    expect(getTurn(db, sessionId, 1)?.contentPromptId).toBeNull();
    expect(getTurn(db, sessionId, 1)?.transcriptLineStart).toBe(1);
    expect(getTurn(db, sessionId, 2)?.contentPromptId).toBe("pid-2");
    expect(getTurn(db, sessionId, 2)?.transcriptLineStart).toBe(3);

    await Bun.$`rm -rf ${transcriptDirectory.trim()}`;
  });

  test("preserves transcriptLineStart on a repeated stop for the same turn", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'active', 'Repeat prompt', 120)`,
    ).run(sessionId);

    const transcriptDirectory = await Bun.$`mktemp -d`.text();
    const transcriptPath = `${transcriptDirectory.trim()}/session.jsonl`;
    await Bun.write(
      transcriptPath,
      [
        JSON.stringify({
          uuid: "u0",
          type: "user",
          promptId: "pid-repeat",
          permissionMode: "default",
          message: {
            role: "user",
            content: "Repeat prompt",
          },
        }),
        JSON.stringify({
          uuid: "u1",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Answer once" }],
          },
        }),
      ].join("\n"),
    );

    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createStopHandler({
      db,
      now: () => 500,
      workerClientDeps: { fetchImpl },
    });

    await handler(
      createInput({
        transcriptPath,
        lastAssistantMessage: "Answer once",
      }),
    );
    expect(getTurn(db, sessionId, 1)?.transcriptLineStart).toBe(1);

    await handler(
      createInput({
        transcriptPath,
        lastAssistantMessage: "Answer twice",
      }),
    );

    expect(getTurn(db, sessionId, 1)?.transcriptLineStart).toBe(1);

    await Bun.$`rm -rf ${transcriptDirectory.trim()}`;
  });

  test("matches repeated prompt text by promptNumber before reusing an existing contentPromptId", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, content_prompt_id, status, user_prompt, assistant_response, created_at_epoch, updated_at_epoch
      ) VALUES (?, 1, 'pid-first', 'extracted', '测试', 'First answer', 120, 120)`,
    ).run(sessionId);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 2, 'active', '测试', 121)`,
    ).run(sessionId);

    const transcriptDirectory = await Bun.$`mktemp -d`.text();
    const transcriptPath = `${transcriptDirectory.trim()}/session.jsonl`;
    await Bun.write(
      transcriptPath,
      [
        JSON.stringify({
          uuid: "u0",
          type: "user",
          promptId: "pid-first",
          permissionMode: "default",
          message: {
            role: "user",
            content: "测试",
          },
        }),
        JSON.stringify({
          uuid: "u1",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "First answer" }],
          },
        }),
        JSON.stringify({
          uuid: "u2",
          type: "user",
          promptId: "pid-second",
          permissionMode: "default",
          message: {
            role: "user",
            content: "测试",
          },
        }),
        JSON.stringify({
          uuid: "u3",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Second answer" }],
          },
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

    expect(result.continue).toBe(true);
    expect(getTurn(db, sessionId, 1)?.contentPromptId).toBe("pid-first");
    expect(getTurn(db, sessionId, 2)?.contentPromptId).toBe("pid-second");

    await Bun.$`rm -rf ${transcriptDirectory.trim()}`;
  });

  test("marks current sidechain turns undone and removes their pending queue work", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, content_prompt_id, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'p1', 'active', 'Draft approach', 120)`,
    ).run(sessionId);

    const transcriptDirectory = await Bun.$`mktemp -d`.text();
    const transcriptPath = `${transcriptDirectory.trim()}/session.jsonl`;
    await Bun.write(
      transcriptPath,
      [
        JSON.stringify({
          role: "user",
          promptId: "p1",
          permissionMode: "default",
          isSidechain: true,
          content: [{ type: "text", text: "Draft approach" }],
        }),
        JSON.stringify({
          role: "assistant",
          isSidechain: true,
          content: [{ type: "text", text: "Discarded branch" }],
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
        lastAssistantMessage: "Discarded branch",
      }),
    );

    const turn = getTurn(db, sessionId, 1)!;
    expect(turn.status).toBe("undone");
    expect(turn.tags).toContain("subagent:pending");
    expect(getPendingQueueRows(db)).toEqual([]);
    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(typeof result.asyncWork).toBe("function");
    expect(fetchImpl).not.toHaveBeenCalled();

    await result.asyncWork?.();

    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await Bun.$`rm -rf ${transcriptDirectory.trim()}`;
  });

  test("stop hook preserves extracted status for newly invalidated turns and schedules a reminder", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, content_prompt_id, status, user_prompt, assistant_response, title, created_at_epoch, updated_at_epoch
      ) VALUES
        (?, 1, 'p1', 'extracted', 'Interrupted prompt', 'Interrupted answer', 'Interrupted title', 120, 120),
        (?, 2, 'p2', 'active', 'Current prompt', NULL, NULL, 121, 121)`,
    ).run(sessionId, sessionId);

    const transcriptDirectory = await Bun.$`mktemp -d`.text();
    const transcriptPath = `${transcriptDirectory.trim()}/session.jsonl`;
    await Bun.write(
      transcriptPath,
      [
        JSON.stringify({
          uuid: "u1",
          type: "user",
          role: "user",
          promptId: "p1",
          permissionMode: "default",
          message: { role: "user", content: "Interrupted prompt" },
        }),
        JSON.stringify({
          uuid: "a1",
          type: "assistant",
          role: "assistant",
          parentUuid: "u1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Interrupted answer" }],
          },
        }),
        JSON.stringify({
          uuid: "i1",
          type: "user",
          role: "user",
          parentUuid: "a1",
          promptId: "p1",
          message: { role: "user", content: "[Request interrupted by user]" },
        }),
        JSON.stringify({
          uuid: "u2",
          type: "user",
          role: "user",
          promptId: "p2",
          permissionMode: "default",
          parentUuid: "a1",
          message: { role: "user", content: "Current prompt" },
        }),
        JSON.stringify({
          uuid: "a2",
          type: "assistant",
          role: "assistant",
          parentUuid: "u2",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Latest answer" }],
          },
        }),
      ].join("\n"),
    );

    const handler = createStopHandler({
      db,
      now: () => 500,
      workerClientDeps: {
        fetchImpl: mock(async () => new Response(null, { status: 200 })),
      },
    });

    await handler(
      createInput({
        transcriptPath,
        lastAssistantMessage: "Latest answer",
      }),
    );

    expect(getTurn(db, sessionId, 1)).toEqual(
      expect.objectContaining({
        status: "extracted",
        wasInterrupted: true,
        wasRolledBack: true,
        tags: [
          "invalidated:notify-pending:interrupt",
          "invalidated:notify-pending:rollback",
        ],
      }),
    );

    await Bun.$`rm -rf ${transcriptDirectory.trim()}`;
  });

  test("runs Step A (intra-session chain) on a Stop with no transcriptPath", async () => {
    // Two turns with NULL parent_turn_id; the later turn should be chained to
    // its predecessor even when the Stop carries no transcript (Step A must run
    // unconditionally, not only inside the if (transcriptPath) block).
    const first = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
          session_id, prompt_number, status, user_prompt, created_at_epoch
        ) VALUES (?, 1, 'active', 'First prompt', 120)
        RETURNING id`,
      )
      .get(sessionId)!.id;
    const second = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
          session_id, prompt_number, status, user_prompt, created_at_epoch
        ) VALUES (?, 2, 'active', 'Second prompt', 121)
        RETURNING id`,
      )
      .get(sessionId)!.id;

    const readParent = (turnId: number): number | null =>
      db
        .query<{ parentTurnId: number | null }, [number]>(
          `SELECT parent_turn_id AS parentTurnId FROM turns WHERE id = ?`,
        )
        .get(turnId)?.parentTurnId ?? null;

    expect(readParent(first)).toBeNull();
    expect(readParent(second)).toBeNull();

    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createStopHandler({
      db,
      now: () => 500,
      workerClientDeps: { fetchImpl },
    });

    // NO transcriptPath on this input.
    const result = await handler(createInput({ lastAssistantMessage: "done" }));

    expect(result.continue).toBe(true);
    expect(readParent(second)).toBe(first);
    expect(readParent(first)).toBeNull();
  });

  test("relinks lineage and recovers the parent's stranded tail on Stop", async () => {
    // Parent session owns the inherited prefix prompts pA, pB; pB is the fork
    // turn. The parent also has a stranded tail turn (phantom-extracted).
    const parentId = upsertSession(db, {
      contentSessionId: "parent-stop",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: null,
      insight: null,
      createdAtEpoch: 50,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    const seedParentTurn = db.query<
      { id: number },
      [number, number, string, string | null]
    >(
      `INSERT INTO turns (session_id, prompt_number, status, assistant_response, title, content, content_prompt_id, created_at_epoch)
       VALUES (?, ?, 'extracted', 'r', NULL, NULL, ?, 1000)
       RETURNING id`,
    );
    seedParentTurn.get(parentId, 14, "pA");
    seedParentTurn.get(parentId, 15, "pB");
    // Parent's stranded tail turn (no content_prompt_id needed; phantom).
    const parentStranded = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, assistant_response, title, content, created_at_epoch)
         VALUES (?, 16, 'extracted', 'r', NULL, NULL, 1000)
         RETURNING id`,
      )
      .get(parentId)!.id;

    // Child (the session-stop session) has its own first turn cC, active so the
    // Stop hook proceeds; the transcript overlaps the parent's pA, pB prefix.
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, content_prompt_id, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'cC', 'active', 'Child prompt', 120)`,
    ).run(sessionId);

    const transcriptDirectory = await Bun.$`mktemp -d`.text();
    const transcriptPath = `${transcriptDirectory.trim()}/session.jsonl`;
    await Bun.write(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          uuid: "pA",
          promptId: "pA",
          message: { role: "user", content: [{ type: "text", text: "pA" }] },
        }),
        JSON.stringify({
          type: "user",
          uuid: "pB",
          promptId: "pB",
          message: { role: "user", content: [{ type: "text", text: "pB" }] },
        }),
        JSON.stringify({
          type: "user",
          uuid: "cC",
          promptId: "cC",
          permissionMode: "default",
          message: { role: "user", content: [{ type: "text", text: "Child prompt" }] },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "ca",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Child answer" }],
          },
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
        lastAssistantMessage: "Child answer",
      }),
    );

    expect(result.continue).toBe(true);

    const child = getSession(db, sessionId)!;
    expect(child.parentSessionId).toBe(parentId);
    expect(child.lineageStatus).toBe("resolved");

    // The parent's stranded tail turn is re-enqueued for recovery.
    expect(queueItemExistsForTurn(db, "turn-stop", parentStranded)).toBe(true);

    await Bun.$`rm -rf ${transcriptDirectory.trim()}`;
  });
});
