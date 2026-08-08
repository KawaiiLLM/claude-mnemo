import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  getExtractableObservationsForTurn,
  hasSkippedObservationsForTurn,
} from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { createPostToolUseHandler } from "../../src/hooks/handlers/post-tool-use";
import type { NormalizedHookInput } from "../../src/hooks/types";

function createInput(
  overrides: Partial<NormalizedHookInput> = {},
): NormalizedHookInput {
  return {
    eventName: "PostToolUse",
    sessionId: "session-tool",
    cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    toolName: "Read",
    toolInput: { file_path: "src/auth.ts" },
    toolResponse: "line 1\n<private>secret</private>\nline 2",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

function getQueueRows(db: Database): Array<{
  kind: string;
  targetId: number;
  sessionDbId: number;
}> {
  return db
    .query<
      { kind: string; targetId: number; sessionDbId: number },
      []
    >(
      `
        SELECT
          kind,
          target_id AS targetId,
          session_db_id AS sessionDbId
        FROM pending_queue
        ORDER BY seq ASC
      `,
    )
    .all();
}

describe("handlePostToolUseHook", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "session-tool",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Tool session",
      content: "Current summary",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;

    const inserted = db
      .query<{ id: number }, [number]>(
        `
          INSERT INTO turns (
            session_id,
            prompt_number,
            status,
            user_prompt,
            created_at_epoch
          ) VALUES (?, 1, 'active', 'Inspect auth flow', 120)
          RETURNING id
        `,
      )
      .get(sessionId);

    turnId = inserted!.id;
  });

  afterEach(() => {
    db.close();
  });

  test("inserts an observation, enqueues it, and defers worker wake to asyncWork", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createPostToolUseHandler({
      db,
      now: () => 500,
      workerClientDeps: { fetchImpl },
      workerEnv: {},
    });

    const result = await handler(createInput());

    const observation = db
      .query<
        {
          id: number;
          turnId: number;
          toolName: string | null;
          toolInput: string | null;
          toolResult: string | null;
          status: string;
        },
        []
      >(
        `
          SELECT
            id,
            turn_id AS turnId,
            tool_name AS toolName,
            tool_input AS toolInput,
            tool_result AS toolResult,
            status,
            title
          FROM observations
        `,
      )
      .get()!;

    expect(result.continue).toBe(true);
    expect(typeof result.asyncWork).toBe("function");
    expect(observation.turnId).toBe(turnId);
    expect(observation.toolName).toBe("Read");
    expect(observation.toolInput).toBe('{"file_path":"src/auth.ts"}');
    expect(observation.toolResult).toBe("line 1\n\nline 2");
    expect(observation.status).toBe("pending");
    expect(observation.title).toBeNull();
    expect(getQueueRows(db)).toEqual([
      {
        kind: "obs",
        targetId: observation.id,
        sessionDbId: sessionId,
      },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();

    await result.asyncWork?.();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:37778/health");
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe("http://127.0.0.1:37778/trigger");
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      action: "wake",
      content_session_id: "session-tool",
      session_id: sessionId,
      env: {},
    });
  });

  test("runs foreground writes through the bounded hook transaction runner", async () => {
    const transactionRunner = mock((runnerDb: Database, fn: () => unknown) => {
      expect(runnerDb).toBe(db);
      return fn();
    });
    const handler = createPostToolUseHandler({
      db,
      now: () => 500,
      runHookWriteTransaction: transactionRunner,
    });

    await handler(createInput());

    expect(transactionRunner).toHaveBeenCalledTimes(1);
  });

  test("rechecks live ownership inside the same transaction as insertion", async () => {
    const transactionRunner = mock((_runnerDb: Database, fn: () => unknown) => {
      db.query("UPDATE turns SET status = 'extracted' WHERE id = ?").run(turnId);
      return fn();
    });
    const handler = createPostToolUseHandler({
      db,
      runHookWriteTransaction: transactionRunner,
      logger: { warn() {} },
    });

    const result = await handler(createInput());

    expect(result).toEqual({ continue: true });
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM observations",
    ).get()?.count).toBe(0);
  });

  test("continues without writing when session or turn context is missing", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createPostToolUseHandler({
      db,
      workerClientDeps: { fetchImpl },
    });

    const missingSession = await handler(
      createInput({
        sessionId: "missing-session",
      }),
    );

    db.query("DELETE FROM turns WHERE session_id = ?").run(sessionId);

    const missingTurn = await handler(createInput());

    expect(missingSession).toEqual({ continue: true });
    expect(missingTurn).toEqual({ continue: true });
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM observations").get()
        ?.count,
    ).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("ignores child-agent events before database writes or worker wake", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const transactionRunner = mock((_db: Database, fn: () => unknown) => fn());
    const handler = createPostToolUseHandler({
      db,
      workerClientDeps: { fetchImpl },
      runHookWriteTransaction: transactionRunner,
    });

    const result = await handler(createInput({ agentId: "child-agent-7" }));

    expect(result).toEqual({ continue: true });
    expect(transactionRunner).not.toHaveBeenCalled();
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM observations").get()?.count).toBe(0);
    expect(getQueueRows(db)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  for (const status of ["extracted", "skipped", "failed", "undone"] as const) {
    test(`ignores root events when the latest turn is ${status}`, async () => {
      db.query("UPDATE turns SET status = ? WHERE id = ?").run(status, turnId);
      const handler = createPostToolUseHandler({ db });

      const result = await handler(createInput());

      expect(result).toEqual({ continue: true });
      expect(db.query<{ status: string }, [number]>("SELECT status FROM turns WHERE id = ?").get(turnId)?.status).toBe(status);
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM observations").get()?.count).toBe(0);
    });
  }

  for (const status of ["active", "provisional"] as const) {
    test(`attaches root events to the latest ${status} turn`, async () => {
      db.query("UPDATE turns SET status = ? WHERE id = ?").run(status, turnId);
      const handler = createPostToolUseHandler({ db });

      const result = await handler(createInput({ toolName: "SendMessage" }));

      expect(typeof result.asyncWork).toBe("function");
      expect(db.query<{ turnId: number; toolName: string }, []>(
        "SELECT turn_id AS turnId, tool_name AS toolName FROM observations",
      ).get()).toEqual({ turnId, toolName: "SendMessage" });
    });
  }

  for (const toolName of ["Agent", "Bash", "SendMessage"] as const) {
    test(`records a top-level ${toolName} launch without agentId`, async () => {
      const handler = createPostToolUseHandler({ db });

      await handler(createInput({ toolName }));

      expect(db.query<{ toolName: string }, []>(
        "SELECT tool_name AS toolName FROM observations",
      ).get()?.toolName).toBe(toolName);
    });
  }

  // Both mount shapes: a plain `.mcp.json` server and a plugin-scoped one.
  for (const toolName of [
    "mcp__mnemo__note",
    "mcp__plugin_claude-mnemo_mnemo__note",
  ] as const) {
    test(`captures ${toolName} but keeps it out of the extraction input stream`, async () => {
      const handler = createPostToolUseHandler({ db, now: () => 500 });

      const result = await handler(
        createInput({
          toolName,
          toolInput: { turn: "S1/T1", title: "t", content: "c" },
          toolResponse: "Noted S1/T1.",
        }),
      );

      const observation = db
        .query<{ id: number; excluded: number; status: string }, []>(
          `SELECT id, excluded_from_extraction AS excluded, status FROM observations`,
        )
        .get()!;

      // Captured for the raw axis…
      expect(observation.excluded).toBe(1);
      // …but never handed to the pipeline: no queue item means the extraction
      // agent never sees the note call as a tool result to summarise.
      expect(getQueueRows(db)).toEqual([]);
      expect(getExtractableObservationsForTurn(db, turnId)).toEqual([]);
      expect(result).toEqual({ continue: true });
    });
  }

  test("a note observation cannot forge the already-delivered signal", async () => {
    const handler = createPostToolUseHandler({ db, now: () => 500 });
    await handler(createInput({ toolName: "mcp__mnemo__note" }));

    // Terminal finalizers retire every *pending* observation wholesale.
    db.query("UPDATE observations SET status = 'skipped' WHERE status = 'pending'").run();

    expect(hasSkippedObservationsForTurn(db, turnId)).toBe(false);
  });

  test("keeps capturing and enqueuing the other mnemo tools unchanged", async () => {
    const handler = createPostToolUseHandler({ db, now: () => 500 });

    await handler(createInput({ toolName: "mcp__mnemo__recall" }));

    const observation = db
      .query<{ id: number; excluded: number }, []>(
        "SELECT id, excluded_from_extraction AS excluded FROM observations",
      )
      .get()!;
    expect(observation.excluded).toBe(0);
    expect(getQueueRows(db)).toEqual([
      { kind: "obs", targetId: observation.id, sessionDbId: sessionId },
    ]);
  });
});
