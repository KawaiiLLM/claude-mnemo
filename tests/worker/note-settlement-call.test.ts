import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { upsertShadowNote, getShadowNote } from "../../src/db/shadow-notes";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementCursor,
  getNoteSettlementJob,
  NOTE_SETTLEMENT_MAX_ATTEMPTS,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { listRecentSettlementProposals } from "../../src/db/note-settlement-proposals";
import { listOpenSegments } from "../../src/db/segments";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { buildNoteSettlementContext } from "../../src/worker/note-settlement-context";
import { renderNoteSettlementPrompt } from "../../src/worker/note-settlement-prompt";
import {
  classifySettlementFailure,
  createNoteSettlementDispatch,
  type NoteSettlementQuery,
  type NoteSettlementQueryRequest,
  type NoteSettlementWindowMetrics,
} from "../../src/worker/note-settlement-dispatch";
import { createNoteSettlementScheduler } from "../../src/worker/note-settlement";
import {
  createSettlementStagingEngine,
  type SettlementStagingEngine,
} from "../../src/worker/note-settlement-staging";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import {
  SETTLEMENT_ENABLED_CONFIG,
  SETTLEMENT_ERA_CUTOFF_EPOCH,
} from "../support/settlement-config";

/**
 * The settlement call itself, tested at the worker seam: a fake window in a
 * real database, a STUBBED model reply, and assertions on the rows that
 * land. No network, no subprocess: the query seam is the injection point
 * precisely so the judgement quality (offline-eval territory) never enters a
 * unit test, while the transactional behaviour fully does.
 *
 * TICKET 05 (ownership-and-note-cadence spec, "settlement demolition"): duty
 * 2 (note reconstruction) is gone — every fixture turn now already carries a
 * genuine note (the main agent's, standing in for real ownership), because
 * there is no more "hole" for settlement to backfill. `assign` is gone from
 * `remember` — every scenario that used to exercise membership now uses
 * `propose`, or drops the membership call entirely (it was never required
 * even before this ticket, and is even less relevant now that the
 * completion gate has no membership-shaped reason to refuse). ADR-0004's
 * summary-flagging report (`db/note-settlement-summary-flags.ts`) is
 * deleted outright along with the segment-field reading it depended on.
 */

const NOW = 1_800_000_000;

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

function seedSession(contentSessionId = "session-a"): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-settlement-call",
    title: "settlement fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

interface SeedTurnOptions {
  note?: { title: string; content: string } | null;
  userPrompt?: string;
  assistantResponse?: string;
}

function seedTurn(
  sessionDbId: number,
  promptNumber: number,
  options: SeedTurnOptions = {},
): number {
  const turnId = db
    .query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, ?, 'active', ?, ?, 3, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      options.userPrompt ?? `prompt ${promptNumber}`,
      options.assistantResponse ?? `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
    )!.id;

  if (options.note) {
    upsertShadowNote(db, {
      turnId,
      title: options.note.title,
      content: options.note.content,
      nowEpoch: NOW - 900,
    });
  }

  return turnId;
}

function seedDebt(
  turnId: number,
  sessionDbId: number,
  promptNumber: number,
  status: "noted" | "skipped" | "pending",
  reason: string | null,
): void {
  db.query<unknown, [number, number, number, string, string | null, number, number]>(
    `INSERT INTO note_debt (
       turn_id, session_id, prompt_number, status, reason,
       opened_at_epoch, updated_at_epoch
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(turnId, sessionDbId, promptNumber, status, reason, NOW - 950, NOW - 950);
}

function classifyThrough(sessionDbId: number, promptNumber: number): void {
  db.query<unknown, [number, number, number]>(
    `INSERT INTO note_debt_cursor (
       session_id, last_classified_prompt_number, updated_at_epoch
     ) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       last_classified_prompt_number = excluded.last_classified_prompt_number,
       updated_at_epoch = excluded.updated_at_epoch`,
  ).run(sessionDbId, promptNumber, NOW);
}

function claimWindow(
  sessionDbId: number,
  windowStart: number,
  windowEnd: number,
): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    db,
    [
      {
        sessionId: sessionDbId,
        windowStart,
        windowEnd,
        triggerType: "consecutive",
      },
    ],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job;
}

