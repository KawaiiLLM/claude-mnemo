import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase, runWriteTransaction } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  transitionNoteSettlementJobToEdges,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  insertImpressionDebt,
  readLaneImpression,
  replaceLaneImpression,
} from "../../src/db/impressions";
import { recordLaneTouch } from "../../src/db/lane-disposition";
import { insertLane } from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  createSegment,
  readSegmentTaskImpression,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { updateTurnById } from "../../src/db/turns";
import {
  anchorResolverFromResolvedSet,
  impressionCapForLane,
  validateImpression,
  TASK_IMPRESSION_TOKEN_CAP,
} from "../../src/shared/lane-impressions";
import { settledMemberIdsForLane } from "../../src/mcp/timeline";
import { readNoteSettlementLaneMemberSnapshot } from "../../src/db/note-settlement-snapshots";
import { createSettlementDirectWriteEngine } from "../../src/worker/note-settlement-direct-write";
import {
  computeTouchedImpressionContainers,
  loadImpressionAdvisories,
  createSettlementImpressionMaintainer,
  ImpressionSettlementRefused,
  membershipGenerationOf,
  normalizeImpressionText,
  renderImpressionAdvisories,
  renderSettlementImpressionAdvisoryBlock,
  resolveEraCutoffForImpressions,
  settleImpressions,
  vouchProjectedLaneMembers,
  type PendingImpressionDecision,
  type SettleImpressionsOutcome,
} from "../../src/worker/note-settlement-impressions";
import {
  IMPRESSION_GOLDEN_SAMPLE_FULL,
  IMPRESSION_GOLDEN_SAMPLE_THIN,
  renderImpressionTeaching,
} from "../../src/worker/note-settlement-impression-teaching";
import {
  retiredImpressionsArgument,
  SETTLEMENT_COMMIT_IMPRESSION_DUTY_DESCRIPTION,
  SETTLEMENT_COMMIT_INPUT_SHAPE,
  SETTLEMENT_COMMIT_TOOL_DESCRIPTION,
  SETTLEMENT_REMEMBER_IMPRESSION_DESCRIPTION,
  SETTLEMENT_REMEMBER_TOOL_DESCRIPTION,
  UNIFIED_COMMIT_TOOL_DESCRIPTION,
  UNIFIED_REMEMBER_TOOL_DESCRIPTION,
} from "../../src/worker/note-settlement-sdk-query";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * THE SETTLEMENT WRITE PATH FOR IMPRESSIONS (lane-impressions spec Rev 8,
 * ticket 02). One property per test, and every assertion is about a TRANSACTION
 * OUTCOME or a RENDERED SURFACE — never a writer internal (the spec's own
 * "Good tests" rule).
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

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  sessionDbId: number;
  segmentId: number;
  turnIds: number[];
  job: NoteSettlementJob;
}

function seedSession(): number {
  return upsertSession(db, {
    contentSessionId: "impression-fixture-session",
    project: "/tmp/project-impressions",
    title: "impression fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(sessionDbId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, ?, 'active', ?, ?, 1, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      SETTLEMENT_ERA_CUTOFF_EPOCH + promptNumber,
    )!.id;
}

/**
 * A task with one declared lane, three member turns carrying its tag, a claimed
 * settlement job already TRANSITIONED to the edge pass — so the frozen worklist
 * and the per-lane member snapshot the caps read both exist, exactly as they do
 * for a real run reaching `commit`.
 */
function seedFixture(options: { lanes?: string[] } = {}): Fixture {
  const lanes = options.lanes ?? ["visual-style"];
  const sessionDbId = seedSession();
  const segmentId = createSegment(db, {
    title: "impression fixture task",
    content: null,
    insight: null,
    type: [],
    tags: ["impression-fixture"],
    nowEpoch: NOW - 5_000,
  }).id;
  const turnIds = [1, 2, 3].map((promptNumber) => seedTurn(sessionDbId, promptNumber));
  addSegmentMembers(db, segmentId, turnIds, NOW);
  for (const tag of lanes) {
    insertLane(db, segmentId, tag, NOW - 4_000);
  }
  for (const turnId of turnIds) {
    updateTurnById(db, turnId, {
      type: ["design"],
      tags: ["impression-fixture", ...lanes],
      updatedAtEpoch: NOW,
    });
  }

  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 3, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const claimed = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!claimed) {
    throw new Error("fixture failed to claim a settlement job");
  }
  const transitioned = transitionNoteSettlementJobToEdges(
    db,
    claimed.id,
    claimed.claimGeneration,
    NOW,
    {
      snapshots: {
        window: turnIds,
        lookback: [],
        closure: [],
        worklist: lanes.map((tag) => ({ segmentId, laneTag: tag })),
      },
    },
  );
  if (!transitioned) {
    throw new Error("fixture failed to transition");
  }
  return { sessionDbId, segmentId, turnIds, job: getNoteSettlementJob(db, claimed.id)! };
}

function maintainerFor(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return createSettlementImpressionMaintainer({
    db,
    jobId: fixture.job.id,
    claimGeneration: fixture.job.claimGeneration,
    readStage: () => "edges",
    readWritableTurnIds: () => new Set(fixture.turnIds),
    now: () => NOW,
    ...overrides,
  });
}

type Maintainer = ReturnType<typeof maintainerFor>;

/**
 * THE WRITE, as the `remember` tool makes it (lane-impressions ticket 10): one
 * container per call. Returns the FIRST refusal text, or "" when every decision
 * was recorded — so a test can assert which call refused, which is the whole
 * property this ticket moved.
 */
function decideAll(
  maintainer: Maintainer,
  entries: ReadonlyArray<Record<string, unknown>>,
): string {
  for (const entry of entries) {
    const result = maintainer.decide(db, { action: "impression", ...entry });
    if (!result.ok) {
      return result.text;
    }
  }
  return "";
}

/** The terminal check, alone. Returns the refusal text, or "" on a clean promotion. */
function commitRefusal(maintainer: Maintainer): string {
  try {
    maintainer.settle(db);
    return "";
  } catch (error) {
    if (error instanceof ImpressionSettlementRefused) {
      return error.message;
    }
    throw error;
  }
}

/** Decide everything, then promote — the ordinary two-step, for tests about the outcome. */
function decideAndSettle(
  maintainer: Maintainer,
  entries: ReadonlyArray<Record<string, unknown>>,
): SettleImpressionsOutcome {
  expect(decideAll(maintainer, entries)).toBe("");
  return maintainer.settle(db);
}

function laneAddress(fixture: Fixture, tag = "visual-style"): string {
  return `E${fixture.segmentId}/#${tag}`;
}

/** The advisories this run would be shown — the coordinates a decision carries. */
function loadAdvisoriesFor(fixture: Fixture) {
  return loadImpressionAdvisories(
    db,
    computeTouchedImpressionContainers(db, fixture.job.id),
    {
      eraCutoffEpoch: resolveEraCutoffForImpressions(db),
      projectedByLane: readNoteSettlementLaneMemberSnapshot(db, fixture.job.id),
      writableTurnIds: new Set(fixture.turnIds),
    },
  ).advisories;
}

