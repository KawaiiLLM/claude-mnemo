import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { ensureRecordedEraCutoff } from "../../src/db/era";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  countNoteSettlementJobs,
  enqueueNoteSettlementWindows,
  getNoteSettlementCursor,
  listNoteSettlementJobs,
  NOTE_SETTLEMENT_CONSECUTIVE_TURNS,
  NOTE_SETTLEMENT_MIN_WINDOW_TURNS,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { createWorkerCore } from "../../src/worker/server";
import { DEFAULT_CONFIG, type MnemoConfig } from "../../src/shared/config";
import {
  SETTLEMENT_ENABLED_CONFIG,
  SETTLEMENT_ERA_CUTOFF_EPOCH,
  SETTLEMENT_KILLED_CONFIG,
} from "../support/settlement-config";

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
}

/**
 * Every `@anthropic-ai/claude-agent-sdk` import reachable from the worker's
 * turn-processing path.
 *
 * The old form of this check counted agent sessions through an injected factory
 * seam, and it could only ever be compared ACROSS a trigger because the resident
 * extraction agent opened sessions from the same drain. Ticket 15 removed that
 * agent, so the honest assertion is absolute and structural: nothing on the path
 * from a captured turn to a settled row may so much as import a model client.
 *
 * Two subtrees are cut, and they are the only two the spec still allows the
 * worker to START (never to host): the D9 settlement payload and the nightly
 * dream. Both are constructed exclusively in `main`, both are config-gated, and
 * neither is reachable from `createWorkerCore` — the core receives the
 * settlement payload as an injected function and defaults to none.
 */
const MODEL_SUBPROCESS_ENTRY_POINTS = [
  "src/worker/note-settlement-sdk-query.ts",
  "src/worker/diary-runtime.ts",
];

function sdkImportsReachableFromWorkerCore(): string[] {
  const root = resolve(import.meta.dir, "../..");
  const cut = new Set(
    MODEL_SUBPROCESS_ENTRY_POINTS.map((path) => resolve(root, path)),
  );
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string): void => {
    const resolved = file.endsWith(".ts") ? file : `${file}.ts`;
    if (seen.has(resolved) || cut.has(resolved) || !existsSync(resolved)) {
      return;
    }
    seen.add(resolved);
    const source = readFileSync(resolved, "utf8");
    if (source.includes("@anthropic-ai/claude-agent-sdk")) {
      offenders.push(resolved.slice(root.length + 1));
    }
    for (const match of source.matchAll(/from "(\.[^"]+)"/g)) {
      visit(resolve(dirname(resolved), match[1]!));
    }
  };
  visit(resolve(root, "src/worker/server.ts"));
  return offenders;
}