interface Fixture {
  sessionDbId: number;
  turnIds: number[];
  job: NoteSettlementJob;
}

/**
 * Four turns, EVERY one already noted by the main agent (ticket 05: duty 2
 * is gone, so a realistic window has no "hole" left for settlement to
 * backfill — the main agent is the note's sole first-hand writer).
 */
function seedFourTurnWindow(): Fixture {
  const sessionDbId = seedSession();
  // The stubbed replies below cite `S1/...` literally, which is only the right
  // address if this fixture owns database id 1.
  if (sessionDbId !== 1) {
    throw new Error(`fixture expected session id 1, got ${sessionDbId}`);
  }
  const t1 = seedTurn(sessionDbId, 1, {
    note: { title: "design+settlement: window shape", content: "Chose windows." },
  });
  seedDebt(t1, sessionDbId, 1, "noted", null);
  const t2 = seedTurn(sessionDbId, 2, {
    note: { title: "research+lease: what the lease covers", content: "Explored the lease." },
  });
  seedDebt(t2, sessionDbId, 2, "noted", null);
  const t3 = seedTurn(sessionDbId, 3, {
    note: { title: "implement+settlement: lease fence", content: "Fenced it." },
  });
  seedDebt(t3, sessionDbId, 3, "noted", null);
  const t4 = seedTurn(sessionDbId, 4, {
    note: { title: "fix+lease: closed the gap", content: "Closed it." },
  });
  seedDebt(t4, sessionDbId, 4, "noted", null);
  classifyThrough(sessionDbId, 4);

  return { sessionDbId, turnIds: [t1, t2, t3, t4], job: claimWindow(sessionDbId, 1, 4) };
}

/**
 * A stub `runQuery` that stages and (optionally) commits through the REAL
 * staging engine, standing in for what the SDK subprocess's tool calls would
 * do (spec A7). `build` receives the engine and the request the dispatch
 * actually sent — everything a real `note-settlement-sdk-query.ts` would
 * have used to build its own `SettlementTurnFacadeContext` — so a test can
 * stage/commit against the SAME job identity and scoping the dispatch
 * computed, without a network or a subprocess.
 */
function queryThatStages(
  build: (engine: SettlementStagingEngine, request: NoteSettlementQueryRequest) => void,
): NoteSettlementQuery {
  return async (request) => {
    const context: SettlementTurnFacadeContext = {
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
      sessionId: request.sessionId,
      reviewableTurnIds: request.reviewableTurnIds,
      contextBuiltAtEpoch: request.contextBuiltAtEpoch,
      eligibleRelationPairKeys: request.eligibleRelationPairKeys,
      attachedSegmentIds: request.attachedSegmentIds,
    };
    const engine = createSettlementStagingEngine({ db, context });
    build(engine, request);
    // `commitMetrics` is `commit`'s own replay result, read the SAME way
    // `note-settlement-sdk-query.ts` reads it (once, after the model's "run"
    // — here, the synchronous `build` call above — has fully finished).
    return {
      text: "settlement run finished.",
      commitMetrics: engine.getLastCommitMetrics(),
    };
  };
}

function dispatchWith(
  runQuery: NoteSettlementQuery,
  metrics?: (value: NoteSettlementWindowMetrics) => void,
) {
  return createNoteSettlementDispatch({
    db,
    config: SETTLEMENT_ENABLED_CONFIG,
    now: () => NOW,
    runQuery,
    metrics,
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  });
}

