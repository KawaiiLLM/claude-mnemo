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
import { createSettlementDirectWriteEngine } from "../../src/worker/note-settlement-direct-write";
import {
  computeTouchedImpressionContainers,
  createSettlementImpressionMaintainer,
  ImpressionSettlementRefused,
  IMPRESSION_PAYLOAD_MAX_BYTES,
  IMPRESSION_REGENERATION_RETRY_BUDGET,
  membershipGenerationOf,
  normalizeImpressionText,
  renderSettlementImpressionAdvisoryBlock,
  resolveEraCutoffForImpressions,
  settleImpressions,
  vouchProjectedLaneMembers,
} from "../../src/worker/note-settlement-impressions";
import {
  IMPRESSION_GOLDEN_SAMPLE_FULL,
  IMPRESSION_GOLDEN_SAMPLE_THIN,
  renderImpressionTeaching,
} from "../../src/worker/note-settlement-impression-teaching";
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
    readWritableTurnIds: () => new Set(fixture.turnIds),
    now: () => NOW,
    ...overrides,
  });
}

function laneAddress(fixture: Fixture, tag = "visual-style"): string {
  return `E${fixture.segmentId}/#${tag}`;
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

describe("the payload must cover the touched set exactly", () => {
  function settle(fixture: Fixture, payload: unknown): string {
    try {
      maintainerFor(fixture).settle(db, payload);
      return "";
    } catch (error) {
      if (error instanceof ImpressionSettlementRefused) {
        return error.message;
      }
      throw error;
    }
  }

  test("a missing judgment is a refusal, not a silent skip", () => {
    const fixture = seedFixture();
    const refusal = settle(fixture, [
      { id: laneAddress(fixture), baseRevision: 0, decision: "retain" },
    ]);
    expect(refusal).toContain("does not match this run's touched set");
    expect(refusal).toContain(`no judgment for: E${fixture.segmentId}`);
  });

  test("a container this run never touched is not its to rewrite", () => {
    const fixture = seedFixture();
    const refusal = settle(fixture, [
      { id: laneAddress(fixture), baseRevision: 0, decision: "retain" },
      { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
      { id: "E999/#stranger", baseRevision: 0, decision: "retain" },
    ]);
    expect(refusal).toContain("judged, but not touched by this run: E999/#stranger");
  });

  test("an omitted payload against an empty touched set commits cleanly", () => {
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
      readWritableTurnIds: () => new Set<number>(),
      now: () => NOW,
    }).settle(db, undefined);
    expect(outcome).toEqual({ replaced: 0, retained: 0, ackedDebts: 0, advisories: [] });
  });
});

// ---------------------------------------------------------------------------
// The fences
// ---------------------------------------------------------------------------

