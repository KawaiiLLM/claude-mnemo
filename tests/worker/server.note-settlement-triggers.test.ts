import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { ensureRecordedEraCutoff } from "../../src/db/era";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  completeNoteSettlementJob,
  countNoteSettlementJobs,
  enqueueNoteSettlementWindows,
  getNoteSettlementCursor,
  listNoteSettlementJobs,
  NOTE_SETTLEMENT_WINDOW_CAP_TURNS,
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
 * dispatch calls out. What this file is FOR is the negative half — turn-stop
 * planning is the ONLY automatic trigger (ticket 04, [S15069/T963]), and
 * "compact / SessionEnd / resume / worker start / timers do not settle" is a
 * claim about paths that call nothing, which only an assertion from outside
 * the module can hold onto.
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
 * CLAIM-MONITOR-REPAIR TICKET 02, PEER ROUND 2 (gate 6) MADE THIS CHECK
 * STRONGER IN TWO WAYS, and both are subtractions.
 *
 * FIRST, THE CUT LIST SHRANK TO ONE. It used to hold three files, and a cut
 * is an EXEMPTION: whatever is named here may host a model client, and
 * nothing downstream of it is inspected at all. Settlement's two entries are
 * gone from it because settlement no longer runs a model in this process AT
 * ALL — both runs (the unified topic-and-edges pass, and the stage-2 cold
 * resume that was the last hold-out) cross a process boundary into
 * `settlement-child.cjs`. `note-settlement-sdk-query.ts` is therefore no
 * longer exempt but genuinely UNREACHABLE, and re-importing it into the
 * worker's turn path now FAILS this test instead of being waved through.
 * (`note-settlement-stage1.ts` had already stopped being imported by
 * anything; it was a dead exemption, and a dead exemption is just a hole.)
 *
 * DREAM-RETIREMENT TICKET 01 EMPTIED THE LIST. `diary-runtime.ts` was the
 * last entry: the nightly dream was the one model client this process still
 * constructed, and it is deleted rather than contained. An EMPTY cut list is
 * the strongest form this check can take — it means no file on the walk is
 * exempt, so the assertion is now simply "nothing reachable from
 * `server.ts` names the SDK", with no carve-out to hide behind. Adding an
 * entry back is re-opening a hole and must argue for itself here.
 *
 * The complement is asserted on the ARTIFACT rather than the source, in
 * tests/shared/release-artifacts.test.ts: `worker.cjs` must contain zero
 * `@anthropic-ai` bytes. Source reachability and shipped bytes are different
 * failures — a stale bundle passes this test and fails that one.
 *
 * SECOND, THE WALK FOLLOWS VALUE IMPORTS ONLY. `import type` is erased before
 * a byte of it reaches a bundle, so a type-only edge cannot carry a model
 * client and treating it as reachability is a false positive that can only be
 * silenced by adding a cut — which is to say, by punching the hole this test
 * exists to detect. Everything else stays over-approximate on purpose: the
 * offender predicate is still a bare substring scan that fires on comments,
 * because naming the package in worker-core prose is itself a smell.
 */
const MODEL_SUBPROCESS_ENTRY_POINTS: string[] = [];

/**
 * Drops `import type … from "…";` statements before the edge scan. Both
 * shapes matter: the single-line form and the multi-line brace form.
 */