/** A legal replacement for the fixture's lane: one global line, anchors that resolve. */
function legalText(fixture: Fixture): string {
  return (
    `The fixture lane: three turns describe one subject and the design still governs ` +
    `(S${fixture.sessionDbId}/T1, T2).\n` +
    `Frontier: the third turn's question is still open (S${fixture.sessionDbId}/T3).`
  );
}

// ---------------------------------------------------------------------------
// Touched set
// ---------------------------------------------------------------------------

describe("the touched set is the union of the frozen worklist, the durable touch ledger and the claimed debts", () => {
  test("a worklist lane and its task tier are both touched", () => {
    const fixture = seedFixture();
    const containers = computeTouchedImpressionContainers(db, fixture.job.id);
    expect(containers.map((container) => container.address)).toEqual([
      laneAddress(fixture),
      `E${fixture.segmentId}`,
    ]);
  });

  test("an edge side this run placed touches its lane even when the worklist never named it", () => {
    const fixture = seedFixture({ lanes: ["visual-style", "elevation"] });
    // The worklist froze ONE lane; the run then placed an edge whose HEAD side
    // names the other. Both directions are recorded as `turn-tag` touches.
    db.query("DELETE FROM note_settlement_worklist WHERE lane_tag = ?").run("elevation");
    recordLaneTouch(db, {
      jobId: fixture.job.id,
      kind: "turn-tag",
      entityId: fixture.turnIds[2]!,
      laneTag: "elevation",
      createdAtEpoch: NOW,
    });
    const addresses = computeTouchedImpressionContainers(db, fixture.job.id).map(
      (container) => container.address,
    );
    expect(addresses).toContain(laneAddress(fixture, "elevation"));
  });

  test("a topic word riding the same ledger is NOT a container — only declared lanes are", () => {
    const fixture = seedFixture();
    recordLaneTouch(db, {
      jobId: fixture.job.id,
      kind: "turn-tag",
      entityId: fixture.turnIds[0]!,
      laneTag: "topic:isometric",
      createdAtEpoch: NOW,
    });
    const addresses = computeTouchedImpressionContainers(db, fixture.job.id).map(
      (container) => container.address,
    );
    expect(addresses).not.toContain(`E${fixture.segmentId}/#topic:isometric`);
  });

  test("a claimed lifecycle debt names its own lane, and a task-tier debt its own task", () => {
    const fixture = seedFixture();
    const otherSegmentId = createSegment(db, {
      title: "another task",
      content: null,
      insight: null,
      type: [],
      tags: [],
      nowEpoch: NOW,
    }).id;
    insertLane(db, otherSegmentId, "renamed-lane", NOW);
    const laneDebt = insertImpressionDebt(db, {
      segmentId: otherSegmentId,
      laneTag: "renamed-lane",
      kind: "rename",
      nowEpoch: NOW,
    });
    const taskDebt = insertImpressionDebt(db, {
      segmentId: otherSegmentId,
      laneTag: null,
      kind: "task-retag",
      nowEpoch: NOW,
    });
    const addresses = computeTouchedImpressionContainers(db, fixture.job.id, [
      laneDebt,
      taskDebt,
    ]).map((container) => container.address);
    expect(addresses).toContain(`E${otherSegmentId}/#renamed-lane`);
    expect(addresses).toContain(`E${otherSegmentId}`);
  });
});

// ---------------------------------------------------------------------------
// Advisory: the writer is never asked to write blind to its budget
// ---------------------------------------------------------------------------

describe("the advisory carries current text, base revision and the cap", () => {
  test("the block names each container's cap, its post-commit member count and its stored text", () => {
    const fixture = seedFixture();
    replaceLaneImpression(db, {
      segmentId: fixture.segmentId,
      tag: "visual-style",
      baseRevision: 0,
      text: "The fixture lane, as previously written.",
    });
    const block = renderSettlementImpressionAdvisoryBlock(
      db,
      fixture.job.id,
      new Set(fixture.turnIds),
    );
    expect(block).toContain(`${laneAddress(fixture)} — lane, baseRevision 1,`);
    // Three window members, none settled yet — the projection is what supplies
    // the count, which is the whole point of the post-commit form.
    expect(block).toContain("cap 100 tokens (3 settled member(s), post-commit)");
    expect(block).toContain("The fixture lane, as previously written.");
    expect(block).toContain(`E${fixture.segmentId} — task tier, baseRevision 0, cap 500 tokens (flat)`);
  });

  test("the cap is the integer formula over the SAME set the membership digest is taken over", () => {
    const fixture = seedFixture();
    const ids = settledMemberIdsForLane(
      db,
      fixture.segmentId,
      "visual-style",
      SETTLEMENT_ERA_CUTOFF_EPOCH,
      fixture.turnIds,
    );
    expect(ids).toEqual([...fixture.turnIds].sort((a, b) => a - b));
    expect(impressionCapForLane(ids.length)).toBe(100);
    expect(membershipGenerationOf(ids)).toBe(membershipGenerationOf([...ids].reverse()));
    expect(membershipGenerationOf(ids)).not.toBe(membershipGenerationOf(ids.slice(1)));
  });
});

// ---------------------------------------------------------------------------
// Coverage: a touched container with no judgment is a rejected payload
// ---------------------------------------------------------------------------

describe("`commit` checks the DUTY: every touched container carries a decision", () => {
  test("a container with no decision refuses the commit, naming it", () => {
    const fixture = seedFixture();
    const maintainer = maintainerFor(fixture);
    expect(
      decideAll(maintainer, [
        { id: laneAddress(fixture), baseRevision: 0, decision: "retain" },
      ]),
    ).toBe("");
    const refusal = commitRefusal(maintainer);
    expect(refusal).toContain("does not carry a current decision for every container");
    expect(refusal).toContain(`no decision recorded for: E${fixture.segmentId}`);
  });

  test("a container this run never touched is refused AT THE WRITE, not at the commit", () => {
    const fixture = seedFixture();
    const maintainer = maintainerFor(fixture);
    const refusal = decideAll(maintainer, [
      { id: "E999/#stranger", baseRevision: 0, decision: "retain" },
    ]);
    expect(refusal).toContain("Impression refused");
    expect(refusal).toContain("E999/#stranger is not a container this run touched");
    // It never became pending, so it cannot reach the commit at all.
    expect([...maintainer.pending().keys()]).toEqual([]);
  });

  test("a container that LEAVES the touched set after its decision refuses the commit", () => {
    const fixture = seedFixture({ lanes: ["visual-style", "elevation"] });
    const maintainer = maintainerFor(fixture);
    expect(
      decideAll(maintainer, [
        { id: laneAddress(fixture), baseRevision: 0, decision: "retain" },
        { id: laneAddress(fixture, "elevation"), baseRevision: 0, decision: "retain" },
        { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
      ]),
    ).toBe("");
    // A manual lifecycle write removes the lane under the run: its decision is
    // now about a container this run no longer touches.
    db.query("DELETE FROM lanes WHERE segment_id = ? AND tag = ?").run(
      fixture.segmentId,
      "elevation",
    );
    const refusal = commitRefusal(maintainer);
    expect(refusal).toContain("no longer touched by this run");
    expect(refusal).toContain(laneAddress(fixture, "elevation"));
  });

  test("a run that decided nothing against an empty touched set commits cleanly", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    enqueueNoteSettlementWindows(
      db,
      [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 1, triggerType: "consecutive" }],
      NOW,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    );
    const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000)!;
    const outcome = createSettlementImpressionMaintainer({
      db,
      jobId: job.id,
      claimGeneration: job.claimGeneration,
      readStage: () => job.stage,
      readWritableTurnIds: () => new Set<number>(),
      now: () => NOW,
    }).settle(db);
    expect(outcome).toEqual({ replaced: 0, retained: 0, ackedDebts: 0, advisories: [] });
  });
});

