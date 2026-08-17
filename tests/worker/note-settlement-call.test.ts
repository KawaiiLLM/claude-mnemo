import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession, getSession } from "../../src/db/sessions";
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
import { hasNoteSettlementMembershipActivity } from "../../src/db/note-settlement-completion";
import { listRecentSettlementProposals } from "../../src/db/note-settlement-proposals";
import {
  attachSegmentToSession,
  createSegment,
  getSegment,
  getSegmentMemberTurnIds,
  listOpenSegments,
} from "../../src/db/segments";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { ELECTION_ERA_CUTOFF_EPOCH } from "../../src/election-era";
import {
  buildNoteSettlementContext,
  NOTE_SETTLEMENT_HOLE_TOKEN_BUDGET,
} from "../../src/worker/note-settlement-context";
import { renderNoteSettlementPrompt } from "../../src/worker/note-settlement-prompt";
import {
  createNoteSettlementDispatch,
  NOTE_SETTLEMENT_METRICS_PREFIX,
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
 * Ticket 07 — the settlement call itself, tested at the worker seam: a fake
 * window in a real database, a STUBBED model reply, and assertions on the rows
 * that land. No network, no subprocess: the query seam is the injection point
 * precisely so the judgement quality (which is offline-eval territory) never
 * enters a unit test, while the transactional behaviour fully does.
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
 * Four turns: two noted, and two written off by residual settlement (reason
 * `closed`) with no note of their own — T2 has a later noted turn (T3), T4
 * does not. Ticket 05 deletes the old interior/trailing distinction: BOTH are
 * now plain holes the payload mechanically backfills, position irrelevant.
 */
function seedInteriorHoleWindow(): Fixture {
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
    userPrompt: "INTERIOR HOLE PROMPT about the lease",
    assistantResponse: "INTERIOR HOLE RESPONSE about the lease",
  });
  seedDebt(t2, sessionDbId, 2, "skipped", "closed");
  const t3 = seedTurn(sessionDbId, 3, {
    note: { title: "implement+settlement: lease fence", content: "Fenced it." },
  });
  seedDebt(t3, sessionDbId, 3, "noted", null);
  const t4 = seedTurn(sessionDbId, 4, {
    userPrompt: "TRAILING HOLE PROMPT never followed up",
    assistantResponse: "TRAILING HOLE RESPONSE never followed up",
  });
  seedDebt(t4, sessionDbId, 4, "skipped", "closed");
  classifyThrough(sessionDbId, 4);

  return { sessionDbId, turnIds: [t1, t2, t3, t4], job: claimWindow(sessionDbId, 1, 4) };
}

