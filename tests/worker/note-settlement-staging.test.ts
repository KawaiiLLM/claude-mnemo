import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, isSqliteBusy } from "../../src/db/database";
import { getOutgoingEdges, reconcileCitedPairs, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { listRecentSettlementProposals } from "../../src/db/note-settlement-proposals";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  attachSegmentToSession,
  createSegment,
  getSegment,
  getSegmentMemberTurnIds,
} from "../../src/db/segments";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getShadowNote, upsertShadowNote } from "../../src/db/shadow-notes";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import {
  claimWriterId,
  recordReadGrant,
  sessionWriterId,
  snapshotWriteGateSequence,
  stampField,
} from "../../src/db/write-gate";
import { createSettlementStagingEngine } from "../../src/worker/note-settlement-staging";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * The settlement staging engine (spec A7): `note`/`remember` calls stage,
 * `commit` is the only writer.
 *
 * TICKET 05 (ownership-and-note-cadence spec, "settlement demolition"):
 * `assign` retired from `remember`, turn prose (title/content/insight)
 * retired from `note`, and the completion gate is now an empty shell — fence
 * plus CAS, no segmentation/note/coverage/election-ceiling checks (see
 * `db/note-settlement-completion.ts`'s module doc comment). TICKET 06
 * ("选举机器拆除"): `tier` is also gone. TICKET 02 (view-render-repair spec,
 * "grading retires whole"): `grade` is gone too — `type`/`tags` review,
 * relations, and text-only proposals are what remains, none of them a
 * completion condition.
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

function seedSession(): number {
  return upsertSession(db, {
    contentSessionId: "settlement-staging-session",
    project: "/tmp/project-settlement-staging",
    title: "settlement staging fixture",
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
       ) VALUES (?, ?, 'active', ?, ?, 3, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
    )!.id;
}

function claimWindow(
  target: Database,
  sessionDbId: number,
  windowStart: number,
  windowEnd: number,
): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    target,
    [{ sessionId: sessionDbId, windowStart, windowEnd, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(target, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job;
}

function baseContext(
  job: NoteSettlementJob,
  overrides: Partial<SettlementTurnFacadeContext> = {},
): SettlementTurnFacadeContext {
  return {
    jobId: job.id,
    claimGeneration: job.claimGeneration,
    sessionId: job.sessionId,
    reviewableTurnIds: new Set(),
    contextBuiltAtEpoch: NOW,
    ...overrides,
  };
}

function tableCounts(target: Database) {
  const count = (sql: string) =>
    target.query<{ count: number }, []>(sql).get()?.count ?? 0;
  return {
    shadowNotes: count("SELECT COUNT(*) AS count FROM shadow_notes"),
    memoryEdges: count("SELECT COUNT(*) AS count FROM memory_edges"),
    proposals: count("SELECT COUNT(*) AS count FROM note_settlement_proposals"),
  };
}

// ---------------------------------------------------------------------------
// Acceptance criterion 1: nothing reaches a live table before commit
// ---------------------------------------------------------------------------

describe("acceptance criterion 1 — a staged write reaches no live table before commit", () => {
  test("note (review) and remember (propose) calls change no row anywhere; commit lands them both", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const before = tableCounts(db);
    const beforeTurn = getTurnById(db, t1)!;

    const noteReceipt = engine.stageNoteWrite({
      turn: `S${sessionDbId}/T1`,
      type: ["design"],
      tags: ["lease"],
    });
    const membershipReceipt = engine.stageMembershipWrite({
      action: "propose",
      addresses: [`S${sessionDbId}/T1`],
      title: "a lone turn's own task",
    });

    expect(noteReceipt.content[0]!.text).toContain("Staged");
    expect(membershipReceipt.content[0]!.text).toContain("Staged");
    expect(engine.pendingCount()).toBe(2);

    // Inspecting the TABLES, not the code: nothing moved.
    expect(tableCounts(db)).toEqual(before);
    expect(getTurnById(db, t1)!).toEqual(beforeTurn);

    const commitReceipt = engine.commit();

    expect(commitReceipt.content[0]!.text).toContain("Committed");
    expect(getTurnById(db, t1)!.type).toEqual(["design"]);
    const after = tableCounts(db);
    expect(after.proposals).toBe(before.proposals + 1);
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2: a staged write validates fully, real receipt
// ---------------------------------------------------------------------------

describe("acceptance criterion 2 — a staged write validates fully and returns a real receipt", () => {
  test("an invalid staged call is rejected immediately and never enters the staged list", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set() });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const receipt = engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, type: ["design"] });

    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(receipt.content[0]!.text).toContain("reviewable window");
    expect(engine.pendingCount()).toBe(0);
  });

  // Ticket 04 (edge-mechanism-revision D6) REVOKED duty 2's retirement: turn
  // prose is settlement's to write again, so a staged call naming it stages
  // like any other field instead of being refused at the door.
  test("title/content/insight stage like any other field (duty 2 revoked, ticket 04)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const receipt = engine.stageNoteWrite({
      turn: `S${sessionDbId}/T1`,
      title: "settlement's own note",
      content: "What this turn settled, in hindsight.",
      insight: null,
    });

    expect(receipt.content[0]!.text).not.toContain("Parameter error");
    expect(receipt.content[0]!.text).toContain("Staged note for");
    expect(engine.pendingCount()).toBe(1);
    // Staged, not written: nothing reaches the note table before commit.
    expect(getShadowNote(db, t1)).toBeNull();
  });

  test("a valid staged call reports the SAME decision a real write would make", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const receipt = engine.stageNoteWrite({
      turn: `S${sessionDbId}/T1`,
      type: ["fix"],
      tags: ["widgets"],
    });

    expect(receipt.content[0]!.text).toContain("fix");
    expect(receipt.content[0]!.text).toContain("widgets");
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3 (ticket 05 re-scope): remember stages ONLY propose —
// `assign` retired outright. A single homeless turn may open its own
// proposal (floor drops from 2 to 1); nothing about membership gates
// completion any more.
// ---------------------------------------------------------------------------

describe("acceptance criterion 3 — remember stages propose only; nothing about membership gates completion", () => {
  test("a window with no remember call at all still completes — propose was never required", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    expect(engine.pendingCount()).toBe(0);
    const commitReceipt = engine.commit();

    expect(commitReceipt.content[0]!.text).toContain("Committed");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
  });

  test("propose stores a text cluster and creates NO segment row; addresses are usable turn addresses", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(db, sessionDbId, 1, 2);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1, t2]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const before = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segments").get()!.count;
    engine.stageMembershipWrite({
      action: "propose",
      addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
      title: "the lease-fencing cluster",
    });
    const commitReceipt = engine.commit();

    expect(commitReceipt.content[0]!.text).toContain("Committed");
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segments").get()!.count,
    ).toBe(before);
    const proposals = listRecentSettlementProposals(db, 3);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.title).toBe("the lease-fencing cluster");
    expect(proposals[0]!.addresses.sort()).toEqual(
      [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`].sort(),
    );
  });

  test("propose accepts a SINGLE address — a lone homeless turn may open its own proposal (ticket 05)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const receipt = engine.stageMembershipWrite({
      action: "propose",
      addresses: [`S${sessionDbId}/T1`],
      title: "not a cluster, and that is fine now",
    });

    expect(receipt.content[0]!.text).toContain("Staged");
    expect(engine.commit().content[0]!.text).toContain("Committed");
    expect(listRecentSettlementProposals(db, 3)).toHaveLength(1);
  });

  test("propose refuses zero addresses", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job);
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const receipt = engine.stageMembershipWrite({
      action: "propose",
      addresses: [],
      title: "no addresses at all",
    });

    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(receipt.content[0]!.text).toContain("at least one");
    expect(listRecentSettlementProposals(db, 3)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 5: commit re-validates — the world moving changes the
// outcome
// ---------------------------------------------------------------------------

describe("acceptance criterion 5 — commit re-validates inside its own transaction", () => {
  // Ticket 05 (read-write-contract spec): yield is now the write gate's own
  // per-field staleness, not a shadow-note timestamp comparison — this
  // fixture reproduces the race using `recordReadGrant`/`stampField`
  // directly (db/write-gate.ts), the same seam
  // worker/note-settlement-context.ts uses for a real dispatch.
  test("a review staged before an agent note landed yields at commit, though stage time reported it would write", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const claimWriter = claimWriterId(job.id, job.claimGeneration);
    // Context build's own read grant (worker/note-settlement-context.ts) —
    // taken before either the stage call or the note that lands later.
    recordReadGrant(db, claimWriter, "turn", t1, NOW, snapshotWriteGateSequence(db));
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const receipt = engine.stageNoteWrite({
      turn: `S${sessionDbId}/T1`,
      type: ["fix"],
      tags: ["settlement"],
      // Ticket 07 (spec D12): declared up front, because by COMMIT time the
      // agent's own note has filled both fields — a correction meaning to
      // replace a non-empty set says so on this surface exactly as on the
      // main agent's own `note`.
      mode: { type: "write", tags: "write" },
    });
    // Stage time's own report: it would write, plainly — nothing about the
    // world has moved yet.
    expect(receipt.content[0]!.text).not.toContain("Yielded");

    // The world moves: the main agent's own note lands, strictly after the
    // read grant context build took — the exact race the note-derived
    // review must yield to. `note.ts`'s real subsumption stamps type
    // and tags together; reproduced directly here.
    const agentWriter = sessionWriterId(sessionDbId);
    stampField(db, "turn", t1, "type", agentWriter, NOW + 5);
    stampField(db, "turn", t1, "tags", agentWriter, NOW + 5);
    updateTurnById(db, t1, { type: ["research"] });

    const commitReceipt = engine.commit();
    expect(commitReceipt.content[0]!.text).toContain("Committed");

    const turn = getTurnById(db, t1)!;
    // Ticket 02 (view-render-repair spec, "grading retires whole"): every
    // reviewable field is note-derived now (grade, the one field that
    // was not, is gone) — type/tags both yield, the agent's own type
    // (["research"]) surviving untouched by the stale review, the exact
    // divergence between the stage-time preview (which reported it would
    // overwrite to ["fix"]) and the commit-time truth.
    expect(turn.type).toEqual(["research"]);
    expect(turn.tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 6: the gate runs inside the commit transaction, under
// the fence — file database, second connection
// ---------------------------------------------------------------------------

/**
 * Run `fire` the instant after the next `SELECT … FROM note_settlement_jobs`
 * reads its row — the fence's own read, `assertNoteSettlementJobClaimed` →
 * `getNoteSettlementJob`, which is `commit`'s FIRST statement.
 */
function fireAfterNextJobsRead(target: Database, fire: () => void): void {
  const originalQuery = target.query.bind(target);
  let armed = true;
  (target as unknown as { query: (sql: string) => unknown }).query = (sql: string) => {
    const statement = originalQuery(sql) as unknown as {
      get: (...args: unknown[]) => unknown;
    };
    if (!armed || !/^\s*SELECT/i.test(sql) || !/FROM note_settlement_jobs/i.test(sql)) {
      return statement;
    }
    const originalGet = statement.get.bind(statement);
    statement.get = (...args: unknown[]) => {
      const row = originalGet(...args);
      if (armed) {
        armed = false;
        statement.get = originalGet;
        (target as unknown as { query: unknown }).query = originalQuery;
        fire();
      }
      return row;
    };
    return statement;
  };
}

describe("acceptance criterion 6 — the gate runs inside commit's transaction, under the fence", () => {
  let directory: string;
  let other: Database;

  beforeEach(() => {
    db.close();
    directory = mkdtempSync(join(tmpdir(), "mnemo-staging-txn-"));
    db = createDatabase(join(directory, "mnemo.sqlite"));
    initializeSchema(db);
    other = createDatabase(join(directory, "mnemo.sqlite"), { busyTimeoutMs: 0 });
  });

  afterEach(() => {
    other.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("a competing connection cannot bump the claim generation between the fence's read and the gate's own compare-and-set", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });
    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, type: ["discuss"], tags: [] });

    let competingBumpLanded = false;
    fireAfterNextJobsRead(db, () => {
      try {
        other
          .query<unknown, [number]>(
            "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
          )
          .run(job.id);
        competingBumpLanded = true;
      } catch (error) {
        if (!isSqliteBusy(error)) {
          throw error;
        }
      }
    });

    const receipt = engine.commit();

    // The load-bearing assertion: the bump was locked out for the ENTIRE
    // commit — the replay AND the gate's own completion compare-and-set,
    // not just the fence's own read. If the gate ran in a SEPARATE
    // transaction from the replay/fence, nothing would hold the lock across
    // the gap and this bump would land.
    expect(competingBumpLanded).toBe(false);
    expect(receipt.content[0]!.text).toContain("Committed");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 7: a refused commit keeps the staging
// ---------------------------------------------------------------------------

describe("acceptance criterion 7 — a refused commit reports what is missing and keeps the staging", () => {
  test("a replay conflict (a proposal's turn disappears between stage and commit) refuses the whole commit and keeps every staged write, including the unrelated ones", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(db, sessionDbId, 1, 2);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1, t2]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, type: ["discuss"], tags: [] });
    engine.stageMembershipWrite({
      action: "propose",
      addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
      title: "a cluster about to lose a member",
    });

    // The world moves between staging and commit: T2's turn row is gone (a
    // rollback, in production), so the proposal's own address no longer
    // resolves at commit-time re-validation.
    db.query<unknown, [number]>("DELETE FROM turns WHERE id = ?").run(t2);

    const refusal = engine.commit();
    expect(refusal.content[0]!.text).toContain("Commit refused");
    expect(refusal.content[0]!.text).toContain("Staging kept");
    expect(getTurnById(db, t1)!.type).toEqual([]);
    expect(listRecentSettlementProposals(db, 3)).toEqual([]);
    expect(engine.pendingCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 8: settlement exposes no `check` tool
// ---------------------------------------------------------------------------

describe("acceptance criterion 8 — the staging engine exposes no check", () => {
  test("SettlementStagingEngine has exactly stageNoteWrite/stageMembershipWrite/commit/previewCommit/pendingCount/getLastCommitMetrics", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(db, sessionDbId, 1, 1);
    const engine = createSettlementStagingEngine({ db, context: baseContext(job) });
    expect(Object.keys(engine).sort()).toEqual(
      [
        "commit",
        "getLastCommitMetrics",
        "pendingCount",
        "previewCommit",
        "stageNoteWrite",
        "stageMembershipWrite",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// `commit`'s own replay is the source of the operator job-log metrics
// (worker/note-settlement-dispatch.ts), and none of the counts inside it
// must ever reach the agent (spec G9).
// ---------------------------------------------------------------------------

describe("commit's own result feeds the job log, never the agent", () => {
  test("commit's agent-visible receipt is the fixed 'Committed' sentence — no count data rides along (spec G9)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, type: ["design"], tags: ["lease"] });

    const commitReceipt = engine.commit();
    // Exact-string, not "does not contain" — a substring check could miss a
    // count folded into different wording.
    expect(commitReceipt.content[0]!.text).toBe(
      `Committed. S${sessionDbId} window settled — job complete.`,
    );
  });

  test("getLastCommitMetrics reflects exactly what commit's replay landed, including turnsReviewed and proposalsCreated", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const t3 = seedTurn(sessionDbId, 3);
    const job = claimWindow(db, sessionDbId, 1, 3);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1, t2, t3]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    expect(engine.getLastCommitMetrics()).toBeNull();

    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, type: ["discuss"], tags: [] });
    engine.stageNoteWrite({ turn: `S${sessionDbId}/T2`, type: ["research"], tags: [] });
    engine.stageNoteWrite({ turn: `S${sessionDbId}/T3`, type: ["discuss"], tags: [] });
    engine.stageMembershipWrite({
      action: "propose",
      addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T3`],
      title: "a homeless cluster",
    });

    const commitReceipt = engine.commit();
    expect(commitReceipt.content[0]!.text).toContain("Committed");

    expect(engine.getLastCommitMetrics()).toEqual({
      turnsReviewed: 3,
      reviewsYieldedToLateNote: 0,
      relationsWritten: 0,
      proposalsCreated: 1,
      sessionNarrativeWritten: 0,
      membersReassigned: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Ticket 04 (edge-mechanism-revision D1/D6): the "frozen ∩ current" describe
// block that stood here is DELETED with the fence it guarded. Both halves —
// the frozen pre-run snapshot (spec C7) and its intersection with the pair's
// current existence (ticket 10d finding 1) — asked whether a relation may
// attach to a pair, a question that no longer exists: a relation is a
// standalone claim, so a pair the main agent's prose stopped naming is not a
// reason to refuse one. Nothing replaces this block; `reconcileCitedPairs`
// owning the bare layer alone (its own tests, tests/db/citations.test.ts) is
// what now keeps a prose rewrite from touching relation rows at all.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Spec A7a — staged entries are keyed, and re-staging a key REPLACES it.
// ---------------------------------------------------------------------------

describe("spec A7a — re-staging a key replaces its entry rather than appending", () => {
  // The merge is field-LEVEL: a second call overwrites only the fields it
  // states. Whole-entry replacement would also satisfy every other test in
  // this block, which is why this one exists — it is the only case that
  // tells the two apart, and under whole-entry replacement the type staged
  // first would be silently destroyed by a later call that only names tags.
  test("a second call naming only tags keeps the type the first call staged", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, type: ["design"] });
    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, tags: ["lease"] });
    expect(engine.pendingCount()).toBe(1);

    expect(engine.commit().content[0]!.text).toContain("Committed");

    const turn = getTurnById(db, t1)!;
    // The load-bearing assertion: the first call's type survived a second
    // call that never mentioned it.
    expect(turn.type).toEqual(["design"]);
    expect(turn.tags).toEqual(["lease"]);
  });

  test("restaging the same turn's note does not grow pendingCount, and only the LATEST content lands", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, type: ["discuss"], tags: [] });
    expect(engine.pendingCount()).toBe(1);

    // A same-run correction — the model noticed a better type — restates
    // the SAME turn address.
    const secondReceipt = engine.stageNoteWrite({
      turn: `S${sessionDbId}/T1`,
      type: ["design"],
      tags: [],
    });
    expect(engine.pendingCount()).toBe(1); // replaced, not appended
    expect(secondReceipt.content[0]!.text).toContain("replaces");

    const commitReceipt = engine.commit();
    expect(commitReceipt.content[0]!.text).toContain("Committed");
    expect(getTurnById(db, t1)!.type).toEqual(["design"]);
  });

  test("restaging the same propose address set does not grow pendingCount", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(db, sessionDbId, 1, 2);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1, t2]) });
    const engine = createSettlementStagingEngine({ db, context });

    engine.stageMembershipWrite({
      action: "propose",
      addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
      title: "first title",
    });
    expect(engine.pendingCount()).toBe(1);
    const secondReceipt = engine.stageMembershipWrite({
      action: "propose",
      // Same set, different ORDER — the key is order-independent.
      addresses: [`S${sessionDbId}/T2`, `S${sessionDbId}/T1`],
      title: "corrected title",
    });
    expect(engine.pendingCount()).toBe(1);
    expect(secondReceipt.content[0]!.text).toContain("replaces");
  });

  test("a note and a remember propose on the SAME turn are different staged keys and coexist", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, type: ["discuss"], tags: [] });
    // Floor is 1 (ticket 05), so a lone turn's own proposal is legal too.
    engine.stageMembershipWrite({
      action: "propose",
      addresses: [`S${sessionDbId}/T1`],
      title: "the same turn, proposed on its own",
    });
    expect(engine.pendingCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Ticket 09 (edge-ownership-impl, "结算顺手维护 session 叙事"): the
// session-addressed narrative write goes through the SAME staging engine as
// every turn/membership call — staged, validated, invisible to a live table
// until `commit`.
// ---------------------------------------------------------------------------

describe("session-addressed narrative writes stage through the same commit channel (ticket 09)", () => {
  test("stages without writing, then lands on commit", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job);
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const stageReceipt = engine.stageNoteWrite({
      session: `S${sessionDbId}`,
      title: "the window's story",
      content: "what happened",
      mode: { title: "write" },
    });
    expect(stageReceipt.content[0]!.text).toContain("pending commit");
    // Nothing landed yet.
    expect(getSession(db, sessionDbId)?.title).toBe("settlement staging fixture");
    expect(getSession(db, sessionDbId)?.content).toBeNull();

    const commitReceipt = engine.commit();
    expect(commitReceipt.content[0]!.text).toContain("Committed");
    expect(getSession(db, sessionDbId)?.title).toBe("the window's story");
    expect(getSession(db, sessionDbId)?.content).toBe("what happened");
  });

  test("re-staging the same session address REPLACES the earlier staged call, not appends a second one", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job);
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageNoteWrite({ session: `S${sessionDbId}`, content: "first draft" });
    expect(engine.pendingCount()).toBe(1);
    const secondReceipt = engine.stageNoteWrite({ session: `S${sessionDbId}`, content: "corrected draft" });
    expect(engine.pendingCount()).toBe(1);
    expect(secondReceipt.content[0]!.text).toContain("replaces");

    engine.commit();
    expect(getSession(db, sessionDbId)?.content).toBe("corrected draft");
  });

  test("a turn note and a session narrative in the same window are different staged keys and coexist", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, type: ["fix"], tags: [] });
    engine.stageNoteWrite({
      session: `S${sessionDbId}`,
      title: "session title",
      mode: { title: "write" },
    });
    expect(engine.pendingCount()).toBe(2);

    engine.commit();
    expect(getTurnById(db, t1)!.type).toEqual(["fix"]);
    expect(getSession(db, sessionDbId)?.title).toBe("session title");
  });

  test("a session-addressed stage against a different session is refused, and the fence stays intact", () => {
    const sessionDbId = seedSession();
    const otherSessionDbId = upsertSession(db, {
      contentSessionId: "settlement-staging-other-session",
      project: "/tmp/project-settlement-staging",
      title: "a different session",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 5_000,
      updatedAtEpoch: NOW - 5_000,
      completedAtEpoch: null,
    }).id;
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job);
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const receipt = engine.stageNoteWrite({ session: `S${otherSessionDbId}`, title: "not mine" });
    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(receipt.content[0]!.text).toContain("not this dispatch's own session");
    expect(engine.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ticket 08 (edge-ownership-impl, "settlement four-field check-and-correct")
// — one end-to-end "wrong -> corrected -> landed in DB via commit" test per
// field (the ticket's own checklist), plus the membership out-of-domain
// boundary and the edge phase-legality validator's legal/illegal cases,
// mirroring `tests/mcp/note.test.ts`'s own phase-pair tests on the note path.
// ---------------------------------------------------------------------------

describe("ticket 08 — type correction", () => {
  test("a wrong type is corrected and lands via commit", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    updateTurnById(db, t1, { type: ["fix"] }); // wrong: this turn was actually a design call
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    expect(getTurnById(db, t1)!.type).toEqual(["fix"]);
    engine.stageNoteWrite({
      turn: `S${sessionDbId}/T1`,
      type: ["design"],
      mode: { type: "write" },
    });
    // Nothing landed yet — still staged.
    expect(getTurnById(db, t1)!.type).toEqual(["fix"]);

    expect(engine.commit().content[0]!.text).toContain("Committed");
    expect(getTurnById(db, t1)!.type).toEqual(["design"]);
  });
});

describe("ticket 08 — tags correction", () => {
  test("a wrong tag is corrected and lands via commit", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    updateTurnById(db, t1, { tags: ["wrong-project"] });
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageNoteWrite({
      turn: `S${sessionDbId}/T1`,
      tags: ["claude-mnemo"],
      mode: { tags: "write" },
    });
    expect(getTurnById(db, t1)!.tags).toEqual(["wrong-project"]);

    expect(engine.commit().content[0]!.text).toContain("Committed");
    // Whole overwrite, not a union — the wrong tag is gone, not merely joined.
    expect(getTurnById(db, t1)!.tags).toEqual(["claude-mnemo"]);
  });
});

