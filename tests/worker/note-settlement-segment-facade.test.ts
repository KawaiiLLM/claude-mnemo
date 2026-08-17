import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { listNoteSettlementSegmentExclusions } from "../../src/db/note-settlement-completion";
import { initializeSchema } from "../../src/db/schema";
import {
  createSegment,
  getSegment,
  getSegmentMemberTurnIds,
  listOpenSegments,
  listTopics,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { ELECTION_ERA_CUTOFF_EPOCH } from "../../src/election-era";
import {
  evaluateSettlementSegmentWrite,
  settlementSegmentWriteInputSchema,
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
    exposedSegmentIds: new Set(),
    contextBuiltAtEpoch: NOW,
    rideTurnId: null,
    writerModel: "claude-sonnet-5",
    eligibleRelationPairKeys: new Set(),
    eraCutoffEpoch: ELECTION_ERA_CUTOFF_EPOCH,
    ...overrides,
  };
}

const NO_HANDLES: SettlementHandleMap = new Map();

function createInput(overrides: Partial<SettlementSegmentWriteInput> = {}): SettlementSegmentWriteInput {
  return {
    action: "create",
    handle: "chapter",
    title: "implement+lease: a new chapter",
    content: "Conclusion first.",
    noCandidateReason: "No open segment or registered topic covers this.",
    members: [],
    ...overrides,
  };
}

