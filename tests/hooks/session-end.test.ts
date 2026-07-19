import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { createContextHandler } from "../../src/hooks/handlers/context";
import { createSessionEndHandler } from "../../src/hooks/handlers/session-end";
import type { NormalizedHookInput } from "../../src/hooks/types";
import { BUILD_ID } from "../../src/shared/build-id";

function createInput(
  overrides: Partial<NormalizedHookInput> = {},
): NormalizedHookInput {
  return {
    eventName: "SessionEnd",
    sessionId: "session-end-1",
    cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

describe("handleSessionEndHook", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "session-end-1",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("returns asyncWork and defers worker flush for the resolved session", async () => {
    await createContextHandler({
      db,
      nowEpoch: () => 200,
    })(
      createInput({
        eventName: "SessionStart",
        source: "resume",
      }),
    );
    db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, created_at_epoch
       ) VALUES (?, 1, 'active', 'new prompt', 201)`,
    ).run(sessionId);
    await createContextHandler({ db })(
      createInput({
        eventName: "SessionStart",
        source: "compact",
      }),
    );
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, buildId: BUILD_ID }), {
          status: 200,
        });
      }
      return new Response(null, { status: 200 });
    });
    const handler = createSessionEndHandler({
      db,
      workerClientDeps: { fetchImpl },
      workerEnv: { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    });

    const result = await handler(createInput());

    expect(result.continue).toBe(true);
    expect(typeof result.asyncWork).toBe("function");
    expect(fetchImpl).not.toHaveBeenCalled();

    await result.asyncWork?.();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:37778/health");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://127.0.0.1:37778/trigger");
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      action: "finish",
      content_session_id: "session-end-1",
      session_id: sessionId,
      env: {},
    });
  });

  test("a resume glance with no new turn does not contact or spawn the worker", async () => {
    db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt,
         assistant_response, created_at_epoch
       ) VALUES (?, 1, 'extracted', 'prior prompt', 'prior response', 90)`,
    ).run(sessionId);
    await createContextHandler({
      db,
      nowEpoch: () => 200,
    })(
      createInput({
        eventName: "SessionStart",
        source: "resume",
      }),
    );
    const fetchImpl = mock(async () => {
      throw new Error("worker is down");
    });
    const spawnImpl = mock(() => ({ unref() {} }));
    const handler = createSessionEndHandler({
      db,
      workerClientDeps: {
        fetchImpl,
        spawnImpl: spawnImpl as never,
        existsSyncImpl: () => true,
      },
    });

    const result = await handler(createInput());

    expect(result.continue).toBe(true);
    expect(typeof result.asyncWork).toBe("function");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test("enqueues a turn-stop for an interrupted final turn before flushing", async () => {
    await createContextHandler({
      db,
      nowEpoch: () => 200,
    })(
      createInput({
        eventName: "SessionStart",
        source: "resume",
      }),
    );
    // Interrupted turn: active, no assistant_response, and — because the Stop
    // hook never fired — no pending turn-stop.
    db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, created_at_epoch
       ) VALUES (?, 1, 'active', 'interrupted prompt', 201)`,
    ).run(sessionId);
    const turnId = db
      .query<{ id: number }, []>(`SELECT id FROM turns ORDER BY id DESC LIMIT 1`)
      .get()!.id;
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, buildId: BUILD_ID }), {
          status: 200,
        });
      }
      return new Response(null, { status: 200 });
    });
    const handler = createSessionEndHandler({
      db,
      now: () => 300,
      workerClientDeps: { fetchImpl },
      workerEnv: { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    });

    const result = await handler(createInput());
    await result.asyncWork?.();

    const queued = db
      .query<{ kind: string; targetId: number; enqueuedAtEpoch: number }, []>(
        `SELECT kind, target_id AS targetId, enqueued_at_epoch AS enqueuedAtEpoch
         FROM pending_queue WHERE kind = 'turn-stop'`,
      )
      .all();
    expect(queued).toEqual([
      { kind: "turn-stop", targetId: turnId, enqueuedAtEpoch: 300 },
    ]);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://127.0.0.1:37778/trigger");
  });

  test("does not duplicate a turn-stop that the Stop hook already queued", async () => {
    await createContextHandler({
      db,
      nowEpoch: () => 200,
    })(
      createInput({
        eventName: "SessionStart",
        source: "resume",
      }),
    );
    db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, created_at_epoch
       ) VALUES (?, 1, 'active', 'normal prompt', 201)`,
    ).run(sessionId);
    const turnId = db
      .query<{ id: number }, []>(`SELECT id FROM turns ORDER BY id DESC LIMIT 1`)
      .get()!.id;
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('turn-stop', ?, ?, 202)`,
    ).run(turnId, sessionId);
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, buildId: BUILD_ID }), {
          status: 200,
        });
      }
      return new Response(null, { status: 200 });
    });
    const handler = createSessionEndHandler({
      db,
      now: () => 300,
      workerClientDeps: { fetchImpl },
      workerEnv: { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    });

    const result = await handler(createInput());
    await result.asyncWork?.();

    const count = db
      .query<{ n: number }, [number]>(
        `SELECT COUNT(*) AS n FROM pending_queue
         WHERE kind = 'turn-stop' AND target_id = ?`,
      )
      .get(turnId)!.n;
    expect(count).toBe(1);
  });

  test("a glance leaves an older run's orphan turn untouched", async () => {
    // Orphan left by a PREVIOUS run: inserted before this run's SessionStart
    // boundary, so the glance gate must keep SessionEnd fully silent.
    db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, created_at_epoch
       ) VALUES (?, 1, 'active', 'old interrupted prompt', 90)`,
    ).run(sessionId);
    await createContextHandler({
      db,
      nowEpoch: () => 200,
    })(
      createInput({
        eventName: "SessionStart",
        source: "resume",
      }),
    );
    const fetchImpl = mock(async () => {
      throw new Error("worker is down");
    });
    const handler = createSessionEndHandler({
      db,
      workerClientDeps: { fetchImpl },
    });

    const result = await handler(createInput());

    expect(result.continue).toBe(true);
    expect(typeof result.asyncWork).toBe("function");
    expect(fetchImpl).not.toHaveBeenCalled();
    const count = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM pending_queue WHERE kind = 'turn-stop'`,
      )
      .get()!.n;
    expect(count).toBe(0);
  });

  test("does nothing when the content session is unknown", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createSessionEndHandler({
      db,
      workerClientDeps: { fetchImpl },
    });

    const result = await handler(
      createInput({
        sessionId: "missing-session",
      }),
    );

    expect(result.continue).toBe(true);
    expect(typeof result.asyncWork).toBe("function");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