describe("settlement context assembly", () => {
  test("a window with no gap at all is empty of hole/kind machinery — that concept retired with duty 2 (ticket 05)", () => {
    const fixture = seedFourTurnWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;

    for (const turn of context.windowTurns) {
      expect(turn).not.toHaveProperty("kind");
      expect(turn).not.toHaveProperty("rawMaterial");
    }
    expect(context).not.toHaveProperty("interiorHoles");

    const prompt = renderNoteSettlementPrompt(context);
    const window = prompt.slice(prompt.indexOf("## Turns"));
    // The old fact line's "kind=" and the raw-material annotation are gone.
    expect(window).not.toContain("kind=");
    expect(window).not.toContain("raw>");
    // The window's notes are still the material for turns that have one.
    expect(window).toContain("implement+settlement: lease fence");
  });

  test("the window's rendered line carries no drafted type or tag", () => {
    const fixture = seedFourTurnWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;

    const t1 = context.windowTurns.find((turn) => turn.promptNumber === 1)!;
    expect(t1).not.toHaveProperty("typeDraft");
    expect(t1).not.toHaveProperty("tagDraft");

    const prompt = renderNoteSettlementPrompt(context);
    const window = prompt.slice(prompt.indexOf("## Turns"));
    expect(window).not.toContain("type_draft=");
    expect(window).not.toContain("tag_draft=");
  });

  test("duty 1 (grading) and duty 2 (reconstruction) left the prompt entirely; only proposals and relations remain (ticket 05)", () => {
    const fixture = seedFourTurnWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;
    const prompt = renderNoteSettlementPrompt(context);

    // The old absolute rubric AND the election-ranking rubric that replaced
    // it are both gone from the prompt now — settlement no longer grades at
    // all until a later ticket restores a rubric-driven duty.
    expect(prompt).not.toContain("Grade 4 — task origin or re-foundation");
    expect(prompt).not.toContain("How much does this task's future depend on this turn?");
    expect(prompt).not.toContain("Seats are CEILINGS");
    expect(prompt).not.toContain("TURN REVIEW");
    expect(prompt).not.toContain("RECONSTRUCTION");

    // Ticket 08 (edge-ownership-impl) folded the old duty 2 (RELATIONS) into
    // a wider CORRECTION duty (type/tags/membership/edges); ticket 09
    // inserted duty 3 (SESSION NARRATIVE) between it and COMMIT, so COMMIT
    // stays numbered "4.".
    const proposalsIndex = prompt.indexOf("1. PROPOSALS");
    const correctionIndex = prompt.indexOf("2. CORRECTION");
    const narrativeIndex = prompt.indexOf("3. SESSION NARRATIVE");
    const commitIndex = prompt.indexOf("4. COMMIT");
    expect(proposalsIndex).toBeGreaterThan(-1);
    expect(correctionIndex).toBeGreaterThan(proposalsIndex);
    expect(narrativeIndex).toBeGreaterThan(correctionIndex);
    expect(commitIndex).toBeGreaterThan(narrativeIndex);
    expect(prompt).toContain("evidenceFor");
    expect(prompt).toContain("dependsOn");
  });

  // Ticket 08 (edge-ownership-impl, "settlement four-field check-and-
  // correct"): the old pre-ticket-01 four-question relation ladder
  // (supersedes-first) is DELETED from the prompt — judgment lives only in
  // the Memory Rubric now, and this duty is a pointer at it, not a second
  // restatement. What survives verbatim is the FORMAT/fence facts a rubric
  // pointer cannot carry: the seven-word field list and the same-run
  // eligibility fence (spec C7).
  test("the relation half is a rubric pointer, not a restated ladder", () => {
    const fixture = seedFourTurnWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;
    const prompt = renderNoteSettlementPrompt(context);

    // The retired four-question ladder must not survive anywhere in the
    // prompt, not merely be absent from duty 2's own text.
    expect(prompt).not.toContain("(1) Did the citing turn overturn it? -> supersedes.");
    expect(prompt).not.toContain(
      "(2) Did the citing turn test its claim, supporting or undermining it?",
    );
    expect(prompt).not.toContain("(4) None of the above -> no relation");
    expect(prompt).not.toContain('"used"');
    expect(prompt).not.toContain('"built on"');

    // The pointer + fence + phase-rejection facts a rubric pointer cannot
    // itself state.
    expect(prompt).toContain("Which relation, if any, is the Memory Rubric's");
    expect(prompt).toContain("must already be a pair that existed");
    expect(prompt).toContain("before this run started");
    expect(prompt).toContain("you cannot invent a relation for a pair a call earlier");
    expect(prompt).toContain("rejected, naming which half is missing");
    expect(prompt).toContain(
      "note`'s evidenceFor/evidenceAgainst/groundedOn/refines/override/encodes/dependsOn fields",
    );
  });
});