/**
 * A stub `runQuery` that stages and (optionally) commits through the REAL
 * staging engine, standing in for what the SDK subprocess's tool calls would
 * do (ticket 10b, spec A7). `build` receives the engine and the request the
 * dispatch actually sent — everything a real `note-settlement-sdk-query.ts`
 * would have used to build its own `SettlementTurnFacadeContext` — so a test
 * can stage/commit against the SAME job identity and scoping the dispatch
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
      reconstructableTurnIds: request.reconstructableTurnIds,
      reviewableTurnIds: request.reviewableTurnIds,
      attachedSegmentIds: request.attachedSegmentIds,
      contextBuiltAtEpoch: request.contextBuiltAtEpoch,
      rideTurnId: request.rideTurnId,
      writerModel: request.writerModel,
      eligibleRelationPairKeys: request.eligibleRelationPairKeys,
      // Mirrors note-settlement-sdk-query.ts's own choice: the election-era
      // boundary is a deterministic constant, not a per-request fact
      // `NoteSettlementQueryRequest` carries.
      eraCutoffEpoch: ELECTION_ERA_CUTOFF_EPOCH,
    };
    const engine = createSettlementStagingEngine({ db, context });
    build(engine, request);
    // Ticket 10c: `runQuery` no longer returns a bare envelope string —
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
  test("injects raw material for every hole regardless of what follows it (spec D7, ticket 05)", () => {
    const fixture = seedInteriorHoleWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;

    const kinds = Object.fromEntries(
      context.windowTurns.map((turn) => [turn.promptNumber, turn.kind]),
    );
    expect(kinds).toEqual({
      1: "noted",
      2: "hole",
      3: "noted",
      4: "hole",
    });
    // Both holes, position irrelevant — the old interior/trailing split (and
    // its "trailing gets nothing" refusal) is gone.
    expect(context.interiorHoles.map((turn) => turn.promptNumber)).toEqual([
      2, 4,
    ]);

    expect(
      context.windowTurns.map((turn) => turn.rawMaterial !== null),
    ).toEqual([false, true, false, true]);

    // Assert on the window section rather than the whole prompt: the arc
    // rendering above it is the production timeline view, which quotes prompt
    // prefixes of its own selection — that is a different surface with its own
    // rules, and this criterion is about the window's material budget.
    const prompt = renderNoteSettlementPrompt(context);
    const window = prompt.slice(prompt.indexOf("## Window turns"));
    expect(window).toContain("raw> user: INTERIOR HOLE PROMPT");
    expect(window).toContain("raw> assistant: INTERIOR HOLE RESPONSE");
    expect(window).toContain("raw> user: TRAILING HOLE PROMPT");
    expect(window).toContain("raw> assistant: TRAILING HOLE RESPONSE");
    // The window's notes are the material for turns that have one.
    expect(window).toContain("implement+settlement: lease fence");
  });

  test("caps hole material at the per-turn token budget", () => {
    const sessionDbId = seedSession();
    const long = "lease".repeat(4_000);
    const t1 = seedTurn(sessionDbId, 1, {
      userPrompt: long,
      assistantResponse: long,
    });
    seedDebt(t1, sessionDbId, 1, "skipped", "closed");
    const t2 = seedTurn(sessionDbId, 2, {
      note: { title: "fix+lease: done", content: "Done." },
    });
    seedDebt(t2, sessionDbId, 2, "noted", null);
    classifyThrough(sessionDbId, 2);

    const job = claimWindow(sessionDbId, 1, 2);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const hole = context.interiorHoles[0]!;
    expect(hole.rawMaterial).not.toBeNull();
    // 0.6 weight per Latin code point × 1.2 → ~2 code points per token.
    expect(hole.rawMaterial!.length).toBeLessThan(
      NOTE_SETTLEMENT_HOLE_TOKEN_BUDGET * 3,
    );
    expect(hole.rawMaterial).toContain("lease");
  });

  /**
   * ticket 02 (spec B1): the mechanical title-to-type derivation is retired,
   * not kept as a fallback — a window turn's line carries only mechanical
   * facts (kind, tool count, files, gap), never a drafted type/tag, and the
   * model states type/tags itself through `turn_review`.
   */
  test("the window's rendered line carries no drafted type or tag", () => {
    const fixture = seedInteriorHoleWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;

    const t1 = context.windowTurns.find((turn) => turn.promptNumber === 1)!;
    expect(t1).not.toHaveProperty("typeDraft");
    expect(t1).not.toHaveProperty("tagDraft");

    const prompt = renderNoteSettlementPrompt(context);
    const window = prompt.slice(prompt.indexOf("## Window turns"));
    expect(window).not.toContain("type_draft=");
    expect(window).not.toContain("tag_draft=");
  });

  test("the prompt states the rubric verbatim (imported, not restated) and the duty order", () => {
    const fixture = seedInteriorHoleWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;
    const prompt = renderNoteSettlementPrompt(context);

    // Ticket 06 (ADR-0003): the old absolute rubric's own words are GONE from
    // the prompt — replaced by the one-line election criterion, imported
    // verbatim from src/election.ts, never restated here.
    expect(prompt).not.toContain("Grade 4 — task origin or re-foundation");
    expect(prompt).not.toContain("Misleading-turn downgrade");
    expect(prompt).toContain(
      "How much does this task's future depend on this turn?",
    );
    expect(prompt).toContain("Seats are CEILINGS, never");

    // The duties appear in this order, and duty 1 is the turn review while
    // membership (duty 3, ticket 08's "MEMBERSHIP & PROPOSALS") comes after
    // both duty 1 (review) and duty 2 (reconstruction). Ticket 10a moved
    // duties 1-2 onto the `note` tool (no longer emitted in the final JSON
    // reply), so this now checks for the tool-call instruction, not a
    // `turn_review` key.
    const reviewIndex = prompt.indexOf("1. TURN REVIEW");
    const reconstructionIndex = prompt.indexOf("RECONSTRUCTION,");
    const membershipIndex = prompt.indexOf("MEMBERSHIP & PROPOSALS");
    expect(reviewIndex).toBeGreaterThan(-1);
    expect(reconstructionIndex).toBeGreaterThan(reviewIndex);
    expect(membershipIndex).toBeGreaterThan(reconstructionIndex);
    expect(prompt).toContain("via the `note` tool");
    expect(prompt).not.toContain("turn_review");
  });

  // Requirement 7 (ticket 07, spec C3/C4): the four ordered questions,
  // first-yes-wins, and specifically question 3's exact counterfactual
  // wording must reach the prompt verbatim — the note tool description
  // cannot carry it (487/500 tokens, 13 of headroom; see mcp/definitions.ts),
  // so this is the ONE place the decision procedure is stated in full.
  test("C3/C4's decision procedure reaches the prompt verbatim (spec C3/C4)", () => {
    const fixture = seedInteriorHoleWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;
    const prompt = renderNoteSettlementPrompt(context);

    expect(prompt.toLowerCase()).toContain("first yes wins");
    expect(prompt).toContain("(1) Did the citing turn overturn it? -> supersedes.");
    expect(prompt).toContain(
      "(2) Did the citing turn test its claim, supporting or undermining it?",
    );
    // Question 3's wording, verbatim and on ONE line — C4 makes this
    // normative and forbids softening it to "used" or "built on".
    expect(prompt).toContain(
      "If the cited turn were wrong, would the citing turn's conclusion also be wrong? -> depends-on.",
    );
    expect(prompt).toContain("(4) None of the above -> no relation");
    expect(prompt).toContain('"used"');
    expect(prompt).toContain('"built on"');
    // The pre-state eligibility rule (spec C7) is also stated, so the model
    // is told the constraint rather than only discovering it by rejection.
    expect(prompt).toContain("already existed before this");
    expect(prompt).toContain("you cannot invent a relation for a pair a call earlier");
  });
});