function createHarness(db: Database, config: MnemoConfig): Harness {
  const dispatched: NoteSettlementJob[] = [];

  const core = createWorkerCore({
    db,
    config,
    noteSettlementDispatchImpl: async ({ job }) => {
      dispatched.push(job);
      return { ok: true };
    },
  });

  return { core, dispatched };
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
    const { core, dispatched } = createHarness(db, SETTLEMENT_ENABLED_CONFIG);

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
    expect(sdkImportsReachableFromWorkerCore()).toEqual([]);
  });

  /**
   * The leak point (spec D7, ticket 05): a `sessionend` job has no trigger of
   * its own — nothing in this worker ever calls `onTurnStop`/`onCompact` for
   * the session that owns it once it is recorded — so every OTHER settlement
   * entry point has to take one attempt at whatever is due, unconditionally,
   * including the overwhelmingly common below-threshold turn-stop that used to
   * return before any cross-session scan ran at all.
   */
  test("the leak dispatches another session's due job even on a below-threshold turn-stop", async () => {
    const busySessionDbId = seedDecidedSession(db, "content-leak-busy", 3);
    const otherSessionDbId = upsertSession(db, {
      contentSessionId: "content-leak-other",
      project: "/tmp/project-note-settlement-triggers",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    enqueueNoteSettlementWindows(
      db,
      [
        {
          sessionId: otherSessionDbId,
          windowStart: 1,
          windowEnd: 7,
          triggerType: "sessionend",
        },
      ],
      1_000,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    );
    const { core, dispatched } = createHarness(db, SETTLEMENT_ENABLED_CONFIG);

    await core.handleTurnStop(busySessionDbId);

    // Nothing of busySessionDbId's own — 3 turns never reach the threshold —
    // yet the other session's recorded job was dispatched in passing.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.sessionId).toBe(otherSessionDbId);
    expect(dispatched[0]!.triggerType).toBe("sessionend");
    expect(listNoteSettlementJobs(db, otherSessionDbId)[0]!.status).toBe(
      "done",
    );
  });

  test("finishSession (flush) also attempts the leak", async () => {
    const flushingSessionDbId = seedDecidedSession(db, "content-leak-flush", 3);
    const otherSessionDbId = upsertSession(db, {
      contentSessionId: "content-leak-flush-other",
      project: "/tmp/project-note-settlement-triggers",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    enqueueNoteSettlementWindows(
      db,
      [
        {
          sessionId: otherSessionDbId,
          windowStart: 1,
          windowEnd: 12,
          triggerType: "sessionend",
        },
      ],
      1_000,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    );
    const { core, dispatched } = createHarness(db, SETTLEMENT_ENABLED_CONFIG);

    await core.finishSession(flushingSessionDbId);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.sessionId).toBe(otherSessionDbId);
    expect(dispatched[0]!.triggerType).toBe("sessionend");
  });

  test("sessionEnd, resume, worker start and every timer settle nothing", async () => {
    // +1: the prompt clock never counts the session's current max turn as
    // ENDED (spec D10 — a turn ends only once a LATER one exists), so two full
    // 50-turn windows need a 101st turn open past them, not exactly 100.
    const sessionDbId = seedDecidedSession(
      db,
      "content-non-triggers",
      NOTE_SETTLEMENT_CONSECUTIVE_TURNS * 2 + 1,
    );
    const { core, dispatched } = createHarness(db, SETTLEMENT_ENABLED_CONFIG);

    // Worker start.
    core.recoverFromCrash();
    // Resume: a fresh env capture for a session already carrying a full window.
    await core.registerSessionEnv("content-non-triggers", sessionDbId, {
      PATH: "/usr/bin",
    });
    // Timers.
    core.runTranscriptRepairTick();
    // SessionEnd.
    await core.finishSession(sessionDbId);

    expect(dispatched).toHaveLength(0);
    expect(countNoteSettlementJobs(db)).toBe(0);
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(0);

    // The same session settles the moment a real trigger arrives, so the zeros
    // above are about the paths, not about an un-settleable fixture.
    await core.handleTurnStop(sessionDbId);
    expect(dispatched).toHaveLength(2);
    expect(sdkImportsReachableFromWorkerCore()).toEqual([]);
  });

  test("the era cutoff alone brings settlement up", async () => {
    // +1: the current max turn is never itself ended (spec D10).
    const sessionDbId = seedDecidedSession(
      db,
      "content-cutoff-only",
      NOTE_SETTLEMENT_CONSECUTIVE_TURNS + 1,
    );
    // The one and only difference from the shipped default (ticket 14): an
    // operator sets a cutoff, and the whole new era comes up behind it.
    const { core, dispatched } = createHarness(db, {
      ...DEFAULT_CONFIG,
      eraCutoffEpoch: SETTLEMENT_ERA_CUTOFF_EPOCH,
    });

    await core.handleTurnStop(sessionDbId);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.windowEnd).toBe(NOTE_SETTLEMENT_CONSECUTIVE_TURNS);
  });

  test("a RECORDED cutoff brings settlement up too, with nothing configured", async () => {
    // The shipped shape: nobody pins a cutoff by hand, the first process of the
    // build records one (db/era.ts). Gating on the config alone left settlement
    // permanently inert on exactly the installs ticket 14 was built for.
    // +1: the current max turn is never itself ended (spec D10).
    const sessionDbId = seedDecidedSession(
      db,
      "content-cutoff-recorded",
      NOTE_SETTLEMENT_CONSECUTIVE_TURNS + 1,
    );
    ensureRecordedEraCutoff(db, SETTLEMENT_ERA_CUTOFF_EPOCH);
    const { core, dispatched } = createHarness(db, DEFAULT_CONFIG);

    await core.handleTurnStop(sessionDbId);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.windowEnd).toBe(NOTE_SETTLEMENT_CONSECUTIVE_TURNS);
  });

  async function expectBothTriggersWriteNothing(
    config: MnemoConfig,
    contentSessionId: string,
  ): Promise<void> {
    const sessionDbId = seedDecidedSession(
      db,
      contentSessionId,
      NOTE_SETTLEMENT_CONSECUTIVE_TURNS * 2,
    );
    const { core, dispatched } = createHarness(db, config);

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
    expect(sdkImportsReachableFromWorkerCore()).toEqual([]);
  }

  test("the product default settles nothing at either trigger", async () => {
    await expectBothTriggersWriteNothing(DEFAULT_CONFIG, "content-no-era");
  });

  test("the kill switch stops both triggers while the era stays up", async () => {
    await expectBothTriggersWriteNothing(
      SETTLEMENT_KILLED_CONFIG,
      "content-killed",
    );
  });

  test("the stub payload is the default: no dispatch dep still settles without a model", async () => {
    // +1: the current max turn is never itself ended (spec D10).
    const sessionDbId = seedDecidedSession(
      db,
      "content-default-stub",
      NOTE_SETTLEMENT_CONSECUTIVE_TURNS + 1,
    );
    const core = createWorkerCore({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
    });

    await core.handleTurnStop(sessionDbId);

    const jobs = listNoteSettlementJobs(db, sessionDbId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("done");
    expect(sdkImportsReachableFromWorkerCore()).toEqual([]);
  });
});