function stripTypeOnlyImports(source: string): string {
  return source.replace(
    /(^|\n)[ \t]*import\s+type\s[\s\S]*?from\s+"[^"]+";/g,
    "$1",
  );
}

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
    for (const match of stripTypeOnlyImports(source).matchAll(
      /from "(\.[^"]+)"/g,
    )) {
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
    // Ticket 04 ("one dispatch per claim"): a fresh window's claim starts on
    // stage `topics`, and the same-drain chain a bare transition used to hand
    // off into is gone — so the recorder standing in for "the real payload"
    // goes in the unified-dispatch slot now, not the old stage-2 one.
    noteSettlementStage1DispatchImpl: async ({ job }) => {
      dispatched.push(job);
      // Ticket 12 Part B: the scheduler no longer completes a claim on
      // trust — this stub must terminalize before reporting `ok: true`.
      completeNoteSettlementJob(
        db,
        job.id,
        Math.floor(Date.now() / 1000),
        job.claimGeneration,
      );
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

  test("turn-stop cuts a capped window and leaves the remainder pending; compact settles nothing (ticket 04, [S15069/T963])", async () => {
    // 60 DECIDED turns (the ticket's own worked example — one 50-turn window
    // is cut, 10 turns left pending): +1, since the prompt clock never counts
    // the session's current max turn as ended (spec D10).
    const sessionDbId = seedDecidedSession(
      db,
      "content-worker-triggers",
      61,
    );
    const { core, dispatched } = createHarness(db, SETTLEMENT_ENABLED_CONFIG);

    await core.handleTurnStop(sessionDbId);
    expect(dispatched.map((job) => job.triggerType)).toEqual(["consecutive"]);
    expect(dispatched[0]!.windowStart).toBe(1);
    expect(dispatched[0]!.windowEnd).toBe(NOTE_SETTLEMENT_WINDOW_CAP_TURNS);
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(
      NOTE_SETTLEMENT_WINDOW_CAP_TURNS,
    );

    // Compact creates and triggers NO settlement work at all now — the
    // remaining 10 turns stay exactly where they were.
    await core.handleCompact(sessionDbId);
    expect(dispatched.map((job) => job.triggerType)).toEqual(["consecutive"]);
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(
      NOTE_SETTLEMENT_WINDOW_CAP_TURNS,
    );
    expect(sdkImportsReachableFromWorkerCore()).toEqual([]);
  });

  /**
   * The leak point (spec D7, ticket 05): a job whose own trigger will not
   * come back for it (here modeled with a `sessionend`-typed row — a legal
   * historical vocabulary value, though nothing derives one automatically any
   * more — ticket 04) needs SOME entry point to take one attempt at whatever
   * is due, unconditionally, including the overwhelmingly common
   * below-threshold turn-stop that used to return before any cross-session
   * scan ran at all. Ticket 04 narrows the leak to turn-stop alone (see the
   * next two tests) — this one is still the live wiring.
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

  test("finishSession (flush) no longer attempts the leak (ticket 04, [S15069/T963])", async () => {
    // Residual/leak piggyback now rides turn-stop ONLY — flush's own leak
    // call is removed outright, not merely narrowed.
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

    expect(dispatched).toHaveLength(0);
    expect(listNoteSettlementJobs(db, otherSessionDbId)[0]!.status).toBe(
      "pending",
    );
  });

  /**
   * P1-3 investigation, UPDATED for ticket 04: `finishSession` no longer
   * leaks at all (not merely self-excluded), so a stranded job is deferred to
   * the next event that DOES leak — an unrelated session's turn-stop. This
   * confirms the claim in the leak's own doc comment (worker/note-settlement.ts):
   * such a job is not permanently stranded, only deferred, and
   * `listDispatchableNoteSettlementSessions` has no turn-count/residual floor
   * that could block it. Not a confirmed bug; kept as a regression guard on
   * the cross-session leak mechanism P1-3 relies on staying intact.
   */
  test("P1-3: a stale session's own due job outlives its own finishSession, and the next session's turn-stop leaks it", async () => {
    const staleSessionDbId = seedDecidedSession(db, "content-p1-3-stale", 1);
    // A job with no trigger of its own — same stand-in as the tests above.
    enqueueNoteSettlementWindows(
      db,
      [
        {
          sessionId: staleSessionDbId,
          windowStart: 1,
          windowEnd: 1,
          triggerType: "sessionend",
        },
      ],
      1_000,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    );
    const { core, dispatched } = createHarness(db, SETTLEMENT_ENABLED_CONFIG);

    await core.finishSession(staleSessionDbId);

    // finishSession leaks nothing at all now — the job it just owns is not
    // dispatched by this same call.
    expect(dispatched).toHaveLength(0);
    expect(listNoteSettlementJobs(db, staleSessionDbId)[0]!.status).toBe(
      "pending",
    );

    // No floor blocks it, and the very next unrelated content event — here, an
    // ordinary below-threshold turn-stop for a DIFFERENT session — leaks it:
    // deferred, not stranded.
    const otherSessionDbId = seedDecidedSession(db, "content-p1-3-other", 3);
    await core.handleTurnStop(otherSessionDbId);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.sessionId).toBe(staleSessionDbId);
    expect(listNoteSettlementJobs(db, staleSessionDbId)[0]!.status).toBe(
      "done",
    );
  });

  test("compact, sessionEnd, resume, worker start and every timer settle nothing (ticket 04, [S15069/T963])", async () => {
    // +1: the prompt clock never counts the session's current max turn as
    // ENDED (spec D10 — a turn ends only once a LATER one exists), so two full
    // 50-turn windows need a 101st turn open past them, not exactly 100.
    const sessionDbId = seedDecidedSession(
      db,
      "content-non-triggers",
      NOTE_SETTLEMENT_WINDOW_CAP_TURNS * 2 + 1,
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
    // Compact — retired as a trigger outright (ticket 04).
    await core.handleCompact(sessionDbId);
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
      NOTE_SETTLEMENT_WINDOW_CAP_TURNS + 1,
    );
    // The one and only difference from the shipped default (ticket 14): an
    // operator sets a cutoff, and the whole new era comes up behind it.
    const { core, dispatched } = createHarness(db, {
      ...DEFAULT_CONFIG,
      eraCutoffEpoch: SETTLEMENT_ERA_CUTOFF_EPOCH,
    });

    await core.handleTurnStop(sessionDbId);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.windowEnd).toBe(NOTE_SETTLEMENT_WINDOW_CAP_TURNS);
  });

  test("a RECORDED cutoff brings settlement up too, with nothing configured", async () => {
    // The shipped shape: nobody pins a cutoff by hand, the first process of the
    // build records one (db/era.ts). Gating on the config alone left settlement
    // permanently inert on exactly the installs ticket 14 was built for.
    // +1: the current max turn is never itself ended (spec D10).
    const sessionDbId = seedDecidedSession(
      db,
      "content-cutoff-recorded",
      NOTE_SETTLEMENT_WINDOW_CAP_TURNS + 1,
    );
    ensureRecordedEraCutoff(db, SETTLEMENT_ERA_CUTOFF_EPOCH);
    const { core, dispatched } = createHarness(db, DEFAULT_CONFIG);

    await core.handleTurnStop(sessionDbId);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.windowEnd).toBe(NOTE_SETTLEMENT_WINDOW_CAP_TURNS);
  });

  async function expectBothTriggersWriteNothing(
    config: MnemoConfig,
    contentSessionId: string,
  ): Promise<void> {
    const sessionDbId = seedDecidedSession(
      db,
      contentSessionId,
      NOTE_SETTLEMENT_WINDOW_CAP_TURNS * 2,
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

  // FINAL REVIEW, RE-RULING 10: a worker with no stage-1 payload does not
  // settle the window with an invented one. The transition-only fallback that
  // used to stand here wrote zero snapshots, so stage 2 read an empty worklist
  // and an empty writable set and committed on that basis — a run that is
  // neither the old monolith nor a staged one, indistinguishable downstream
  // from a real settlement. It records a deterministic failure instead, and the
  // window stays unsettled and retryable.
  test("no stage-1 payload is a deterministic failure, not a settled window", async () => {
    // +1: the current max turn is never itself ended (spec D10).
    const sessionDbId = seedDecidedSession(
      db,
      "content-default-stub",
      NOTE_SETTLEMENT_WINDOW_CAP_TURNS + 1,
    );
    const core = createWorkerCore({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
    });

    await core.handleTurnStop(sessionDbId);

    const jobs = listNoteSettlementJobs(db, sessionDbId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).not.toBe("done");
    expect(jobs[0]!.failureClass).toBe("deterministic");
    expect(jobs[0]!.lastError).toContain("requires a stage-1 dispatch");
    // Nothing was published: the stage never moved and the cursor never walked.
    expect(jobs[0]!.stage).toBe("topics");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(0);
    // And the worker still hosts no model of its own.
    expect(sdkImportsReachableFromWorkerCore()).toEqual([]);
  });
});