describe("the terminal transaction rejects the WHOLE commit on any drift", () => {
  function fullPayload(
    fixture: Fixture,
    lane: { baseRevision: number; decision: "retain" | "replace"; text?: string },
  ): unknown {
    return [
      { id: laneAddress(fixture), ...lane },
      { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
    ];
  }

  function settle(fixture: Fixture, payload: unknown): string {
    try {
      maintainerFor(fixture).settle(db, payload);
      return "";
    } catch (error) {
      if (error instanceof ImpressionSettlementRefused) {
        return error.message;
      }
      throw error;
    }
  }

  test("two jobs read v1; the first commits v2 and the second's ENTIRE commit rejects", () => {
    const fixture = seedFixture();
    const maintainer = maintainerFor(fixture);
    maintainer.renderAdvisories();
    // The FIRST job's commit, landing between the second's read and its own.
    expect(
      replaceLaneImpression(db, {
        segmentId: fixture.segmentId,
        tag: "visual-style",
        baseRevision: 0,
        text: "The first job's impression.",
      }),
    ).toBe(true);

    let refusal = "";
    try {
      maintainer.settle(db, fullPayload(fixture, { baseRevision: 0, decision: "replace", text: legalText(fixture) }));
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain("baseRevision 0 is not the stored revision 1");
    // The whole commit is rejected: the first job's text stands untouched.
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBe(
      "The first job's impression.",
    );
  });

  test("A retains at v1 while B already replaced to v2 — A's commit rejects (the retain fence)", () => {
    const fixture = seedFixture();
    replaceLaneImpression(db, {
      segmentId: fixture.segmentId,
      tag: "visual-style",
      baseRevision: 0,
      text: "B's replacement.",
    });
    const refusal = settle(fixture, fullPayload(fixture, { baseRevision: 0, decision: "retain" }));
    expect(refusal).toContain("baseRevision 0 is not the stored revision 1");
  });

  test("membership moved without the impression row moving — the commit still rejects", () => {
    const fixture = seedFixture();
    const maintainer = maintainerFor(fixture);
    maintainer.renderAdvisories();
    // A tag write elsewhere takes one member OUT of the lane. The impression
    // row is untouched, so its revision still reads 0 — only the membership
    // digest can see this.
    updateTurnById(db, fixture.turnIds[2]!, {
      tags: ["impression-fixture"],
      updatedAtEpoch: NOW,
    });
    let refusal = "";
    try {
      maintainer.settle(db, fullPayload(fixture, { baseRevision: 0, decision: "retain" }));
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain("membership moved under you");
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
    maintainer.renderAdvisories();
    // It joins the lane after the advisory: the settled half of the universe
    // grows, the impression row never moves (its revision still reads 0), and
    // nothing this window projected has left.
    updateTurnById(db, outsider, {
      tags: ["impression-fixture", "visual-style"],
      updatedAtEpoch: NOW,
    });

    let refusal = "";
    try {
      maintainer.settle(db, fullPayload(fixture, { baseRevision: 0, decision: "retain" }));
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain("settled membership moved since you were shown it");
  });

  test("a STALE container may not be retained", () => {
    const fixture = seedFixture();
    db.query("UPDATE lanes SET impression_stale = 1 WHERE segment_id = ? AND tag = ?").run(
      fixture.segmentId,
      "visual-style",
    );
    const refusal = settle(fixture, fullPayload(fixture, { baseRevision: 0, decision: "retain" }));
    expect(refusal).toContain("this container is STALE");
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
    const outcome = maintainerFor(fixture).settle(db, [
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
    let refusal = "";
    try {
      maintainerFor(fixture).settle(db, [
        { id: laneAddress(fixture), baseRevision: 1, decision: "retain" },
        { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
      ]);
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain(`overrode the anchor(s) S${fixture.sessionDbId}/T1`);
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
    const outcome = maintainerFor(fixture).settle(db, [
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
    const outcome = maintainerFor(fixture).settle(db, [
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
    maintainerFor(fixture).settle(db, [
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
    let refusal = "";
    try {
      maintainerFor(fixture).settle(db, [
        { id: laneAddress(fixture), baseRevision: 0, decision: "replace", text: long },
        { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
      ]);
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain("failed the write-time validator");
    expect(refusal).toContain("100-token cap");
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBeNull();
  });

  test("a delivery word with no anchor on its line is refused (the deterministic tier, live)", () => {
    const fixture = seedFixture();
    let refusal = "";
    try {
      maintainerFor(fixture).settle(db, [
        {
          id: laneAddress(fixture),
          baseRevision: 0,
          decision: "replace",
          text: "The fixture lane shipped.",
        },
        { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
      ]);
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain("delivery-anchor");
  });

  test("TICKET 01 HANDOFF (d): a trailing newline is tolerated at the write path, and never stored", () => {
    const fixture = seedFixture();
    const text = legalText(fixture);
    expect(normalizeImpressionText(`${text}\n`)).toBe(text);
    maintainerFor(fixture).settle(db, [
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
    maintainer.renderAdvisories();
    // The frozen snapshot still names a turn the lane no longer holds.
    updateTurnById(db, fixture.turnIds[1]!, {
      tags: ["impression-fixture"],
      updatedAtEpoch: NOW,
    });
    let refusal = "";
    try {
      maintainer.settle(db, [
        { id: laneAddress(fixture), baseRevision: 0, decision: "retain" },
        { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
      ]);
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain("no longer belong to this lane");
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
// The payload cap
// ---------------------------------------------------------------------------

describe("the payload cap is a deterministic rejection routed to compress-only regeneration", () => {
  function oversized(fixture: Fixture): unknown {
    return [
      {
        id: laneAddress(fixture),
        baseRevision: 0,
        decision: "replace",
        text: "x".repeat(IMPRESSION_PAYLOAD_MAX_BYTES + 1),
      },
      { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
    ];
  }

  test("overflow refuses, names the compress-only rules, and writes nothing", () => {
    const fixture = seedFixture();
    let refusal = "";
    try {
      maintainerFor(fixture).settle(db, oversized(fixture));
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain(`over the ${IMPRESSION_PAYLOAD_MAX_BYTES}-byte cap`);
    expect(refusal).toContain("You may NOT omit a touched container's judgment");
    expect(refusal).toContain("demote a");
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBeNull();
  });

  test("an exhausted regeneration budget becomes an operator-visible failure", () => {
    const fixture = seedFixture();
    const errors: string[] = [];
    const maintainer = maintainerFor(fixture, {
      logger: { error: (message: string) => errors.push(message) },
    });
    const attempt = (): string => {
      try {
        maintainer.settle(db, oversized(fixture));
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    };
    for (let index = 1; index < IMPRESSION_REGENERATION_RETRY_BUDGET; index += 1) {
      expect(attempt()).not.toContain("REGENERATION BUDGET EXHAUSTED");
    }
    expect(attempt()).toContain("REGENERATION BUDGET EXHAUSTED");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("cannot commit its impression obligations");
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
      settleImpressions: (database, raw) => {
        try {
          maintainer.settle(database, raw);
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
    const receipt = engine.commit("no friction", [
      { id: laneAddress(fixture), baseRevision: 0, decision: "replace", text: legalText(fixture) },
      { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
    ]);
    expect(receipt.content[0]!.text).toContain("Committed");
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBe(
      legalText(fixture),
    );
  });

  test("a refused impression payload leaves the job UNCOMMITTED and no impression written", () => {
    const fixture = seedFixture();
    const maintainer = maintainerFor(fixture);
    const engine = engineFor(fixture, maintainer);
    const receipt = engine.commit("no friction", [
      { id: laneAddress(fixture), baseRevision: 0, decision: "replace", text: legalText(fixture) },
      // The task tier's judgment is missing: the WHOLE commit rejects.
    ]);
    expect(receipt.content[0]!.text).toContain("Commit refused");
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBeNull();
    // And it costs no attempt: the run may repair and commit again.
    const second = engine.commit("no friction", [
      { id: laneAddress(fixture), baseRevision: 0, decision: "replace", text: legalText(fixture) },
      { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
    ]);
    expect(second.content[0]!.text).toContain("Committed");
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
    expect(teaching).toContain("OVERRIDE edges are the mechanical source of truth");
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
// The write path is transaction-safe
// ---------------------------------------------------------------------------

describe("settleImpressions runs inside the caller's transaction", () => {
  test("it opens none of its own — a caller's rollback takes the impression with it", () => {
    const fixture = seedFixture();
    expect(() =>
      runWriteTransaction(db, () => {
        settleImpressions(db, {
          jobId: fixture.job.id,
          writableTurnIds: new Set(fixture.turnIds),
          claimedDebts: [],
          rawPayload: [
            {
              id: laneAddress(fixture),
              baseRevision: 0,
              decision: "replace",
              text: legalText(fixture),
            },
            { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
          ],
          nowEpoch: NOW,
          shownAdvisories: new Map(),
        });
        throw new Error("the caller changed its mind");
      }),
    ).toThrow("the caller changed its mind");
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBeNull();
  });
});
