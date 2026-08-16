import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import {
  createSegment,
  getSegment,
  getSegmentMemberTurnIds,
  listOpenSegments,
  listTopics,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import {
  evaluateSettlementSegmentWrite,
  type SettlementHandleMap,
  type SettlementSegmentWriteInput,
} from "../../src/worker/note-settlement-segment-facade";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Ticket 10b (spec A7/A3-amended) — the settlement segment-write facade's
 * decision function, `evaluateSettlementSegmentWrite`. There was no segment
 * tool before this ticket; this file is new. Same discipline as
 * `note-settlement-turn-facade.test.ts`: `apply: false` is a dry run
 * exercised for its own describe block, `apply: true` everywhere else.
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
    contentSessionId: "settlement-segment-facade-session",
    project: "/tmp/project-settlement-segment-facade",
    title: "settlement segment facade fixture",
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
    exposedSegmentIds: new Set(),
    contextBuiltAtEpoch: NOW,
    rideTurnId: null,
    writerModel: "claude-sonnet-5",
    eligibleRelationPairKeys: new Set(),
    ...overrides,
  };
}

const NO_HANDLES: SettlementHandleMap = new Map();

function createInput(overrides: Partial<SettlementSegmentWriteInput> = {}): SettlementSegmentWriteInput {
  return {
    action: "create",
    title: "implement+lease: a new chapter",
    content: "Conclusion first.",
    noCandidateReason: "No open segment or registered topic covers this.",
    type: ["implement"],
    tags: ["lease"],
    members: [],
    ...overrides,
  };
}

describe("create — required fields (requirement 3)", () => {
  test("rejects an empty title", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ title: "" }),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("title");
    expect(listOpenSegments(db)).toHaveLength(0);
  });

  test("rejects a create with no no_candidate_reason (D9 anti-fragmentation, carried over)", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ noCandidateReason: "" }),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("no_candidate_reason");
  });

  test("rejects an unknown type word", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ type: ["bugfix"] }),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );
    expect(result.ok).toBe(false);
    expect(listOpenSegments(db)).toHaveLength(0);
  });

  test("lands a segment with type/tags/members and an automatic anchor edge (requirement 3)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ content: `Fenced. [S${sessionDbId}/T1]`, members: [`S${sessionDbId}/T1`] }),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(true);
    const segmentId = result.ok ? result.outcome.segmentId! : -1;
    const segment = getSegment(db, segmentId)!;
    expect(segment.type).toEqual(["implement"]);
    expect(segment.tags).toEqual(["lease"]);
    expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([t1]);
    // db/segments.ts's own reconcileSegmentCitedPairs does this automatically
    // — no anchor-writing code exists in the facade itself.
    const anchors = getOutgoingEdges(db, { kind: "segment", id: segmentId });
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.cited.id).toBe(t1);
    expect(anchors[0]!.relation).toBeNull();
    expect(anchors[0]!.provenance).toBe("text-ref");
  });

  test("a member address that does not resolve is dropped, not a reason to fail the call", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ members: [`S${sessionDbId}/T1`, `S${sessionDbId}/T999`] }),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(true);
    const outcome = result.ok ? result.outcome : null;
    expect(outcome!.membersAdded).toBe(1);
    expect(outcome!.membersDropped).toBe(1);
    expect(getSegmentMemberTurnIds(db, outcome!.segmentId!)).toEqual([t1]);
  });

  test("mints a new topic, and a later create reuses it rather than minting a second one", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job);

    const first = evaluateSettlementSegmentWrite(
      db,
      context,
      createInput({ topic: "lease fencing" }),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );
    expect(first.ok && first.outcome.topicMinted).toBe(true);
    expect(listTopics(db, "active")).toHaveLength(1);

    const second = evaluateSettlementSegmentWrite(
      db,
      context,
      createInput({ topic: "Lease Fencing", title: "implement+lease: chapter two" }),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );
    expect(second.ok && second.outcome.topicReused).toBe(true);
    expect(listTopics(db, "active")).toHaveLength(1);
  });
});

