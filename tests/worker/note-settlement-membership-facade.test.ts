import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { hasNoteSettlementMembershipActivity } from "../../src/db/note-settlement-completion";
import { listRecentSettlementProposals } from "../../src/db/note-settlement-proposals";
import { initializeSchema } from "../../src/db/schema";
import { createSegment, getSegment, getSegmentMemberTurnIds } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { ELECTION_ERA_CUTOFF_EPOCH } from "../../src/election-era";
import {
  evaluateSettlementMembershipWrite,
  renderSettlementMembershipWriteReceipt,
  settlementMembershipWriteInputSchema,
  type SettlementMembershipWriteInput,
} from "../../src/worker/note-settlement-membership-facade";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Ticket 08 (ADR-0002/0007) — the settlement membership facade's DECISION
 * function, `evaluateSettlementMembershipWrite`. Mirrors
 * `note-settlement-turn-facade.test.ts`'s own discipline: `apply: false` is a
 * dry run exercised for its own describe block, `apply: true` everywhere
 * else. `note-settlement-staging.test.ts` covers the staged/commit lifecycle
 * (keys, replace-on-restage, replay); this file covers the decision function
 * in isolation, including the acceptance criteria's mandatory mutation
 * checks: the attached-set boundary, homeless-stays-legal, the proposal
 * never-creates-a-segment invariant, and the system-tag exclusion.
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
    reconstructableTurnIds: new Set(),
    reviewableTurnIds: new Set(),
    attachedSegmentIds: new Set(),
    contextBuiltAtEpoch: NOW,
    rideTurnId: null,
    writerModel: "claude-sonnet-5",
    eligibleRelationPairKeys: new Set(),
    eraCutoffEpoch: ELECTION_ERA_CUTOFF_EPOCH,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

describe("settlementMembershipWriteInputSchema", () => {
  test("accepts a minimal assign and a minimal propose", () => {
    expect(
      settlementMembershipWriteInputSchema.safeParse({
        action: "assign",
        turn: "S1/T1",
        segmentId: 1,
      }).success,
    ).toBe(true);
    expect(
      settlementMembershipWriteInputSchema.safeParse({
        action: "propose",
        addresses: ["S1/T1", "S1/T2"],
        title: "a cluster",
      }).success,
    ).toBe(true);
  });

  test("rejects an unknown field (strict schema)", () => {
    expect(
      settlementMembershipWriteInputSchema.safeParse({
        action: "assign",
        turn: "S1/T1",
        segmentId: 1,
        type: ["implement"],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assign
// ---------------------------------------------------------------------------

describe("assign — required fields and turn resolution", () => {
  test("refuses a missing turn", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job),
      { action: "assign", segmentId: 1 },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("turn");
  });

  test("refuses a missing segmentId", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "assign", turn: `S${sessionDbId}/T1` },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("segmentId");
  });

  test("refuses a turn address naming no turn", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { attachedSegmentIds: new Set([segment.id]) }),
      { action: "assign", turn: `S${sessionDbId}/T999`, segmentId: segment.id },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("no turn");
  });

  test("refuses a compact-marker turn", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1, { type: ["compact"] });
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, {
        reviewableTurnIds: new Set([t1]),
        attachedSegmentIds: new Set([segment.id]),
      }),
      { action: "assign", turn: `S${sessionDbId}/T1`, segmentId: segment.id },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("compact marker");
  });

  test("refuses a turn outside this dispatch's reviewable window", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    const result = evaluateSettlementMembershipWrite(
      db,
      // reviewableTurnIds deliberately empty.
      baseContext(job, { attachedSegmentIds: new Set([segment.id]) }),
      { action: "assign", turn: `S${sessionDbId}/T1`, segmentId: segment.id },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("reviewable window");
    void t1;
  });
});

describe("assign — the attached-set boundary (spec: 'assignment only ever targets attached segments')", () => {
  test("refuses a real segment that is NOT in the attached set", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const notAttached = createSegment(db, { title: "elsewhere", nowEpoch: NOW });
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, {
        reviewableTurnIds: new Set([t1]),
        attachedSegmentIds: new Set(), // notAttached is real, just not attached
      }),
      { action: "assign", turn: `S${sessionDbId}/T1`, segmentId: notAttached.id },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("not attached");
    expect(getSegmentMemberTurnIds(db, notAttached.id)).toEqual([]);
  });

  test("accepts a segment that IS in the attached set", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, {
        reviewableTurnIds: new Set([t1]),
        attachedSegmentIds: new Set([segment.id]),
      }),
      { action: "assign", turn: `S${sessionDbId}/T1`, segmentId: segment.id },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(true);
    expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([t1]);
  });

  test("refuses a segmentId that resolves to no row at all", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, {
        reviewableTurnIds: new Set([t1]),
        attachedSegmentIds: new Set([9999]),
      }),
      { action: "assign", turn: `S${sessionDbId}/T1`, segmentId: 9999 },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("no segment");
  });
});

