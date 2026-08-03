import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation } from "../../src/db/observations";
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

  test("finalizes an interrupted final turn and retires its pending observations before flushing", async () => {
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
    const observation = createObservation(db, {
      turnId,
      toolName: "Read",
      toolInput: "{}",
      toolResult: "partial result",
      createdAtEpoch: 202,
    });
    db.query(
      `INSERT INTO pending_queue (
         kind, target_id, session_db_id, enqueued_at_epoch
       ) VALUES ('obs', ?, ?, 202)`,
    ).run(observation.id, sessionId);
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

    const turn = db
      .query<{ status: string; updatedAtEpoch: number | null }, [number]>(
        `SELECT status, updated_at_epoch AS updatedAtEpoch
         FROM turns WHERE id = ?`,
      )
      .get(turnId);
    expect(turn).toEqual({ status: "skipped", updatedAtEpoch: 300 });
    expect(
      db
        .query<{ status: string }, [number]>(
          "SELECT status FROM observations WHERE id = ?",
        )
        .get(observation.id)?.status,
    ).toBe("skipped");
    expect(
      db
        .query<{ count: number }, [number, number]>(
          `SELECT COUNT(*) AS count FROM pending_queue
           WHERE (kind = 'turn-stop' AND target_id = ?)
              OR (kind = 'obs' AND target_id IN (
                SELECT id FROM observations WHERE turn_id = ?
              ))`,
        )
        .get(turnId, turnId)?.count,
    ).toBe(0);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://127.0.0.1:37778/trigger");
  });

  test("preserves partial orphan content by finalizing the turn as extracted", async () => {
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
         session_id, prompt_number, status, user_prompt, title,
         created_at_epoch
       ) VALUES (?, 1, 'active', 'interrupted prompt', 'Partial title', 201)`,
    ).run(sessionId);
    const turnId = db
      .query<{ id: number }, []>(`SELECT id FROM turns ORDER BY id DESC LIMIT 1`)
      .get()!.id;
    const handler = createSessionEndHandler({
      db,
      now: () => 300,
    });

    await handler(createInput());

    expect(
      db
        .query<{ status: string }, [number]>(
          "SELECT status FROM turns WHERE id = ?",
        )
        .get(turnId)?.status,
    ).toBe("extracted");
    expect(
      db
        .query<{ count: number }, [number]>(
          `SELECT COUNT(*) AS count FROM pending_queue
           WHERE kind = 'turn-stop' AND target_id = ?`,
        )
        .get(turnId)?.count,
    ).toBe(0);
  });

  test("leaves a turn whose turn-stop is already queued for extraction", async () => {
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
       ) VALUES (?, 1, 'active', 'interrupted prompt', 201)`,
    ).run(sessionId);
    const turnId = db
      .query<{ id: number }, []>(`SELECT id FROM turns ORDER BY id DESC LIMIT 1`)
      .get()!.id;
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('turn-stop', ?, ?, 202)`,
    ).run(turnId, sessionId);
    const handler = createSessionEndHandler({
      db,
      now: () => 300,
    });

    await handler(createInput());

    expect(
      db
        .query<{ status: string }, [number]>(
          "SELECT status FROM turns WHERE id = ?",
        )
        .get(turnId)?.status,
    ).toBe("active");
    expect(
      db
        .query<{ count: number }, [number]>(
          `SELECT COUNT(*) AS count FROM pending_queue
           WHERE kind = 'turn-stop' AND target_id = ?`,
        )
        .get(turnId)?.count,
    ).toBe(1);
  });

  test("leaves a completed-response turn and all of its queue items untouched", async () => {
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
         session_id, prompt_number, status, user_prompt,
         assistant_response, created_at_epoch
       ) VALUES (?, 1, 'active', 'normal prompt', 'completed response', 201)`,
    ).run(sessionId);
    const turnId = db
      .query<{ id: number }, []>(`SELECT id FROM turns ORDER BY id DESC LIMIT 1`)
      .get()!.id;
    const observation = createObservation(db, {
      turnId,
      toolName: "Read",
      toolInput: "{}",
      toolResult: "result",
      createdAtEpoch: 202,
    });
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('turn-stop', ?, ?, 202), ('obs', ?, ?, 203)`,
    ).run(turnId, sessionId, observation.id, sessionId);
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

    expect(
      db
        .query<{ status: string; updatedAtEpoch: number | null }, [number]>(
          `SELECT status, updated_at_epoch AS updatedAtEpoch
           FROM turns WHERE id = ?`,
        )
        .get(turnId),
    ).toEqual({ status: "active", updatedAtEpoch: null });
    expect(
      db
        .query<{ status: string }, [number]>(
          "SELECT status FROM observations WHERE id = ?",
        )
        .get(observation.id)?.status,
    ).toBe("pending");
    expect(
      db
        .query<{ kind: string; targetId: number }, [number, number]>(
          `SELECT kind, target_id AS targetId FROM pending_queue
           WHERE (kind = 'turn-stop' AND target_id = ?)
              OR (kind = 'obs' AND target_id = ?)
           ORDER BY seq`,
        )
        .all(turnId, observation.id),
    ).toEqual([
      { kind: "turn-stop", targetId: turnId },
      { kind: "obs", targetId: observation.id },
    ]);
  });

  test("a glance leaves an older run's orphan turn untouched", async () => {
    // Orphan left by a PREVIOUS run: inserted before this run's SessionStart
    // boundary, so the glance gate must keep SessionEnd fully silent.
    db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, created_at_epoch
       ) VALUES (?, 1, 'active', 'old interrupted prompt', 90)`,
    ).run(sessionId);
    const turnId = db
      .query<{ id: number }, []>(`SELECT id FROM turns ORDER BY id DESC LIMIT 1`)
      .get()!.id;
    const observation = createObservation(db, {
      turnId,
      toolName: "Read",
      toolInput: "{}",
      toolResult: "old result",
      createdAtEpoch: 91,
    });
    db.query(
      `INSERT INTO pending_queue (
         kind, target_id, session_db_id, enqueued_at_epoch
       ) VALUES ('obs', ?, ?, 91)`,
    ).run(observation.id, sessionId);
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
    expect(
      db
        .query<{ status: string; updatedAtEpoch: number | null }, [number]>(
          `SELECT status, updated_at_epoch AS updatedAtEpoch
           FROM turns WHERE id = ?`,
        )
        .get(turnId),
    ).toEqual({ status: "active", updatedAtEpoch: null });
    expect(
      db
        .query<{ status: string }, [number]>(
          "SELECT status FROM observations WHERE id = ?",
        )
        .get(observation.id)?.status,
    ).toBe("pending");
    expect(
      db
        .query<{ kind: string; targetId: number }, []>(
          "SELECT kind, target_id AS targetId FROM pending_queue ORDER BY seq",
        )
        .all(),
    ).toEqual([{ kind: "obs", targetId: observation.id }]);
  });

  // Settlement tail gate (spec §A). The two conditions are the SAME pre-repair
  // activity snapshot the orphan pass uses, and a terminal count past the last
  // successfully settled boundary. Enqueue only — the settle runs in the worker.
  function seedTerminalTurns(count: number, fromEpoch = 201): void {
    for (let promptNumber = 1; promptNumber <= count; promptNumber += 1) {
      db.query(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, title, created_at_epoch
         ) VALUES (?, ?, 'extracted', 'p', 't', ?)`,
      ).run(sessionId, promptNumber, fromEpoch + promptNumber);
    }
  }

  async function startRun(): Promise<void> {
    await createContextHandler({ db, nowEpoch: () => 200 })(
      createInput({ eventName: "SessionStart", source: "resume" }),
    );
  }

  test("enqueues a tail settlement job when the run had activity", async () => {
    await startRun();
    seedTerminalTurns(37);
    const handler = createSessionEndHandler({
      db,
      workerClientDeps: { fetchImpl: mock(async () => new Response(null, { status: 200 })) },
    });

    await handler(createInput());

    expect(
      db
        .query<{ boundary: number; status: string; members: string }, []>(
          `SELECT boundary, status, frozen_member_ids AS members
           FROM settlement_jobs`,
        )
        .all(),
    ).toEqual([
      {
        boundary: 37,
        status: "pending",
        members: JSON.stringify(
          db
            .query<{ id: number }, []>(
              "SELECT id FROM turns ORDER BY prompt_number ASC",
            )
            .all()
            .map((row) => row.id),
        ),
      },
    ]);
  });

  test("the tail job's frozen cohort includes an orphan this SessionEnd just skipped", async () => {
    await startRun();
    seedTerminalTurns(37);
    // Still `active` when the session exits. The orphan pass finalizes it to
    // `skipped`, which makes it the 38th TERMINAL turn — and the tail gate reads
    // the terminal population, so enqueueing before that repair froze a cohort
    // one short and set a boundary no later event would ever cross again.
    const orphan = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, created_at_epoch
         ) VALUES (?, 38, 'active', 'interrupted', ?)
         RETURNING id`,
      )
      .get(sessionId, 300)!.id;

    const handler = createSessionEndHandler({
      db,
      workerClientDeps: { fetchImpl: mock(async () => new Response(null, { status: 200 })) },
    });

    await handler(createInput());

    expect(
      db
        .query<{ status: string }, [number]>(
          "SELECT status FROM turns WHERE id = ?",
        )
        .get(orphan)?.status,
    ).toBe("skipped");
    const job = db
      .query<{ boundary: number; members: string }, []>(
        `SELECT boundary, frozen_member_ids AS members FROM settlement_jobs`,
      )
      .get()!;
    expect(job.boundary).toBe(38);
    expect(JSON.parse(job.members)).toContain(orphan);
  });

  test("a glance with no new turn enqueues no tail settlement job", async () => {
    // Turns from a PREVIOUS run: the pre-repair activity snapshot is false, so
    // a bare resume glance must not spend an inference re-grading them.
    seedTerminalTurns(37, 90);
    await startRun();
    const handler = createSessionEndHandler({
      db,
      workerClientDeps: { fetchImpl: mock(async () => new Response(null, { status: 200 })) },
    });

    await handler(createInput());

    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM settlement_jobs",
      ).get()!.count,
    ).toBe(0);
  });

  test("a tail job is not enqueued when the cursor already covers every turn", async () => {
    await startRun();
    seedTerminalTurns(37);
    db.query(
      `INSERT INTO settlement_cursors (session_id, last_settled_boundary, updated_at_epoch)
       VALUES (?, 37, 1)`,
    ).run(sessionId);
    const handler = createSessionEndHandler({
      db,
      workerClientDeps: { fetchImpl: mock(async () => new Response(null, { status: 200 })) },
    });

    await handler(createInput());

    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM settlement_jobs",
      ).get()!.count,
    ).toBe(0);
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
