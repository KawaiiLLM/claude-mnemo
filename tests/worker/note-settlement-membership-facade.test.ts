import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { getLane, listLanesForSegment } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { listRecentSettlementProposals } from "../../src/db/note-settlement-proposals";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  attachSegmentToSession,
  createSegment,
  getSegment,
  getSegmentMemberTurnIds,
  listAttachedSegments,
  reassignSegmentMembers,
  setSegmentTags,
  toggleSegmentStatus,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import {
  evaluateSettlementMembershipWrite,
  renderSettlementMembershipWriteReceipt,
  settlementMembershipWriteInputSchema,
  type SettlementMembershipWriteInput,
} from "../../src/worker/note-settlement-membership-facade";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * The settlement membership facade's DECISION function,
 * `evaluateSettlementMembershipWrite`.
 *
 * TICKET 05 (ownership-and-note-cadence spec, "settlement demolition"):
 * `assign` retired outright — every describe block that exercised it
 * (required fields, the attached-set boundary, landing/idempotence, the
 * `homeless stays legal` negative space, the tag-facet exclusion proved
 * through the assign path) is gone, because the ACTION is gone, not because
 * the facade grew stricter about it. `propose` is the sole survivor, and its
 * floor drops from 2 addresses to 1 (spec: "最小簇 1，修订现行 ≥2 ——孤立 turn
 * 独自开启新任务是合法情形"). It is also no longer a completion condition —
 * `recordNoteSettlementMembershipActivity` and the table it wrote to
 * (`note_settlement_membership_activity`) are gone with the membership gate
 * (see `db/note-settlement-completion.ts`'s module doc comment).
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
    contentSessionId: "settlement-membership-facade-session",
    project: "/tmp/project-settlement-membership-facade",
    title: "settlement membership facade fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(
  sessionDbId: number,
  promptNumber: number,
  facets: { type?: string[]; tags?: string[] } = {},
): number {
  return db
    .query<{ id: number }, [number, number, string, string, number, string, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, tags
       ) VALUES (?, ?, 'active', ?, ?, 3, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
      JSON.stringify(facets.type ?? []),
      JSON.stringify(facets.tags ?? []),
    )!.id;
}

function claimWindow(sessionDbId: number, windowStart: number, windowEnd: number): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart, windowEnd, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
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

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

describe("settlementMembershipWriteInputSchema", () => {
  test("accepts a minimal propose", () => {
    expect(
      settlementMembershipWriteInputSchema.safeParse({
        action: "propose",
        addresses: ["S1/T1"],
        title: "a cluster",
      }).success,
    ).toBe(true);
  });

  test("rejects action=\"assign\" — the value itself is gone from the enum, not merely refused downstream", () => {
    expect(
      settlementMembershipWriteInputSchema.safeParse({
        action: "assign",
        addresses: ["S1/T1"],
        title: "x",
      }).success,
    ).toBe(false);
  });

  test("accepts declare/undeclare with id+tag — settlement owns the lane registry (ticket 02, spec D4)", () => {
    for (const action of ["declare", "undeclare"] as const) {
      expect(
        settlementMembershipWriteInputSchema.safeParse({ action, id: "E60", tag: "write-gate" })
          .success,
      ).toBe(true);
    }
  });

  test("rejects an unknown field (strict schema)", () => {
    expect(
      settlementMembershipWriteInputSchema.safeParse({
        action: "propose",
        addresses: ["S1/T1"],
        title: "a cluster",
        segmentId: 1,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

describe("propose — required fields and address resolution", () => {
  test("refuses a missing title", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "propose", addresses: [`S${sessionDbId}/T1`] },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("title");
  });

  test("refuses zero addresses", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job),
      { action: "propose", addresses: [], title: "empty cluster" },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("at least one");
  });

  test("a malformed address rejects the WHOLE call — nothing is stored for a partially bad list", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      {
        action: "propose",
        addresses: [`S${sessionDbId}/T1`, "not-an-address"],
        title: "a cluster",
      },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("not-an-address");
    expect(listRecentSettlementProposals(db, 3)).toEqual([]);
  });

  test("an address outside this dispatch's reviewable window rejects the whole call", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    const result = evaluateSettlementMembershipWrite(
      db,
      // t2 deliberately outside reviewableTurnIds.
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      {
        action: "propose",
        addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
        title: "a cluster",
      },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("reviewable window");
  });
});

describe("propose — a single homeless turn may open its own proposal (ticket 05: floor drops from 2 to 1)", () => {
  test("a lone address is accepted and stored as a one-turn proposal", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "propose", addresses: [`S${sessionDbId}/T1`], title: "a lone turn's own task" },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.outcome.addressesResolved).toBe(1);
    const proposals = listRecentSettlementProposals(db, 3);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.addresses).toEqual([`S${sessionDbId}/T1`]);
  });

  test("a multi-turn cluster is still legal", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1, t2]) }),
      {
        action: "propose",
        addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
        title: "a two-turn cluster",
      },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.outcome.addressesResolved).toBe(2);
  });
});

