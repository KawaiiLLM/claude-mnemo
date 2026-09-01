import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  markLaneImpressionStale,
  replaceLaneImpression,
} from "../../src/db/impressions";
import { insertLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import { reindexTurnFromDb } from "../../src/db/search";
import {
  addSegmentMembers,
  applySegmentWrites,
  createSegment,
  getSegment,
  markSegmentTaskImpressionStale,
  replaceSegmentTaskImpression,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { IMPRESSION_PENDING_SYNTHESIS_LINE } from "../../src/mcp/impression-display";
import { recallMemory, recallMemoryDelivery } from "../../src/mcp/recall";
import { IMPRESSION_CAP_CEILING } from "../../src/shared/lane-impressions";
import { countTokens } from "../../src/shared/token-count";

/**
 * LANE-IMPRESSIONS TICKET 04 — the two display surfaces, and only those two
 * (spec Rev 8, "Display"): the `recall(id="E<n>/#<tag>")` page-1 preface and
 * the segment card's content slot. Nothing here writes an impression through
 * the settlement path — ticket 02 owns that; these fixtures seed storage
 * directly and assert what a reader SEES, which is the seam the spec names
 * ("Good tests assert transaction outcomes and rendered output, never writer
 * internals").
 */

const CUTOFF = 1_960_000_000;

/** Two lines, distinctive enough that no other part of a render can supply them. */
const LANE_IMPRESSION =
  "The write-gate lane: every write passes one gate, and the gate is the fence (S1/T1).\nBinding: no second predicate answers the same question (S1/T2).";

const TASK_IMPRESSION =
  "The write-gate task: one fence, two tiers, both settled by the same run (S1/T1).\nFrontier: the backfill has not run for closed tasks (S1/T2).";

describe("lane route: the impression as a page-1 preface outside the member paginator", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;
  const turnIds: Record<string, number> = {};

  function makeTurn(promptNumber: number, title: string, tags: string[]): number {
    const id = db
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, title, tags, created_at_epoch,
           user_prompt, assistant_response, content, files_read, files_modified
         ) VALUES (?, ?, 'extracted', ?, ?, ?, 'user prompt text',
                   'assistant response text', 'turn body', '[]', '[]')
         RETURNING id`,
      )
      .get(sessionId, promptNumber, title, JSON.stringify(tags), CUTOFF + promptNumber)!.id;
    reindexTurnFromDb(db, id);
    return id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-lane-impression-display",
      project: "/tmp/project-lane-impression-display",
      title: "Lane preface fixture session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    turnIds.inLane = makeTurn(1, "declares the write gate", ["write-gate"]);
    turnIds.alsoInLane = makeTurn(2, "closes the write gate", ["write-gate"]);
    turnIds.notInLane = makeTurn(3, "an unrelated turn", []);

    segmentId = createSegment(db, { title: "write gate work", nowEpoch: CUTOFF }).id;
    addSegmentMembers(
      db,
      segmentId,
      [turnIds.inLane!, turnIds.alsoInLane!, turnIds.notInLane!],
      CUTOFF,
    );
    insertLane(db, segmentId, "write-gate", CUTOFF);
  });

  afterEach(() => {
    db.close();
  });

  function seedLaneImpression(text: string): void {
    expect(
      replaceLaneImpression(db, {
        segmentId,
        tag: "write-gate",
        baseRevision: 0,
        text,
        origin: "settlement",
      }),
    ).toBe(true);
  }

  const laneId = (): string => `E${segmentId}/#write-gate`;

  /**
   * THE CENTRAL CLAIM, in its strongest form: the response with an impression
   * is BYTE-FOR-BYTE the response without one, with the impression spliced in
   * front. That single equality carries three of the ticket's rules at once —
   * byte-verbatim from storage, at the HEAD, and OUTSIDE the paginator (not one
   * character of the paginated page moved).
   */
  test("page 1 is the untouched page with the stored impression spliced in front, byte for byte", () => {
    const before = recallMemory(db, { id: laneId() });
    seedLaneImpression(LANE_IMPRESSION);
    const after = recallMemory(db, { id: laneId() });

    expect(after).toBe(`${LANE_IMPRESSION}\n\n${before}`);
    expect(after.startsWith(`${LANE_IMPRESSION}\n\n[E${segmentId}]`)).toBe(true);
  });

  /**
   * THE DEEPER-PAGE RULE, with a genuinely deeper page: `pageSize: 1` splits
   * the lane's two members across two pages. Page 2 must repeat nothing — and
   * it must be byte-identical to the pre-impression page 2, so "no repeat"
   * cannot be satisfied by some other part of the render shifting.
   */
  test("page 2 carries no preface at all", () => {
    const before = recallMemory(db, { id: laneId(), page: 2, pageSize: 1 });
    seedLaneImpression(LANE_IMPRESSION);
    const after = recallMemory(db, { id: laneId(), page: 2, pageSize: 1 });

    expect(after).toBe(before);
    expect(after).not.toContain("The write-gate lane:");
    expect(after).toContain("closes the write gate");
  });

  /**
   * THE ROUTE SHOWS ITS OWN LANE. With one declared lane every lane-selection
   * bug is invisible — "the first lane of this task" and "the lane you asked
   * for" are the same row. A second lane with its own impression is what makes
   * the assertion mean anything.
   */
  test("a task with two lanes shows each route its own impression, never the other's", () => {
    insertLane(db, segmentId, "read-path", CUTOFF);
    const otherTurn = makeTurn(4, "reads without the gate", ["read-path"]);
    addSegmentMembers(db, segmentId, [otherTurn], CUTOFF);
    const otherImpression =
      "The read-path lane: reads never take the gate, and that asymmetry is the design (S1/T4).";
    seedLaneImpression(LANE_IMPRESSION);
    expect(
      replaceLaneImpression(db, {
        segmentId,
        tag: "read-path",
        baseRevision: 0,
        text: otherImpression,
        origin: "settlement",
      }),
    ).toBe(true);

    const writeGate = recallMemory(db, { id: laneId() });
    expect(writeGate.startsWith(`${LANE_IMPRESSION}\n\n`)).toBe(true);
    expect(writeGate).not.toContain("The read-path lane:");

    const readPath = recallMemory(db, { id: `E${segmentId}/#read-path` });
    expect(readPath.startsWith(`${otherImpression}\n\n`)).toBe(true);
    expect(readPath).not.toContain("The write-gate lane:");
  });

  /**
   * MEMBER PAGINATION MECHANICS UNCHANGED, pinned by the numbers rather than by
   * eyeballing the preface: the same two pages, the same header totals, the
   * same member on each — with a preface sitting above page 1.
   */
  test("the member paginator's page count, totals and per-page members are unchanged", () => {
    seedLaneImpression(LANE_IMPRESSION);

    const page1 = recallMemory(db, { id: laneId(), page: 1, pageSize: 1 });
    expect(page1).toContain("page 1 / 2 (total 2)");
    expect(page1).toContain("declares the write gate");
    expect(page1).not.toContain("closes the write gate");
    // The preface is ABOVE the paginator's own header, not inside its page.
    expect(page1.indexOf(LANE_IMPRESSION)).toBeLessThan(page1.indexOf("page 1 / 2"));

    const page2 = recallMemory(db, { id: laneId(), page: 2, pageSize: 1 });
    expect(page2).toContain("page 2 / 2 (total 2)");
    expect(page2).toContain("closes the write gate");
    expect(page2).not.toContain("declares the write gate");
  });

  /**
   * THE RECEIPT LINE, pinned: the preface must not change which members the
   * lane read receipt credits, nor the membership snapshot beside them.
   */
  test("the lane read receipt records the same members with the preface as without", () => {
    const reader = "claim:impression-04:1";
    function receiptRow(): { rendered: string; membership: string } {
      return db
        .query<{ rendered: string; membership: string }, [string]>(
          `SELECT rendered_member_ids AS rendered, membership_snapshot AS membership
             FROM lane_read_receipts WHERE reader_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(reader)!;
    }

    const withoutDelivery = recallMemoryDelivery(db, {
      id: laneId(),
      readerId: reader,
      now: () => CUTOFF,
    });
    withoutDelivery.commitDelivered(withoutDelivery.text.length);
    const without = receiptRow();

    seedLaneImpression(LANE_IMPRESSION);

    const withDelivery = recallMemoryDelivery(db, {
      id: laneId(),
      readerId: reader,
      now: () => CUTOFF,
    });
    withDelivery.commitDelivered(withDelivery.text.length);
    const withPreface = receiptRow();

    expect(JSON.parse(withPreface.rendered)).toEqual([turnIds.inLane!, turnIds.alsoInLane!]);
    expect(withPreface.rendered).toBe(without.rendered);
    expect(withPreface.membership).toBe(without.membership);
  });

  /**
   * THE SPLICE ARITHMETIC, which nothing above can see: a grant's offset names
   * where in the RESPONSE its text ends, and the preface moves every one of
   * them forward. Delivered one character short of the whole response, the
   * member grants must NOT be credited — with the offsets left un-shifted they
   * would appear to end a preface's length earlier and be credited for bytes
   * the reader never received.
   */
  test("the preface shifts the member grants' offsets, so a cut response credits nothing", () => {
    const reader = "claim:impression-04:2";
    function grantCount(): number {
      return db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM write_gate_reads WHERE writer = ? AND entity_type = 'turn'`,
        )
        .get(reader)!.n;
    }

    seedLaneImpression(LANE_IMPRESSION);
    const delivery = recallMemoryDelivery(db, {
      id: laneId(),
      readerId: reader,
      now: () => CUTOFF,
    });
    delivery.commitDelivered(delivery.text.length - 1);
    expect(grantCount()).toBe(0);

    // The same response delivered WHOLE still credits both members — the
    // assertion above is about the offsets, not about grants having gone away.
    const whole = recallMemoryDelivery(db, {
      id: laneId(),
      readerId: reader,
      now: () => CUTOFF,
    });
    whole.commitDelivered(whole.text.length);
    expect(grantCount()).toBe(2);
  });

  test("a lane with no impression renders nothing extra — no placeholder, no empty heading", () => {
    const body = recallMemory(db, { id: laneId() });

    expect(body.startsWith(`[E${segmentId}]`)).toBe(true);
    expect(body).not.toContain(IMPRESSION_PENDING_SYNTHESIS_LINE);
    expect(body).not.toContain("impression");
  });

  /** BOTH HALVES: the old prose is gone AND the marker is there. */
  test("a STALE lane suppresses its old prose entirely and renders the pending-synthesis marker", () => {
    seedLaneImpression(LANE_IMPRESSION);
    expect(markLaneImpressionStale(db, segmentId, "write-gate")).toBe(true);

    const body = recallMemory(db, { id: laneId() });

    expect(body).not.toContain("The write-gate lane:");
    expect(body).not.toContain("Binding: no second predicate");
    expect(body).toContain(IMPRESSION_PENDING_SYNTHESIS_LINE);
    expect(body.startsWith(`${IMPRESSION_PENDING_SYNTHESIS_LINE}\n\n[E${segmentId}]`)).toBe(true);
  });

  /**
   * THE BOUND, measured with the real tokenizer: the route's response grows by
   * the impression's own bytes and the blank line, and by nothing else — so a
   * cap-sized impression costs the cap, not the cap plus a heading.
   */
  test("the response grows by at most the storage cap (real tokenizer, not char/4)", () => {
    const before = recallMemory(db, { id: laneId() });
    seedLaneImpression(LANE_IMPRESSION);
    const after = recallMemory(db, { id: laneId() });

    const growth = countTokens(after) - countTokens(before);
    expect(growth).toBe(countTokens(`${LANE_IMPRESSION}\n\n`));
    expect(growth).toBeLessThanOrEqual(IMPRESSION_CAP_CEILING + 2);
  });

  /**
   * `filter.tag` renders NO impression (spec "Display": a global exact-match
   * cannot bind a qualified lane, and a mixed result set under one lane's
   * impression would misattribute). The hit itself is asserted, so the test
   * cannot pass by the query simply matching nothing.
   */
  test("a filter.tag query over the lane's own tag renders no lane impression and no marker", () => {
    seedLaneImpression(LANE_IMPRESSION);

    const hit = recallMemory(db, { filter: { tag: "write-gate" } });
    expect(hit).toContain("declares the write gate");
    expect(hit).not.toContain("The write-gate lane:");
    expect(hit).not.toContain(IMPRESSION_PENDING_SYNTHESIS_LINE);

    markLaneImpressionStale(db, segmentId, "write-gate");
    const staleHit = recallMemory(db, { filter: { tag: "write-gate" } });
    expect(staleHit).toContain("declares the write gate");
    expect(staleHit).not.toContain(IMPRESSION_PENDING_SYNTHESIS_LINE);
  });
});

describe("segment card: the content slot is the task tier's display surface", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;

  const LEGACY_CONTENT = "The ledger ships behind the fence, and the fence is one predicate.";

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-task-impression-display",
      project: "/tmp/project-task-impression-display",
      title: "Task impression display session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    segmentId = createSegment(db, {
      title: "write gate work",
      tags: ["gate-task"],
      nowEpoch: CUTOFF,
    }).id;
    applySegmentWrites(
      db,
      [
        {
          segmentId,
          expectedRevision: getSegment(db, segmentId)!.revision,
          content: LEGACY_CONTENT,
        },
      ],
      { nowEpoch: CUTOFF },
    );
  });

  afterEach(() => {
    db.close();
  });

  function seedTaskImpression(text: string): void {
    expect(
      replaceSegmentTaskImpression(db, {
        segmentId,
        baseRevision: 0,
        text,
        origin: "settlement",
        nowEpoch: CUTOFF,
      }),
    ).toBe(true);
  }

  /**
   * `impression_origin IS NULL` is the discriminator, and this is its LEGACY
   * arm: an un-backfilled task's card is byte-identical to what it has always
   * rendered — an impression path must never claim legacy field text.
   */
  test("legacy content (origin NULL) still renders through the content row, never as an impression", () => {
    const card = recallMemory(db, { id: `E${segmentId}` });

    expect(card).toContain(`- content: ${LEGACY_CONTENT}`);
    expect(card).not.toContain("- impression:");
    expect(card).not.toContain(IMPRESSION_PENDING_SYNTHESIS_LINE);
  });

  test("a task-tier impression renders in the content slot, every line of it, on its own path", () => {
    seedTaskImpression(TASK_IMPRESSION);
    const card = recallMemory(db, { id: `E${segmentId}` });

    expect(card).toContain("- impression:");
    for (const line of TASK_IMPRESSION.split("\n")) {
      expect(card).toContain(line);
    }
    // Never through the legacy row, and the legacy text it replaced is gone.
    expect(card).not.toContain("- content:");
    expect(card).not.toContain(LEGACY_CONTENT);
  });

  /** BOTH HALVES again, on the card. */
  test("a STALE task tier suppresses its prose entirely and renders the marker in the slot", () => {
    seedTaskImpression(TASK_IMPRESSION);
    expect(markSegmentTaskImpressionStale(db, segmentId)).toBe(true);

    const card = recallMemory(db, { id: `E${segmentId}` });

    expect(card).not.toContain("The write-gate task:");
    expect(card).not.toContain("Frontier: the backfill has not run");
    expect(card).toContain(IMPRESSION_PENDING_SYNTHESIS_LINE);
  });

  /**
   * THE ORIGIN GATE, in the direction that costs information if it is missing:
   * `mergeSegments` (ticket 03) sets `impression_stale` on the survivor
   * unconditionally, so a phase-1 task that has never been backfilled can carry
   * the flag over ordinary legacy prose. Asking "is this stale" without asking
   * "is this an impression" first would blank that task's real content and put
   * a pending-synthesis marker where live text used to be.
   */
  test("STALE over LEGACY content (origin still NULL) keeps the content row and shows no marker", () => {
    expect(markSegmentTaskImpressionStale(db, segmentId)).toBe(true);

    const card = recallMemory(db, { id: `E${segmentId}` });

    expect(card).toContain(`- content: ${LEGACY_CONTENT}`);
    expect(card).not.toContain(IMPRESSION_PENDING_SYNTHESIS_LINE);
    expect(card).not.toContain("- impression:");
  });

  /** The card's un-elided overflow page renders the slot through the same path. */
  test("the card's page-2 overflow render carries the impression, not a legacy content row", () => {
    seedTaskImpression(TASK_IMPRESSION);
    const card = recallMemory(db, { id: `E${segmentId}`, page: 2 });

    expect(card).toContain("- impression:");
    expect(card).toContain("The write-gate task:");
    expect(card).not.toContain("- content:");
  });

  /**
   * A TASK-TAG query is a search hit, not the card: it renders no impression at
   * all — not the text (which its own row would truncate mid-claim) and not the
   * marker (which belongs to the card's slot). The hit is asserted, so the test
   * cannot pass by matching nothing.
   */
  test("a task-tag query renders the segment hit with no impression in it", () => {
    seedTaskImpression(TASK_IMPRESSION);

    const hit = recallMemory(db, { filter: { tag: "gate-task" } });
    expect(hit).toContain(`[E${segmentId}]`);
    expect(hit).not.toContain("The write-gate task:");
    expect(hit).not.toContain("- content:");

    markSegmentTaskImpressionStale(db, segmentId);
    const staleHit = recallMemory(db, { filter: { tag: "gate-task" } });
    expect(staleHit).toContain(`[E${segmentId}]`);
    expect(staleHit).not.toContain(IMPRESSION_PENDING_SYNTHESIS_LINE);
  });

  /** The same surface's LEGACY arm: an un-backfilled task still shows its content row on a search hit. */
  test("a task-tag query still renders the legacy content row before backfill", () => {
    const hit = recallMemory(db, { filter: { tag: "gate-task" } });
    expect(hit).toContain(`[E${segmentId}]`);
    expect(hit).toContain("- content:");
  });
});