// ---------------------------------------------------------------------------
// The principal
// ---------------------------------------------------------------------------

describe("the impression write is SETTLEMENT-ONLY, gated on the run's lease", () => {
  test("a caller whose claim generation is stale is refused, naming the lease", () => {
    const fixture = seedFixture();
    const impostor = maintainerFor(fixture, {
      claimGeneration: fixture.job.claimGeneration + 1,
    });
    const refusal = decideAll(impostor, [
      { id: laneAddress(fixture), baseRevision: 0, decision: "retain" },
    ]);
    expect(refusal).toContain("belongs to the settlement run that holds this window's lease");
    expect(refusal).toContain("is stale");
    expect([...impostor.pending().keys()]).toEqual([]);
  });

  test("a caller believing the wrong stage is refused — the lease is the full tuple", () => {
    const fixture = seedFixture();
    const impostor = maintainerFor(fixture, { readStage: () => "topics" });
    expect(
      decideAll(impostor, [{ id: laneAddress(fixture), baseRevision: 0, decision: "retain" }]),
    ).toContain("stage topics is stale");
  });

  test("a run whose job is no longer claimed writes nothing", () => {
    const fixture = seedFixture();
    const maintainer = maintainerFor(fixture);
    db.query("UPDATE note_settlement_jobs SET status = 'done' WHERE id = ?").run(
      fixture.job.id,
    );
    expect(
      decideAll(maintainer, [{ id: laneAddress(fixture), baseRevision: 0, decision: "retain" }]),
    ).toContain("not claimed");
  });
});

// ---------------------------------------------------------------------------
// The fences
// ---------------------------------------------------------------------------

