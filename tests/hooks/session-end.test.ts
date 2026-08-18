import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation } from "../../src/db/observations";
import {
  getNoteSettlementCursor,
  listNoteSettlementJobs,
  NOTE_SETTLEMENT_MIN_WINDOW_TURNS,
} from "../../src/db/note-settlement";
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

/**
 * The sessionend settlement boundary (spec note-prompt-clock D7, ticket 05):
 * the hook freezes and enqueues its own window SYNCHRONOUSLY, before the
 * async worker flush is ever notified — the async half only ever leaks
 * whatever is already due, never plans anything of its own. These tests
 * assert directly on `note_settlement_jobs`, deliberately bypassing the async
 * flush entirely, so a passing assertion can only be explained by the hook's
 * own write transaction.
 */
describe("handleSessionEndHook — note settlement boundary", () => {
  let db: Database;
  let sessionId: number;
  const ERA_CUTOFF_EPOCH = 1;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "session-boundary-1",
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

  function seedTurns(from: number, count: number, createdAtEpoch = 200): void {
    for (let promptNumber = from; promptNumber < from + count; promptNumber += 1) {
      db.query(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, ?, 'active', 'p', 'r', ?)`,
      ).run(sessionId, promptNumber, createdAtEpoch);
    }
  }

  test("a tail under the 20-turn floor opens NO window — the sessionend exemption is dead (ticket 05)", async () => {
    seedTurns(1, 7);
    const handler = createSessionEndHandler({
      db,
      eraCutoffEpoch: ERA_CUTOFF_EPOCH,
      settlementEnabled: true,
    });

    await handler(createInput({ sessionId: "session-boundary-1" }));

    // Well under NOTE_SETTLEMENT_MIN_WINDOW_TURNS — ticket 05 kills the old
    // "sessionend is exempt from the floor" carve-out, so this tail leaves
    // no trace at all; it waits to accumulate into a later window.
    expect(7).toBeLessThan(NOTE_SETTLEMENT_MIN_WINDOW_TURNS);
    const jobs = listNoteSettlementJobs(db, sessionId);
    expect(jobs).toHaveLength(0);
  });

  test("a repeat SessionEnd with no new activity is idempotent", async () => {
    // Over the floor (ticket 05: sessionend is no longer exempt), so this
    // still exercises a REAL window's idempotency, not merely "nothing
    // happened three times".
    seedTurns(1, 22);
    const handler = createSessionEndHandler({
      db,
      eraCutoffEpoch: ERA_CUTOFF_EPOCH,
      settlementEnabled: true,
    });

    await handler(createInput({ sessionId: "session-boundary-1" }));
    await handler(createInput({ sessionId: "session-boundary-1" }));
    await handler(createInput({ sessionId: "session-boundary-1" }));

    const jobs = listNoteSettlementJobs(db, sessionId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.windowStart).toBe(1);
    expect(jobs[0]!.windowEnd).toBe(22);
  });

  test("end then resume with new turns opens a SECOND window; the first job is untouched", async () => {
    // Both phases over the floor (ticket 05: sessionend is no longer
    // exempt), so each end event genuinely opens its own window.
    seedTurns(1, 22);
    const handler = createSessionEndHandler({
      db,
      eraCutoffEpoch: ERA_CUTOFF_EPOCH,
      settlementEnabled: true,
    });

    await handler(createInput({ sessionId: "session-boundary-1" }));
    const firstJob = listNoteSettlementJobs(db, sessionId)[0]!;

    // Resume is a normal shape (spec D7): new turns belong to the NEXT window.
    seedTurns(23, 20);
    await handler(createInput({ sessionId: "session-boundary-1" }));

    const jobs = listNoteSettlementJobs(db, sessionId);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.id).toBe(firstJob.id);
    expect(jobs[0]!.windowStart).toBe(1);
    expect(jobs[0]!.windowEnd).toBe(22);
    expect(jobs[0]!.status).toBe("pending"); // untouched by the second end event
    expect(jobs[1]!.windowStart).toBe(23);
    expect(jobs[1]!.windowEnd).toBe(42);
    expect(jobs[1]!.triggerType).toBe("sessionend");
  });

  test("an inert install (no era) writes no boundary and no job", async () => {
    seedTurns(1, 5);
    // No eraCutoffEpoch override: resolves via resolveEraCutoff(db), which is
    // null on a fresh database — the product default (spec D9).
    const handler = createSessionEndHandler({ db });

    await handler(createInput({ sessionId: "session-boundary-1" }));

    expect(listNoteSettlementJobs(db, sessionId)).toHaveLength(0);
    expect(getNoteSettlementCursor(db, sessionId)).toBe(0);
  });

  test("the kill switch stops the boundary write while the era stays up", async () => {
    seedTurns(1, 5);
    const handler = createSessionEndHandler({
      db,
      eraCutoffEpoch: ERA_CUTOFF_EPOCH,
      settlementEnabled: false,
    });

    await handler(createInput({ sessionId: "session-boundary-1" }));

    expect(listNoteSettlementJobs(db, sessionId)).toHaveLength(0);
  });
});