describe("extend — scope, freeze, and the compare-and-set (requirements 3/5)", () => {
  test("refuses a segment not exposed to this dispatch (carried-over review-scope discipline)", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const existing = createSegment(db, { title: "chapter", nowEpoch: NOW - 1000 });

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job, { exposedSegmentIds: new Set() }),
      { action: "extend", segmentId: existing.id, expectedRevision: existing.revision },
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("not shown");
  });

  test("refuses a nonexistent segment", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job, { exposedSegmentIds: new Set([9999]) }),
      { action: "extend", segmentId: 9999, expectedRevision: 0 },
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("no segment");
  });

  test("refuses a frozen (delivered/abandoned) segment (spec D6 — overturn with an edge, never rewrite)", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const existing = createSegment(db, { title: "chapter", status: "delivered", nowEpoch: NOW - 1000 });

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job, { exposedSegmentIds: new Set([existing.id]) }),
      { action: "extend", segmentId: existing.id, expectedRevision: existing.revision, title: "new title" },
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("delivered");
  });

  test("omitted fields leave the stored value alone; present fields overwrite whole (spec D5a)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const existing = createSegment(db, {
      title: "implement+lease: original",
      content: "original body",
      type: ["implement"],
      tags: ["lease"],
      nowEpoch: NOW - 1000,
    });

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job, { exposedSegmentIds: new Set([existing.id]) }),
      {
        action: "extend",
        segmentId: existing.id,
        expectedRevision: existing.revision,
        tags: ["lease", "fencing"],
        members: [`S${sessionDbId}/T1`],
      },
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(true);
    const updated = getSegment(db, existing.id)!;
    expect(updated.title).toBe("implement+lease: original");
    expect(updated.content).toBe("original body");
    expect(updated.tags).toEqual(["lease", "fencing"]);
    expect(getSegmentMemberTurnIds(db, existing.id)).toEqual([t1]);
  });

  test("a stage-time revision mismatch is feedback, not a hard failure — the real CAS at commit time is truth (spec A7 requirement 5)", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const existing = createSegment(db, { title: "chapter", nowEpoch: NOW - 1000 });
    // A concurrent writer bumps the revision after this call was composed.
    db.query<unknown, [number]>("UPDATE segments SET revision = revision + 1 WHERE id = ?").run(
      existing.id,
    );

    const context = baseContext(job, { exposedSegmentIds: new Set([existing.id]) });
    const stale: SettlementSegmentWriteInput = {
      action: "extend",
      segmentId: existing.id,
      expectedRevision: existing.revision, // stale on purpose
      title: "revised title",
    };

    const staged = evaluateSettlementSegmentWrite(db, context, stale, NOW, {
      apply: false,
      handleMap: NO_HANDLES,
    });
    expect(staged.ok).toBe(true); // feedback, not a refusal

    const atCommit = evaluateSettlementSegmentWrite(db, context, stale, NOW + 1, {
      apply: true,
      handleMap: NO_HANDLES,
    });
    expect(atCommit.ok).toBe(false);
    expect(!atCommit.ok && atCommit.message).toContain("revision");
    // Nothing landed from the refused apply.
    expect(getSegment(db, existing.id)!.title).toBe("chapter");
  });
});

// ---------------------------------------------------------------------------
// Handles (spec A7 requirement 4)
// ---------------------------------------------------------------------------

describe("run-scoped handles", () => {
  test("a member token that is a handle is rejected outright — a member is always a turn", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const handles: SettlementHandleMap = new Map([["E#1", null]]);

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ members: ["E#1"] }),
      NOW,
      { apply: false, handleMap: handles },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("not a turn");
  });

  test("a handle referenced in content that this run never assigned is refused, at both stage and commit", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const stage = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ content: "Continues the work in [E#7]." }),
      NOW,
      { apply: false, handleMap: NO_HANDLES },
    );
    expect(stage.ok).toBe(false);
    expect(!stage.ok && stage.message).toContain("E#7");
    expect(listOpenSegments(db)).toHaveLength(0);
  });

  test("a handle known so far (assigned by an earlier staged create) is accepted at stage time without a real id yet", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const handles: SettlementHandleMap = new Map([["E#1", null]]);

    const stage = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ content: "Continues [E#1]." }),
      NOW,
      { apply: false, handleMap: handles },
    );
    expect(stage.ok).toBe(true);
    // Nothing landed — this is still a dry run.
    expect(listOpenSegments(db)).toHaveLength(0);
  });

  test("commit resolves a handle to its real id and lands a real anchor edge to it", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job);

    // Entry 1: the segment this run creates, addressed later as E#1.
    const first = evaluateSettlementSegmentWrite(
      db,
      context,
      createInput({ title: "implement+lease: the fenced chapter" }),
      NOW,
      { apply: true, handleMap: new Map() },
    );
    expect(first.ok).toBe(true);
    const realId = first.ok ? first.outcome.segmentId! : -1;
    const handleMap: SettlementHandleMap = new Map([["E#1", realId]]);

    // Entry 2: a second segment whose body cites the first by handle.
    const second = evaluateSettlementSegmentWrite(
      db,
      context,
      createInput({
        title: "design+lease: the follow-up chapter",
        content: `Builds on the fencing in [E#1].`,
      }),
      NOW,
      { apply: true, handleMap },
    );
    expect(second.ok).toBe(true);
    const secondId = second.ok ? second.outcome.segmentId! : -1;

    const anchors = getOutgoingEdges(db, { kind: "segment", id: secondId });
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.cited).toEqual({ kind: "segment", id: realId });
  });
});