describe("the terminal transaction rejects the WHOLE commit on any drift", () => {
  /** Both of the fixture's containers, decided; the lane's decision is the caller's. */
  function decideBoth(
    maintainer: Maintainer,
    fixture: Fixture,
    lane: { baseRevision: number; decision: "retain" | "replace"; text?: string },
  ): string {
    return decideAll(maintainer, [
      { id: laneAddress(fixture), ...lane },
      { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
    ]);
  }

  test("two jobs read v1; the first commits v2 and the second's ENTIRE commit rejects", () => {
    const fixture = seedFixture();
    const maintainer = maintainerFor(fixture);
    maintainer.renderAdvisories();
    expect(
      decideBoth(maintainer, fixture, {
        baseRevision: 0,
        decision: "replace",
        text: legalText(fixture),
      }),
    ).toBe("");
    // The FIRST job's commit, landing between the second's decision and its own.
    expect(
      replaceLaneImpression(db, {
        segmentId: fixture.segmentId,
        tag: "visual-style",
        baseRevision: 0,
        text: "The first job's impression.",
      }),
    ).toBe(true);

    const refusal = commitRefusal(maintainer);
    expect(refusal).toContain("you decided against revision 0");
    expect(refusal).toContain("the stored revision is now 1");
    // The whole commit is rejected: the first job's text stands untouched.
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBe(
      "The first job's impression.",
    );
  });

  test("A's WRITE is refused outright when B replaced before it decided", () => {
    const fixture = seedFixture();
    replaceLaneImpression(db, {
      segmentId: fixture.segmentId,
      tag: "visual-style",
      baseRevision: 0,
      text: "B's replacement.",
    });
    const refusal = decideBoth(maintainerFor(fixture), fixture, {
      baseRevision: 0,
      decision: "retain",
    });
    expect(refusal).toContain("baseRevision 0 is not the stored revision 1");
  });

  test("A retains at v1 while B replaces to v2 AFTERWARDS — A's commit rejects (the retain fence)", () => {
    const fixture = seedFixture();
    const maintainer = maintainerFor(fixture);
    expect(decideBoth(maintainer, fixture, { baseRevision: 0, decision: "retain" })).toBe("");
    replaceLaneImpression(db, {
      segmentId: fixture.segmentId,
      tag: "visual-style",
      baseRevision: 0,
      text: "B's replacement.",
    });
    expect(commitRefusal(maintainer)).toContain("the stored revision is now 1");
  });

  test("membership moved without the impression row moving — the commit still rejects", () => {
    const fixture = seedFixture();
    const maintainer = maintainerFor(fixture);
    maintainer.renderAdvisories();
    expect(decideBoth(maintainer, fixture, { baseRevision: 0, decision: "retain" })).toBe("");
    // A tag write elsewhere takes one member OUT of the lane. The impression
    // row is untouched, so its revision still reads 0 — only the membership
    // digest can see this.
    updateTurnById(db, fixture.turnIds[2]!, {
      tags: ["impression-fixture"],
      updatedAtEpoch: NOW,
    });
    expect(commitRefusal(maintainer)).toContain("membership moved under you");
  });

  test("settled membership moves OUTSIDE this window's projection — only the generation fence can see it", () => {
    const fixture = seedFixture();
    // A fourth turn, already covered by an earlier COMMITTED window and a member
    // of the task, but not yet carrying the lane's tag. It is outside this
    // window's projection, so the projection-offender assertion (ticket 01's
    // handoff (b)) can never see it move — this is the case that isolates the
    // membership-generation fence from every other rejection path.
    const outsider = seedTurn(fixture.sessionDbId, 4);
    addSegmentMembers(db, fixture.segmentId, [outsider], NOW);
    db.query(
      `INSERT INTO note_settlement_jobs (
         session_id, window_start, window_end, trigger_type,
         status, attempts, retry_at_epoch, created_at_epoch, updated_at_epoch
       ) VALUES (?, 4, 4, 'sessionend', 'done', 1, 0, ?, ?)`,
    ).run(fixture.sessionDbId, NOW, NOW);

    const maintainer = maintainerFor(fixture);
    expect(decideBoth(maintainer, fixture, { baseRevision: 0, decision: "retain" })).toBe("");
    // It joins the lane after the decision: the settled half of the universe
    // grows, the impression row never moves (its revision still reads 0), and
    // nothing this window projected has left.
    updateTurnById(db, outsider, {
      tags: ["impression-fixture", "visual-style"],
      updatedAtEpoch: NOW,
    });

    expect(commitRefusal(maintainer)).toContain(
      "settled membership moved since you decided it",
    );
  });

  test("a STALE container may not be retained — refused at the write", () => {
    const fixture = seedFixture();
    db.query("UPDATE lanes SET impression_stale = 1 WHERE segment_id = ? AND tag = ?").run(
      fixture.segmentId,
      "visual-style",
    );
    expect(
      decideBoth(maintainerFor(fixture), fixture, { baseRevision: 0, decision: "retain" }),
    ).toContain("this container is STALE");
  });

  test("a container that goes STALE AFTER its retain is decided refuses the commit", () => {
    const fixture = seedFixture();
    const maintainer = maintainerFor(fixture);
    expect(decideBoth(maintainer, fixture, { baseRevision: 0, decision: "retain" })).toBe("");
    db.query("UPDATE lanes SET impression_stale = 1 WHERE segment_id = ? AND tag = ?").run(
      fixture.segmentId,
      "visual-style",
    );
    expect(commitRefusal(maintainer)).toContain("this container is STALE");
  });

  test("STALE clears with the COMMIT, never with the write that proposed the replacement", () => {
    const fixture = seedFixture();
    db.query("UPDATE lanes SET impression_stale = 1 WHERE segment_id = ? AND tag = ?").run(
      fixture.segmentId,
      "visual-style",
    );
    const maintainer = maintainerFor(fixture);
    expect(
      decideBoth(maintainer, fixture, {
        baseRevision: 0,
        decision: "replace",
        text: legalText(fixture),
      }),
    ).toBe("");
    // The decision is recorded and the flag still stands: a run that dies here
    // has discharged nothing, and the next run is still told the container is
    // owed a rewrite.
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.stale).toBe(true);
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBeNull();

    maintainer.settle(db);
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unchanged guard
// ---------------------------------------------------------------------------

describe("the unchanged guard keeps a retained impression byte-identical", () => {
  test("a touched lane with no semantic change retains, byte-identical, fence still checked", () => {
    const fixture = seedFixture();
    const stored = "The fixture lane, unchanged since the last window.";
    replaceLaneImpression(db, {
      segmentId: fixture.segmentId,
      tag: "visual-style",
      baseRevision: 0,
      text: stored,
    });
    const outcome = decideAndSettle(maintainerFor(fixture), [
      { id: laneAddress(fixture), baseRevision: 1, decision: "retain" },
      { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
    ]);
    expect(outcome.retained).toBe(2);
    expect(outcome.replaced).toBe(0);
    const after = readLaneImpression(db, fixture.segmentId, "visual-style")!;
    expect(after.text).toBe(stored);
    // A retain touches nothing — not even the revision.
    expect(after.revision).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Anchor invalidation
// ---------------------------------------------------------------------------

describe("anchor invalidation runs unconditionally for every touched container", () => {
  function overrideEdge(fixture: Fixture, citing: number, cited: number, relation: "override" | "narrows") {
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation,
          provenance: "asserted",
          tailTag: "visual-style",
          headTag: "visual-style",
        },
      ],
      NOW,
    );
  }

  test("an override landing on an anchored claim refuses the retain and names the anchor", () => {
    const fixture = seedFixture();
    replaceLaneImpression(db, {
      segmentId: fixture.segmentId,
      tag: "visual-style",
      baseRevision: 0,
      text: `The fixture lane rests on S${fixture.sessionDbId}/T1.`,
    });
    overrideEdge(fixture, fixture.turnIds[2]!, fixture.turnIds[0]!, "override");
    const refusal = decideAll(maintainerFor(fixture), [
      { id: laneAddress(fixture), baseRevision: 1, decision: "retain" },
      { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
    ]);
    expect(refusal).toContain(`overrode the anchor(s) S${fixture.sessionDbId}/T1`);
  });

  test("an override landing AFTER the retain was decided refuses the commit", () => {
    const fixture = seedFixture();
    replaceLaneImpression(db, {
      segmentId: fixture.segmentId,
      tag: "visual-style",
      baseRevision: 0,
      text: `The fixture lane rests on S${fixture.sessionDbId}/T1.`,
    });
    const maintainer = maintainerFor(fixture);
    expect(
      decideAll(maintainer, [
        { id: laneAddress(fixture), baseRevision: 1, decision: "retain" },
        { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
      ]),
    ).toBe("");
    overrideEdge(fixture, fixture.turnIds[2]!, fixture.turnIds[0]!, "override");
    expect(commitRefusal(maintainer)).toContain(
      `overrode the anchor(s) S${fixture.sessionDbId}/T1`,
    );
  });

  test("the HEAD-lane side sees the same override — the check is not tail-side", () => {
    const fixture = seedFixture({ lanes: ["visual-style", "elevation"] });
    // The overridden turn's OTHER lane holds the anchored claim; that lane is
    // touched as an edge HEAD, and its retain is refused by the same rule.
    replaceLaneImpression(db, {
      segmentId: fixture.segmentId,
      tag: "elevation",
      baseRevision: 0,
      text: `The elevation lane rests on S${fixture.sessionDbId}/T1.`,
    });
    overrideEdge(fixture, fixture.turnIds[2]!, fixture.turnIds[0]!, "override");
    const block = renderSettlementImpressionAdvisoryBlock(
      db,
      fixture.job.id,
      new Set(fixture.turnIds),
    );
    expect(block).toContain(`OVERRIDDEN anchors: S${fixture.sessionDbId}/T1`);
  });

  test("a narrows edge NUDGES — it is reported and it blocks nothing", () => {
    const fixture = seedFixture();
    replaceLaneImpression(db, {
      segmentId: fixture.segmentId,
      tag: "visual-style",
      baseRevision: 0,
      text: `The fixture lane rests on S${fixture.sessionDbId}/T1.`,
    });
    overrideEdge(fixture, fixture.turnIds[2]!, fixture.turnIds[0]!, "narrows");
    const block = renderSettlementImpressionAdvisoryBlock(
      db,
      fixture.job.id,
      new Set(fixture.turnIds),
    );
    expect(block).toContain(`NARROWED anchors: S${fixture.sessionDbId}/T1`);
    const outcome = decideAndSettle(maintainerFor(fixture), [
      { id: laneAddress(fixture), baseRevision: 1, decision: "retain" },
      { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
    ]);
    expect(outcome.retained).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Replacement and validation
// ---------------------------------------------------------------------------

describe("a replacement is validated against the recomputed cap", () => {
  test("a legal replacement lands with a bumped revision", () => {
    const fixture = seedFixture();
    const text = legalText(fixture);
    const outcome = decideAndSettle(maintainerFor(fixture), [
      { id: laneAddress(fixture), baseRevision: 0, decision: "replace", text },
      { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
    ]);
    expect(outcome.replaced).toBe(1);
    const after = readLaneImpression(db, fixture.segmentId, "visual-style")!;
    expect(after.text).toBe(text);
    expect(after.revision).toBe(1);
  });

  test("the task tier's replacement lands in the segment's content, and CLAIMS the slot", () => {
    const fixture = seedFixture();
    const text = `The fixture task: one lane, three turns (S${fixture.sessionDbId}/T1).`;
    decideAndSettle(maintainerFor(fixture), [
      { id: laneAddress(fixture), baseRevision: 0, decision: "retain" },
      { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "replace", text },
    ]);
    const stored = readSegmentTaskImpression(db, fixture.segmentId)!;
    expect(stored.text).toBe(text);
    // The slot is CLAIMED by this write and by nothing else: before it, the
    // task-tier read returns no text at all (lane-impressions ticket 05 —
    // `impression_origin` is the one remaining tenancy mark for `content`).
    expect(
      db
        .query<{ origin: string | null }, [number]>(
          "SELECT impression_origin AS origin FROM segments WHERE id = ?",
        )
        .get(fixture.segmentId)?.origin,
    ).toBe("settlement");
  });

  test("a replacement over its lane's cap is refused, with the cap named", () => {
    const fixture = seedFixture();
    const long = `${"budget ".repeat(200)}(S${fixture.sessionDbId}/T1).`;
    const refusal = decideAll(maintainerFor(fixture), [
      { id: laneAddress(fixture), baseRevision: 0, decision: "replace", text: long },
    ]);
    expect(refusal).toContain("failed the write-time validator");
    expect(refusal).toContain("100-token cap");
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBeNull();
  });

  test("a delivery word with no anchor on its line is refused (the deterministic tier, live)", () => {
    const fixture = seedFixture();
    const refusal = decideAll(maintainerFor(fixture), [
      {
        id: laneAddress(fixture),
        baseRevision: 0,
        decision: "replace",
        text: "The fixture lane shipped.",
      },
    ]);
    expect(refusal).toContain("delivery-anchor");
  });

  test("TICKET 01 HANDOFF (d): a trailing newline is tolerated at the write path, and never stored", () => {
    const fixture = seedFixture();
    const text = legalText(fixture);
    expect(normalizeImpressionText(`${text}\n`)).toBe(text);
    decideAndSettle(maintainerFor(fixture), [
      { id: laneAddress(fixture), baseRevision: 0, decision: "replace", text: `${text}\n\n` },
      { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
    ]);
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Ticket 01's handoffs (a) and (b)
// ---------------------------------------------------------------------------

describe("ticket 01's handoffs, answered", () => {
  test("(b) a projected id that is NOT a member of this lane is named, not silently counted", () => {
    const fixture = seedFixture();
    const stranger = seedTurn(fixture.sessionDbId, 9);
    const { vouched, offenders } = vouchProjectedLaneMembers(
      db,
      fixture.segmentId,
      "visual-style",
      [...fixture.turnIds, stranger],
    );
    expect(vouched).toEqual([...fixture.turnIds].sort((a, b) => a - b));
    expect(offenders).toEqual([stranger]);
  });

  test("(b) the terminal transaction turns that vouching failure into the whole commit's rejection", () => {
    const fixture = seedFixture();
    const maintainer = maintainerFor(fixture);
    expect(
      decideAll(maintainer, [
        { id: laneAddress(fixture), baseRevision: 0, decision: "retain" },
        { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
      ]),
    ).toBe("");
    // The frozen snapshot still names a turn the lane no longer holds.
    updateTurnById(db, fixture.turnIds[1]!, {
      tags: ["impression-fixture"],
      updatedAtEpoch: NOW,
    });
    expect(commitRefusal(maintainer)).toContain("no longer belong to this lane");
  });

  test("(a) the cutoff is RESOLVED from the database at every moment — a null one is the all-era answer every other frontier consumer gives, never a forgotten argument", () => {
    const fixture = seedFixture();
    // This install records no era boundary at all: the legacy world, and the
    // one shape ticket 07's bootstrap lesson is about.
    expect(resolveEraCutoffForImpressions(db)).toBeNull();

    // A lane member SETTLED by an earlier window and absent from this run's
    // frozen projection — the only kind of member an era boundary can move,
    // since the projection half is era-inclusive by construction.
    const older = seedTurn(fixture.sessionDbId, 9);
    addSegmentMembers(db, fixture.segmentId, [older], NOW);
    updateTurnById(db, older, {
      type: ["design"],
      tags: ["impression-fixture", "visual-style"],
      updatedAtEpoch: NOW,
    });
    db.query(
      `INSERT INTO note_settlement_jobs
         (session_id, window_start, window_end, trigger_type, status, stage, created_at_epoch, updated_at_epoch)
       VALUES (?, 9, 9, 'consecutive', 'done', 'edges', ?, ?)`,
    ).run(fixture.sessionDbId, NOW, NOW);

    const cutoff = SETTLEMENT_ERA_CUTOFF_EPOCH + 20;
    const allEra = settledMemberIdsForLane(
      db,
      fixture.segmentId,
      "visual-style",
      null,
      fixture.turnIds,
    );
    const scoped = settledMemberIdsForLane(
      db,
      fixture.segmentId,
      "visual-style",
      cutoff,
      fixture.turnIds,
    );
    expect(allEra).toContain(older);
    expect(scoped).not.toContain(older);
    // The two coordinates the fence compares differ, so an era arriving between
    // the advisory and the commit rejects the whole commit for re-read-re-decide
    // instead of silently changing the count under a cap already handed out.
    expect(membershipGenerationOf(allEra)).not.toBe(membershipGenerationOf(scoped));

    db.query(
      "INSERT INTO era_state (id, cutoff_epoch, recorded_at_epoch) VALUES (1, ?, ?)",
    ).run(cutoff, NOW);
    expect(resolveEraCutoffForImpressions(db)).toBe(cutoff);
  });
});

// ---------------------------------------------------------------------------
// The isolation the write bought (lane-impressions ticket 10)
// ---------------------------------------------------------------------------

describe("a malformed impression fails only its OWN call", () => {
  test("three written, the second invalid: the first and third stand, and the run commits once the second is repaired", () => {
    const fixture = seedFixture({ lanes: ["visual-style", "elevation", "roads"] });
    const maintainer = maintainerFor(fixture);
    const first = `The visual-style lane: the look still governs (S${fixture.sessionDbId}/T1).`;
    const third = `The roads lane: connected tiles, never stripes (S${fixture.sessionDbId}/T2).`;

    expect(
      decideAll(maintainer, [
        { id: laneAddress(fixture), baseRevision: 0, decision: "replace", text: first },
      ]),
    ).toBe("");

    // THE SECOND IS INVALID — a delivery word with no anchor on its line, the
    // deterministic tier's own rule.
    const refusal = decideAll(maintainer, [
      {
        id: laneAddress(fixture, "elevation"),
        baseRevision: 0,
        decision: "replace",
        text: "The elevation lane shipped.",
      },
    ]);
    expect(refusal).toContain("Impression refused");
    expect(refusal).toContain("delivery-anchor");
    // Its violations are reported to the writer, not swallowed…
    expect(refusal).toContain(laneAddress(fixture, "elevation"));
    // …and nothing else is disturbed: the first decision is still pending.
    expect([...maintainer.pending().keys()]).toEqual([laneAddress(fixture)]);

    expect(
      decideAll(maintainer, [
        { id: laneAddress(fixture, "roads"), baseRevision: 0, decision: "replace", text: third },
      ]),
    ).toBe("");
    expect([...maintainer.pending().keys()].sort()).toEqual(
      [laneAddress(fixture), laneAddress(fixture, "roads")].sort(),
    );

    // The run cannot commit while the second container is undecided — the duty
    // check names it — and CAN once it is repaired.
    expect(commitRefusal(maintainer)).toContain(
      `no decision recorded for: ${laneAddress(fixture, "elevation")}`,
    );
    const repaired = `The elevation lane: the decode is real and its integration is open (S${fixture.sessionDbId}/T3).`;
    expect(
      decideAll(maintainer, [
        { id: laneAddress(fixture, "elevation"), baseRevision: 0, decision: "replace", text: repaired },
        { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
      ]),
    ).toBe("");
    const outcome = maintainer.settle(db);
    expect(outcome.replaced).toBe(3);

    // All three landed, including the two that were written before the refusal.
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBe(first);
    expect(readLaneImpression(db, fixture.segmentId, "elevation")!.text).toBe(repaired);
    expect(readLaneImpression(db, fixture.segmentId, "roads")!.text).toBe(third);
  });

  test("deciding a container twice keeps the LAST decision", () => {
    const fixture = seedFixture();
    const maintainer = maintainerFor(fixture);
    expect(
      decideAll(maintainer, [
        { id: laneAddress(fixture), baseRevision: 0, decision: "retain" },
        { id: laneAddress(fixture), baseRevision: 0, decision: "replace", text: legalText(fixture) },
        { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
      ]),
    ).toBe("");
    expect(maintainer.settle(db).replaced).toBe(1);
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBe(
      legalText(fixture),
    );
  });

  test("the receipt names what is still owed, so the duty is visible before the commit", () => {
    const fixture = seedFixture({ lanes: ["visual-style", "elevation"] });
    const maintainer = maintainerFor(fixture);
    const first = maintainer.decide(db, {
      action: "impression",
      id: laneAddress(fixture),
      baseRevision: 0,
      decision: "retain",
    });
    expect(first.ok).toBe(true);
    expect(first.text).toContain("PENDING");
    expect(first.text).toContain("Still owed:");
    expect(first.text).toContain(laneAddress(fixture, "elevation"));
    expect(first.text).toContain(`E${fixture.segmentId}`);
  });
});

describe("`commit` still refuses a pending decision that has gone invalid", () => {
  test("an anchor that stops resolving after the decision rejects the whole commit", () => {
    const fixture = seedFixture();
    // The anchor is a turn OUTSIDE the lane, so removing it moves no membership
    // and no revision — the validator is the only thing that can see it go.
    const witness = seedTurn(fixture.sessionDbId, 9);
    const maintainer = maintainerFor(fixture);
    expect(
      decideAll(maintainer, [
        {
          id: laneAddress(fixture),
          baseRevision: 0,
          decision: "replace",
          text: `The fixture lane rests on a witness turn (S${fixture.sessionDbId}/T9).`,
        },
        { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
      ]),
    ).toBe("");
    db.query("DELETE FROM turns WHERE id = ?").run(witness);

    const refusal = commitRefusal(maintainer);
    expect(refusal).toContain("no longer pass the write-time validator");
    expect(refusal).toContain("anchor-unresolvable");
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The terminal transaction: atomicity with the commit
// ---------------------------------------------------------------------------

describe("impressions ride the terminal transaction", () => {
  function engineFor(fixture: Fixture, maintainer: ReturnType<typeof maintainerFor>) {
    const context: SettlementTurnFacadeContext = {
      jobId: fixture.job.id,
      claimGeneration: fixture.job.claimGeneration,
      stage: "edges",
      sessionId: fixture.sessionDbId,
      reviewableTurnIds: new Set(fixture.turnIds),
      contextBuiltAtEpoch: NOW,
    };
    return createSettlementDirectWriteEngine({
      db,
      context,
      now: () => NOW,
      settleImpressions: (database) => {
        try {
          maintainer.settle(database);
          return { ok: true as const };
        } catch (error) {
          if (error instanceof ImpressionSettlementRefused) {
            return { ok: false as const, refusal: error.message };
          }
          throw error;
        }
      },
    });
  }

  test("a successful commit lands the job's terminal mark AND the impression together", () => {
    const fixture = seedFixture();
    const maintainer = maintainerFor(fixture);
    const engine = engineFor(fixture, maintainer);
    expect(
      decideAll(maintainer, [
        { id: laneAddress(fixture), baseRevision: 0, decision: "replace", text: legalText(fixture) },
        { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
      ]),
    ).toBe("");
    const receipt = engine.commit("no friction");
    expect(receipt.content[0]!.text).toContain("Committed");
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBe(
      legalText(fixture),
    );
  });

  test("an undischarged duty leaves the job UNCOMMITTED and no impression written", () => {
    const fixture = seedFixture();
    const maintainer = maintainerFor(fixture);
    const engine = engineFor(fixture, maintainer);
    // The task tier has no decision: the WHOLE commit rejects, and the lane's
    // pending replacement lands nowhere.
    expect(
      decideAll(maintainer, [
        { id: laneAddress(fixture), baseRevision: 0, decision: "replace", text: legalText(fixture) },
      ]),
    ).toBe("");
    const receipt = engine.commit("no friction");
    expect(receipt.content[0]!.text).toContain("Commit refused");
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBeNull();
    // And it costs no attempt: the run may record the missing decision and
    // commit again, with the decision it already made still standing.
    expect(
      decideAll(maintainer, [
        { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
      ]),
    ).toBe("");
    const second = engine.commit("no friction");
    expect(second.content[0]!.text).toContain("Committed");
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBe(
      legalText(fixture),
    );
  });

  test("an engine with no impression seam commits exactly as it did before this ticket", () => {
    const fixture = seedFixture();
    const engine = createSettlementDirectWriteEngine({
      db,
      context: {
        jobId: fixture.job.id,
        claimGeneration: fixture.job.claimGeneration,
        stage: "edges",
        sessionId: fixture.sessionDbId,
        reviewableTurnIds: new Set(fixture.turnIds),
        contextBuiltAtEpoch: NOW,
      },
      now: () => NOW,
    });
    expect(engine.commit("no friction").content[0]!.text).toContain("Committed");
  });
});

// ---------------------------------------------------------------------------
// The teaching
// ---------------------------------------------------------------------------

describe("the writing law and both golden samples ship in the settlement prompt", () => {
  const teaching = renderImpressionTeaching();

  test("the four-question checklist, the state ceiling, the line form and lane relevance are all present", () => {
    expect(teaching).toContain("GLOBAL IMPRESSION");
    expect(teaching).toContain("CAUSAL MODEL");
    expect(teaching).toContain("BINDINGS");
    expect(teaching).toContain("FRONTIER");
    expect(teaching).toContain("THE STATE CEILING");
    expect(teaching).toContain("at most 150 tokens");
    expect(teaching).toContain("at most 8");
    expect(teaching).toContain("LANE RELEVANCE");
    expect(teaching).toContain("ANCHOR DISCIPLINE");
    expect(teaching).toContain("BYTE-IDENTICAL");
  });

  // -------------------------------------------------------------------------
  // TICKET 09's three repairs. Each is pinned twice: once on the PROSE, once on
  // the SAMPLE — because the sample is the effective teaching (two independent
  // writers in two independent draws reproduced the same four sample lines
  // verbatim, and the arm shown the unrepaired sample reproduced its defect).
  // A repair pinned only on the prose would let the sample ship the defect.
  // -------------------------------------------------------------------------

  /** Clause = what a state predicate can govern: a `;`/`—`-delimited span. */
  const clausesOf = (line: string): string[] => line.split(/[;—]/);
  const DELIVERY_WORD = /\b(shipped|landed|committed|released)\b/i;
  const ANCHOR = /\bS\d+\/T\d+\b|\bT\d+\b/;
  const OPEN_BOUNDARY = /\bopen boundary\b|\b(remain|remains|stay|stays)\s+open\b|\bis\s+open\b/i;
  const SUPERSESSION_MARKER = /\bsupersed(?:e|es|ed|ing)\b|\boverturn(?:s|ed|ing)?\b|\bkilled by\b|\bdead\b|\breplac(?:es|ed|ing)\b/i;

  test("REPAIR 1 — line 1's fourth duty is the open boundary, and the duty list and the line-form clause agree", () => {
    // The shipped defect: the duty-list header named four questions while the
    // line-1 clause named three duties, and writers followed the prose —
    // 0 of 3 lanes held frontier for a line-1-only reader (ticket 06).
    expect(teaching).toContain(
      "GLOBAL IMPRESSION — what this lane is, its governing law, its current",
    );
    expect(teaching).toContain("state, AND its open boundary. All four, in one line.");
    expect(teaching).toContain(
      "— what it is, its governing law, its current state, AND ITS OPEN BOUNDARY —",
    );
    expect(teaching).toContain("THE OPEN BOUNDARY IS LINE 1'S FOURTH DUTY");
    expect(teaching).toContain("FALSE line 1");
    // No surviving three-duty formulation anywhere: that is the contradiction.
    expect(teaching).not.toContain("its governing law, its current state — written to stand");
  });

  test("REPAIR 2 — the state-scope isolation rule ships, with its item classes named", () => {
    expect(teaching).toContain("STATE-SCOPE ISOLATION");
    expect(teaching).toContain("A state predicate governs ONLY the items explicitly");
    for (const cls of [
      "SOURCE",
      "RULING",
      "DESIGN",
      "PREVIEW",
      "DECODED-ONLY EVIDENCE",
      "DELIVERED STATE",
    ]) {
      expect(teaching).toContain(cls);
    }
    expect(teaching).toContain("never appear as unlabelled");
    expect(teaching).toContain("TRANSITION starts a new locally-qualified clause");
  });

  test("REPAIR 3 — the supersession rule ships, and it forbids BOTH failure shapes", () => {
    expect(teaching).toContain("SUPERSESSION");
    expect(teaching).toContain("SEQUENCE IS NOT");
    // Sequence words are the measured mechanism: "then" read as chronology and
    // 5 of 5 readers took the dead path for live frontier.
    expect(teaching).toContain('"then"');
    // The mirror failure — buying clarity by deleting the history — is the one
    // the synthesis form falls into, and is refused in the same breath.
    expect(teaching).toContain("DELETING the history");
    expect(teaching).toContain("NEVER keep it unmarked");
    // main-agent-edges ticket 05 (spec D3): the mechanical source of truth is
    // the WINDOW's correct/full edges, not "your own" — `computeAnchorInvalidations`
    // scopes by writable turn and never by provenance, and the main agent now
    // writes such rows. The retired possessive is pinned absent.
    expect(teaching).toContain(
      "The window's CORRECT/FULL edges are the mechanical source of",
    );
    expect(teaching).toContain("whoever wrote them");
    expect(teaching).not.toContain("Your own OVERRIDE edges");
    expect(teaching).toContain("an anchor CORRECTED in\nFULL by any edge in this window");
    expect(teaching).not.toContain("an anchor your own edges CORRECTED");
  });

  test("REPAIR 1, ON THE SAMPLES — line 1 of each names the open boundary", () => {
    const fullLine1 = IMPRESSION_GOLDEN_SAMPLE_FULL.split("\n")[0]!;
    expect(fullLine1).toMatch(OPEN_BOUNDARY);
    // The thin sample IS line 1 — a one-line impression owes the same duty.
    expect(IMPRESSION_GOLDEN_SAMPLE_THIN).toMatch(OPEN_BOUNDARY);
  });

  test("REPAIR 2, ON THE SAMPLES — no delivery predicate governs a clause it cannot prove", () => {
    for (const sample of [IMPRESSION_GOLDEN_SAMPLE_FULL, IMPRESSION_GOLDEN_SAMPLE_THIN]) {
      for (const [index, line] of sample.split("\n").entries()) {
        for (const clause of clausesOf(line)) {
          if (!DELIVERY_WORD.test(clause)) continue;
          // A delivery word must sit in a clause carrying its OWN anchor. The
          // shipped sample's line 1 opened "the look is locked and shipped
          // through ticket 004 —" with no anchor in that clause, and hung three
          // items of three different maturities off the dash after it.
          expect({ line: index + 1, clause: clause.trim() }).toMatchObject({
            clause: expect.stringMatching(ANCHOR),
          });
        }
      }
    }
    // The specific item that shipped the defect — a ruled SOURCE with nothing
    // built — carries its own non-delivery predicate in line 1.
    expect(IMPRESSION_GOLDEN_SAMPLE_FULL.split("\n")[0]!).toMatch(
      /ruled SOURCE only .*extraction not built/,
    );
  });

  test("REPAIR 3, ON THE SAMPLES — dead paths are marked dead, and never by sequence alone", () => {
    // The full sample's lane reversed its projection three times; the shipped
    // sample named not one of those reversals, teaching the deletion strategy.
    expect(IMPRESSION_GOLDEN_SAMPLE_FULL).toMatch(SUPERSESSION_MARKER);
    expect(IMPRESSION_GOLDEN_SAMPLE_FULL).toContain("Dead, superseded by ruling, never revive:");
    // Every superseded item names the ruling that killed it, not an ordering.
    const deadLine = IMPRESSION_GOLDEN_SAMPLE_FULL.split("\n").find((line) =>
      line.startsWith("Dead, superseded"),
    )!;
    expect(deadLine.match(/\bby T\d+\b|\bkilled by T\d+\b/g) ?? []).toHaveLength(3);
    // And neither sample leans on a sequence word: the validator's soft lint is
    // the mechanical witness, and a sample that tripped it would teach the trap.
    for (const sample of [IMPRESSION_GOLDEN_SAMPLE_FULL, IMPRESSION_GOLDEN_SAMPLE_THIN]) {
      const result = validateImpression({
        text: sample,
        cap: TASK_IMPRESSION_TOKEN_CAP,
        resolveAnchor: () => true,
      });
      expect(result.warnings).toEqual([]);
    }
  });

  test("both golden samples ship, and the thin one is exactly ONE line", () => {
    expect(teaching).toContain(IMPRESSION_GOLDEN_SAMPLE_FULL);
    expect(teaching).toContain(IMPRESSION_GOLDEN_SAMPLE_THIN);
    expect(IMPRESSION_GOLDEN_SAMPLE_THIN.split("\n")).toHaveLength(1);
  });

  test("both golden samples PASS the shipped deterministic validator", () => {
    for (const sample of [IMPRESSION_GOLDEN_SAMPLE_FULL, IMPRESSION_GOLDEN_SAMPLE_THIN]) {
      const resolved = new Set<string>();
      for (const line of sample.split("\n")) {
        let session: string | null = null;
        for (const match of line.matchAll(/\bS(\d+)\/T(\d+)\b|\bT(\d+)\b/g)) {
          if (match[1] !== undefined) {
            session = match[1];
            resolved.add(`S${match[1]}/T${match[2]}`);
          } else if (match[3] !== undefined && session !== null) {
            resolved.add(`S${session}/T${match[3]}`);
          }
        }
      }
      const result = validateImpression({
        text: sample,
        cap: TASK_IMPRESSION_TOKEN_CAP,
        resolveAnchor: anchorResolverFromResolvedSet(resolved),
      });
      expect(result.rejections).toEqual([]);
      expect(result.accepted).toBe(true);
      // TICKET 01 HANDOFF (c): the anchor scanner treats any prose `T<digits>`
      // as an anchor. Neither shipped sample produces a false positive — every
      // parsed anchor is a real address, and the folded `T149` binds to the
      // full anchor before it on its own line.
      expect(result.anchors.every((anchor) => resolved.has(`S${anchor.sessionId}/T${anchor.promptNumber}`))).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // FIRST-SETTLEMENT-FEEDBACK TICKET 01, third repair (user ruling
  // S15069/T2367). Job 171's first `commit` was refused on ELEVEN
  // `anchor-format` violations and one `delivery-anchor`: every anchor in
  // every line of a four-line impression was a bare `T<m>` and the full form
  // was never written once.
  //
  // The ticket's premise — that the grammar lives only in the sample and
  // never in the prose — is FALSE, and the header of the teaching module
  // records it as false: QUALIFIED FOLD stated the per-line rule verbatim in
  // the very prompt that run was shown. What ships is therefore the SAME rule
  // restated at the failure the run made, plus the consequence the old text
  // left the reader to derive. Both halves are validator rules
  // (`anchor-format`, `delivery-anchor`); neither is new law.
  // -------------------------------------------------------------------------
  test("REPAIR 4 — the fold's per-line reset ships in prose, and the delivery rule is read the same way", () => {
    // The rule the shipped text already carried stays byte-intact.
    expect(teaching).toContain(
      "line is the full `S<n>/T<m>`; later anchors in that SAME line from the same",
    );
    // What the refusal proved the writer still had to derive.
    expect(teaching).toContain("THE FOLD RESETS AT EVERY NEWLINE");
    expect(teaching).toContain("A bare `T<m>` is not this system's");
    expect(teaching).toContain("line 1 pays the full `S<n>/T<m>` before anything may");
    expect(teaching).toContain("refused");
    expect(teaching).toContain("once per anchor, not once");
    // The `delivery-anchor` rejection from the same commit: the delivery rule
    // is per LINE, exactly like the fold.
    expect(teaching).toContain(
      "rule above: a line carrying shipped, landed, committed or released must",
    );
    expect(teaching).toContain("carry a well-formed anchor on THAT line");
  });

  test("REPAIR 4 — every anchor the shipped samples teach obeys the rule the prose now restates", () => {
    // The samples are the effective teaching, so they are the second pin: on
    // EVERY line of both samples the first anchor is the full form. A sample
    // that opened a line on a bare `T<m>` would teach the exact defect job
    // 171 shipped, whatever the prose says.
    for (const sample of [IMPRESSION_GOLDEN_SAMPLE_FULL, IMPRESSION_GOLDEN_SAMPLE_THIN]) {
      for (const line of sample.split("\n")) {
        const first = line.match(/\bS\d+\/T\d+\b|\bT\d+\b/);
        expect(first).not.toBeNull();
        expect(first![0]).toMatch(/^S\d+\/T\d+$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The teaching says the new shape, and names no retired argument
// ---------------------------------------------------------------------------

describe("the teaching teaches the write where it now happens (ticket 10)", () => {
  const teaching = renderImpressionTeaching();

  test("it names the tool, the action and its four fields", () => {
    expect(teaching).toContain('remember(action: "impression"');
    expect(teaching).toContain("baseRevision");
    expect(teaching).toContain('decision: "retain" | "replace"');
    expect(teaching).toContain("the WHOLE new impression");
  });

  test("it says WRITE AS YOU DECIDE, not as one batch at the end", () => {
    expect(teaching).toContain("AS YOU");
    expect(teaching).toContain("DECIDE IT — never as one batch at the end");
  });

  test("it says the failure is LOCAL, and that a decision is PENDING until the commit", () => {
    expect(teaching).toContain("The failure is LOCAL");
    expect(teaching).toContain("every decision you already recorded still stands");
    expect(teaching).toContain("NOTHING IS WRITTEN UNTIL YOU COMMIT");
    expect(teaching).toContain("PENDING");
  });

  test("it says what `commit` now does — check the duty, name what is missing", () => {
    expect(teaching).toContain("CHECKS the");
    expect(teaching).toContain("duty");
    expect(teaching).toContain("with none refuses the commit by name");
  });

  test("NO SHIPPED TEXT names the retired argument", () => {
    // The prompts, the teaching and every tool description a settlement run
    // actually reads. The retirement is only meaningful if the surfaces stop
    // teaching the shape — a description that still named the array would send
    // a compliant writer straight into the one refusal this ticket exists to
    // remove.
    const shipped = [
      teaching,
      renderImpressionAdvisories([]),
      SETTLEMENT_COMMIT_TOOL_DESCRIPTION,
      SETTLEMENT_COMMIT_IMPRESSION_DUTY_DESCRIPTION,
      SETTLEMENT_REMEMBER_TOOL_DESCRIPTION,
      SETTLEMENT_REMEMBER_IMPRESSION_DESCRIPTION,
      UNIFIED_REMEMBER_TOOL_DESCRIPTION,
      UNIFIED_COMMIT_TOOL_DESCRIPTION,
    ];
    for (const text of shipped) {
      expect(text).not.toContain("`impressions`");
      expect(text).not.toContain("impressions array");
      expect(text).not.toContain("impressions payload");
    }
    // And `commit`'s own input shape does not accept it either.
    expect(Object.keys(SETTLEMENT_COMMIT_INPUT_SHAPE)).toEqual(["report"]);
  });

  test("a call that still sends it is refused, naming the retired argument and its replacement", () => {
    const refusal = retiredImpressionsArgument({ report: "r", impressions: [] });
    expect(refusal).toContain("`impressions` has retired from `commit`");
    expect(refusal).toContain('remember(action: "impression"');
    expect(refusal).toContain("Nothing was committed");
    // A well-formed call is not touched by the guard.
    expect(retiredImpressionsArgument({ report: "r" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The write path is transaction-safe
// ---------------------------------------------------------------------------

describe("settleImpressions runs inside the caller's transaction", () => {
  test("it opens none of its own — a caller's rollback takes the impression with it", () => {
    const fixture = seedFixture();
    expect(() =>
      runWriteTransaction(db, () => {
        const pending = new Map<string, PendingImpressionDecision>();
        for (const advisory of loadAdvisoriesFor(fixture)) {
          pending.set(advisory.address, {
            kind: advisory.kind,
            segmentId: advisory.segmentId,
            laneTag: advisory.laneTag,
            address: advisory.address,
            decision: advisory.kind === "lane" ? "replace" : "retain",
            text: advisory.kind === "lane" ? legalText(fixture) : null,
            baseRevision: advisory.baseRevision,
            membershipGeneration: advisory.membershipGeneration,
            cap: advisory.cap,
            decidedAtEpoch: NOW,
          });
        }
        settleImpressions(db, {
          jobId: fixture.job.id,
          writableTurnIds: new Set(fixture.turnIds),
          claimedDebts: [],
          pending,
          nowEpoch: NOW,
        });
        throw new Error("the caller changed its mind");
      }),
    ).toThrow("the caller changed its mind");
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBeNull();
  });
});
