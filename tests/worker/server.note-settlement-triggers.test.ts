import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  countNoteSettlementJobs,
  getNoteSettlementCursor,
  listNoteSettlementJobs,
  NOTE_SETTLEMENT_CONSECUTIVE_TURNS,
  NOTE_SETTLEMENT_MIN_WINDOW_TURNS,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { createWorkerCore } from "../../src/worker/server";
import { DEFAULT_CONFIG, type MnemoConfig } from "../../src/shared/config";
import { SETTLEMENT_ENABLED_CONFIG } from "../support/settlement-config";
import type { WorkerQuerySession } from "../../src/worker/query-session";

/**
 * The worker-module boundary (spec Testing Decisions): events in, DB rows and
 * dispatch calls out. What this file is FOR is the negative half — settlement
 * has exactly two triggers, and "SessionEnd / resume / worker start / timers do
 * not settle" is a claim about paths that call nothing, which only an assertion
 * from outside the module can hold onto.
 */

function seedDecidedSession(
  db: Database,
  contentSessionId: string,
  turns: number,
): number {
  const sessionDbId = upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-settlement-triggers",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: 1_000,
    completedAtEpoch: null,
  }).id;

  // TERMINAL turns, so the session is decided on both readings — the note-debt
  // ledger below and `turns.status` — and `updateCompactAnchor` can place the
  // compact boundary at the last turn rather than one short of it. `failed` is
  // the terminal status this very harness produced for these rows anyway (no
  // extraction runs here, so the derailment floor closed them), and unlike
  // `extracted` it does not hand them to the legacy 0.8.4 grading settlement,
  // whose agent session would then be the thing this file's zero is counting.
  for (let promptNumber = 1; promptNumber <= turns; promptNumber += 1) {
    const turnId = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, ?, 'failed', 'prompt', 'reply', 1000)
         RETURNING id`,
      )
      .get(sessionDbId, promptNumber)!.id;
    db.query<unknown, [number, number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status,
         opened_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, 'noted', 1000, 1000)`,
    ).run(turnId, sessionDbId, promptNumber);
  }
  db.query<unknown, [number, number]>(
    `INSERT INTO note_debt_cursor (
       session_id, last_classified_prompt_number, updated_at_epoch
     ) VALUES (?, ?, 1000)`,
  ).run(sessionDbId, turns);

  return sessionDbId;
}

interface Harness {
  core: ReturnType<typeof createWorkerCore>;
  dispatched: NoteSettlementJob[];
  agentSessionsCreated: () => number;
}

function createHarness(db: Database, config: MnemoConfig): Harness {
  const dispatched: NoteSettlementJob[] = [];
  let agentSessionsCreated = 0;

  const core = createWorkerCore({
    db,
    config,
    processBatchImpl: async () => {},
    pushSessionSummaryPromptImpl: async () => {},
    closeSessionQueryImpl: async () => {},
    readAgentContextTokensImpl: () => null,
    isProcessAliveImpl: () => false,
    noteSettlementDispatchImpl: async ({ job }) => {
      dispatched.push(job);
      return { ok: true };
    },
    // Any settlement path that reached for a model would have to come through
    // here; it stays at zero for the whole lifecycle.
    createWorkerQuerySessionImpl: (() => {
      agentSessionsCreated += 1;
      return {
        sessionId: `agent-${agentSessionsCreated}`,
        queryPid: 1,
        sendPrompt: async () => ({ session_id: `agent-${agentSessionsCreated}` }),
        compact: async () => {},
        close: async () => {},
      } satisfies WorkerQuerySession;
    }) as unknown as typeof import("../../src/worker/query-session").createWorkerQuerySession,
  });

  return { core, dispatched, agentSessionsCreated: () => agentSessionsCreated };
}

