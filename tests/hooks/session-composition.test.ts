import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  appendSegmentWorkingStateRows,
  attachSegmentToSession,
  createSegment,
  SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH,
} from "../../src/db/segments";

// Ticket 02: the roster now applies the segment-era freeze BY DEFAULT, so
// every fixture segment that should be visible must be minted inside the
// container era. Small offsets stay readable; the base moves past the cutoff.
const ERA = SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH;
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
  renderSegmentRosterBlock,
  segmentBlockHeader,
} from "../../src/hooks/session-composition";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
} from "../../src/db/note-settlement";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";
import { estimateTokens } from "../../src/utils/token-estimate";

const PROPOSAL_FIXTURE_NOW = 1_800_000_000;


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
  test("renders the self-identifying [E<n>] · <kind> line", () => {
    expect(segmentBlockHeader(31, "fields")).toBe("[E31] · fields");
    expect(segmentBlockHeader(31, "milestones")).toBe("[E31] · milestones");
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
    const segment = createSegment(db, {
      title: "Ship the wiring test",
      nowEpoch: ERA + 1_000,
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
    return { session, segment };
  }

  test("the fields block equals the header plus recallMemory's byte-for-byte output at pageBudget 2000", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const { segment } = seedSegment(db);

    const block = renderAttachedSegmentBlock(db, "fields", segment, null);
    const expectedBody = recallMemory(db, {
      id: `E${segment.id}`,
      depth: "collapsed",
      pageBudget: SEGMENT_BLOCK_PAGE_BUDGET,
      eraCutoffEpoch: null,
    });

    expect(block).toBe(`[E${segment.id}] · fields\n${expectedBody}`);
    db.close();
  });

  test("the milestones block equals the header plus timelineQuery's byte-for-byte output at pageBudget 2000", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const { segment } = seedSegment(db);

    const block = renderAttachedSegmentBlock(db, "milestones", segment, null);
    const expectedBody = timelineQuery(db, {
      id: `E${segment.id}`,
      view: "milestones",
      pageBudget: SEGMENT_BLOCK_PAGE_BUDGET,
      eraCutoffEpoch: null,
    });

    expect(block).toBe(`[E${segment.id}] · milestones\n${expectedBody}`);
    db.close();
  });

  test("mutation check: passing the WRONG pageBudget to the reader breaks the byte-for-byte assertion — proves the test observes the real call, not a stub", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const { segment } = seedSegment(db);
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

    const block = renderAttachedSegmentBlock(db, "fields", segment, null);
    const wrongBudgetBody = recallMemory(db, {
      id: `E${segment.id}`,
      depth: "collapsed",
      pageBudget: 999, // NOT the 2000 the composer actually uses
      eraCutoffEpoch: null,
    });

    // If this ever matched, the composer would have silently drifted off
    // pageBudget: 2000 — a real bug this assertion exists to catch.
    expect(block).not.toBe(`[E${segment.id}] · fields\n${wrongBudgetBody}`);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Roster (ticket 14 rebuild, spec "roster 重建"): a unified-renderer segment
// listing — activity-recency order, title+tags fields only, 100-tok item /
// 2000-tok page budgets, token pagination, grant recording. Retired by this
// rebuild and NOT retested here: topic grouping headers, the type facet, the
// 40-segment count cap, and character-only title truncation.
// ---------------------------------------------------------------------------

describe("renderSegmentRosterBlock", () => {
  test("excludes frozen (non-open) segments — the only source of a non-open status under this redesign is the pre-redesign legacy rows", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const open = createSegment(db, {
      title: "Live open segment",
      nowEpoch: ERA + 1_000,
    });
    createSegment(db, {
      title: "Legacy arc-segment",
      status: "delivered",
      nowEpoch: ERA + 900,
    });
    createSegment(db, {
      title: "Abandoned legacy segment",
      status: "abandoned",
      nowEpoch: ERA + 800,
    });

    const roster = renderSegmentRosterBlock(db, { segmentEraCutoffEpoch: null });

    expect(roster).toContain(`E${open.id} Live open segment`);
    expect(roster).not.toContain("Legacy arc-segment");
    expect(roster).not.toContain("Abandoned legacy segment");
    expect(roster).toContain("(1 live)");
    db.close();
  });

  test("ticket 02, the production default: a pre-cutoff OPEN segment never reaches the roster — excluded from rows and the live count alike, with no option passed", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const live = createSegment(db, {
      title: "Container-era lane",
      nowEpoch: ERA + 1_000,
    });
    // Open status, pre-cutoff creation — the exact leak ticket 02 froze:
    // status alone cannot tell a legacy arc-segment from a live one.
    createSegment(db, {
      title: "Legacy open arc-segment",
      nowEpoch: 1_000,
    });

    const roster = renderSegmentRosterBlock(db);

    expect(roster).toContain(`E${live.id} Container-era lane`);
    expect(roster).not.toContain("Legacy open arc-segment");
    expect(roster).toContain("(1 live)");
    db.close();
  });

  test("segments render flat, in activity-recency order, with no ### header", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    createSegment(db, { title: "Mnemo lane one", nowEpoch: ERA + 1_001 });
    createSegment(db, { title: "Mnemo lane two", nowEpoch: ERA + 1_002 });
    createSegment(db, { title: "Side lane", nowEpoch: ERA + 1_003 });

    const roster = renderSegmentRosterBlock(db, { segmentEraCutoffEpoch: null });

    expect(roster).not.toContain("###");
    expect(roster).toContain("Mnemo lane one");
    expect(roster).toContain("Mnemo lane two");
    expect(roster).toContain("Side lane");
    db.close();
  });

  test("paginates by TOKEN page budget (not a segment count cap) — a tiny page budget spreads five segments across pages, with the standard page header", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    for (let index = 1; index <= 5; index += 1) {
      createSegment(db, {
        title: `Lane ${index}`,
        nowEpoch: ERA + 1_000 + index,
      });
    }

    // Small enough that one segment row alone exceeds it, so every page holds
    // exactly one item (a page always holds at least one, never zero).
    const roster = renderSegmentRosterBlock(db, { segmentEraCutoffEpoch: null, pageBudget: 5 });

    expect(roster).toMatch(/page 1 \/ 5 \(total 5\)/);
    db.close();
  });

  test("page defaults to 1 when omitted", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    for (let index = 1; index <= 5; index += 1) {
      createSegment(db, {
        title: `Lane ${index}`,
        nowEpoch: ERA + 1_000 + index,
      });
    }

    const withoutPage = renderSegmentRosterBlock(db, { segmentEraCutoffEpoch: null, pageBudget: 5 });
    const explicitPage1 = renderSegmentRosterBlock(db, {
      segmentEraCutoffEpoch: null,
      pageBudget: 5,
      page: 1,
    });
    expect(withoutPage).toBe(explicitPage1);
    db.close();
  });

  test("annotates an attached segment past the block-slot pool with a recall pointer instead of dropping it", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const overflowSegment = createSegment(db, {
      title: "Attached overflow lane",
      nowEpoch: ERA + 1_000,
    });

    const roster = renderSegmentRosterBlock(db, {
      segmentEraCutoffEpoch: null,
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
    createSegment(db, { title: "One", nowEpoch: ERA + 1_000 });
    createSegment(db, { title: "Two", nowEpoch: ERA + 1_001 });

    const roster = renderSegmentRosterBlock(db, { segmentEraCutoffEpoch: null });
    expect(roster.startsWith("## Segment roster (2 live)")).toBe(true);
    db.close();
  });

  test("renders a graceful message when no live segments exist", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const roster = renderSegmentRosterBlock(db, { segmentEraCutoffEpoch: null });
    expect(roster).toContain("no live segments yet");
    db.close();
  });

  test("records a read grant for every segment the shown page actually renders (ticket 14, spec 与 01 的表断言)", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const segment = createSegment(db, { title: "Granted lane", nowEpoch: ERA + 1_000 });

    renderSegmentRosterBlock(db, {
      segmentEraCutoffEpoch: null,
      readerId: "session:1",
      now: () => 500,
    });

    const grant = db
      .query<{ readAtEpoch: number }, [string, number]>(
        `SELECT read_at_epoch AS readAtEpoch FROM write_gate_reads
         WHERE writer = ? AND entity_type = 'segment' AND entity_id = ?`,
      )
      .get("session:1", segment.id);
    expect(grant).not.toBeNull();
    expect(grant?.readAtEpoch).toBe(500);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Roster rows as the injection's ONE vocabulary surface (lane-model-v12
// ticket 18, ruling [S15069/T1670]): the writable tag LEADS the row, then the
// segment id, then as much title as the item budget leaves; the ATTACHED
// segment adds one line of its declared lane tags. Ticket 12 introduced a tag
// facet at the row's END; ticket 14 sourced it from the segment's own
// persisted `tags`; ticket 18 moves it to the FRONT, which is what makes the
// item knife cut the title instead of the tag.
// ---------------------------------------------------------------------------

describe("renderSegmentRosterBlock: the tag leads the row", () => {
  test("a named segment's row opens with its own one tag, before the id and the title", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const segment = createSegment(db, {
      title: "Tagged lane",
      tags: ["card"],
      nowEpoch: ERA + 1_000,
    });

    const roster = renderSegmentRosterBlock(db, { segmentEraCutoffEpoch: null });
    expect(roster).toContain(`- #card E${segment.id} Tagged lane`);
    expect(roster).not.toContain("×1");
    db.close();
  });

  // The normal state today, not an edge case: nine of the ten live standing
  // containers carry no tag, because naming a container is a human's call
  // (ticket 14 reported them rather than auto-naming them).
  test("a TAGLESS segment renders without crashing — `(unnamed)` leads the row, and never as a `#word` the write gate would reject", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const segment = createSegment(db, { title: "Unnamed container", nowEpoch: ERA + 1_000 });

    const roster = renderSegmentRosterBlock(db, { segmentEraCutoffEpoch: null });
    expect(roster).toContain(`- (unnamed) E${segment.id} Unnamed container`);
    expect(roster).not.toContain("#(unnamed)");
    expect(roster).not.toContain("undefined");
    expect(roster).not.toContain("#null");
    db.close();
  });

  // Tag-first is not cosmetic: it decides WHAT the knife eats. A long title
  // used to push the tag off the end of the row, so the roster spent its
  // budget on prose and then cut the one word a writer came for.
  test("an oversized row is cut in the TITLE, never in the leading tag", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const segment = createSegment(db, {
      title: `Very long title ${"padding ".repeat(40)}tail-word`,
      tags: ["survivor"],
      nowEpoch: ERA + 1_000,
    });

    const roster = renderSegmentRosterBlock(db, { segmentEraCutoffEpoch: null });
    expect(roster).toContain(`- #survivor E${segment.id} Very long title`);
    expect(roster).not.toContain("tail-word");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// The lane vocabulary's new home (ticket 18): one extra line under the
// ATTACHED segment's row, bare tags, `·` separated. No degradation ladder
// (ruling [S15069/T1667]) — a list that does not fit is lane proliferation,
// not a rendering problem.
// ---------------------------------------------------------------------------

describe("renderSegmentRosterBlock: the attached segment's lane vocabulary", () => {
  function seedTwoTaggedSegments(db: ReturnType<typeof createDatabase>) {
    const mine = createSegment(db, { title: "Mine", tags: ["mine"], nowEpoch: ERA + 1_002 });
    const theirs = createSegment(db, { title: "Theirs", tags: ["theirs"], nowEpoch: ERA + 1_001 });
    insertLane(db, mine.id, "write-gate", ERA + 1_000);
    insertLane(db, mine.id, "arc-spine", ERA + 1_000);
    insertLane(db, theirs.id, "not-mine", ERA + 1_000);
    return { mine, theirs };
  }

  test("UNATTACHED: no lane line appears anywhere, however many lanes are declared", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    seedTwoTaggedSegments(db);

    const roster = renderSegmentRosterBlock(db, { segmentEraCutoffEpoch: null });

    expect(roster).not.toContain("- lanes:");
    expect(roster).not.toContain("write-gate");
    expect(roster).not.toContain("arc-spine");
    expect(roster).not.toContain("not-mine");
    db.close();
  });

  test("ATTACHED: the lane line appears under that row and carries ONLY that segment's lanes", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const { mine } = seedTwoTaggedSegments(db);

    const roster = renderSegmentRosterBlock(db, {
      segmentEraCutoffEpoch: null,
      attachedSegmentIds: new Set([mine.id]),
    });

    // Bare tags, `·` separated, in the registry's own alphabetical order.
    expect(roster).toContain("  - lanes: arc-spine · write-gate");
    // A sibling segment's lane never leaks onto the attached row (lane tags
    // are segment-scoped — the same word in two segments is two lanes).
    expect(roster).not.toContain("not-mine");
    // Exactly one expansion, directly under the attached segment's own row.
    const lines = roster.split("\n");
    const laneLineIndexes = lines.flatMap((line, index) =>
      line.trimStart().startsWith("- lanes:") ? [index] : [],
    );
    expect(laneLineIndexes).toHaveLength(1);
    expect(lines[laneLineIndexes[0]! - 1]).toContain(`E${mine.id}`);
    db.close();
  });

  test("an attached segment with NO declared lanes adds no empty line", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const bare = createSegment(db, { title: "No lanes yet", tags: ["bare"], nowEpoch: ERA + 1_000 });

    const roster = renderSegmentRosterBlock(db, {
      segmentEraCutoffEpoch: null,
      attachedSegmentIds: new Set([bare.id]),
    });

    expect(roster).not.toContain("- lanes:");
    db.close();
  });

  // No degradation ladder (ruling [S15069/T1667]): the item knife governs the
  // tag/id/title head and stops there. A 40-lane vocabulary renders whole, `+N
  // 条` tail and all absent — the count IS the proliferation signal.
  test("the lane line is NOT subject to the item knife — 40 lanes render whole, with no truncation marker", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const segment = createSegment(db, { title: "Crowded", tags: ["crowded"], nowEpoch: ERA + 1_000 });
    const tags = Array.from({ length: 40 }, (_, index) => `lane-tag-${index.toString().padStart(3, "0")}`);
    for (const tag of tags) {
      insertLane(db, segment.id, tag, ERA + 1_000);
    }

    const roster = renderSegmentRosterBlock(db, {
      segmentEraCutoffEpoch: null,
      attachedSegmentIds: new Set([segment.id]),
      itemBudget: 16,
    });

    for (const tag of tags) {
      expect(roster).toContain(tag);
    }
    expect(roster).not.toContain("条");
    expect(roster).not.toContain("…");
    db.close();
  });

  // The ticket's own acceptance measure: the whole block, now carrying a lane
  // vocabulary it did not carry before, still costs what the roster cost
  // WITHOUT one. MEASURED on the live shape (ten live standing containers,
  // titles 63–140 chars, the attached segment's 25 busiest lanes): 286 tokens
  // before this ticket, 273 after. The bound below is the BEFORE number, so
  // any change that spends more than the row shape it replaced fails here —
  // restoring the old 100-token item budget alone overshoots it.
  test("the whole block, lane vocabulary included, still costs no more than the roster that carried none", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    let attachedId = 0;
    for (let index = 0; index < 10; index += 1) {
      const segment = createSegment(db, {
        title: `container-${index} standing container: ${"a realistic blurb of the kind these titles carry ".repeat(2)}`,
        tags: [`container-${index}`],
        nowEpoch: ERA + 1_000 + index,
      });
      if (index === 0) {
        attachedId = segment.id;
        for (let lane = 0; lane < 25; lane += 1) {
          insertLane(db, segment.id, `lane-tag-${lane.toString().padStart(2, "0")}`, ERA + 1_000);
        }
      }
    }

    const roster = renderSegmentRosterBlock(db, {
      segmentEraCutoffEpoch: null,
      attachedSegmentIds: new Set([attachedId]),
    });

    expect(roster).toContain("- lanes: lane-tag-00 · lane-tag-01");
    expect(estimateTokens(roster)).toBeLessThanOrEqual(286);
    db.close();
  });

  test("the overflow pointer survives the knife, and coexists with the lane line", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const segment = createSegment(db, {
      title: `Overflowing attachment ${"padding ".repeat(40)}tail-word`,
      tags: ["overflowing"],
      nowEpoch: ERA + 1_000,
    });
    insertLane(db, segment.id, "still-visible", ERA + 1_000);

    const roster = renderSegmentRosterBlock(db, {
      segmentEraCutoffEpoch: null,
      attachedSegmentIds: new Set([segment.id]),
      overflowAttachedSegmentIds: new Set([segment.id]),
    });

    expect(roster).toContain(`attached, not rendered here — recall(id="E${segment.id}")`);
    expect(roster).toContain("  - lanes: still-visible");
    expect(roster).not.toContain("tail-word");
    db.close();
  });
});

describe("ATTACHED_SEGMENT_BLOCK_SLOTS / MAX_INJECTED_BLOCK_CHARS", () => {
  test("stay pinned to their documented values", () => {
    expect(ATTACHED_SEGMENT_BLOCK_SLOTS).toBe(3);
    expect(MAX_INJECTED_BLOCK_CHARS).toBe(9_500);
  });
});