describe("ticket 08 — membership correction", () => {
  test("a mis-homed turn is reassigned to a different attached segment and lands via commit", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const wrongSegment = createSegment(db, { title: "wrong task", nowEpoch: NOW });
    const rightSegment = createSegment(db, { title: "right task", nowEpoch: NOW });
    attachSegmentToSession(db, sessionDbId, wrongSegment.id, NOW);
    attachSegmentToSession(db, sessionDbId, rightSegment.id, NOW);
    addSegmentMembers(db, wrongSegment.id, [t1], NOW);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, {
      reviewableTurnIds: new Set([t1]),
    });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const receipt = engine.stageMembershipWrite({
      action: "reassign",
      turns: [`S${sessionDbId}/T1`],
      id: `E${rightSegment.id}`,
    });
    expect(receipt.content[0]!.text).toContain("Staged");
    // Nothing landed yet.
    expect(getSegmentMemberTurnIds(db, wrongSegment.id)).toEqual([t1]);
    expect(getSegmentMemberTurnIds(db, rightSegment.id)).toEqual([]);

    expect(engine.commit().content[0]!.text).toContain("Committed");
    expect(getSegmentMemberTurnIds(db, wrongSegment.id)).toEqual([]);
    expect(getSegmentMemberTurnIds(db, rightSegment.id)).toEqual([t1]);
  });

  // Ticket 04 (edge-mechanism-revision D6, "跨段改派") deleted the value
  // domain this test used to pin: a segment this session never attached is a
  // legal target now. A segment id naming NOTHING is still refused, which is
  // the check that actually protects the write.
  test("a segment id naming nothing is refused, and nothing lands", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, {
      reviewableTurnIds: new Set([t1]),
    });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const receipt = engine.stageMembershipWrite({
      action: "reassign",
      turns: [`S${sessionDbId}/T1`],
      id: "E9999",
    });

    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(receipt.content[0]!.text).toContain("E9999");
    expect(receipt.content[0]!.text).toContain("does not exist");
    expect(engine.pendingCount()).toBe(0);
  });

  test("a segment another session owns is a legal target — cross-segment reassignment (ticket 04)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const elsewhere = createSegment(db, { title: "another session's task", nowEpoch: NOW });
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, {
      reviewableTurnIds: new Set([t1]),
    });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageMembershipWrite({
      action: "reassign",
      turns: [`S${sessionDbId}/T1`],
      id: `E${elsewhere.id}`,
    });
    expect(engine.commit().content[0]!.text).toContain("Committed");
    expect(getSegmentMemberTurnIds(db, elsewhere.id)).toEqual([t1]);
  });

  // Ticket 02's own fixture shape (tests/db/segments.test.ts, "type and tags
  // are DERIVED from the members"): assert the segment's own derived
  // type/tags directly after the membership change, no separate
  // recomputation call — `reassignSegmentMembers` recomputes the vacated
  // segment's facets synchronously.
  test("a mis-homed turn corrected to homeless leaves the old segment's derived facets excluding it", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    updateTurnById(db, t1, { type: ["design"], tags: ["lease"] });
    const segment = createSegment(db, { title: "lease fencing", nowEpoch: NOW });
    attachSegmentToSession(db, sessionDbId, segment.id, NOW);
    addSegmentMembers(db, segment.id, [t1], NOW);
    expect(getSegment(db, segment.id)?.type).toEqual(["design"]);
    expect(getSegment(db, segment.id)?.tags).toEqual(["lease"]);

    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, {
      reviewableTurnIds: new Set([t1]),
    });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    // `id` omitted: reassign to no segment (homeless).
    engine.stageMembershipWrite({ action: "reassign", turns: [`S${sessionDbId}/T1`] });
    expect(engine.commit().content[0]!.text).toContain("Committed");

    expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([]);
    // The load-bearing assertion (ticket 02's own fixture shape): the
    // segment's DERIVED facets no longer count the departed member at all.
    expect(getSegment(db, segment.id)?.type).toEqual([]);
    expect(getSegment(db, segment.id)?.tags).toEqual([]);
  });
});