describe("worker settlement trigger surface", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("turn-stop settles once the window is full, and compact settles a partial one", async () => {
    const sessionDbId = seedDecidedSession(
      db,
      "content-worker-triggers",
      NOTE_SETTLEMENT_CONSECUTIVE_TURNS + NOTE_SETTLEMENT_MIN_WINDOW_TURNS,
    );
    const { core, dispatched, agentSessionsCreated } = createHarness(
      db,
      SETTLEMENT_ENABLED_CONFIG,
    );

    await core.handleTurnStop(sessionDbId);
    expect(dispatched.map((job) => job.triggerType)).toEqual(["consecutive"]);
    expect(dispatched[0]!.windowEnd).toBe(NOTE_SETTLEMENT_CONSECUTIVE_TURNS);

    await core.handleCompact(sessionDbId);
    expect(dispatched.map((job) => job.triggerType)).toEqual([
      "consecutive",
      "compact",
    ]);
    expect(dispatched[1]!.windowStart).toBe(
      NOTE_SETTLEMENT_CONSECUTIVE_TURNS + 1,
    );
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(
      NOTE_SETTLEMENT_CONSECUTIVE_TURNS + NOTE_SETTLEMENT_MIN_WINDOW_TURNS,
    );
    expect(agentSessionsCreated()).toBe(0);
  });

  test("sessionEnd, resume, worker start and every timer settle nothing", async () => {
    const sessionDbId = seedDecidedSession(
      db,
      "content-non-triggers",
      NOTE_SETTLEMENT_CONSECUTIVE_TURNS * 2,
    );
    const { core, dispatched, agentSessionsCreated } = createHarness(
      db,
      SETTLEMENT_ENABLED_CONFIG,
    );

    // Worker start.
    core.recoverFromCrash();
    // Resume: a fresh env capture for a session already carrying a full window.
    await core.registerSessionEnv("content-non-triggers", sessionDbId, {
      PATH: "/usr/bin",
    });
    // Timers.
    await core.runRetryTick(2_000_000);
    await core.runKeepaliveTick(2_000_000);
    await core.abortStalledSessions(2_000_000);
    core.runTranscriptRepairTick();
    // SessionEnd.
    await core.finishSession(sessionDbId);

    expect(dispatched).toHaveLength(0);
    expect(countNoteSettlementJobs(db)).toBe(0);
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(0);

    // The same session settles the moment a real trigger arrives, so the zeros
    // above are about the paths, not about an un-settleable fixture.
    //
    // The agent-session count is compared ACROSS the trigger rather than to
    // zero: the legacy P1 extraction agent still opens sessions from the drain
    // this test also exercises (D10 removes it in P2), and an absolute zero
    // would be asserting that instead of the settlement path.
    const agentSessionsBefore = agentSessionsCreated();
    await core.handleTurnStop(sessionDbId);
    expect(dispatched).toHaveLength(2);
    expect(agentSessionsCreated()).toBe(agentSessionsBefore);
  });

  test("settlementEnabled=false makes both triggers write nothing", async () => {
    const sessionDbId = seedDecidedSession(
      db,
      "content-gate-off",
      NOTE_SETTLEMENT_CONSECUTIVE_TURNS * 2,
    );
    const { core, dispatched, agentSessionsCreated } = createHarness(
      db,
      DEFAULT_CONFIG,
    );

    await core.handleTurnStop(sessionDbId);
    await core.handleCompact(sessionDbId);
    await core.finishSession(sessionDbId);

    expect(dispatched).toHaveLength(0);
    expect(listNoteSettlementJobs(db, sessionDbId)).toHaveLength(0);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM note_settlement_cursors",
        )
        .get()!.count,
    ).toBe(0);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM note_debt WHERE status != 'noted'",
        )
        .get()!.count,
    ).toBe(0);
    expect(agentSessionsCreated()).toBe(0);
  });

  test("the stub payload is the default: no dispatch dep still settles without a model", async () => {
    const sessionDbId = seedDecidedSession(
      db,
      "content-default-stub",
      NOTE_SETTLEMENT_CONSECUTIVE_TURNS,
    );
    let agentSessionsCreated = 0;
    const core = createWorkerCore({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      processBatchImpl: async () => {},
      pushSessionSummaryPromptImpl: async () => {},
      closeSessionQueryImpl: async () => {},
      readAgentContextTokensImpl: () => null,
      isProcessAliveImpl: () => false,
      createWorkerQuerySessionImpl: (() => {
        agentSessionsCreated += 1;
        throw new Error("settlement must never open an agent session");
      }) as unknown as typeof import("../../src/worker/query-session").createWorkerQuerySession,
    });

    await core.handleTurnStop(sessionDbId);

    const jobs = listNoteSettlementJobs(db, sessionDbId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("done");
    expect(agentSessionsCreated).toBe(0);
  });
});