describe("settlement dispatch — staged writes and commit (ticket 10b, spec A7; re-scoped by ticket 08)", () => {
  test("a full run (review, reconstruction, membership, a relation) lands atomically once the agent calls commit", async () => {
    const fixture = seedInteriorHoleWindow();
    // Ticket 08: segment creation/naming is the main agent's alone
    // (ADR-0002) — both segments here are pre-created and ATTACHED as
    // fixture setup, standing in for what the main agent already did.
    const existing = createSegment(db, {
      title: "implement+lease: fencing the claim",
      content: "Earlier chapter.",
      nowEpoch: NOW - 5_000,
    });
    const holeReconstruction = createSegment(db, {
      title: "design+holes: reconstructing written-off turns",
      nowEpoch: NOW - 5_000,
    });
    attachSegmentToSession(db, fixture.sessionDbId, existing.id, NOW - 5_000);
    attachSegmentToSession(db, fixture.sessionDbId, holeReconstruction.id, NOW - 5_000);
    // Ticket 07 (spec C7): a judged relation is legal only on a pair present
    // BEFORE this window's run — seed the T3->T1 pair here (a prior bare
    // citation, in production) so the `dependsOn` relation below is
    // attaching to an existing pair, not minting one.
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

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(
      queryThatStages((engine, request) => {
        // Duty 1: review every window turn.
        engine.stageNoteWrite({ turn: "S1/T1", grade: 2, type: ["design"], tags: ["lease"] });
        engine.stageNoteWrite({
          turn: "S1/T3",
          grade: 3,
          type: ["implement", "correction"],
          tags: ["lease"],
          dependsOn: ["S1/T1"],
        });
        // Duty 2: reconstruct the two owed holes (T2, T4), through the SAME
        // note tool the review calls above used.
        engine.stageNoteWrite({
          turn: "S1/T2",
          title: "research+lease: what the hole covered",
          content: "Reconstructed from the raw material.",
          insight: null,
          grade: 1,
          type: ["research"],
          tags: ["lease"],
        });
        engine.stageNoteWrite({
          turn: "S1/T4",
          title: "research+lease: what the trailing gap covered",
          content: "The old refusal is gone (spec D7).",
          insight: null,
          grade: 1,
          type: ["research"],
          tags: ["lease"],
        });
        // Duty 3 (ticket 08): assign each turn to whichever attached segment
        // it fits.
        engine.stageMembershipWrite({ action: "assign", turn: "S1/T1", segmentId: existing.id });
        engine.stageMembershipWrite({ action: "assign", turn: "S1/T3", segmentId: existing.id });
        engine.stageMembershipWrite({
          action: "assign",
          turn: "S1/T2",
          segmentId: holeReconstruction.id,
        });
        engine.stageMembershipWrite({
          action: "assign",
          turn: "S1/T4",
          segmentId: holeReconstruction.id,
        });
        engine.commit();
      }),
      (value) => metricsSeen.push(value),
    )({ job: fixture.job });
    expect(outcome).toEqual({ ok: true });

    // Ticket 14 (spec K5a), still true under `assign`: type/tags are DERIVED
    // from the members the same run just reviewed. T1 is design, T3 is
    // implement+correction, each once, so the frequency tie breaks on
    // vocabulary order; both members carry the tag `lease`.
    const extended = getSegment(db, existing.id)!;
    expect(extended.type).toEqual(["design", "implement", "correction"]);
    expect(extended.tags).toEqual(["lease"]);
    const created = getSegment(db, holeReconstruction.id)!;
    expect(created.type).toEqual(["research"]);
    expect(created.tags).toEqual(["lease"]);

    // Membership, and anchors landed automatically by db/segments.ts.
    expect(getSegmentMemberTurnIds(db, existing.id)).toEqual([
      fixture.turnIds[0]!,
      fixture.turnIds[2]!,
    ]);
    expect(getSegmentMemberTurnIds(db, created.id).sort()).toEqual(
      [fixture.turnIds[1]!, fixture.turnIds[3]!].sort(),
    );

    // The judged relation (spec C7's pre-state gate).
    const judged = getOutgoingEdges(db, { kind: "turn", id: fixture.turnIds[2]! });
    expect(judged.some((edge) => edge.relation === "depends-on" && edge.provenance === "judged")).toBe(true);

    // Both holes reconstructed with settlement provenance.
    const holeNote = getShadowNote(db, fixture.turnIds[1]!)!;
    expect(holeNote.writerOrigin).toBe("settlement");
    expect(holeNote.title).toContain("what the hole covered");
    const trailingNote = getShadowNote(db, fixture.turnIds[3]!)!;
    expect(trailingNote.writerOrigin).toBe("settlement");

    // The agent's own note on T1 keeps its origin.
    expect(getShadowNote(db, fixture.turnIds[0]!)!.writerOrigin).toBe("agent");

    // Job/cursor resolution: `commit` is what did this, not the dispatch.
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(4);
    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.committed).toBe(true);

    // Ticket 10c/08: the job log's counts are sourced from `commit`'s own
    // replay, not from a payload nobody sends — checked against exactly what
    // this run staged above. T1 review-only (grade 2, no prose — it already
    // had a note); T3 review + a dependsOn relation; T2/T4 reconstruction +
    // review each; four assigns, no proposals.
    expect(metricsSeen[0]!.commit).toEqual({
      notesReconstructed: 2,
      notesYielded: 0,
      turnsReviewed: 4,
      reviewsYieldedToLateNote: 0,
      gradeHistogram: [0, 2, 1, 1, 0],
      tierCounts: { A: 0, B: 0, C: 0 },
      relationsWritten: 1,
      membersAdded: 4,
      proposalsCreated: 0,
    });
    // Attempt bookkeeping (spec A2a): a first-attempt success is convergence,
    // never abandonment — `attemptsExhausted` must read false even though
    // `job.attempts` (1) equals neither here nor at the cap.
    expect(metricsSeen[0]!.attempt).toBe(fixture.job.attempts);
    expect(metricsSeen[0]!.attemptsExhausted).toBe(false);
  });

  /**
   * ADR-0004's flagging half (ticket 08): the settlement report's own
   * section, wired at the dispatch seam — `db/note-settlement-summary-flags.ts`
   * is unit-tested on its own (tests/db/note-settlement-summary-flags.test.ts);
   * this proves `note-settlement-dispatch.ts` actually calls it after a real
   * commit and surfaces the result on the metrics sink, never inside the
   * agent-visible commit receipt (spec G9's discipline, extended).
   */
  test("a committed window's attached-segment summary claims are flagged on the metrics sink (ADR-0004)", async () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1, { note: { title: "design+lease: fence", content: "Fenced it." } });
    seedDebt(t1, sessionDbId, 1, "noted", null);
    classifyThrough(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    // An attached segment whose content is a bare, unsupported claim — the
    // citation-less heuristic.
    const segment = createSegment(db, {
      title: "chapter",
      content: "Revision complete and verified.",
      nowEpoch: NOW - 1_000,
    });
    attachSegmentToSession(db, sessionDbId, segment.id, NOW - 1_000);

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        engine.stageNoteWrite({ turn: "S1/T1", grade: 1, type: ["design"], tags: ["lease"] });
        engine.stageMembershipWrite({ action: "assign", turn: "S1/T1", segmentId: segment.id });
        engine.commit();
      }),
      (value) => metricsSeen.push(value),
    )({ job });

    expect(outcome).toEqual({ ok: true });
    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.summaryFlags).toEqual([
      { segmentId: segment.id, field: "content", reason: "citation-less" },
    ]);
  });

  test("commit is the only path that completes a job — a run that stages everything but never calls commit lands nothing (requirement 9)", async () => {
    const fixture = seedInteriorHoleWindow();

    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        engine.stageNoteWrite({
          turn: "S1/T2",
          title: "research+lease: staged but never committed",
          content: "Reconstructed from raw material.",
          insight: null,
          grade: 1,
          type: ["research"],
          tags: [],
        });
        // Deliberately no engine.commit() call.
      }),
    )({ job: fixture.job });

    expect(outcome.ok).toBe(false);
    // Nothing landed — staging without commit is exactly as durable as never
    // having called a tool at all.
    expect(getShadowNote(db, fixture.turnIds[1]!)).toBeNull();
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(0);
  });

  /**
   * Ticket 10c: the job log documents the three-strike cursor advance as
   * ABANDONING a remainder, not converging toward eventually settling it
   * (spec A2a). This dispatch never decides terminality itself (that is
   * db/note-settlement.ts's `failNoteSettlementJob`/`advanceNoteSettlementCursor`,
   * driven by the scheduler after this call returns) — it only reports
   * `job.attempts` against the same cap, which is why the fixture job here
   * is spread with a fabricated `attempts` rather than driven through three
   * real claim/fail cycles: the metrics computation reads no state this
   * dispatch itself would not already have in hand.
   */
  test("a failed run on the job's last attempt reports attemptsExhausted — abandonment, not convergence (spec A2a)", async () => {
    const fixture = seedInteriorHoleWindow();
    const lastAttemptJob = { ...fixture.job, attempts: NOTE_SETTLEMENT_MAX_ATTEMPTS };

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        engine.stageNoteWrite({
          turn: "S1/T2",
          title: "never committed",
          content: "Staged only.",
          insight: null,
        });
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
    const fixture = seedInteriorHoleWindow();
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
    const fixture = seedInteriorHoleWindow();
    const lastAttemptJob = { ...fixture.job, attempts: NOTE_SETTLEMENT_MAX_ATTEMPTS };

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        // T2/T4 are the fixture's holes — the note gate (G1a) refuses commit
        // until they are reconstructed, same as every other passing commit
        // test in this file.
        engine.stageNoteWrite({
          turn: "S1/T2",
          title: "reconstructed on the last attempt",
          content: "Filled in.",
          insight: null,
        });
        engine.stageNoteWrite({
          turn: "S1/T4",
          title: "reconstructed on the last attempt",
          content: "Filled in.",
          insight: null,
        });
        for (const turnId of fixture.turnIds) {
          updateTurnById(db, turnId, { type: ["research"] });
        }
        // This session attaches no segment, so the re-keyed segmentation
        // check (ticket 08) is trivially satisfied without a remember call.
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
    const fixture = seedInteriorHoleWindow();

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
   * Spec D7, the race a mechanical backfill must lose on purpose: the main
   * agent can write a hole's real note WHILE the model call is in flight —
   * after the window's context was read, before this run's own reconstruction
   * call lands. The agent's own account of its turn wins.
   */
  test("a mid-flight agent note wins over settlement's own reconstruction of the same turn", async () => {
    const fixture = seedInteriorHoleWindow();

    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        // The agent's own note lands mid-run, before this reconstruction call.
        upsertShadowNote(db, {
          turnId: fixture.turnIds[1]!,
          title: "agent+lease: the turn's own account",
          content: "Written by the agent while settlement was thinking.",
          nowEpoch: NOW,
        });
        engine.stageNoteWrite({
          turn: "S1/T2",
          title: "settlement's reconstruction",
          content: "Written from the raw material.",
          insight: null,
        });
        engine.stageNoteWrite({
          turn: "S1/T4",
          title: "settlement's reconstruction of the trailing hole",
          content: "Written from the raw material.",
          insight: null,
        });
        // This test's subject is the note-race, not coverage/membership —
        // satisfy commit's gate directly for every window turn. This session
        // attaches no segment, so the re-keyed segmentation check (ticket 08)
        // is trivially satisfied without a remember call.
        for (const turnId of fixture.turnIds) {
          updateTurnById(db, turnId, { type: ["research"] });
        }
        engine.commit();
      }),
    )({ job: fixture.job });

    expect(outcome).toEqual({ ok: true });
    const note = getShadowNote(db, fixture.turnIds[1]!)!;
    expect(note.writerOrigin).toBe("agent");
    expect(note.title).toBe("agent+lease: the turn's own account");
    // T4 has no racing write and lands as settlement's own reconstruction.
    expect(getShadowNote(db, fixture.turnIds[3]!)!.writerOrigin).toBe("settlement");
  });

  /**
   * A staged assign cannot be UN-staged — there is no operation for it (spec
   * A7's G5 dissolution: no per-write replay contract is needed precisely
   * because nothing landed, so the intended recovery from a replay conflict
   * is a CLEAN re-run, not patching around a now-permanently-stale entry
   * still sitting in this run's own staged list). This test therefore models
   * TWO separate dispatch attempts — a fresh `runQuery` call, a fresh
   * staging engine, exactly what the job's own attempt/retry mechanism
   * already provides — rather than trying to recover inside one run.
   *
   * Ticket 08: `assign` (unlike the retired `extend`) carries no revision
   * fence — membership is a plain idempotent insert, not a CAS rewrite — so
   * this demonstrates the GENERAL replay-refusal shape instead: a fact a
   * staged call depended on stops holding by commit time (here, the target
   * segment itself is gone — no production path deletes a segment today,
   * but the mechanism this proves is commit re-validating fresh, not
   * replaying blindly).
   */
  test("a vanished attach target refuses the whole commit; a fresh dispatch attempt against a valid one succeeds", async () => {
    const fixture = seedInteriorHoleWindow();
    const contested = createSegment(db, { title: "implement+lease: contested", nowEpoch: NOW - 5_000 });
    attachSegmentToSession(db, fixture.sessionDbId, contested.id, NOW - 5_000);

    function stageEveryDutyExceptMembership(engine: SettlementStagingEngine): void {
      // Every window turn needs to be accounted for before commit's gate
      // will pass — T2/T4 are holes, T1/T3 already have notes. Type
      // coverage is set directly; this test's subject is the replay
      // refusal, not review.
      for (const turnId of fixture.turnIds) {
        updateTurnById(db, turnId, { type: ["research"] });
      }
      engine.stageNoteWrite({
        turn: "S1/T2",
        title: "hole T2 reconstructed",
        content: "Filled in.",
        insight: null,
      });
      engine.stageNoteWrite({
        turn: "S1/T4",
        title: "hole T4 reconstructed",
        content: "Filled in.",
        insight: null,
      });
    }

    // Attempt 1: stages an assign against `contested`, then the segment
    // vanishes before commit — refuses whole.
    const firstOutcome = await dispatchWith(
      queryThatStages((engine) => {
        stageEveryDutyExceptMembership(engine);
        engine.stageMembershipWrite({ action: "assign", turn: "S1/T1", segmentId: contested.id });
        db.query<unknown, [number]>("DELETE FROM segments WHERE id = ?").run(contested.id);
        const refused = engine.commit();
        expect(refused.content[0]!.text).toContain("Commit refused");
      }),
    )({ job: fixture.job });
    expect(firstOutcome.ok).toBe(false);
    expect(getSegment(db, contested.id)).toBeNull();

    // Attempt 2: a genuinely fresh dispatch call — new `runQuery`
    // invocation, new staging engine, against a segment that is genuinely
    // still attached. The job is still `claimed` under the same generation
    // (nothing moved it), so this models the job's own next attempt rather
    // than a same-run patch.
    const recovery = createSegment(db, { title: "implement+lease: recovery", nowEpoch: NOW - 1_000 });
    attachSegmentToSession(db, fixture.sessionDbId, recovery.id, NOW - 1_000);
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        stageEveryDutyExceptMembership(engine);
        engine.stageMembershipWrite({ action: "assign", turn: "S1/T1", segmentId: recovery.id });
        engine.commit();
      }),
    )({ job: fixture.job });

    expect(outcome).toEqual({ ok: true });
    expect(getSegmentMemberTurnIds(db, recovery.id)).toEqual([fixture.turnIds[0]!]);
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
  });

  /**
   * Spec D4/D6: the subagent may revise a turn from an earlier window that is
   * still in its context — not a loophole, the mechanism the rubric's own
   * Grade-4 "provisional, confirmed or demoted later" language assumes. T1's
   * Grade 4 from window one is demoted in window two, once T1 is a PRECEDING
   * turn rather than a window turn.
   */
  test("a note call revises a turn settled by an earlier window once it is only in the preceding-turns context", async () => {
    const fixture = seedInteriorHoleWindow();
    const firstOutcome = await dispatchWith(
      queryThatStages((engine) => {
        // Spec A7a: a turn note's staging key is the turn address alone —
        // restaging T2/T4 for their review would REPLACE the reconstruction
        // call above rather than merge with it, so reconstruction and review
        // are stated together, one call per turn (exactly what duty 1/2's
        // shared `note` tool already allows).
        engine.stageNoteWrite({
          turn: "S1/T2",
          title: "research+lease: hole reconstructed",
          content: "Filled in.",
          insight: null,
          grade: 1,
          type: ["research"],
          tags: ["lease"],
        });
        engine.stageNoteWrite({
          turn: "S1/T4",
          title: "research+lease: trailing hole reconstructed",
          content: "Filled in.",
          insight: null,
          grade: 1,
          type: ["research"],
          tags: ["lease"],
        });
        engine.stageNoteWrite({ turn: "S1/T1", grade: 4, type: ["design"], tags: ["settlement"] });
        engine.stageNoteWrite({ turn: "S1/T3", grade: 2, type: ["implement"], tags: ["settlement"] });
        // This session attaches no segment, so the re-keyed segmentation
        // check (ticket 08) is trivially satisfied without a remember call.
        engine.commit();
      }),
    )({ job: fixture.job });
    expect(firstOutcome).toEqual({ ok: true });
    expect(getTurnById(db, fixture.turnIds[0]!)!.significanceGrade).toBe(4);

    // A second window, T5-T8: T1-T4 are now PRECEDING turns in its context,
    // not window turns — buildNoteSettlementContext still exposes them (the
    // previous-50 lookback), which is what makes citing S1/T1 legal here.
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
        // T1's arc turned out short-lived — demoted now that its real scale
        // is visible, exactly what the rubric's own Grade-4 language expects.
        engine.stageNoteWrite({ turn: "S1/T1", grade: 0, type: ["design"], tags: ["settlement"] });
        for (let promptNumber = 5; promptNumber <= 8; promptNumber += 1) {
          engine.stageNoteWrite({
            turn: `S1/T${promptNumber}`,
            grade: 1,
            type: ["implement"],
            tags: ["seam"],
          });
        }
        // This session attaches no segment, so the re-keyed segmentation
        // check (ticket 08) is trivially satisfied without a remember call —
        // this test's subject is the cross-window revision, not membership.
        engine.commit();
      }),
    )({ job: secondJob });

    expect(secondOutcome).toEqual({ ok: true });
    expect(getTurnById(db, fixture.turnIds[0]!)!.significanceGrade).toBe(0);
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

    // Ticket 08: creation/attachment is the main agent's, not settlement's —
    // pre-create and attach the segment settlement will assign into. This
    // dispatch reads `attachedSegmentIds` live off the DB (`buildNoteSettlementContext`),
    // so a REAL attachment row is required here, not just a context override.
    const segment = createSegment(db, { title: "implement+seam: the payload plugs in unchanged", nowEpoch: NOW - 1_000 });
    attachSegmentToSession(db, sessionDbId, segment.id, NOW - 1_000);

    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      nowMs: () => NOW * 1000,
      consecutiveTurns: 4,
      dispatch: dispatchWith(
        queryThatStages((engine) => {
          // Type coverage (duty 1), for every window turn — membership
          // below covers duty 3, and each turn already carries a note from
          // the fixture (duty 2).
          for (let promptNumber = 1; promptNumber <= 4; promptNumber += 1) {
            engine.stageNoteWrite({
              turn: `S1/T${promptNumber}`,
              grade: 1,
              type: ["implement"],
              tags: ["scheduler seam"],
            });
            engine.stageMembershipWrite({
              action: "assign",
              turn: `S1/T${promptNumber}`,
              segmentId: segment.id,
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

    expect(getSegment(db, segment.id)!.title).toContain("plugs in unchanged");
    expect(getSegmentMemberTurnIds(db, segment.id)).toHaveLength(4);
    // commit already completed the job and moved the cursor inside its own
    // transaction; the scheduler's completion re-asserts the same facts.
    expect(getNoteSettlementJob(db, pass.created[0]!.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(4);
  });

  test("a genuine gap end to end lands a settlement-authored note through the scheduler", async () => {
    const sessionDbId = seedSession();
    if (sessionDbId !== 1) {
      throw new Error("fixture expected session id 1");
    }
    const t1 = seedTurn(sessionDbId, 1, {
      note: { title: "design+seam: window shape", content: "Chose windows." },
    });
    seedDebt(t1, sessionDbId, 1, "noted", null);
    // T2 has no note AND no note_debt row at all — a plain gap. Spec D7: a
    // missing debt row no longer reads as "trivial", it is a hole like any
    // other.
    const t2 = seedTurn(sessionDbId, 2, {
      userPrompt: "GAP PROMPT never written up",
      assistantResponse: "GAP RESPONSE never written up",
    });
    // Turn 3, still open: turn 2 alone is not yet decided (spec D10).
    seedTurn(sessionDbId, 3, { userPrompt: "still open" });
    classifyThrough(sessionDbId, 2);

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const dispatch = createNoteSettlementDispatch({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      runQuery: queryThatStages((engine) => {
        engine.stageNoteWrite({
          turn: "S1/T2",
          title: "research+seam: reconstructed end to end",
          content: "Filled in from raw material.",
          insight: null,
        });
        // This session attaches no segment, so the re-keyed segmentation
        // check (ticket 08) is trivially satisfied without a remember call.
        updateTurnById(db, t1, { type: ["design"] });
        updateTurnById(db, t2, { type: ["research"] });
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
      consecutiveTurns: 2,
      dispatch,
      logger: { warn: () => {}, error: () => {} },
    });

    const pass = await scheduler.onTurnStop(sessionDbId);
    expect(pass.dispatched).toHaveLength(1);

    const note = getShadowNote(db, t2)!;
    expect(note.writerOrigin).toBe("settlement");
    expect(note.title).toContain("reconstructed end to end");
    expect(getNoteSettlementJob(db, pass.created[0]!.id)!.status).toBe("done");
    // Requirement 9's observable end to end: the metrics sink (the same
    // seam the ticket's own log line used to prove `notesReconstructed`
    // through) now reports the run's committed status, sourced from the job
    // row `commit` moved — never from a parsed envelope.
    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.committed).toBe(true);
  });
});