describe("ticket 08 — edge correction through the shared phase validator (requirement: one validator, both write paths)", () => {
  test("a legal phase pair (decision -> decision, refines) is classified and lands via commit", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    // Both decision-phase, seeded directly — the CITED side's phase check
    // reads the live database, so it must already be there before staging.
    updateTurnById(db, t1, { type: ["design"] });
    updateTurnById(db, t2, { type: ["correction"] });
    // A pre-existing bare pair — settlement fills in the missing
    // classification with hindsight, exactly like a `note` path correction.
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: null, provenance: "text-ref" }],
      NOW - 500,
    );
    const job = claimWindow(db, sessionDbId, 1, 2);
    const context = baseContext(job);
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const receipt = engine.stageNoteWrite({
      turn: `S${sessionDbId}/T2`,
      refines: [`S${sessionDbId}/T1`],
    });
    expect(receipt.content[0]!.text).toContain("Staged");

    expect(engine.commit().content[0]!.text).toContain("Committed");
    const edges = getOutgoingEdges(db, { kind: "turn", id: t2 });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("refines");
    expect(edges[0]!.provenance).toBe("judged");
  });

  test("an illegal phase pair (delivery-only citing turn attempting refines) is rejected, naming which half is missing — mirrors the note path's own case", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["design"] }); // decision-phase target: fine
    updateTurnById(db, t2, { type: ["implement"] }); // delivery-ONLY citing turn: refines needs decision
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: null, provenance: "text-ref" }],
      NOW - 500,
    );
    const job = claimWindow(db, sessionDbId, 1, 2);
    const context = baseContext(job);
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const receipt = engine.stageNoteWrite({
      turn: `S${sessionDbId}/T2`,
      refines: [`S${sessionDbId}/T1`],
    });

    expect(receipt.content[0]!.text).toContain("Parameter error");
    // explainRelationPhaseRejection: which HALF is missing, same wording the
    // note tool's own phase-pair test asserts.
    expect(receipt.content[0]!.text).toContain("decision-phase");
    expect(engine.pendingCount()).toBe(0);
    // Nothing landed — not even the bare pair's relation moved.
    const edges = getOutgoingEdges(db, { kind: "turn", id: t2 });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBeNull();
  });

  test("a relation whose same-call type correction YIELDS to a late note is judged by the persisted type, not the never-landed proposal", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["design"] }); // decision-phase target: fine
    // t2's PERSISTED type stays [] — no decision phase on the citing side.
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: null, provenance: "text-ref" }],
      NOW - 500,
    );
    const job = claimWindow(db, sessionDbId, 1, 2);
    const context = baseContext(job, {
      reviewableTurnIds: new Set([t2]),
      contextBuiltAtEpoch: NOW,
    });
    // Context build's own read grant, taken at NOW. The agent's own note
    // lands AFTER it (write-gate stamp, ticket 05) — the review's
    // note-derived half (type/tags) stands down. The proposed ["design"]
    // below never reaches the database — so the refines edge may not ride
    // on it either.
    const claimWriter = claimWriterId(job.id, job.claimGeneration);
    recordReadGrant(db, claimWriter, "turn", t2, NOW, snapshotWriteGateSequence(db));
    const agentWriter = sessionWriterId(sessionDbId);
    stampField(db, "turn", t2, "type", agentWriter, NOW + 5);
    stampField(db, "turn", t2, "tags", agentWriter, NOW + 5);
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW + 6 });

    const receipt = engine.stageNoteWrite({
      turn: `S${sessionDbId}/T2`,
      type: ["design"],
      refines: [`S${sessionDbId}/T1`],
    });

    // Judged by the persisted [] type: refines lacks its decision half.
    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(receipt.content[0]!.text).toContain("decision-phase");
    expect(engine.pendingCount()).toBe(0);
    const edges = getOutgoingEdges(db, { kind: "turn", id: t2 });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBeNull();
    expect(getTurnById(db, t2)!.type).toEqual([]);
  });
});