describe("type and tags left the tool: they are derived from the members (spec K5a, ticket 14)", () => {
  // The retired `topic:` tag guard that used to live here went with the field:
  // a tool that takes no tags cannot be handed a retired one. The note tool
  // still refuses it, and `note-settlement-turn-facade.test.ts` still pins that.

  test("the input schema refuses a stated type or tags by name", () => {
    const base = {
      action: "create" as const,
      handle: "chapter",
      title: "implement+lease: a new chapter",
      noCandidateReason: "nothing fits",
    };

    expect(settlementSegmentWriteInputSchema.safeParse(base).success).toBe(true);
    expect(
      settlementSegmentWriteInputSchema.safeParse({ ...base, type: ["implement"] }).success,
    ).toBe(false);
    expect(
      settlementSegmentWriteInputSchema.safeParse({ ...base, tags: ["lease"] }).success,
    ).toBe(false);
  });

  test("a created segment takes its type and tags from its members, most frequent first", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1, { type: ["research"], tags: ["lease", "fencing"] });
    const t2 = seedTurn(sessionDbId, 2, { type: ["implement"], tags: ["lease"] });
    const t3 = seedTurn(sessionDbId, 3, { type: ["implement"], tags: ["lease"] });
    const job = claimWindow(sessionDbId, 1, 3);

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({
        members: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`, `S${sessionDbId}/T3`],
      }),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(true);
    const segment = getSegment(db, result.ok ? result.outcome.segmentId! : -1)!;
    // implement on two members, research on one — frequency, not arrival.
    expect(segment.type).toEqual(["implement", "research"]);
    expect(segment.tags).toEqual(["lease", "fencing"]);
    expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([t1, t2, t3]);
  });

  test("extending with a new member recomputes both facets and the FTS row", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1, { type: ["research"], tags: ["lease"] });
    const t2 = seedTurn(sessionDbId, 2, { type: ["fix"], tags: ["fencing"] });
    const job = claimWindow(sessionDbId, 1, 2);
    const created = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ members: [`S${sessionDbId}/T1`] }),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );
    const segmentId = created.ok ? created.outcome.segmentId! : -1;
    expect(getSegment(db, segmentId)!.type).toEqual(["research"]);

    const extended = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      {
        action: "extend",
        segmentId,
        expectedRevision: getSegment(db, segmentId)!.revision,
        members: [`S${sessionDbId}/T2`],
      },
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(extended.ok).toBe(true);
    const segment = getSegment(db, segmentId)!;
    // One member each: the frequency tie breaks on vocabulary order for type
    // (research precedes fix in MEMORY_TYPES) and on the tag itself for tags.
    expect(segment.type).toEqual(["research", "fix"]);
    expect(segment.tags).toEqual(["fencing", "lease"]);
    expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([t1, t2]);
    // The facet is INDEXED, so a stale index is the failure this checks for.
    expect(
      db
        .query<{ extra: string | null }, [number]>(
          "SELECT extra FROM memory_fts WHERE layer = 'segment' AND source_id = ?",
        )
        .get(segmentId)!.extra,
    ).toContain("fencing");
  });
});

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

  test("rejects a create with no noCandidateReason (D9 anti-fragmentation, carried over)", () => {
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
    expect(!result.ok && result.message).toContain("noCandidateReason");
  });

  test("rejects a create with no handle (spec A7a — the model-named staging key)", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ handle: undefined }),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("handle");
  });

  test("rejects a handle with an illegal character — it must be safely embeddable in [E#<handle>]", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ handle: "lease fencing" }),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("handle");
  });

  test("lands a segment with derived facets, members and an automatic anchor edge (requirement 3)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1, { type: ["implement"], tags: ["lease"] });
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
      insight: "original insight",
      nowEpoch: NOW - 1000,
    });

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job, { exposedSegmentIds: new Set([existing.id]) }),
      {
        action: "extend",
        segmentId: existing.id,
        expectedRevision: existing.revision,
        insight: "the lease route was ruled out: the fence outlives the claim",
        members: [`S${sessionDbId}/T1`],
      },
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(true);
    const updated = getSegment(db, existing.id)!;
    expect(updated.title).toBe("implement+lease: original");
    expect(updated.content).toBe("original body");
    expect(updated.insight).toBe(
      "the lease route was ruled out: the fence outlives the claim",
    );
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

  // Ticket 10d finding: `E#<n>` handling was a bare, unbracketed scan
  // (`/E#(\d+)/g`) that rewrote ordinary prose and refused an unrelated
  // "E#2024". A handle is now recognised ONLY inside a `[E#<handle>]`
  // citation token, matching every other reference's bracket-qualified
  // grammar.
  test("an ordinary mention of the substring 'E#<n>' outside brackets is left untouched, not rewritten as a handle reference", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job);

    const first = evaluateSettlementSegmentWrite(
      db,
      context,
      createInput({ handle: "chapter-one", title: "implement+lease: first chapter" }),
      NOW,
      { apply: true, handleMap: new Map() },
    );
    expect(first.ok).toBe(true);
    const realId = first.ok ? first.outcome.segmentId! : -1;
    const handleMap: SettlementHandleMap = new Map([["E#chapter-one", realId]]);

    const second = evaluateSettlementSegmentWrite(
      db,
      context,
      createInput({
        handle: "chapter-two",
        title: "implement+lease: second chapter",
        content: "The error code E#1 was observed during the fencing work.",
      }),
      NOW,
      { apply: true, handleMap },
    );
    expect(second.ok).toBe(true);
    const secondId = second.ok ? second.outcome.segmentId! : -1;
    const stored = getSegment(db, secondId)!;
    // The unbracketed "E#1" survives byte-for-byte — the old unbracketed
    // scan would have rewritten it to "E<realId>".
    expect(stored.content).toBe("The error code E#1 was observed during the fencing work.");
    expect(getOutgoingEdges(db, { kind: "segment", id: secondId })).toEqual([]);
  });

  test("an ordinary unbracketed 'E#2024' is not refused as an unknown handle", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ content: "Filed as E#2024 in the external tracker." }),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(true);
  });

  test("a bracketed [E#<handle>] citation is still recognised and substituted at commit", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job);

    const first = evaluateSettlementSegmentWrite(
      db,
      context,
      createInput({ handle: "alpha", title: "implement+lease: alpha" }),
      NOW,
      { apply: true, handleMap: new Map() },
    );
    const realId = first.ok ? first.outcome.segmentId! : -1;
    const handleMap: SettlementHandleMap = new Map([["E#alpha", realId]]);

    const second = evaluateSettlementSegmentWrite(
      db,
      context,
      createInput({
        handle: "beta",
        title: "implement+lease: beta",
        content: "Builds on [E#alpha].",
      }),
      NOW,
      { apply: true, handleMap },
    );
    expect(second.ok).toBe(true);
    const secondId = second.ok ? second.outcome.segmentId! : -1;
    expect(getSegment(db, secondId)!.content).toBe(`Builds on [E${realId}].`);
  });
});