describe("settlement dispatch — staged writes and commit (ticket 05: review, proposals, relations — no reconstruction, no assign)", () => {
  test("a full run (review, a proposal, a relation) lands atomically once the agent calls commit", async () => {
    const fixture = seedFourTurnWindow();
    // A judged relation is legal only on a pair present BEFORE this window's
    // run (spec C7) — seed the T3->T1 pair here (a prior bare citation, in
    // production) so the `encodes` relation below is attaching to an
    // existing pair, not minting one. `encodes` (not `dependsOn`) because T1
    // is staged decision-phase (`design`) and T3 delivery+decision
    // (`implement`+`correction`) — the phase pair `encodes` requires
    // (ticket 08's phase-legality gate, `shared/turn-phase.ts`).
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: fixture.turnIds[2]! },
          cited: { kind: "turn", id: fixture.turnIds[0]! },
          relation: null,
          provenance: "text-ref",
        },
      ],
      NOW - 4_000,
      { eligibleForRelation: "unrestricted" },
    );
    // The CITED side of a phase check reads the LIVE database (both at stage
    // time's dry run and inside commit's own replay) — a sibling stage call
    // that also corrects T1's type is not yet applied when T3's phase check
    // runs against it, so T1 needs its decision-phase type seeded directly
    // rather than relying on this same run's own T1 correction landing
    // first (ticket 08's phase-legality gate).
    updateTurnById(db, fixture.turnIds[0]!, { type: ["design"] });

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        // T1's type was seeded above, so replacing it is a declared `write`
        // (ticket 07, spec D12).
        engine.stageNoteWrite({
          turn: "S1/T1",
          type: ["design"],
          tags: ["lease"],
          mode: { type: "write" },
        });
        engine.stageNoteWrite({
          turn: "S1/T3",
          type: ["implement", "correction"],
          tags: ["lease"],
          encodes: ["S1/T1"],
        });
        engine.stageNoteWrite({ turn: "S1/T2", type: ["research"], tags: ["lease"] });
        engine.stageMembershipWrite({
          action: "propose",
          addresses: ["S1/T2", "S1/T4"],
          title: "a homeless cluster settlement noticed",
        });
        engine.commit();
      }),
      (value) => metricsSeen.push(value),
    )({ job: fixture.job });
    expect(outcome).toEqual({ ok: true });

    // The judged relation (spec C7's pre-state gate).
    const judged = getOutgoingEdges(db, { kind: "turn", id: fixture.turnIds[2]! });
    expect(judged.some((edge) => edge.relation === "encodes" && edge.provenance === "judged")).toBe(true);

    // The proposal — text only, never a segment.
    const proposals = listRecentSettlementProposals(db, 3);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.addresses.sort()).toEqual(["S1/T2", "S1/T4"].sort());
    expect(listOpenSegments(db)).toHaveLength(0);

    // The agent's own notes on every turn keep their origin — settlement
    // never touched prose.
    for (const turnId of fixture.turnIds) {
      expect(getShadowNote(db, turnId)!.writerOrigin).toBe("agent");
    }

    // Job/cursor resolution: `commit` is what did this, not the dispatch.
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(4);
    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.committed).toBe(true);

    // The job log's counts are sourced from `commit`'s own replay: three
    // reviews, one relation, one proposal — no reconstruction, no members.
    expect(metricsSeen[0]!.commit).toEqual({
      turnsReviewed: 3,
      reviewsYieldedToLateNote: 0,
      relationsWritten: 1,
      proposalsCreated: 1,
      sessionNarrativeWritten: 0,
      membersReassigned: 0,
    });
    // Attempt bookkeeping (spec A2a): a first-attempt success is convergence,
    // never abandonment.
    expect(metricsSeen[0]!.attempt).toBe(fixture.job.attempts);
    expect(metricsSeen[0]!.attemptsExhausted).toBe(false);
  });

  test("an EMPTY-HANDED run (nothing staged, nothing to correct) lands cleanly through commit alone — the checklist's own scenario (ticket 05)", async () => {
    const fixture = seedFourTurnWindow();

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        // No stageNoteWrite, no stageMembershipWrite — the model looked, found
        // nothing to correct or propose, and simply commits.
        engine.commit();
      }),
      (value) => metricsSeen.push(value),
    )({ job: fixture.job });

    expect(outcome).toEqual({ ok: true });
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(4);
    expect(metricsSeen[0]!.commit).toEqual({
      turnsReviewed: 0,
      reviewsYieldedToLateNote: 0,
      relationsWritten: 0,
      proposalsCreated: 0,
      sessionNarrativeWritten: 0,
      membersReassigned: 0,
    });
  });

  test("commit is the only path that completes a job — a run that stages a review but never calls commit lands nothing (requirement 9)", async () => {
    const fixture = seedFourTurnWindow();

    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        engine.stageNoteWrite({ turn: "S1/T2", type: ["research"], tags: ["lease"] });
        // Deliberately no engine.commit() call.
      }),
    )({ job: fixture.job });

    expect(outcome.ok).toBe(false);
    // Nothing landed — staging without commit is exactly as durable as never
    // having called a tool at all.
    expect(getTurnById(db, fixture.turnIds[1]!)!.tags).toEqual([]);
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(0);
  });

  /**
   * The job log documents the three-strike cursor advance as ABANDONING a
   * remainder, not converging toward eventually settling it (spec A2a).
   * This dispatch never decides terminality itself (that is
   * db/note-settlement.ts's `failNoteSettlementJob`/`advanceNoteSettlementCursor`,
   * driven by the scheduler after this call returns) — it only reports
   * `job.attempts` against the same cap.
   */
  test("a failed run on the job's last attempt reports attemptsExhausted — abandonment, not convergence (spec A2a)", async () => {
    const fixture = seedFourTurnWindow();
    const lastAttemptJob = { ...fixture.job, attempts: NOTE_SETTLEMENT_MAX_ATTEMPTS };

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        engine.stageNoteWrite({ turn: "S1/T2", type: ["research"], tags: [] });
        // Deliberately no commit — this attempt fails, and it is the job's
        // last one.
      }),
      (value) => metricsSeen.push(value),
    )({ job: lastAttemptJob });

    expect(outcome.ok).toBe(false);
    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.attempt).toBe(NOTE_SETTLEMENT_MAX_ATTEMPTS);
    expect(metricsSeen[0]!.attemptsExhausted).toBe(true);
    expect(metricsSeen[0]!.commit).toBeNull();
  });

  test("a failed run BEFORE the last attempt does not report attemptsExhausted — there is still a retry coming", async () => {
    const fixture = seedFourTurnWindow();
    const firstAttemptJob = { ...fixture.job, attempts: 1 };

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    await dispatchWith(
      queryThatStages(() => {
        // No staged writes, no commit — this attempt simply fails.
      }),
      (value) => metricsSeen.push(value),
    )({ job: firstAttemptJob });

    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.attempt).toBe(1);
    expect(metricsSeen[0]!.attemptsExhausted).toBe(false);
  });

  test("a SUCCESSFUL commit on the job's last attempt is convergence, not abandonment — attemptsExhausted stays false", async () => {
    const fixture = seedFourTurnWindow();
    const lastAttemptJob = { ...fixture.job, attempts: NOTE_SETTLEMENT_MAX_ATTEMPTS };

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        for (const turnId of fixture.turnIds) {
          updateTurnById(db, turnId, { type: ["research"] });
        }
        engine.commit();
      }),
      (value) => metricsSeen.push(value),
    )({ job: lastAttemptJob });

    expect(outcome).toEqual({ ok: true });
    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.attempt).toBe(NOTE_SETTLEMENT_MAX_ATTEMPTS);
    expect(metricsSeen[0]!.attemptsExhausted).toBe(false);
  });

  test("discards the whole run when the job generation expired before commit's own fence", async () => {
    const fixture = seedFourTurnWindow();

    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        engine.stageMembershipWrite({
          action: "propose",
          addresses: ["S1/T1", "S1/T3"],
          title: "should not land",
        });
        // Another worker reclaimed the window while this dispatch was "thinking" —
        // simulated here, inside the query, exactly where the race would land.
        db.query<unknown, [number]>(
          "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
        ).run(fixture.job.id);
        engine.commit();
      }),
    )({ job: fixture.job });

    expect(outcome.ok).toBe(false);
    expect(listOpenSegments(db)).toHaveLength(0);
    expect(listRecentSettlementProposals(db, 3)).toHaveLength(0);
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(0);
  });

  /**
   * A replay conflict refuses the WHOLE commit and keeps every staged write;
   * a fresh dispatch attempt (a new `runQuery` call, a new staging engine —
   * exactly what the job's own attempt/retry mechanism already provides)
   * against a world that no longer conflicts then succeeds. Ticket 05: this
   * used to demonstrate the shape through `assign` against a vanished
   * segment; `assign` is gone, so this now uses a `propose` whose own turn
   * vanishes — the same general "the world moved" mechanism, through the
   * one membership verb that remains.
   */
  test("a vanished proposal target refuses the whole commit; a fresh dispatch attempt against a valid one succeeds", async () => {
    const fixture = seedFourTurnWindow();

    // Attempt 1: stages a propose naming T1 and a turn that then vanishes
    // before commit — refuses whole.
    const firstOutcome = await dispatchWith(
      queryThatStages((engine) => {
        for (const turnId of fixture.turnIds) {
          updateTurnById(db, turnId, { type: ["research"] });
        }
        engine.stageMembershipWrite({
          action: "propose",
          addresses: ["S1/T1", "S1/T2"],
          title: "about to lose a member",
        });
        db.query<unknown, [number]>("DELETE FROM turns WHERE id = ?").run(fixture.turnIds[1]!);
        const refused = engine.commit();
        expect(refused.content[0]!.text).toContain("Commit refused");
      }),
    )({ job: fixture.job });
    expect(firstOutcome.ok).toBe(false);
    expect(getTurnById(db, fixture.turnIds[1]!)).toBeNull();

    // Attempt 2: a genuinely fresh dispatch call — new `runQuery`
    // invocation, new staging engine — against turns that are all still
    // present. The job is still `claimed` under the same generation
    // (nothing moved it), so this models the job's own next attempt rather
    // than a same-run patch.
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        for (const turnId of [fixture.turnIds[0]!, fixture.turnIds[2]!, fixture.turnIds[3]!]) {
          updateTurnById(db, turnId, { type: ["research"] });
        }
        engine.stageMembershipWrite({
          action: "propose",
          addresses: ["S1/T1", "S1/T3"],
          title: "a valid cluster this time",
        });
        engine.commit();
      }),
    )({ job: fixture.job });

    expect(outcome).toEqual({ ok: true });
    expect(listRecentSettlementProposals(db, 3)).toHaveLength(1);
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
  });

  /**
   * Spec D4/D6: the subagent may revise a turn from an earlier window that is
   * still in its context — not a loophole, ordinary review-window mechanics.
   * T1's tags from window one are corrected in window two, once T1 is a
   * PRECEDING turn rather than a window turn.
   */
  test("a note call revises a turn settled by an earlier window once it is only in the preceding-turns context", async () => {
    const fixture = seedFourTurnWindow();
    const firstOutcome = await dispatchWith(
      queryThatStages((engine) => {
        engine.stageNoteWrite({ turn: "S1/T1", type: ["design"], tags: ["settlement"] });
        engine.stageNoteWrite({ turn: "S1/T3", type: ["implement"], tags: ["settlement"] });
        engine.commit();
      }),
    )({ job: fixture.job });
    expect(firstOutcome).toEqual({ ok: true });
    expect(getTurnById(db, fixture.turnIds[0]!)!.tags).toEqual(["settlement"]);

    // A second window, T5-T8: T1-T4 are now PRECEDING turns in its context,
    // not window turns — buildNoteSettlementContext still exposes them (ticket
    // 04: lookback defaults to the window's own size, here 4, which is
    // exactly enough to reach back to T1), which is what makes citing S1/T1
    // legal here.
    for (let promptNumber = 5; promptNumber <= 8; promptNumber += 1) {
      const turnId = seedTurn(fixture.sessionDbId, promptNumber, {
        note: { title: `implement+seam: turn ${promptNumber}`, content: "Noted." },
      });
      seedDebt(turnId, fixture.sessionDbId, promptNumber, "noted", null);
    }
    classifyThrough(fixture.sessionDbId, 8);
    const secondJob = claimWindow(fixture.sessionDbId, 5, 8);

    const secondOutcome = await dispatchWith(
      queryThatStages((engine) => {
        // T1's tag turned out wrong — corrected now that its real scale is
        // visible.
        engine.stageNoteWrite({
          turn: "S1/T1",
          type: ["design"],
          tags: ["revised"],
          mode: { type: "write", tags: "write" },
        });
        for (let promptNumber = 5; promptNumber <= 8; promptNumber += 1) {
          engine.stageNoteWrite({
            turn: `S1/T${promptNumber}`,
            type: ["implement"],
            tags: ["seam"],
          });
        }
        engine.commit();
      }),
    )({ job: secondJob });

    expect(secondOutcome).toEqual({ ok: true });
    expect(getTurnById(db, fixture.turnIds[0]!)!.tags).toEqual(["revised"]);
    expect(getNoteSettlementJob(db, secondJob.id)!.status).toBe("done");
  });
});

