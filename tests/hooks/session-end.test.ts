import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation } from "../../src/db/observations";
import {
  getNoteSettlementCursor,
  listNoteSettlementJobs,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { createContextHandler } from "../../src/hooks/handlers/context";
import { createSessionEndHandler } from "../../src/hooks/handlers/session-end";
import type { NormalizedHookInput } from "../../src/hooks/types";
import { BUILD_ID } from "../../src/shared/build-id";
import {
  checkFieldGate,
  recordFieldCompleteness,
  recordReadGrant,
  sessionWriterId,
  snapshotWriteGateSequence,
  stampField,
  STALE_READ_GRANT_AGE_SECONDS,
} from "../../src/db/write-gate";

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
 * The sessionend settlement boundary is RETIRED (ticket 04, [S15069/T963]):
 * the hook used to freeze and enqueue its own window synchronously here, but
 * turn-stop planning is the only automatic trigger now — settlement reads the
 * database, not live context, so a session ending carries no settlement
 * urgency of its own any more. These tests assert directly on
 * `note_settlement_jobs`, bypassing the async flush entirely, so a passing
 * assertion can only be explained by the hook writing nothing at all.
 */
describe("handleSessionEndHook — note settlement boundary (retired, ticket 04)", () => {
  let db: Database;
  let sessionId: number;

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

  test("SessionEnd opens no window however many decided turns accumulated", async () => {
    // Well past both the old 20-turn floor and the new 25-turn threshold —
    // if any settlement path survived here, this would trip it.
    seedTurns(1, 90);
    const handler = createSessionEndHandler({ db });

    await handler(createInput({ sessionId: "session-boundary-1" }));

    expect(listNoteSettlementJobs(db, sessionId)).toHaveLength(0);
    expect(getNoteSettlementCursor(db, sessionId)).toBe(0);
  });

  test("a repeat SessionEnd with new activity in between still opens nothing", async () => {
    seedTurns(1, 22);
    const handler = createSessionEndHandler({ db });

    await handler(createInput({ sessionId: "session-boundary-1" }));
    seedTurns(23, 20);
    await handler(createInput({ sessionId: "session-boundary-1" }));
    await handler(createInput({ sessionId: "session-boundary-1" }));

    expect(listNoteSettlementJobs(db, sessionId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Write gate — grant lifecycle (ticket 01, read-write-contract spec "compact
// 后才清空一次授权"): SessionEnd no longer wipes its own writer's grants
// (PreCompact does, see tests/hooks/compact.test.ts) — it only runs the
// age-keyed janitor sweep now.
// ---------------------------------------------------------------------------

describe("handleSessionEndHook — write gate grant lifecycle", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "write-gate-end-1",
      project: "/tmp/write-gate",
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

  test("no longer clears the ending session's own grants — a simulated exit + same-writer continuation reuses them for a whole-field overwrite of an unchanged foreign field, without a re-read", async () => {
    // Someone else wrote the field, THEN this session read it whole.
    stampField(db, "segment", 1, "goal", "session:9999", 100);
    recordReadGrant(db, sessionWriterId(sessionId), "segment", 1, 150, snapshotWriteGateSequence(db));
    recordFieldCompleteness(
      db,
      sessionWriterId(sessionId),
      [{ entityType: "segment", entityId: 1, field: "goal", complete: true }],
      150,
      snapshotWriteGateSequence(db),
    );

    // The simulated exit: SessionEnd fires.
    const handler = createSessionEndHandler({ db, now: () => 1_000 });
    await handler(createInput({ sessionId: "write-gate-end-1" }));

    // The same-writer continuation (a resume reloads the FULL transcript, so
    // the pre-exit grant still describes exactly what it can see): a
    // whole-field overwrite of the unchanged foreign field succeeds without
    // any re-read.
    const verdict = checkFieldGate(db, sessionWriterId(sessionId), "segment", 1, "goal", "E1", {
      requireCompleteRead: true,
    });
    expect(verdict.ok).toBe(true);
  });

  test("the freshness guard still refuses when the field changed after the pre-exit read — grant survival never bypasses staleness", async () => {
    recordReadGrant(db, sessionWriterId(sessionId), "segment", 1, 100, snapshotWriteGateSequence(db));

    const handler = createSessionEndHandler({ db, now: () => 1_000 });
    await handler(createInput({ sessionId: "write-gate-end-1" }));

    // A FOREIGN write lands after the pre-exit read (and after SessionEnd,
    // which the surviving grant makes irrelevant to this judgment).
    stampField(db, "segment", 1, "goal", "session:9999", 2_000);

    const verdict = checkFieldGate(db, sessionWriterId(sessionId), "segment", 1, "goal", "E1");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("stale");
    }
  });

  test("the janitor sweeps by age only: a completed-but-recent writer's grants survive another session's SessionEnd; 30-day-stale rows go", async () => {
    const staleSessionId = upsertSession(db, {
      contentSessionId: "write-gate-stale-1",
      project: "/tmp/write-gate",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 50,
      updatedAtEpoch: 60,
      completedAtEpoch: 60,
    }).id;
    // Completed just as long ago, but its grant was recorded RECENTLY
    // (e.g. a late resume glance) — completion status no longer decides
    // anything; only the grant row's own age does.
    const recentCompletedSessionId = upsertSession(db, {
      contentSessionId: "write-gate-recent-completed-1",
      project: "/tmp/write-gate",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 50,
      updatedAtEpoch: 60,
      completedAtEpoch: 60,
    }).id;
    const nowEpoch = 10_000_000;
    recordReadGrant(
      db,
      sessionWriterId(staleSessionId),
      "segment",
      2,
      nowEpoch - STALE_READ_GRANT_AGE_SECONDS,
      snapshotWriteGateSequence(db),
    );
    recordReadGrant(
      db,
      sessionWriterId(recentCompletedSessionId),
      "segment",
      3,
      nowEpoch - 60,
      snapshotWriteGateSequence(db),
    );

    const handler = createSessionEndHandler({ db, now: () => nowEpoch });
    await handler(createInput({ sessionId: "write-gate-end-1" }));

    const staleRows = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM write_gate_reads WHERE writer = ?",
      )
      .get(sessionWriterId(staleSessionId));
    expect(staleRows?.count).toBe(0);

    const recentRows = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM write_gate_reads WHERE writer = ?",
      )
      .get(sessionWriterId(recentCompletedSessionId));
    expect(recentRows?.count).toBe(1);
  });
});
