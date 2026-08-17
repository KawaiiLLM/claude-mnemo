import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  appendSegmentWorkingStateRows,
  attachSegmentToSession,
  createSegment,
  upsertTopic,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { recallMemory } from "../../src/mcp/recall";
import { timelineQuery } from "../../src/mcp/timeline";
import {
  ATTACHED_SEGMENT_BLOCK_SLOTS,
  MAX_INJECTED_BLOCK_CHARS,
  MAX_RENDERED_PROPOSALS,
  SEGMENT_BLOCK_PAGE_BUDGET,
  composeWithDemoteLadder,
  enforceHardCharLimit,
  renderAttachedSegmentBlock,
  renderProposalsBlock,
  renderSegmentRoster,
  segmentBlockHeader,
} from "../../src/hooks/session-composition";
import { recordNoteSettlementProposal } from "../../src/db/note-settlement-proposals";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
} from "../../src/db/note-settlement";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

const PROPOSAL_FIXTURE_NOW = 1_800_000_000;

/** A real session + a claimed settlement job — `note_settlement_proposals`' two FKs (ticket 08's own fixture pattern). */
function seedProposalJob(db: Database, contentSessionId: string): { sessionDbId: number; jobId: number } {
  const sessionDbId = upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-session-composition",
    title: "proposal fixture session",
    content: null,
    insight: null,
    createdAtEpoch: PROPOSAL_FIXTURE_NOW - 10_000,
    updatedAtEpoch: PROPOSAL_FIXTURE_NOW - 10_000,
    completedAtEpoch: null,
  }).id;
  db.query<{ id: number }, [number, number, string, string, number]>(
    `INSERT INTO turns (
       session_id, prompt_number, status, user_prompt, assistant_response,
       tool_call_count, created_at_epoch
     ) VALUES (?, 1, 'active', 'prompt', 'response', 1, ?)
     RETURNING id`,
  ).get(sessionDbId, PROPOSAL_FIXTURE_NOW - 1_000);
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 1, triggerType: "consecutive" }],
    PROPOSAL_FIXTURE_NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, PROPOSAL_FIXTURE_NOW, PROPOSAL_FIXTURE_NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return { sessionDbId, jobId: job.id };
}

// ---------------------------------------------------------------------------
// The demote ladder — pure, reader-agnostic (ticket 10 requirement 3).
// ---------------------------------------------------------------------------

describe("composeWithDemoteLadder", () => {
  test("returns the FIRST budget's render when it already fits under the limit", () => {
    const calls: number[] = [];
    const result = composeWithDemoteLadder(
      "HEADER",
      (budget) => {
        calls.push(budget);
        return "short body";
      },
      [2000, 1000, 500],
      9500,
    );

    expect(result).toBe("HEADER\nshort body");
    // Only the first budget was ever tried — no wasted re-renders.
    expect(calls).toEqual([2000]);
  });

  test("demotes through the ladder, re-invoking the SAME render at each halved budget, until one fits", () => {
    const calls: number[] = [];
    // Simulate a reader whose output shrinks with its budget: only the
    // budget=500 attempt fits under a small test limit.
    const result = composeWithDemoteLadder(
      "H",
      (budget) => {
        calls.push(budget);
        return "x".repeat(budget);
      },
      [2000, 1000, 500],
      600,
    );

    expect(calls).toEqual([2000, 1000, 500]);
    expect(result).toBe(`H\n${"x".repeat(500)}`);
    expect(result.length).toBeLessThan(600);
  });

  test("hard-truncates with a visible marker when even the smallest budget still overflows", () => {
    const result = composeWithDemoteLadder(
      "H",
      () => "y".repeat(1000),
      [2000, 1000, 500],
      600,
    );

    expect(result.length).toBeLessThanOrEqual(600);
    expect(result).toContain("truncated to fit the SessionStart size limit");
    // The last (smallest) budget's attempt is what gets truncated, not a
    // fourth re-render.
    expect(result.startsWith(`H\n${"y".repeat(1000)}`.slice(0, 20))).toBe(true);
  });

  test("mutation check: a ladder that always demotes on the FIRST size check (never returns early) still terminates and truncates — proves the loop bound, not an infinite retry", () => {
    let renderCount = 0;
    const result = composeWithDemoteLadder(
      "H",
      () => {
        renderCount += 1;
        return "z".repeat(10_000); // always overflows every budget
      },
      [2000, 1000, 500],
      9500,
    );

    expect(renderCount).toBe(3); // exactly the ladder's three rungs, no more
    expect(result.length).toBeLessThanOrEqual(9500);
    expect(result).toContain("truncated to fit the SessionStart size limit");
  });
});