describe("assign — landing, idempotence, and the dry run", () => {
  test("apply:true adds a member and records the job's membership activity", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    expect(hasNoteSettlementMembershipActivity(db, job.id)).toBe(false);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, {
        reviewableTurnIds: new Set([t1]),
        attachedSegmentIds: new Set([segment.id]),
      }),
      { action: "assign", turn: `S${sessionDbId}/T1`, segmentId: segment.id },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.outcome.added).toBe(true);
    expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([t1]);
    expect(hasNoteSettlementMembershipActivity(db, job.id)).toBe(true);
  });

  test("re-assigning the same pair is idempotent — added: false the second time, still one member", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    const context = baseContext(job, {
      reviewableTurnIds: new Set([t1]),
      attachedSegmentIds: new Set([segment.id]),
    });
    const input: SettlementMembershipWriteInput = {
      action: "assign",
      turn: `S${sessionDbId}/T1`,
      segmentId: segment.id,
    };

    const first = evaluateSettlementMembershipWrite(db, context, input, NOW, { apply: true });
    const second = evaluateSettlementMembershipWrite(db, context, input, NOW, { apply: true });

    expect(first.ok && first.outcome.added).toBe(true);
    expect(second.ok && second.outcome.added).toBe(false);
    expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([t1]);
  });

  test("apply:false is a dry run — no member lands, no activity recorded, but the receipt reports what WOULD happen", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, {
        reviewableTurnIds: new Set([t1]),
        attachedSegmentIds: new Set([segment.id]),
      }),
      { action: "assign", turn: `S${sessionDbId}/T1`, segmentId: segment.id },
      NOW,
      { apply: false },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.outcome.added).toBe(true); // would add
    expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([]);
    expect(hasNoteSettlementMembershipActivity(db, job.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Homeless stays legal — the negative space: no verb exists to force a
// verdict onto a turn that fits nothing, and no evaluation of ANY OTHER
// turn's assign/propose call ever touches a turn nobody named.
// ---------------------------------------------------------------------------

describe("homeless stays legal (spec: 'never forced')", () => {
  test("a turn nobody ever calls assign/propose for is simply never a member of anything, and no error is raised for it", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    const context = baseContext(job, {
      reviewableTurnIds: new Set([t1, t2]),
      attachedSegmentIds: new Set([segment.id]),
    });

    // Only t1 is assigned; t2 is simply never named in any call — no
    // "exclude"/"homeless" verb exists to invoke for it, by design.
    const result = evaluateSettlementMembershipWrite(
      db,
      context,
      { action: "assign", turn: `S${sessionDbId}/T1`, segmentId: segment.id },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([t1]);
    // t2 belongs to no segment and no error, gap, or verdict exists for it.
    void t2;
  });
});

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

describe("propose — required fields and address resolution", () => {
  test("refuses a missing title", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1, t2]) }),
      { action: "propose", addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`] },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("title");
  });

  test("refuses fewer than two addresses — a proposal is a cluster, not one turn", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "propose", addresses: [`S${sessionDbId}/T1`], title: "not a cluster" },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("at least two");
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

describe("propose — never creates a segment row (spec: 'never a database segment')", () => {
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

  test("apply:false stores nothing and creates no segment", () => {
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
        title: "a cluster",
      },
      NOW,
      { apply: false },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.outcome.proposalId).toBeNull();
    expect(listRecentSettlementProposals(db, 3)).toEqual([]);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segments").get()!.count,
    ).toBe(0);
    expect(hasNoteSettlementMembershipActivity(db, job.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// System-namespaced tag values never influence assignment (spec, background:
// "tags on turns — system-namespaced values contain ':' and never influence
// assignment"). This is the EXISTING facet-derivation exclusion
// (db/segments.ts's recomputeSegmentFacets, `tag.includes(":")`) — proved
// here through the NEW assign path, so a future write surface that bypassed
// `addSegmentMembers`'s own facet recomputation would be caught.
// ---------------------------------------------------------------------------

describe("system-namespaced tag values never influence assignment", () => {
  test("a turn's colon-namespaced tag is excluded from the segment's derived tags; its plain tag is not", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1, { tags: ["lease", "compact:cursor-42"] });
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, {
        reviewableTurnIds: new Set([t1]),
        attachedSegmentIds: new Set([segment.id]),
      }),
      { action: "assign", turn: `S${sessionDbId}/T1`, segmentId: segment.id },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    const updated = getSegment(db, segment.id)!;
    expect(updated.tags).toEqual(["lease"]);
    expect(updated.tags).not.toContain("compact:cursor-42");
  });
});

// ---------------------------------------------------------------------------
// Receipt rendering
// ---------------------------------------------------------------------------

describe("renderSettlementMembershipWriteReceipt", () => {
  test("assign: names the ref and segment, and whether it landed or was already a member", () => {
    const landed = renderSettlementMembershipWriteReceipt(
      { action: "assign", ref: "S1/T1", segmentId: 5, added: true, proposalId: null, addressesResolved: 0 },
      { staged: false },
    );
    expect(landed).toContain("S1/T1");
    expect(landed).toContain("E5");
    expect(landed).toContain("joins");

    const already = renderSettlementMembershipWriteReceipt(
      { action: "assign", ref: "S1/T1", segmentId: 5, added: false, proposalId: null, addressesResolved: 0 },
      { staged: false },
    );
    expect(already).toContain("already a member");
  });

  test("propose: states the address count and that it creates no segment", () => {
    const text = renderSettlementMembershipWriteReceipt(
      { action: "propose", ref: null, segmentId: null, added: false, proposalId: 3, addressesResolved: 2 },
      { staged: true },
    );
    expect(text).toContain("2 address(es)");
    expect(text).toContain("creates no segment");
    expect(text).toContain("pending commit");
  });
});
