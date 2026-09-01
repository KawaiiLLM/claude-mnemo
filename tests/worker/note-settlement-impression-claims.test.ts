import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  failNoteSettlementJob,
  getNoteSettlementJob,
  releaseNoteSettlementJobClaim,
  transitionNoteSettlementJobToEdges,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  insertImpressionDebt,
  listOpenImpressionDebts,
  readLaneImpression,
  replaceLaneImpression,
  type ImpressionDebtRecord,
} from "../../src/db/impressions";
import { insertLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  attachSegmentToSession,
  createSegment,
  readSegmentTaskImpression,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { updateTurnById } from "../../src/db/turns";
import { rememberTool } from "../../src/mcp/remember";
import { createSettlementDirectWriteEngine } from "../../src/worker/note-settlement-direct-write";
import {
  computeTouchedImpressionContainers,
  createAttachedImpressionDebtClaimer,
  createSettlementImpressionMaintainer,
  ImpressionSettlementRefused,
} from "../../src/worker/note-settlement-impressions";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * LIFECYCLE DEBTS, CLAIM SIDE (lane-impressions spec Rev 8, "Lifecycle debts";
 * ticket 03).
 *
 * A settlement run CLAIMS the open debts of the tasks its session is ATTACHED
 * to, at run start; it ACKS them only inside its successful terminal commit; a
 * failed run's claims release for the next eligible run; and consumption is
 * never read-and-delete. A debt with no eligible run waits durably.
 *
 * Every assertion is about a durable outcome or a refusal's rendered text.
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
// Fixture — the ticket-02 shape: a task with declared lanes, member turns, and
// a claimed settlement job already transitioned to the edge pass.
// ---------------------------------------------------------------------------

interface Fixture {
  sessionDbId: number;
  segmentId: number;
  turnIds: number[];
  job: NoteSettlementJob;
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

function seedFixture(options: { lanes?: string[] } = {}): Fixture {
  const lanes = options.lanes ?? ["visual-style"];
  const sessionDbId = upsertSession(db, {
    contentSessionId: "impression-claim-session",
    project: "/tmp/project-impression-claims",
    title: "impression claim fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
  const segmentId = createSegment(db, {
    title: "impression claim fixture task",
    content: null,
    insight: null,
    type: [],
    tags: ["impression-claim"],
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
      tags: ["impression-claim", ...lanes],
      updatedAtEpoch: NOW,
    });
  }

  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 3, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const claimed = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000)!;
  transitionNoteSettlementJobToEdges(db, claimed.id, claimed.claimGeneration, NOW, {
    snapshots: {
      window: turnIds,
      lookback: [],
      closure: [],
      worklist: lanes.map((tag) => ({ segmentId, laneTag: tag })),
    },
  });
  return { sessionDbId, segmentId, turnIds, job: getNoteSettlementJob(db, claimed.id)! };
}

function claimerFor(fixture: Fixture): (database: Database) => readonly ImpressionDebtRecord[] {
  return createAttachedImpressionDebtClaimer({
    jobId: fixture.job.id,
    sessionId: fixture.sessionDbId,
    now: () => NOW,
  });
}

/** A task-tier debt on the fixture's task — the shape a manual `retag` leaves. */
function seedTaskDebt(fixture: Fixture): ImpressionDebtRecord {
  return insertImpressionDebt(db, {
    segmentId: fixture.segmentId,
    laneTag: null,
    kind: "task-retag",
    nowEpoch: NOW - 100,
  });
}

function debtRow(id: number): ImpressionDebtRecord | null {
  return (
    db
      .query<ImpressionDebtRecord, [number]>(
        `SELECT id, segment_id AS segmentId, lane_tag AS laneTag, kind,
                created_at_epoch AS createdAtEpoch,
                claimed_at_epoch AS claimedAtEpoch,
                claimed_by_job_id AS claimedByJobId,
                acked_at_epoch AS ackedAtEpoch
           FROM impression_debts WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

// ---------------------------------------------------------------------------
// Eligibility: attachment, and nothing else
// ---------------------------------------------------------------------------

describe("only a run whose session is attached to the debt's task may claim it", () => {
  test("an UNATTACHED run claims nothing — the debt stays open and unclaimed", () => {
    const fixture = seedFixture();
    const debt = seedTaskDebt(fixture);

    expect(claimerFor(fixture)(db)).toEqual([]);

    const after = debtRow(debt.id)!;
    expect(after.claimedByJobId).toBeNull();
    expect(after.claimedAtEpoch).toBeNull();
    expect(after.ackedAtEpoch).toBeNull();
  });

  test("an ATTACHED run claims it, stamped with the job that leased it", () => {
    const fixture = seedFixture();
    const debt = seedTaskDebt(fixture);
    attachSegmentToSession(db, fixture.sessionDbId, fixture.segmentId, NOW);

    expect(claimerFor(fixture)(db).map((row) => row.id)).toEqual([debt.id]);

    const after = debtRow(debt.id)!;
    expect(after.claimedByJobId).toBe(fixture.job.id);
    expect(after.claimedAtEpoch).toBe(NOW);
  });

  test("a debt on a task this session never attached is left alone even while another IS claimed", () => {
    const fixture = seedFixture();
    const mine = seedTaskDebt(fixture);
    const strangerSegment = createSegment(db, {
      title: "someone else's task",
      tags: ["stranger-task"],
      nowEpoch: NOW,
    }).id;
    const theirs = insertImpressionDebt(db, {
      segmentId: strangerSegment,
      laneTag: null,
      kind: "task-retag",
      nowEpoch: NOW - 100,
    });
    attachSegmentToSession(db, fixture.sessionDbId, fixture.segmentId, NOW);

    expect(claimerFor(fixture)(db).map((row) => row.id)).toEqual([mine.id]);
    expect(debtRow(theirs.id)!.claimedByJobId).toBeNull();
  });

  test("the claimed debt's lane enters the run's touched set", () => {
    const fixture = seedFixture();
    insertLane(db, fixture.segmentId, "declared-by-hand", NOW);
    insertImpressionDebt(db, {
      segmentId: fixture.segmentId,
      laneTag: "declared-by-hand",
      kind: "declare",
      nowEpoch: NOW - 100,
    });
    attachSegmentToSession(db, fixture.sessionDbId, fixture.segmentId, NOW);

    const withoutClaim = computeTouchedImpressionContainers(db, fixture.job.id, []);
    expect(withoutClaim.map((container) => container.address)).not.toContain(
      `E${fixture.segmentId}/#declared-by-hand`,
    );

    const withClaim = computeTouchedImpressionContainers(
      db,
      fixture.job.id,
      claimerFor(fixture)(db),
    );
    expect(withClaim.map((container) => container.address)).toContain(
      `E${fixture.segmentId}/#declared-by-hand`,
    );
  });

  test("the claimed set is STABLE across calls — a second call does not answer with the empty set the claim WRITE would return", () => {
    const fixture = seedFixture();
    const debt = seedTaskDebt(fixture);
    attachSegmentToSession(db, fixture.sessionDbId, fixture.segmentId, NOW);
    const claimer = claimerFor(fixture);

    const first = claimer(db).map((row) => row.id);
    const second = claimer(db).map((row) => row.id);

    expect(first).toEqual([debt.id]);
    expect(second).toEqual(first);
  });

  test("a debt with no eligible run waits DURABLY — it is still open, unclaimed and unmarked after a run that could not claim it", () => {
    const fixture = seedFixture();
    insertLane(db, fixture.segmentId, "declared-by-hand", NOW);
    const debt = insertImpressionDebt(db, {
      segmentId: fixture.segmentId,
      laneTag: "declared-by-hand",
      kind: "declare",
      nowEpoch: NOW - 100,
    });
    // No attachment: this run is not eligible.
    const claimer = claimerFor(fixture);
    claimer(db);
    claimer(db);

    const waiting = debtRow(debt.id)!;
    expect(waiting.claimedByJobId).toBeNull();
    expect(waiting.ackedAtEpoch).toBeNull();
    expect(listOpenImpressionDebts(db, fixture.segmentId).map((row) => row.id)).toEqual([
      debt.id,
    ]);
    // And it is invisible: a non-merge debt sets no STALE flag on either tier,
    // which is the only thing a reader surface is ever shown.
    expect(readLaneImpression(db, fixture.segmentId, "declared-by-hand")!.stale).toBe(false);
    expect(readSegmentTaskImpression(db, fixture.segmentId)!.stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ack and release
// ---------------------------------------------------------------------------

describe("ack in the successful terminal commit; release on failure", () => {
  function maintainerFor(fixture: Fixture) {
    return createSettlementImpressionMaintainer({
      db,
      jobId: fixture.job.id,
      claimGeneration: fixture.job.claimGeneration,
      readStage: () => "edges",
      readWritableTurnIds: () => new Set(fixture.turnIds),
      claimImpressionDebts: claimerFor(fixture),
      now: () => NOW,
    });
  }

  /**
   * THE WRITE, through the `remember` seam (lane-impressions ticket 10): one
   * container per call, refused at the call. Returns the first refusal, or "".
   */
  function decideAll(
    maintainer: ReturnType<typeof maintainerFor>,
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

  function engineFor(
    fixture: Fixture,
    maintainer: ReturnType<typeof maintainerFor>,
  ): ReturnType<typeof createSettlementDirectWriteEngine> {
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

  function legalText(fixture: Fixture): string {
    return (
      `The fixture lane: three turns describe one subject and the design still ` +
      `governs (S${fixture.sessionDbId}/T1, T2).`
    );
  }

  test("a successful commit acks the claimed debt, and the ROW SURVIVES with its claim stamp", () => {
    const fixture = seedFixture();
    const debt = seedTaskDebt(fixture);
    attachSegmentToSession(db, fixture.sessionDbId, fixture.segmentId, NOW);
    const maintainer = maintainerFor(fixture);
    const engine = engineFor(fixture, maintainer);

    expect(decideAll(maintainer, [
      {
        id: `E${fixture.segmentId}/#visual-style`,
        baseRevision: 0,
        decision: "replace",
        text: legalText(fixture),
      },
      { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
    ])).toBe("");
    const receipt = engine.commit("no friction");

    expect(receipt.content[0]!.text).toContain("Committed");
    const after = debtRow(debt.id)!;
    // Consumption is never read-and-delete: the row is still here.
    expect(after.ackedAtEpoch).toBe(NOW);
    expect(after.claimedByJobId).toBe(fixture.job.id);
    expect(listOpenImpressionDebts(db, fixture.segmentId)).toEqual([]);
  });

  test("an ACKED debt is never served again — the surviving audit row is not a re-owed obligation", () => {
    const fixture = seedFixture();
    const debt = seedTaskDebt(fixture);
    attachSegmentToSession(db, fixture.sessionDbId, fixture.segmentId, NOW);
    const maintainer = maintainerFor(fixture);
    const engine = engineFor(fixture, maintainer);

    expect(decideAll(maintainer, [
      {
        id: `E${fixture.segmentId}/#visual-style`,
        baseRevision: 0,
        decision: "replace",
        text: legalText(fixture),
      },
      { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
    ])).toBe("");
    engine.commit("no friction");
    expect(debtRow(debt.id)!.ackedAtEpoch).toBe(NOW);

    // The row survives with its claim stamp, so "everything this job holds a
    // lease on" must exclude it by ACK, not by the claim write having moved on.
    expect(claimerFor(fixture)(db)).toEqual([]);
  });

  test("a REFUSED commit acks nothing — the claim stands for this run's next attempt", () => {
    const fixture = seedFixture();
    const debt = seedTaskDebt(fixture);
    attachSegmentToSession(db, fixture.sessionDbId, fixture.segmentId, NOW);
    const maintainer = maintainerFor(fixture);
    const engine = engineFor(fixture, maintainer);
    // A real run claims at its start, when it is shown its coordinates — the
    // `commit` transaction is not where the lease is born.
    maintainer.renderAdvisories();
    expect(debtRow(debt.id)!.claimedByJobId).toBe(fixture.job.id);

    // The task tier's decision is missing: the WHOLE commit rejects.
    expect(
      decideAll(maintainer, [
        {
          id: `E${fixture.segmentId}/#visual-style`,
          baseRevision: 0,
          decision: "replace",
          text: legalText(fixture),
        },
      ]),
    ).toBe("");
    const receipt = engine.commit("no friction");

    expect(receipt.content[0]!.text).toContain("Commit refused");
    const after = debtRow(debt.id)!;
    expect(after.ackedAtEpoch).toBeNull();
    expect(after.claimedByJobId).toBe(fixture.job.id);
  });

  test("a FAILED run releases its claims, and the next eligible run picks them up", () => {
    const fixture = seedFixture();
    const debt = seedTaskDebt(fixture);
    attachSegmentToSession(db, fixture.sessionDbId, fixture.segmentId, NOW);
    expect(claimerFor(fixture)(db)).toHaveLength(1);

    expect(
      failNoteSettlementJob(
        db,
        fixture.job.id,
        "transient",
        "the model never answered",
        NOW + 10,
        fixture.job.claimGeneration,
      ),
    ).not.toBeNull();

    const released = debtRow(debt.id)!;
    expect(released.claimedByJobId).toBeNull();
    expect(released.claimedAtEpoch).toBeNull();
    expect(released.ackedAtEpoch).toBeNull();

    // A different job, same session, same attachment: the debt is claimable again.
    const next = claimNextNoteSettlementJob(db, fixture.sessionDbId, NOW + 20, (NOW + 20) * 1000)!;
    const reclaimed = createAttachedImpressionDebtClaimer({
      jobId: next.id,
      sessionId: fixture.sessionDbId,
      now: () => NOW + 20,
    })(db);
    expect(reclaimed.map((row) => row.id)).toEqual([debt.id]);
  });

  test("an ABANDONED job releases too — a lease on a job that will never run again is a debt nobody can reach", () => {
    const fixture = seedFixture();
    const debt = seedTaskDebt(fixture);
    attachSegmentToSession(db, fixture.sessionDbId, fixture.segmentId, NOW);
    claimerFor(fixture)(db);

    const abandoned = failNoteSettlementJob(
      db,
      fixture.job.id,
      "deterministic",
      "the payload can never validate",
      NOW + 10,
      fixture.job.claimGeneration,
      { maxAttempts: 1 },
    )!;

    expect(abandoned.status).toBe("abandoned");
    expect(debtRow(debt.id)!.claimedByJobId).toBeNull();
  });

  test("a graceful lease release hands the debts back with the job", () => {
    const fixture = seedFixture();
    const debt = seedTaskDebt(fixture);
    attachSegmentToSession(db, fixture.sessionDbId, fixture.segmentId, NOW);
    claimerFor(fixture)(db);

    expect(
      releaseNoteSettlementJobClaim(db, fixture.job.id, NOW + 5, fixture.job.claimGeneration),
    ).toBe(true);

    expect(debtRow(debt.id)!.claimedByJobId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The merge family, end to end: STALE set by a manual merge, cleared by a
  // qualified CAS rewrite, and never demotable to a retain.
  // -------------------------------------------------------------------------

  /** Merges `folded` into `visual-style` through the real `remember` verb — the manual operation this ticket's write side wired. */
  function foldLaneByHand(fixture: Fixture): void {
    const text = rememberTool(db, {
      verb: "merge",
      id: `E${fixture.segmentId}`,
      tag: "folded",
      into: "visual-style",
    }).content[0]!.text;
    expect(text).toContain("Merged");
  }

  test("merge → STALE → an eligible run replaces → the flag is clear and the debt acked", () => {
    const fixture = seedFixture({ lanes: ["visual-style", "folded"] });
    attachSegmentToSession(db, fixture.sessionDbId, fixture.segmentId, NOW);
    foldLaneByHand(fixture);

    const stale = readLaneImpression(db, fixture.segmentId, "visual-style")!;
    expect(stale.stale).toBe(true);

    const maintainer = maintainerFor(fixture);
    const engine = engineFor(fixture, maintainer);
    expect(
      decideAll(maintainer, [
        {
          id: `E${fixture.segmentId}/#visual-style`,
          baseRevision: stale.revision,
          decision: "replace",
          text: legalText(fixture),
        },
        { id: `E${fixture.segmentId}`, baseRevision: 0, decision: "retain" },
      ]),
    ).toBe("");
    // The flag is still set until the commit promotes the replacement.
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.stale).toBe(true);
    const receipt = engine.commit("no friction");

    expect(receipt.content[0]!.text).toContain("Committed");
    const rewritten = readLaneImpression(db, fixture.segmentId, "visual-style")!;
    expect(rewritten.stale).toBe(false);
    expect(rewritten.text).toBe(legalText(fixture));
    expect(listOpenImpressionDebts(db, fixture.segmentId)).toEqual([]);
  });

  /**
   * TICKET 07's OWN CRITERION, end to end: the fold CONCATENATES, and the join
   * it produces MAY NOT BE RETAINED. Both lanes carry real, distinguishable
   * impressions before the merge, so the survivor's post-fold text is provably
   * the join — and the run that then tries to keep it is refused, at the
   * revision the fold itself moved to.
   */
  test("the concatenation the fold produced stands in storage and may NOT be retained", () => {
    const fixture = seedFixture({ lanes: ["visual-style", "folded"] });
    attachSegmentToSession(db, fixture.sessionDbId, fixture.segmentId, NOW);
    const survivorText = `The visual-style lane: the tiles are locked (S${fixture.sessionDbId}/T1).`;
    const foldedText = `The folded lane: the roads are connected (S${fixture.sessionDbId}/T2).`;
    for (const [tag, text] of [
      ["visual-style", survivorText],
      ["folded", foldedText],
    ] as const) {
      expect(
        replaceLaneImpression(db, {
          segmentId: fixture.segmentId,
          tag,
          baseRevision: 0,
          text,
          origin: "settlement",
        }),
      ).toBe(true);
    }

    foldLaneByHand(fixture);

    const joined = readLaneImpression(db, fixture.segmentId, "visual-style")!;
    expect(joined.text).toBe(`${survivorText}\n${foldedText}`);
    expect(joined.stale).toBe(true);

    const maintainer = maintainerFor(fixture);
    engineFor(fixture, maintainer);
    // The retain never even becomes pending: the WRITE refuses it, naming the
    // fold, so the run cannot carry a demotion as far as its own commit.
    const refusal = decideAll(maintainer, [
      {
        id: `E${fixture.segmentId}/#visual-style`,
        baseRevision: joined.revision,
        decision: "retain",
      },
    ]);

    expect(refusal).toContain("Impression refused");
    expect(refusal).toContain("this container is STALE");
    // Nothing landed: the join is still what a reader sees, still owed a rewrite.
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.text).toBe(
      `${survivorText}\n${foldedText}`,
    );
  });

  test("the cheapest repair — dropping the required replace to a retain — is refused, and the debt survives it", () => {
    const fixture = seedFixture({ lanes: ["visual-style", "folded"] });
    attachSegmentToSession(db, fixture.sessionDbId, fixture.segmentId, NOW);
    foldLaneByHand(fixture);
    const stale = readLaneImpression(db, fixture.segmentId, "visual-style")!;

    const maintainer = maintainerFor(fixture);
    const engine = engineFor(fixture, maintainer);

    // 1. An impression that cannot fit its own cap is refused AT ITS OWN CALL,
    //    naming the cap — the per-container bound that replaced the retired
    //    whole-payload one. It costs the run nothing but that call.
    const overflow = decideAll(maintainer, [
      {
        id: `E${fixture.segmentId}/#visual-style`,
        baseRevision: stale.revision,
        decision: "replace",
        text: `${legalText(fixture)} ${"budget ".repeat(400)}`,
      },
    ]);
    expect(overflow).toContain("Impression refused");
    expect(overflow).toContain("failed the write-time validator");
    expect(overflow).toContain("total-cap");

    // 2. The cheapest "compression" available — dropping the judgment to a
    //    retain — is exactly the one a STALE container refuses.
    const demoted = decideAll(maintainer, [
      { id: `E${fixture.segmentId}/#visual-style`, baseRevision: stale.revision, decision: "retain" },
    ]);
    expect(demoted).toContain("this container is STALE");

    // 3. And the run cannot commit around it either: the duty names the
    //    container it still owes.
    const refused = engine.commit("no friction").content[0]!.text;
    expect(refused).toContain("Commit refused");
    expect(refused).toContain(`no decision recorded for: E${fixture.segmentId}/#visual-style`);

    // Nothing landed at any point: the flag still stands and the debt is open.
    expect(readLaneImpression(db, fixture.segmentId, "visual-style")!.stale).toBe(true);
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");
    expect(
      listOpenImpressionDebts(db, fixture.segmentId).map((debt) => debt.kind),
    ).toContain("merge");
  });

  test("a task merge's STALE mark reaches the surviving TASK tier the same way", () => {
    const fixture = seedFixture();
    const donor = createSegment(db, {
      title: "donor task",
      tags: ["donor-task"],
      nowEpoch: NOW,
    }).id;

    rememberTool(db, { verb: "merge", id: `E${donor}`, into: `E${fixture.segmentId}` });

    expect(readSegmentTaskImpression(db, fixture.segmentId)!.stale).toBe(true);
    expect(
      listOpenImpressionDebts(db, fixture.segmentId).map((debt) => debt.kind),
    ).toContain("task-merge");
  });
});