describe("settlement payload at the scheduler seam", () => {
  test("a trigger drains the window through the real payload", async () => {
    const sessionDbId = seedSession();
    if (sessionDbId !== 1) {
      throw new Error("fixture expected session id 1");
    }
    for (let promptNumber = 1; promptNumber <= 4; promptNumber += 1) {
      const turnId = seedTurn(sessionDbId, promptNumber, {
        note: { title: `implement+seam: turn ${promptNumber}`, content: "Noted." },
      });
      seedDebt(turnId, sessionDbId, promptNumber, "noted", null);
    }
    // A 5th, still-open turn: turn 4 alone is not yet decided (spec D10) —
    // this is what makes it so, and it stays outside window 1-4.
    seedTurn(sessionDbId, 5, { userPrompt: "still open" });
    classifyThrough(sessionDbId, 4);

    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      nowMs: () => NOW * 1000,
      thresholdTurns: 4,
      dispatch: dispatchWith(
        queryThatStages((engine) => {
          for (let promptNumber = 1; promptNumber <= 4; promptNumber += 1) {
            engine.stageNoteWrite({
              turn: `S1/T${promptNumber}`,
              type: ["implement"],
              tags: ["scheduler seam"],
            });
          }
          engine.commit();
        }),
      ),
      logger: { warn: () => {}, error: () => {} },
    });

    const pass = await scheduler.onTurnStop(sessionDbId);
    expect(pass.created).toHaveLength(1);
    expect(pass.dispatched).toHaveLength(1);

    // commit already completed the job and moved the cursor inside its own
    // transaction; the scheduler's completion re-asserts the same facts.
    expect(getNoteSettlementJob(db, pass.created[0]!.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(4);
  });

  test("an empty-handed window (main agent already typed/noted everything, nothing to correct) completes end to end through the scheduler (ticket 05, checklist item 1)", async () => {
    const sessionDbId = seedSession();
    if (sessionDbId !== 1) {
      throw new Error("fixture expected session id 1");
    }
    const t1 = seedTurn(sessionDbId, 1, {
      note: { title: "design+seam: window shape", content: "Chose windows." },
    });
    seedDebt(t1, sessionDbId, 1, "noted", null);
    const t2 = seedTurn(sessionDbId, 2, {
      note: { title: "research+seam: already noted by the main agent", content: "Explored it." },
    });
    seedDebt(t2, sessionDbId, 2, "noted", null);
    updateTurnById(db, t1, { type: ["design"] });
    updateTurnById(db, t2, { type: ["research"] });
    // Turn 3, still open: turn 2 alone is not yet decided (spec D10).
    seedTurn(sessionDbId, 3, { userPrompt: "still open" });
    classifyThrough(sessionDbId, 2);

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const dispatch = createNoteSettlementDispatch({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      // The model looks, finds nothing to correct or propose, and commits
      // empty-handed — legal by construction after ticket 05's demolition.
      runQuery: queryThatStages((engine) => {
        engine.commit();
      }),
      metrics: (value) => metricsSeen.push(value),
      logger: { warn: () => {}, error: () => {} },
    });
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      nowMs: () => NOW * 1000,
      thresholdTurns: 2,
      dispatch,
      logger: { warn: () => {}, error: () => {} },
    });

    const pass = await scheduler.onTurnStop(sessionDbId);
    expect(pass.dispatched).toHaveLength(1);

    expect(getNoteSettlementJob(db, pass.created[0]!.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(2);
    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.committed).toBe(true);
    expect(metricsSeen[0]!.commit).toEqual({
      turnsReviewed: 0,
      reviewsYieldedToLateNote: 0,
      relationsWritten: 0,
      proposalsCreated: 0,
      sessionNarrativeWritten: 0,
      membersReassigned: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Ticket 06 (read-write-contract spec "重试"): failure classification, both
// the pure classifier and its wiring into the dispatch's own outcome.
// ---------------------------------------------------------------------------

describe("classifySettlementFailure (ticket 06)", () => {
  test("SQLITE_BUSY is transient", () => {
    expect(classifySettlementFailure({ code: "SQLITE_BUSY", message: "database is locked" })).toBe(
      "transient",
    );
  });

  test("a connection-shaped error (ECONNRESET) is transient", () => {
    expect(classifySettlementFailure({ code: "ECONNRESET", message: "socket hang up" })).toBe(
      "transient",
    );
  });

  test("an authentication/invalid-request-shaped error is deterministic", () => {
    expect(classifySettlementFailure({ type: "invalid_request_error", status: 400 })).toBe(
      "deterministic",
    );
  });

  test("an unrecognised error defaults to deterministic (unknown failures do not retry forever)", () => {
    expect(classifySettlementFailure(new Error("something this classifier has never seen"))).toBe(
      "deterministic",
    );
  });
});

describe("the dispatch's own outcome carries a failureClass (ticket 06)", () => {
  test("runQuery throwing a connection-shaped error reports failureClass: transient", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1, { note: { title: "design+seam: x", content: "y" } });
    seedTurn(sessionDbId, 2, { userPrompt: "still open" });
    classifyThrough(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const dispatch = dispatchWith(async () => {
      throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    });
    const outcome = await dispatch({ job });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.failureClass).toBe("transient");
  });

  test("runQuery returning normally but the job never committing reports failureClass: deterministic", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1, { note: { title: "design+seam: x", content: "y" } });
    seedTurn(sessionDbId, 2, { userPrompt: "still open" });
    classifyThrough(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    // The model's run ends normally (no thrown error) but never calls commit
    // — exactly what a Stop-hook-blocked-then-exhausted run looks like from
    // the dispatch's own vantage point.
    const dispatch = dispatchWith(
      queryThatStages(() => {
        /* never commits */
      }),
    );
    const outcome = await dispatch({ job });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.failureClass).toBe("deterministic");
  });
});