describe("propose — never creates a segment row, and is no longer a completion condition (ticket 05)", () => {
  test("a landed propose adds zero rows to segments, whatever the address count", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const t3 = seedTurn(sessionDbId, 3);
    const job = claimWindow(sessionDbId, 1, 3);
    const before = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segments").get()!.count;

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1, t2, t3]) }),
      {
        action: "propose",
        addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`, `S${sessionDbId}/T3`],
        title: "a three-turn cluster",
      },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segments").get()!.count,
    ).toBe(before);
    const proposals = listRecentSettlementProposals(db, 3);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.title).toBe("a three-turn cluster");
  });

  // Ticket 05 (spec "propose 携幂等键"): a RE-CLAIMED job (new job id after a
  // lost lease) retrying the same propose must not duplicate the row.
  test("a duplicate propose from a DIFFERENT job id (a re-claimed retry) lands on the same row, never a second one", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const firstJob = claimWindow(sessionDbId, 1, 2);

    const first = evaluateSettlementMembershipWrite(
      db,
      baseContext(firstJob, { reviewableTurnIds: new Set([t1, t2]) }),
      {
        action: "propose",
        addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
        title: "first attempt's title",
      },
      NOW,
      { apply: true },
    );
    expect(first.ok).toBe(true);

    // A retry after the lease was lost carries a DIFFERENT job id (the
    // pinned reason a job-scoped key cannot dedupe) but the SAME session and
    // the SAME canonical address set.
    const retryContext = baseContext(firstJob, {
      jobId: firstJob.id + 1000,
      reviewableTurnIds: new Set([t1, t2]),
    });
    const retry = evaluateSettlementMembershipWrite(
      db,
      retryContext,
      {
        action: "propose",
        addresses: [`S${sessionDbId}/T2`, `S${sessionDbId}/T1`],
        title: "retry's own (different) title",
      },
      NOW + 10,
      { apply: true },
    );

    expect(retry.ok).toBe(true);
    expect(retry.ok && retry.outcome.proposeAlreadyExisted).toBe(true);
    expect(retry.ok && first.ok && retry.outcome.proposalId).toBe(first.outcome.proposalId);
    expect(
      retry.ok
        ? renderSettlementMembershipWriteReceipt(retry.outcome, { staged: false })
        : "",
    ).toContain("already exists");

    const proposals = listRecentSettlementProposals(db, 5);
    expect(proposals).toHaveLength(1);
    // Ticket 14 (spec "propose 撞键刷新 title"): the retry's title refreshes
    // the stored row — a later pass has seen more of the window.
    expect(proposals[0]!.title).toBe("retry's own (different) title");
  });

});

// ---------------------------------------------------------------------------
// reassign (ticket 08) — the membership-correction verb. Ticket 04
// (edge-mechanism-revision D6, "跨段改派") DELETED its value domain: any
// segment that exists and is open is a legal target, whichever session it
// belongs to. What still refuses is the segment's own lifecycle (closed) and
// the window scope on the TURNS being moved.
// ---------------------------------------------------------------------------

describe("reassign — cross-segment, bounded only by existence and status (ticket 04)", () => {
  test("a segment this session never attached is a legal target — that is what cross-segment reassignment means", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const elsewhere = createSegment(db, { title: "elsewhere, never attached", nowEpoch: NOW });

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "reassign", turns: [`S${sessionDbId}/T1`], id: `E${elsewhere.id}` },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(getSegmentMemberTurnIds(db, elsewhere.id)).toEqual([t1]);
  });

  test("a segment id naming nothing at all is still refused", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "reassign", turns: [`S${sessionDbId}/T1`], id: "E9999" },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("does not exist");
  });

  test("naming an attached segment is accepted", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const attached = createSegment(db, { title: "this session's own segment", nowEpoch: NOW });
    attachSegmentToSession(db, sessionDbId, attached.id, NOW);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "reassign", turns: [`S${sessionDbId}/T1`], id: `E${attached.id}` },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(getSegmentMemberTurnIds(db, attached.id)).toEqual([t1]);
  });

  test("id omitted clears ownership (homeless) without naming any segment domain", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const attached = createSegment(db, { title: "was home", nowEpoch: NOW });
    attachSegmentToSession(db, sessionDbId, attached.id, NOW);
    addSegmentMembers(db, attached.id, [t1], NOW);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "reassign", turns: [`S${sessionDbId}/T1`] },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.outcome.reassign?.targetSegmentId).toBeNull();
    expect(getSegmentMemberTurnIds(db, attached.id)).toEqual([]);
  });

  test("requires at least one turn address", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job),
      { action: "reassign", turns: [] },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("at least one turn address");
  });

  // Ticket 05 (spec: "渲染后被 detach/close 的段不可再收成员"), surviving
  // ticket 04's domain deletion: status is read LIVE, every call.
  test("a segment closed after the roster was rendered is refused", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const attached = createSegment(db, { title: "closes mid-run", nowEpoch: NOW });
    attachSegmentToSession(db, sessionDbId, attached.id, NOW);

    // The main agent closed it between context-build and this call.
    toggleSegmentStatus(db, attached.id, NOW + 1);
    expect(getSegment(db, attached.id)!.status).toBe("closed");

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "reassign", turns: [`S${sessionDbId}/T1`], id: `E${attached.id}` },
      NOW + 2,
      { apply: true },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(`E${attached.id}`);
    expect(!result.ok && result.message).toContain("closed");
    expect(getSegmentMemberTurnIds(db, attached.id)).toEqual([]);
  });

  test("a segment attached after the roster was rendered is accepted — the rendered roster was never the gate", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const freshlyAttached = createSegment(db, { title: "attached mid-run", nowEpoch: NOW });

    attachSegmentToSession(db, sessionDbId, freshlyAttached.id, NOW + 1);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "reassign", turns: [`S${sessionDbId}/T1`], id: `E${freshlyAttached.id}` },
      NOW + 2,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(getSegmentMemberTurnIds(db, freshlyAttached.id)).toEqual([t1]);
  });

  test("settlementMembershipWriteInputSchema accepts reassign", () => {
    expect(
      settlementMembershipWriteInputSchema.safeParse({
        action: "reassign",
        turns: ["S1/T1"],
        id: "E1",
      }).success,
    ).toBe(true);
    expect(
      settlementMembershipWriteInputSchema.safeParse({
        action: "reassign",
        turns: ["S1/T1"],
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reassign — the membership tag gate (rubric-v10 ticket 07): one of the
// three call sites sharing `checkSegmentMembershipTagGate` (db/segments.ts).
// ---------------------------------------------------------------------------

describe("reassign — the membership tag gate (ticket 07)", () => {
  test("a turn missing a target segment tag is refused, naming the gap and the segment; nothing is co-written", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1, { tags: ["lease"] }); // missing "fencing"
    const job = claimWindow(sessionDbId, 1, 1);
    const target = createSegment(db, {
      title: "gated",
      tags: ["lease", "fencing"],
      nowEpoch: NOW,
    });

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "reassign", turns: [`S${sessionDbId}/T1`], id: `E${target.id}` },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(`E${target.id}`);
    expect(!result.ok && result.message).toContain("fencing");
    expect(getSegmentMemberTurnIds(db, target.id)).toEqual([]);
  });

  test("a turn carrying every target tag is accepted", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1, { tags: ["lease", "fencing", "extra"] });
    const job = claimWindow(sessionDbId, 1, 1);
    const target = createSegment(db, {
      title: "gated",
      tags: ["lease", "fencing"],
      nowEpoch: NOW,
    });

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "reassign", turns: [`S${sessionDbId}/T1`], id: `E${target.id}` },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(getSegmentMemberTurnIds(db, target.id)).toEqual([t1]);
  });

  test("an EMPTY target segment.tags gates nothing — vacuous pass", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1); // untagged
    const job = claimWindow(sessionDbId, 1, 1);
    const target = createSegment(db, { title: "ungated", nowEpoch: NOW });

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "reassign", turns: [`S${sessionDbId}/T1`], id: `E${target.id}` },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(getSegmentMemberTurnIds(db, target.id)).toEqual([t1]);
  });

  test("id omitted (homeless) is never gated", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1); // untagged
    const job = claimWindow(sessionDbId, 1, 1);
    const attached = createSegment(db, { title: "was home", tags: ["required"], nowEpoch: NOW });
    attachSegmentToSession(db, sessionDbId, attached.id, NOW);
    addSegmentMembers(db, attached.id, [t1], NOW);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "reassign", turns: [`S${sessionDbId}/T1`] },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(getSegmentMemberTurnIds(db, attached.id)).toEqual([]);
  });

  test("grandfathering: an existing member lacking the target's tags is untouched by retagging the segment or an unrelated reassign", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1); // untagged, joins before the segment is tagged
    const t2 = seedTurn(sessionDbId, 2, { tags: ["required"] });
    const job = claimWindow(sessionDbId, 1, 2);
    const target = createSegment(db, { title: "grandfathered", nowEpoch: NOW });
    addSegmentMembers(db, target.id, [t1], NOW); // pre-gate: untagged segment, vacuous pass
    expect(getSegmentMemberTurnIds(db, target.id)).toEqual([t1]);

    // Tags land on the segment AFTER t1 already joined — nothing re-checks
    // that pre-existing membership.
    setSegmentTags(db, target.id, ["required"], NOW);
    expect(getSegmentMemberTurnIds(db, target.id)).toEqual([t1]);

    // A later reassign call for a DIFFERENT turn is checked, but never
    // re-checks t1's pre-gate membership.
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1, t2]) }),
      { action: "reassign", turns: [`S${sessionDbId}/T2`], id: `E${target.id}` },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(true);
    expect(getSegmentMemberTurnIds(db, target.id).sort()).toEqual([t1, t2].sort());
  });

  // Mutation check (this ticket's own acceptance criterion): if the gate
  // call in `evaluateReassign` were removed, this test would let a
  // mismatched turn through undetected — it must fail loudly instead.
  test("MUTATION CHECK: disabling the gate on this path would let a mismatched turn through undetected", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1); // carries no tags at all
    const job = claimWindow(sessionDbId, 1, 1);
    const target = createSegment(db, { title: "gated", tags: ["required"], nowEpoch: NOW });

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "reassign", turns: [`S${sessionDbId}/T1`], id: `E${target.id}` },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(false);
    expect(getSegmentMemberTurnIds(db, target.id)).toEqual([]);
  });

  test("create's own seed-member reassignment is NOT gated (ticket 07 scope)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1); // untagged
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "create", title: "fresh, tagged, seeded from an untagged turn", turns: [`S${sessionDbId}/T1`] },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    const segmentId = result.ok ? result.outcome.create!.segmentId! : -1;
    expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([t1]);
  });
});

// ---------------------------------------------------------------------------
// create (ticket 04, edge-mechanism-revision D6, "建段") — settlement mints a
// segment when no existing one fits, and it joins THIS session's roster so the
// next window (and the main agent's SessionStart) can see it.
// ---------------------------------------------------------------------------

describe("create — settlement opens a segment (ticket 04)", () => {
  test("mints the segment, attaches it to this session, and seeds the named members", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1, t2]) }),
      {
        action: "create",
        title: "the arc this window actually shows",
        turns: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
      },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    const segmentId = result.ok ? result.outcome.create!.segmentId! : 0;
    expect(getSegment(db, segmentId)!.title).toBe("the arc this window actually shows");
    expect(getSegmentMemberTurnIds(db, segmentId).sort()).toEqual([t1, t2].sort());
    // On the roster: what makes the rubric's "check the roster before minting
    // a new one" rule followable for the NEXT window.
    expect(listAttachedSegments(db, sessionDbId).map((segment) => segment.id)).toEqual([
      segmentId,
    ]);
  });

  test("a seeded turn is evicted from its previous segment — one home, one write path", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const previous = createSegment(db, { title: "the wrong home", nowEpoch: NOW });
    attachSegmentToSession(db, sessionDbId, previous.id, NOW);
    addSegmentMembers(db, previous.id, [t1], NOW);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "create", title: "the right home", turns: [`S${sessionDbId}/T1`] },
      NOW + 1,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(getSegmentMemberTurnIds(db, previous.id)).toEqual([]);
  });

  test("requires a title, and refuses a member address outside the rendered window", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const untitled = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "create", title: "   " },
      NOW,
      { apply: true },
    );
    expect(untitled.ok).toBe(false);
    expect(!untitled.ok && untitled.message).toContain("create requires title");

    const outOfWindow = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set() }),
      { action: "create", title: "a title", turns: [`S${sessionDbId}/T1`] },
      NOW,
      { apply: true },
    );
    expect(outOfWindow.ok).toBe(false);
    expect(!outOfWindow.ok && outOfWindow.message).toContain("outside this dispatch's reviewable window");
    expect(listAttachedSegments(db, sessionDbId)).toEqual([]);
  });

  test("settlementMembershipWriteInputSchema accepts create and still refuses the retired assign", () => {
    expect(
      settlementMembershipWriteInputSchema.safeParse({
        action: "create",
        title: "a segment",
        turns: ["S1/T1"],
      }).success,
    ).toBe(true);
    expect(
      settlementMembershipWriteInputSchema.safeParse({ action: "assign", turns: ["S1/T1"] })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Receipt rendering
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// declare / undeclare (lane-declaration spec D1/D4, ticket 02)
// ---------------------------------------------------------------------------

/**
 * Settlement owns lane declaration outright ([S15069/T1547]), and the
 * settlement prompt's Block B step 2 tells a run to `declare` a fresh tag when
 * no existing one fits. Before this ticket the facade's action enum was
 * `["propose", "reassign", "create"]`, so that instruction was a hard schema
 * rejection rather than a refusal a run could read and act on.
 *
 * Asserted at the FACADE boundary, never against `db/lanes.ts` — the point is
 * that settlement reaches the same rules the main agent's `remember` enforces,
 * not that the primitives underneath still work.
 */
describe("declare / undeclare — settlement's half of the lane registry (ticket 02)", () => {
  // ONE claimed window per test — `claimWindow` mints a job, and a helper that
  // re-claimed on every call would throw on the second refusal a test asserts.
  let context: SettlementTurnFacadeContext | null = null;
  beforeEach(() => {
    context = null;
  });
  const evaluate = (input: SettlementMembershipWriteInput) => {
    context ??= baseContext(claimWindow(seedSession(), 1, 1));
    return evaluateSettlementMembershipWrite(db, context, input, NOW);
  };

  function openSegment(title = "a lane home"): number {
    return createSegment(db, { title, nowEpoch: NOW }).id;
  }

  test("declare mints the lane and the receipt names it", () => {
    const segmentId = openSegment();
    const result = evaluate({ action: "declare", id: `E${segmentId}`, tag: "write-gate" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.lane).toEqual({
      action: "declare",
      segmentId,
      tag: "write-gate",
      laneId: getLane(db, segmentId, "write-gate")!.id,
    });
    expect(renderSettlementMembershipWriteReceipt(result.outcome)).toContain(
      'Landed declare: lane "write-gate"',
    );
    expect(listLanesForSegment(db, segmentId).map((lane) => lane.tag)).toEqual(["write-gate"]);
  });

  test("a NON-CANONICAL tag is refused naming the exact problem, never normalized", () => {
    const segmentId = openSegment();
    for (const [tag, fragment] of [
      ["Write-Gate", "not lowercase"],
      ["write gate", "interior whitespace"],
      [" write-gate", "leading or trailing whitespace"],
    ] as const) {
      const result = evaluate({ action: "declare", id: `E${segmentId}`, tag });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain(fragment);
      }
    }
    // Nothing was silently canonicalized into existence.
    expect(listLanesForSegment(db, segmentId)).toEqual([]);
  });

  test("a tag already among the segment's CURATED tags is refused — the two vocabularies stay separate", () => {
    const segmentId = createSegment(db, { title: "curated", tags: ["release"], nowEpoch: NOW }).id;
    const result = evaluate({ action: "declare", id: `E${segmentId}`, tag: "release" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("already one of");
      expect(result.message).toContain("curated tags");
    }
    expect(listLanesForSegment(db, segmentId)).toEqual([]);
  });

  test("declaring the same lane twice is refused, naming the existing row", () => {
    const segmentId = openSegment();
    expect(evaluate({ action: "declare", id: `E${segmentId}`, tag: "write-gate" }).ok).toBe(true);
    const second = evaluate({ action: "declare", id: `E${segmentId}`, tag: "write-gate" });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.message).toContain("already declares");
    }
  });

  test("a missing id, a missing tag, a nonexistent segment and a CLOSED segment each refuse by name", () => {
    const segmentId = openSegment();
    const closedId = openSegment("closed");
    toggleSegmentStatus(db, closedId, NOW);

    expect(evaluate({ action: "declare", tag: "x" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("requires id"),
    });
    expect(evaluate({ action: "declare", id: `E${segmentId}` })).toMatchObject({
      ok: false,
      message: expect.stringContaining("requires tag"),
    });
    expect(evaluate({ action: "declare", id: "E99999", tag: "x" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("does not exist"),
    });
    expect(evaluate({ action: "declare", id: `E${closedId}`, tag: "x" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("is closed"),
    });
  });

  test("undeclare removes an unused lane, and refuses while any edge still carries the tag", () => {
    const sessionDbId = seedSession();
    const segmentId = openSegment();
    const cited = seedTurn(sessionDbId, 1, { type: ["design"], tags: ["write-gate"] });
    const citing = seedTurn(sessionDbId, 2, { type: ["design"], tags: ["write-gate"] });
    expect(reassignSegmentMembers(db, [cited, citing], segmentId, NOW).ok).toBe(true);
    expect(evaluate({ action: "declare", id: `E${segmentId}`, tag: "write-gate" }).ok).toBe(true);

    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "extends",
          provenance: "judged",
          ...deriveSideTags(["write-gate"]),
        },
      ],
      NOW,
    );

    const inUse = evaluate({ action: "undeclare", id: `E${segmentId}`, tag: "write-gate" });
    expect(inUse.ok).toBe(false);
    if (!inUse.ok) {
      expect(inUse.message).toContain("still has 1 edge(s) carrying it");
    }
    expect(getLane(db, segmentId, "write-gate")).not.toBeNull();

    // A lane nothing carries goes.
    expect(evaluate({ action: "declare", id: `E${segmentId}`, tag: "unused" }).ok).toBe(true);
    const removed = evaluate({ action: "undeclare", id: `E${segmentId}`, tag: "unused" });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(renderSettlementMembershipWriteReceipt(removed.outcome)).toContain(
        'Landed undeclare: lane "unused"',
      );
    }
    expect(getLane(db, segmentId, "unused")).toBeNull();
  });

  test("undeclaring a lane that was never declared refuses by name", () => {
    const segmentId = openSegment();
    const result = evaluate({ action: "undeclare", id: `E${segmentId}`, tag: "never-declared" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("has no declared lane");
    }
  });
});

// ---------------------------------------------------------------------------
// The lane gate on settlement's own membership moves (ticket 02, D2)
// ---------------------------------------------------------------------------

describe("reassign — the lane stranding gate", () => {
  test("a reassignment that would strand an incident tagged edge refuses, and declaring the lane in the destination first makes it land", () => {
    const sessionDbId = seedSession();
    const home = createSegment(db, { title: "home", nowEpoch: NOW }).id;
    const destination = createSegment(db, { title: "destination", nowEpoch: NOW }).id;
    const cited = seedTurn(sessionDbId, 1, { type: ["design"], tags: ["lane-a"] });
    const citing = seedTurn(sessionDbId, 2, { type: ["design"], tags: ["lane-a"] });
    expect(reassignSegmentMembers(db, [cited, citing], home, NOW).ok).toBe(true);
    const context = baseContext(claimWindow(sessionDbId, 1, 2), {
      reviewableTurnIds: new Set([cited, citing]),
    });
    expect(
      evaluateSettlementMembershipWrite(
        db,
        context,
        { action: "declare", id: `E${home}`, tag: "lane-a" },
        NOW,
      ).ok,
    ).toBe(true);
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "extends",
          provenance: "judged",
          ...deriveSideTags(["lane-a"]),
        },
      ],
      NOW,
    );

    const move: SettlementMembershipWriteInput = {
      action: "reassign",
      turns: [`S${sessionDbId}/T2`],
      id: `E${destination}`,
    };
    const refused = evaluateSettlementMembershipWrite(db, context, move, NOW);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain(`E${destination}`);
      expect(refused.message).toContain('has not declared lane "lane-a"');
    }
    expect(getSegmentMemberTurnIds(db, home).sort()).toEqual([cited, citing].sort());
    expect(getSegmentMemberTurnIds(db, destination)).toEqual([]);

    // The ONLY change: settlement declares the lane in the destination.
    expect(
      evaluateSettlementMembershipWrite(
        db,
        context,
        { action: "declare", id: `E${destination}`, tag: "lane-a" },
        NOW,
      ).ok,
    ).toBe(true);
    expect(evaluateSettlementMembershipWrite(db, context, move, NOW).ok).toBe(true);
    expect(getSegmentMemberTurnIds(db, destination)).toEqual([citing]);
  });
});

describe("renderSettlementMembershipWriteReceipt", () => {
  test("states the address count and that it creates no segment", () => {
    const text = renderSettlementMembershipWriteReceipt({
      proposalId: 3,
      addressesResolved: 2,
    });
    expect(text).toContain("2 address(es)");
    expect(text).toContain("creates no segment");
    // Ticket 11: with staging deleted there is one landing state, so the
    // receipt states it plainly — the old "pending commit" register belonged
    // to a staged write that no longer exists.
    expect(text).toContain("Landed");
  });

  test("a proposal id of null (a dry run) still renders a receipt", () => {
    const text = renderSettlementMembershipWriteReceipt(
      { proposalId: null, addressesResolved: 1 },
      { staged: true },
    );
    expect(text).toContain("1 address(es)");
    expect(text).not.toContain("as proposal #");
  });

  test("a reassign outcome renders the target and vacated segments, not the propose wording (ticket 08)", () => {
    const text = renderSettlementMembershipWriteReceipt(
      {
        proposalId: null,
        addressesResolved: 1,
        reassign: { targetSegmentId: 7, vacatedSegmentIds: [3], addedTurnIds: [42] },
      },
      { staged: false },
    );
    expect(text).toContain("reassign");
    expect(text).toContain("E7");
    expect(text).toContain("vacated E3");
    expect(text).not.toContain("creates no segment");
  });

  test("a homeless reassign (no target) renders explicitly, not as a silently-empty destination", () => {
    const text = renderSettlementMembershipWriteReceipt(
      {
        proposalId: null,
        addressesResolved: 1,
        reassign: { targetSegmentId: null, vacatedSegmentIds: [3], addedTurnIds: [] },
      },
      { staged: true },
    );
    expect(text).toContain("homeless");
  });
});
