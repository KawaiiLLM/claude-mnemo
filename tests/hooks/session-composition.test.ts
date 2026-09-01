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
import { buildSegmentFrontierSection, timelineQuery } from "../../src/mcp/timeline";
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

  // frontier-injection ticket 02: the milestones SLOT is preserved — same
  // slot header, same cache/persist coordinates, same 2000-token budget — and
  // only its PRODUCER swapped: `buildSegmentFrontierSection` (per-lane
  // digests + elected rows) replaces the retired split-segment milestone
  // card. `timeline(id="E<n>", view="milestones")` keeps rendering the old
  // scorer's single-election view untouched (spec "Scorer scope and
  // retirement") — the two surfaces now genuinely diverge.
  test("the milestones block equals the header plus buildSegmentFrontierSection's byte-for-byte output at pageBudget 2000 — the slot's coordinates unchanged, its producer swapped", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const { segment } = seedSegment(db);

    const block = renderAttachedSegmentBlock(db, "milestones", segment, null);
    const expectedBody = buildSegmentFrontierSection(
      db,
      segment.id,
      null,
      SEGMENT_BLOCK_PAGE_BUDGET,
    );
    const mcpQuerySurfaceBody = timelineQuery(db, {
      id: `E${segment.id}`,
      view: "milestones",
      pageBudget: SEGMENT_BLOCK_PAGE_BUDGET,
      eraCutoffEpoch: null,
    });

    // The slot's own header line is untouched (assert the preserved
    // coordinates): the composed block is exactly the old `[E<n>] ·
    // milestones` header over the new producer's whole output.
    expect(block).toBe(`[E${segment.id}] · milestones\n${expectedBody}`);
    // The frontier section leads with its own task header...
    expect(expectedBody.split("\n")[0]).toBe(`E${segment.id}`);
    // ...and is NOT the MCP milestones view (the old scorer lives THERE).
    expect(expectedBody).not.toBe(mcpQuerySurfaceBody);
    expect(mcpQuerySurfaceBody).toContain(`[E${segment.id}] Ship the wiring test`);
    db.close();
  });

  test("mutation check: passing the WRONG pageBudget to the frontier producer breaks the byte-for-byte assertion — proves the wiring threads SEGMENT_BLOCK_PAGE_BUDGET through, not a stub", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const session = upsertSession(db, {
      contentSessionId: "wiring-boundary-session",
      project: "/projects/wiring",
      title: "Wiring boundary session",
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const segment = createSegment(db, {
      title: "Wiring boundary segment",
      tags: ["wiring-boundary"],
      nowEpoch: ERA + 1_000,
    });
    insertLane(db, segment.id, "boundary-lane", ERA + 1_000);
    // Enough settled rows with long titles that a 2000-token budget and a
    // 40-token budget genuinely seat different row sets.
    const turnIds: number[] = [];
    const pad = "x".repeat(120);
    for (let i = 1; i <= 30; i += 1) {
      const turn = db
        .query<{ id: number }, [number, number, number]>(
          `INSERT INTO turns (
            session_id, prompt_number, status, user_prompt, assistant_response,
            title, type, tags, created_at_epoch
          ) VALUES (?, ?, 'extracted', 'p', 'r', ?, '["implement"]', '["boundary-lane"]', ?)
          RETURNING id`,
        )
        .get(session.id, i, `member ${i} ${pad}`, 1_000 + i)!;
      turnIds.push(turn.id);
    }
    addSegmentMembers(db, segment.id, turnIds, 1_000);
    attachSegmentToSession(db, session.id, segment.id, 1_000);
    db.query(
      `INSERT INTO note_settlement_jobs (
         session_id, window_start, window_end, trigger_type,
         status, attempts, retry_at_epoch, created_at_epoch, updated_at_epoch
       ) VALUES (?, 1, 30, 'consecutive', 'done', 1, 0, 2000, 2000)`,
    ).run(session.id);

    const block = renderAttachedSegmentBlock(db, "milestones", segment, null);
    const correctBody = buildSegmentFrontierSection(
      db,
      segment.id,
      null,
      SEGMENT_BLOCK_PAGE_BUDGET,
    );
    const wrongBudgetBody = buildSegmentFrontierSection(
      db,
      segment.id,
      null,
      40, // NOT the 2000 the composer actually uses
    );

    expect(block).toBe(`[E${segment.id}] · milestones\n${correctBody}`);
    expect(block).not.toBe(`[E${segment.id}] · milestones\n${wrongBudgetBody}`);
    // Content, not chrome: the correct budget seats rows the tiny one demotes.
    const correctRows = correctBody.split("\n").filter((line) => /^(S\d+\/)?T\d+ /.test(line));
    const wrongRows = wrongBudgetBody.split("\n").filter((line) => /^(S\d+\/)?T\d+ /.test(line));
    expect(correctRows.length).toBeGreaterThan(wrongRows.length);
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
      "constraints",
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
// Vocabulary succession (frontier-injection ticket 03): the roster's
// `- lanes:` expansion — lane-model-v12 ticket 18's interim home for the lane
// vocabulary — is RETIRED. The lane vocabulary's one authoritative surface is
// the frontier digest lines (the `milestones` blocks' `#tag · … settled · …`
// lines, plus the attach receipt that renders them verbatim); the roster
// carries the TASK-tag half only. These tests pin the retirement: no lane
// line, no lane tag, whatever is declared and whatever is attached.
// ---------------------------------------------------------------------------

describe("renderSegmentRosterBlock: the lane vocabulary no longer renders here", () => {
  test("no `- lanes:` line and no declared lane tag appears, however many lanes exist", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const mine = createSegment(db, { title: "Mine", tags: ["mine"], nowEpoch: ERA + 1_002 });
    const theirs = createSegment(db, { title: "Theirs", tags: ["theirs"], nowEpoch: ERA + 1_001 });
    insertLane(db, mine.id, "write-gate", ERA + 1_000);
    insertLane(db, mine.id, "arc-spine", ERA + 1_000);
    insertLane(db, theirs.id, "not-mine", ERA + 1_000);

    const roster = renderSegmentRosterBlock(db, { segmentEraCutoffEpoch: null });

    expect(roster).toContain(`#mine E${mine.id}`);
    expect(roster).not.toContain("- lanes:");
    expect(roster).not.toContain("write-gate");
    expect(roster).not.toContain("arc-spine");
    expect(roster).not.toContain("not-mine");
    db.close();
  });

  test("an overflow-attached row keeps its recall pointer and grows no lane expansion", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const segment = createSegment(db, {
      title: `Overflowing attachment ${"padding ".repeat(40)}tail-word`,
      tags: ["overflowing"],
      nowEpoch: ERA + 1_000,
    });
    insertLane(db, segment.id, "not-rendered-here", ERA + 1_000);

    const roster = renderSegmentRosterBlock(db, {
      segmentEraCutoffEpoch: null,
      overflowAttachedSegmentIds: new Set([segment.id]),
    });

    expect(roster).toContain(`attached, not rendered here — recall(id="E${segment.id}")`);
    expect(roster).not.toContain("- lanes:");
    expect(roster).not.toContain("not-rendered-here");
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

// ---------------------------------------------------------------------------
// Ticket 07 P1-1 — the frontier slot NEVER char-truncates. The peer's review
// reproduced the old failure at this exact seam: 300 lanes → the char clamp
// kept 131 digests; 400 lanes → a cut inside `#lane-205`. The tag floor now
// lives inside the frontier renderer (host char constraint threaded in), so
// the composed block keeps EVERY declared tag as a whole line and stays
// inside MAX_INJECTED_BLOCK_CHARS without ever reaching enforceHardCharLimit.
// ---------------------------------------------------------------------------

describe("renderAttachedSegmentBlock: the milestones slot at 300/400 lanes (ticket 07 P1-1)", () => {
  function seedManyLanes(db: Database, laneCount: number) {
    const session = upsertSession(db, {
      contentSessionId: `many-lanes-${laneCount}`,
      project: "/projects/many-lanes",
      title: "Many lanes",
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const segment = createSegment(db, { title: "Many lanes", nowEpoch: ERA + 1_000 });
    const insertTurn = db.query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, type, tags, created_at_epoch
       ) VALUES (?, ?, 'extracted', 'asked', 'answered', 'lane member', '[]', ?, ?)
       RETURNING id`,
    );
    const turnIds: number[] = [];
    db.transaction(() => {
      for (let index = 1; index <= laneCount; index += 1) {
        const tag = `lane-${index}`;
        insertLane(db, segment.id, tag, 1_000);
        turnIds.push(
          insertTurn.get(session.id, index, JSON.stringify([tag]), 1_000 + index)!.id,
        );
      }
    })();
    addSegmentMembers(db, segment.id, turnIds, 1_000);
    attachSegmentToSession(db, session.id, segment.id, 1_000);
    // Settle everything: every lane has one settled member, so every digest
    // line carries real denominators (the peer's reproduction shape).
    db.query(
      `INSERT INTO note_settlement_jobs (
         session_id, window_start, window_end, trigger_type,
         status, attempts, retry_at_epoch, created_at_epoch, updated_at_epoch
       ) VALUES (?, 1, ?, 'consecutive', 'done', 1, 0, 1000, 1000)`,
    ).run(session.id, laneCount);
    return segment;
  }

  for (const laneCount of [300, 400]) {
    test(`${laneCount} lanes: every declared tag present as a whole line, no mid-line cut, host limit respected, no truncation marker`, () => {
      const db = createDatabase(":memory:");
      initializeSchema(db);
      const segment = seedManyLanes(db, laneCount);

      const block = renderAttachedSegmentBlock(db, "milestones", segment, null);
      const lines = block.split("\n");

      // Host limit respected — and NOT via the composition clamp: the
      // hard-truncation marker must never appear on this slot.
      expect(block.length).toBeLessThanOrEqual(MAX_INJECTED_BLOCK_CHARS);
      expect(block).not.toContain("truncated to fit the SessionStart size limit");
      expect(lines[0]).toBe(`[E${segment.id}] · milestones`);

      // EVERY declared tag renders, each as a WHOLE line — either the full
      // digest grammar or the bare `#tag` swap, never a prefix of either.
      for (let index = 1; index <= laneCount; index += 1) {
        const tag = `#lane-${index}`;
        const line = lines.find(
          (candidate) => candidate === tag || candidate.startsWith(`${tag} · `),
        );
        expect(line).toBeDefined();
        expect(line).toMatch(/^#lane-\d+( · .+[^·\s])?$/);
      }
      db.close();
    });
  }
});
