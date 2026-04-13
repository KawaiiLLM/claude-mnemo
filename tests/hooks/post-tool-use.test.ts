import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
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
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe("http://127.0.0.1:37778/wake");
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
});