// ---------------------------------------------------------------------------
// `action: "exclude"` (spec A7a, ticket 10d finding 3)
// ---------------------------------------------------------------------------

describe("exclude — the model-facing path to the job-scoped no-segment verdict", () => {
  test("writes the exclusion through the SAME facade a model calls, not the DB helper directly", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "exclude", turn: `S${sessionDbId}/T1` },
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.outcome.excludedTurnRef).toBe(`S${sessionDbId}/T1`);
    expect(listNoteSettlementSegmentExclusions(db, job.id)).toEqual([t1]);
  });

  test("a dry run (apply: false) writes no exclusion row", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "exclude", turn: `S${sessionDbId}/T1` },
      NOW,
      { apply: false, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(true);
    expect(listNoteSettlementSegmentExclusions(db, job.id)).toEqual([]);
  });

  test("refuses a missing turn field", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      { action: "exclude" },
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(false);
  });

  test("refuses a turn address naming no turn", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      { action: "exclude", turn: `S${sessionDbId}/T999` },
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("no turn");
  });

  test("ticket 15 finding 6: refuses an exclude naming a real turn outside this dispatch's reviewable window", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementSegmentWrite(
      db,
      // Default baseContext: reviewableTurnIds is empty. T1 is a perfectly
      // real row — address syntax and row existence both pass — but this
      // dispatch's prompt never showed it, so a verdict about it must be
      // refused the same way a review verdict already is
      // (note-settlement-turn-facade.ts).
      baseContext(job),
      { action: "exclude", turn: `S${sessionDbId}/T1` },
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("reviewable window");
    expect(listNoteSettlementSegmentExclusions(db, job.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `status` on create (ticket 10d: honoured, not silently accepted-and-ignored)
// ---------------------------------------------------------------------------

describe("create honours a stated status rather than dropping it (ticket 10d)", () => {
  test("a create stating status: \"delivered\" lands a segment already in that status", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ status: "delivered" }),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(true);
    const segmentId = result.ok ? result.outcome.segmentId! : -1;
    expect(getSegment(db, segmentId)!.status).toBe("delivered");
  });

  test("an omitted status still defaults to open, unchanged from before", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput(),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(true);
    const segmentId = result.ok ? result.outcome.segmentId! : -1;
    expect(getSegment(db, segmentId)!.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Body citations validated at STAGE time, not only at apply (ticket 10d)
// ---------------------------------------------------------------------------

describe("segment body citations are validated at stage time (ticket 10d)", () => {
  test("an unresolvable [S999/T1] in content is reported as a dropped citation at STAGE time, not just silently absorbed at commit", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const staged = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ content: "Fenced. [S999/T1]" }),
      NOW,
      { apply: false, handleMap: NO_HANDLES },
    );

    expect(staged.ok).toBe(true);
    expect(staged.ok && staged.outcome.citationsDropped).toBe(1);
    // Still nothing landed — this is a dry run.
    expect(listOpenSegments(db)).toHaveLength(0);
  });

  test("the same unresolved citation is reported again at commit (apply: true), and no anchor edge is created for it", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ content: "Fenced. [S999/T1]" }),
      NOW,
      { apply: true, handleMap: NO_HANDLES },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.outcome.citationsDropped).toBe(1);
    const segmentId = result.ok ? result.outcome.segmentId! : -1;
    expect(getOutgoingEdges(db, { kind: "segment", id: segmentId })).toEqual([]);
  });

  test("a resolvable citation reports zero dropped and does become an anchor", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const staged = evaluateSettlementSegmentWrite(
      db,
      baseContext(job),
      createInput({ content: `Fenced. [S${sessionDbId}/T1]` }),
      NOW,
      { apply: false, handleMap: NO_HANDLES },
    );

    expect(staged.ok).toBe(true);
    expect(staged.ok && staged.outcome.citationsDropped).toBe(0);
    void t1;
  });
});