describe("enforceHardCharLimit", () => {
  test("passes text under the limit through unchanged", () => {
    expect(enforceHardCharLimit("hello", 100)).toBe("hello");
  });

  test("truncates and appends the marker when over the limit", () => {
    const result = enforceHardCharLimit("a".repeat(200), 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain("truncated to fit the SessionStart size limit");
    expect(result.startsWith("a")).toBe(true);
  });
});

describe("segmentBlockHeader", () => {
  test("renders the self-identifying [E<n>] #<topic> · <kind> line", () => {
    expect(segmentBlockHeader(31, "claude-mnemo", "fields")).toBe(
      "[E31] #claude-mnemo · fields",
    );
    expect(segmentBlockHeader(31, "claude-mnemo", "milestones")).toBe(
      "[E31] #claude-mnemo · milestones",
    );
    expect(segmentBlockHeader(7, null, "fields")).toBe(
      "[E7] #(no topic) · fields",
    );
  });
});

// ---------------------------------------------------------------------------
// The wiring test (ticket 10 requirement 1): the block is the header over
// the REAL reader's byte-for-byte output at pageBudget 2000 — no dedicated
// renderer.
// ---------------------------------------------------------------------------

describe("renderAttachedSegmentBlock", () => {
  function seedSegment(db: Database) {
    const session = upsertSession(db, {
      contentSessionId: "wiring-session",
      project: "/projects/wiring",
      title: "Wiring session",
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const topic = upsertTopic(db, { name: "claude-mnemo", nowEpoch: 1_000 });
    const segment = createSegment(db, {
      title: "Ship the wiring test",
      topicId: topic.id,
      nowEpoch: 1_000,
    });
    const turn = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
          session_id, prompt_number, status, user_prompt, assistant_response,
          title, type, created_at_epoch
        ) VALUES (?, 1, 'extracted', 'wire the block', 'wired',
          'Wire the segment block', '["implement"]', 1000)
        RETURNING id`,
      )
      .get(session.id)!;
    addSegmentMembers(db, segment.id, [turn.id], 1_000);
    attachSegmentToSession(db, session.id, segment.id, 1_000);
    return { session, segment, topic };
  }

  test("the fields block equals the header plus recallMemory's byte-for-byte output at pageBudget 2000", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const { segment, topic } = seedSegment(db);

    const block = renderAttachedSegmentBlock(db, "fields", segment, topic.name, null);
    const expectedBody = recallMemory(db, {
      id: `E${segment.id}`,
      depth: "collapsed",
      pageBudget: SEGMENT_BLOCK_PAGE_BUDGET,
      eraCutoffEpoch: null,
    });

    expect(block).toBe(`[E${segment.id}] #claude-mnemo · fields\n${expectedBody}`);
    db.close();
  });

  test("the milestones block equals the header plus timelineQuery's byte-for-byte output at pageBudget 2000", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const { segment, topic } = seedSegment(db);

    const block = renderAttachedSegmentBlock(db, "milestones", segment, topic.name, null);
    const expectedBody = timelineQuery(db, {
      id: `E${segment.id}`,
      view: "milestones",
      pageBudget: SEGMENT_BLOCK_PAGE_BUDGET,
      eraCutoffEpoch: null,
    });

    expect(block).toBe(`[E${segment.id}] #claude-mnemo · milestones\n${expectedBody}`);
    db.close();
  });

  test("mutation check: passing the WRONG pageBudget to the reader breaks the byte-for-byte assertion — proves the test observes the real call, not a stub", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const { segment, topic } = seedSegment(db);
    // Enough decision rows that elision genuinely differs between budgets —
    // at pageBudget 2000 every row fits; at 999 some get elided. Without
    // enough content both budgets render identically and this check would
    // pass for the wrong reason (nothing to distinguish, not "matched the
    // real budget").
    appendSegmentWorkingStateRows(
      db,
      segment.id,
      "decisions",
      Array.from(
        { length: 200 },
        (_, index) =>
          `Decision row ${index} chose the mutex approach over a queue because of contention and latency issues observed in production traffic`,
      ),
      1_000,
    );

    const block = renderAttachedSegmentBlock(db, "fields", segment, topic.name, null);
    const wrongBudgetBody = recallMemory(db, {
      id: `E${segment.id}`,
      depth: "collapsed",
      pageBudget: 999, // NOT the 2000 the composer actually uses
      eraCutoffEpoch: null,
    });

    // If this ever matched, the composer would have silently drifted off
    // pageBudget: 2000 — a real bug this assertion exists to catch.
    expect(block).not.toBe(`[E${segment.id}] #claude-mnemo · fields\n${wrongBudgetBody}`);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Roster: every live segment, legacy exclusion, topic grouping, budget
// truncation with a recall() pointer.
// ---------------------------------------------------------------------------

describe("renderSegmentRoster", () => {
  test("excludes frozen (non-open) segments — the only source of a non-open status under this redesign is the pre-redesign legacy rows", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const topic = upsertTopic(db, { name: "claude-mnemo", nowEpoch: 1_000 });
    const open = createSegment(db, {
      title: "Live open segment",
      topicId: topic.id,
      nowEpoch: 1_000,
    });
    createSegment(db, {
      title: "Legacy arc-segment",
      topicId: topic.id,
      status: "delivered",
      nowEpoch: 900,
    });
    createSegment(db, {
      title: "Abandoned legacy segment",
      topicId: topic.id,
      status: "abandoned",
      nowEpoch: 800,
    });

    const roster = renderSegmentRoster(db, { eraCutoffEpoch: null });

    expect(roster).toContain(`E${open.id} Live open segment`);
    expect(roster).not.toContain("Legacy arc-segment");
    expect(roster).not.toContain("Abandoned legacy segment");
    expect(roster).toContain("(1 live)");
    db.close();
  });

  test("groups segments under their topic as a coarse project header", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const mnemo = upsertTopic(db, { name: "claude-mnemo", nowEpoch: 1_000 });
    const other = upsertTopic(db, { name: "side-project", nowEpoch: 1_000 });
    createSegment(db, { title: "Mnemo lane one", topicId: mnemo.id, nowEpoch: 1_001 });
    createSegment(db, { title: "Mnemo lane two", topicId: mnemo.id, nowEpoch: 1_002 });
    createSegment(db, { title: "Side lane", topicId: other.id, nowEpoch: 1_003 });

    const roster = renderSegmentRoster(db, { eraCutoffEpoch: null });

    expect(roster).toContain("### claude-mnemo (2)");
    expect(roster).toContain("### side-project (1)");
    db.close();
  });

  test("truncates on budget with a recall() pointer for the remainder", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const topic = upsertTopic(db, { name: "claude-mnemo", nowEpoch: 1_000 });
    for (let index = 1; index <= 5; index += 1) {
      createSegment(db, {
        title: `Lane ${index}`,
        topicId: topic.id,
        nowEpoch: 1_000 + index,
      });
    }

    const roster = renderSegmentRoster(db, { eraCutoffEpoch: null, limit: 2 });

    const rows = roster.split("\n").filter((line) => /^- E\d+/.test(line));
    expect(rows.length).toBe(2);
    expect(roster).toContain("3 more: recall()");
    db.close();
  });

  test("annotates an attached segment past the block-slot pool with a recall pointer instead of dropping it", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const topic = upsertTopic(db, { name: "claude-mnemo", nowEpoch: 1_000 });
    const overflowSegment = createSegment(db, {
      title: "Attached overflow lane",
      topicId: topic.id,
      nowEpoch: 1_000,
    });

    const roster = renderSegmentRoster(db, {
      eraCutoffEpoch: null,
      overflowAttachedSegmentIds: new Set([overflowSegment.id]),
    });

    expect(roster).toContain(
      `attached, not rendered here — recall(id="E${overflowSegment.id}")`,
    );
    db.close();
  });

  test("mutation check: dropping the (2 live) count would silently misreport roster completeness — pinned here", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const topic = upsertTopic(db, { name: "claude-mnemo", nowEpoch: 1_000 });
    createSegment(db, { title: "One", topicId: topic.id, nowEpoch: 1_000 });
    createSegment(db, { title: "Two", topicId: topic.id, nowEpoch: 1_001 });

    const roster = renderSegmentRoster(db, { eraCutoffEpoch: null });
    expect(roster.startsWith("## Segment roster (2 live)")).toBe(true);
    db.close();
  });

  test("renders a graceful message when no live segments exist", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const roster = renderSegmentRoster(db, { eraCutoffEpoch: null });
    expect(roster).toContain("no live segments yet");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Proposals: at most three, newest first, with the render-time ask-user
// boilerplate ticket 08 deliberately left unstored.
// ---------------------------------------------------------------------------

describe("renderProposalsBlock", () => {
  test("renders addresses, suggested title, and the ask-user boilerplate per proposal", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const { sessionDbId, jobId } = seedProposalJob(db, "proposal-render-fixture");
    recordNoteSettlementProposal(db, {
      jobId,
      sessionId: sessionDbId,
      title: "Investigate the flaky retry path",
      addresses: ["S1/T3", "S1/T5"],
      nowEpoch: 1_000,
    });

    const block = renderProposalsBlock(db);

    expect(block).toContain("## Proposals");
    expect(block).toContain("Investigate the flaky retry path");
    expect(block).toContain("S1/T3");
    expect(block).toContain("S1/T5");
    expect(block.toLowerCase()).toContain("ask the user");
    db.close();
  });

  test("caps at MAX_RENDERED_PROPOSALS, newest first", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const { sessionDbId, jobId } = seedProposalJob(db, "proposal-cap-fixture");
    for (let index = 1; index <= 5; index += 1) {
      recordNoteSettlementProposal(db, {
        jobId,
        sessionId: sessionDbId,
        title: `Proposal ${index}`,
        addresses: [`S1/T${index}`],
        nowEpoch: 1_000 + index,
      });
    }

    const block = renderProposalsBlock(db);
    const rows = block.split("\n").filter((line) => line.startsWith("- \""));
    expect(rows.length).toBe(MAX_RENDERED_PROPOSALS);
    expect(block).toContain("Proposal 5");
    expect(block).not.toContain("Proposal 1\"");
    db.close();
  });

  test("renders a graceful message with no pending proposals", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const block = renderProposalsBlock(db);
    expect(block).toContain("(none pending)");
    db.close();
  });
});

describe("ATTACHED_SEGMENT_BLOCK_SLOTS / MAX_INJECTED_BLOCK_CHARS", () => {
  test("stay pinned to their documented values", () => {
    expect(ATTACHED_SEGMENT_BLOCK_SLOTS).toBe(3);
    expect(MAX_INJECTED_BLOCK_CHARS).toBe(9_500);
  });
});
