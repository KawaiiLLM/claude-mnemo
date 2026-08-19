import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import type { RankedSegmentMember } from "../../src/db/segment-rank";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { estimateDiaryTokens } from "../../src/diary/domain";
import {
  buildSegmentTimelineView,
  parseSegmentTimelineId,
  renderSegmentTimeline,
  selectSegmentMilestoneRows,
  timelineQuery,
  type SegmentMilestoneRow,
} from "../../src/mcp/timeline";

/**
 * `timeline(id="E<n>")` addressing a segment directly, in both views, plus
 * the pure admission function (`selectSegmentMilestoneRows`) both views
 * share with the S<n> era spine's nested rows
 * (see tests/mcp/timeline.era-milestones.test.ts).
 *
 * TICKET 06 (ownership-and-note-cadence spec, "选举机器拆除"): the election
 * A/B-tier half of the admission rule (`election_tier`, `src/election.ts`)
 * is GONE — dead code cleanup, not a rendering redesign, since tier never
 * carried real production data. State-citation is the only admission
 * mechanism left; the tier-specific unit tests below (A-tier admission, the
 * B-tier budget filler) are removed along with the mechanism, not merely
 * adjusted — there is nothing left to assert about them. The budget-demote
 * sweep survives unchanged: it always ran over the SAME `keptAlways` list
 * this ticket leaves in place, just without a second B-tier list feeding
 * into it any more.
 */

// ---------------------------------------------------------------------------
// selectSegmentMilestoneRows — the pure admission mechanism, mutation-tested
// directly (no DB): state-cited admits unconditionally; overflow demotes
// (drops outright) rather than paginating.
// ---------------------------------------------------------------------------

function fakeMember(
  overrides: Partial<RankedSegmentMember> & { turnId: number },
): RankedSegmentMember {
  return {
    turnId: overrides.turnId,
    sessionId: overrides.sessionId ?? 1,
    promptNumber: overrides.promptNumber ?? overrides.turnId,
    title: overrides.title ?? `title ${overrides.turnId}`,
    type: overrides.type ?? [],
    status: overrides.status ?? "extracted",
    createdAtEpoch: overrides.createdAtEpoch ?? 1_000_000 + overrides.turnId,
    isCorrector: overrides.isCorrector ?? 0,
    isRolledBack: overrides.isRolledBack ?? 0,
    citedBy: overrides.citedBy ?? 0,
    isDeliveryMember: overrides.isDeliveryMember ?? 0,
    filesModifiedCount: overrides.filesModifiedCount ?? 0,
  };
}

const FLAT_COST = (): number => 10;

describe("selectSegmentMilestoneRows", () => {
  test("admits a state-cited member", () => {
    const m1 = fakeMember({ turnId: 1 });
    const selection = selectSegmentMilestoneRows([m1], new Set([1]), 1000, FLAT_COST);
    expect(selection.kept.map((row) => row.member.turnId)).toEqual([1]);
    expect(selection.demotedCount).toBe(0);
  });

  test("a member with no citation is excluded", () => {
    const uncited = fakeMember({ turnId: 1 });
    const selection = selectSegmentMilestoneRows([uncited], new Set(), 1000, FLAT_COST);
    expect(selection.kept).toHaveLength(0);
    expect(selection.demotedCount).toBe(0); // never eligible, so not "demoted" either
  });

  test("a corrector with no citation is still excluded — correction alone is not an admission signal here", () => {
    const corrector = fakeMember({ turnId: 1, isCorrector: 1 });
    const selection = selectSegmentMilestoneRows([corrector], new Set(), 1000, FLAT_COST);
    expect(selection.kept).toHaveLength(0);
  });

  test("mutation: disabling the cited branch drops a cited-only row (red without it)", () => {
    const m1 = fakeMember({ turnId: 1 });
    const withCited = selectSegmentMilestoneRows([m1], new Set([1]), 1000, FLAT_COST);
    expect(withCited.kept).toHaveLength(1);
    const withoutCited = selectSegmentMilestoneRows([m1], new Set(), 1000, FLAT_COST);
    expect(withoutCited.kept).toHaveLength(0);
  });

  test("an over-budget always-admitted set demotes the OLDEST row first — overflow demotes, never paginates", () => {
    const m1 = fakeMember({ turnId: 1 }); // event order 1, oldest
    const m2 = fakeMember({ turnId: 2 });
    const m3 = fakeMember({ turnId: 3 });
    const cited = new Set([1, 2, 3]);
    // budget 20: only 2 of 3 rows (10 each) fit.
    const selection = selectSegmentMilestoneRows([m1, m2, m3], cited, 20, FLAT_COST);
    expect(selection.kept.map((row) => row.member.turnId)).toEqual([2, 3]);
    expect(selection.demotedCount).toBe(1);
    // The function's signature carries no page/offset parameter at all: the
    // demoted row is gone from `kept`, not moved to a later call's result —
    // structurally the opposite of the turn view's `paginateByTokenBudget`,
    // which is built precisely so every item DOES turn up on some page.
  });

  test("mutation: a larger budget admits strictly more of an over-budget cited set", () => {
    const m1 = fakeMember({ turnId: 1 });
    const m2 = fakeMember({ turnId: 2 });
    const m3 = fakeMember({ turnId: 3 });
    const cited = new Set([1, 2, 3]);
    const tight = selectSegmentMilestoneRows([m1, m2, m3], cited, 20, FLAT_COST);
    const loose = selectSegmentMilestoneRows([m1, m2, m3], cited, 30, FLAT_COST);
    expect(tight.kept.length).toBeLessThan(loose.kept.length);
    expect(loose.kept).toHaveLength(3);
  });

  test("kept rows render in event order, not citation-check order", () => {
    const uncited = fakeMember({ turnId: 1 });
    const citedA = fakeMember({ turnId: 2 });
    const citedB = fakeMember({ turnId: 3 });
    const selection = selectSegmentMilestoneRows(
      [uncited, citedA, citedB],
      new Set([2, 3]),
      1000,
      FLAT_COST,
    );
    expect(selection.kept.map((row) => row.member.turnId)).toEqual([2, 3]);
    expect(selection.kept.map((row) => row.ordinal)).toEqual([2, 3]);
  });
});

// ---------------------------------------------------------------------------
// `timeline(id="E<n>")` at the MCP seam.
// ---------------------------------------------------------------------------

describe("timeline(id=\"E<n>\") segment views", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;
  const CUTOFF = 1_950_000_000;
  const originalTz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  function makeTurn(
    promptNumber: number,
    options: {
      title?: string | null;
      promptText?: string;
      type?: string;
    } = {},
  ): number {
    return db
      .query<
        { id: number },
        [number, number, string, string | null, number, string]
      >(
        `INSERT INTO turns (
           session_id, prompt_number, status, type, title, created_at_epoch,
           user_prompt, assistant_response, content, files_read, files_modified, tags
         ) VALUES (?, ?, 'extracted', ?, ?, ?, ?,
                   'assistant response text', 'turn body', '[]', '[]', '[]')
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.type ? JSON.stringify([options.type]) : "[]",
        options.title === undefined ? `title ${promptNumber}` : options.title,
        CUTOFF + promptNumber,
        options.promptText ?? `user prompt text ${promptNumber}`,
      )!.id;
  }

  beforeEach(() => {
    process.env.TZ = "UTC";
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-e-view",
      project: "/tmp/project",
      title: "E-view session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const segment = createSegment(db, {
      title: "the E-view ships",
      type: ["implement"],
      nowEpoch: CUTOFF,
    });
    segmentId = segment.id;
  });

  afterEach(() => {
    db.close();
    process.env.TZ = originalTz;
  });

  test("parseSegmentTimelineId matches E<n> case-insensitively, treats E<n>/T... as equivalent, and rejects any range/wildcard on the segment id itself", () => {
    expect(parseSegmentTimelineId("E47")).toEqual({ segmentId: 47 });
    expect(parseSegmentTimelineId("e47")).toEqual({ segmentId: 47 });
    expect(parseSegmentTimelineId("S47")).toBeNull();
    // Ticket 09 (read-write-contract spec): `E<n>/T...` — any trailing
    // selector — is EQUIVALENT to bare `E<n>` (timeline(id="E31/T1...") ≡
    // timeline(id="E31")), a deliberate change from the pre-ticket-09
    // rejection this test used to assert.
    expect(parseSegmentTimelineId("E47/T3")).toEqual({ segmentId: 47 });
    expect(parseSegmentTimelineId("E47/T3..7")).toEqual({ segmentId: 47 });
    expect(parseSegmentTimelineId("E47/T*")).toEqual({ segmentId: 47 });
    expect(parseSegmentTimelineId("E*")).toBeNull();
    expect(parseSegmentTimelineId("E1..9")).toBeNull();
  });

  test("timeline(id=\"E<n>/T1...\") renders identically to timeline(id=\"E<n>\")", () => {
    const t1 = makeTurn(1, { title: "equivalence member" });
    addSegmentMembers(db, segmentId, [t1], CUTOFF);

    const bare = timelineQuery(db, { id: `E${segmentId}`, view: "turns" });
    const suffixed = timelineQuery(db, { id: `E${segmentId}/T1..9`, view: "turns" });
    expect(suffixed).toBe(bare);
  });

  test("timelineQuery reports an error for a segment that does not exist", () => {
    const output = timelineQuery(db, { id: "E999999" });
    expect(output).toContain("timeline error");
  });

  // Ticket 09 (read-write-contract spec, "里程碑"): the standalone `E<n>`
  // milestones view's admission rule is now LEXICOGRAPHIC over
  // `getTurnEdgeSignals` (`selectSegmentMilestonesByEdgeSignals`), filling
  // `pageSize` — replacing the state-citation/token-budget rule these tests
  // used to assert. Deliberately scoped to THIS route only: the `S<n>`
  // session view's own nested per-segment rows keep using
  // `selectSegmentMilestoneRows` unchanged (see that function's own updated
  // doc comment) — its pure-function unit tests above are untouched.
  describe("milestones view (lexicographic edge-signal selection)", () => {
    test("minimal row: no grade label, no prompt excerpt, no antecedent counters; the corrector flag survives", () => {
      const t1 = makeTurn(1, { title: "first member" });
      const t2 = makeTurn(2, { title: "corrects an earlier approach" });
      addSegmentMembers(db, segmentId, [t1, t2], CUTOFF);
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: t2 },
            cited: { kind: "turn", id: t1 },
            relation: "supersedes",
            provenance: "judged",
          },
        ],
        CUTOFF,
        { eligibleForRelation: "unrestricted" },
      );

      const output = timelineQuery(db, { id: `E${segmentId}`, view: "milestones" });

      expect(output).toContain("first member");
      expect(output).toContain("corrects an earlier approach");
      // No tier/grade label anywhere on a milestone row.
      expect(output).not.toMatch(/G[0-4]/);
      // No prompt excerpt.
      expect(output).not.toContain("user prompt text");
      // No antecedent counters.
      expect(output).not.toContain("↳");

      const correctorLine = output
        .split("\n")
        .find((line) => line.includes("corrects an earlier approach"))!;
      expect(correctorLine).toContain("⚑");
    });

    test("every kept row exposes its segment ordinal, date and time", () => {
      const t1 = makeTurn(1, { title: "first member" });
      addSegmentMembers(db, segmentId, [t1], CUTOFF);

      const output = timelineQuery(db, { id: `E${segmentId}`, view: "milestones" });
      const row = output.split("\n").find((line) => line.includes("first member"))!;
      expect(row).toContain("T1 ");
      expect(row).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(row).toMatch(/\d{2}:\d{2}/);
    });

    test("key 0: an overridden turn is excluded outright, even with a strong encodes signal", () => {
      const overridden = makeTurn(1, { title: "overridden turn" });
      const overrider = makeTurn(2, { title: "overrides it" });
      const encoder = makeTurn(3, { title: "encoder" });
      const plain = makeTurn(4, { title: "plain survivor" });
      addSegmentMembers(db, segmentId, [overridden, overrider, plain], CUTOFF);
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: overrider },
            cited: { kind: "turn", id: overridden },
            relation: "override",
            provenance: "judged",
          },
          {
            citing: { kind: "turn", id: encoder },
            cited: { kind: "turn", id: overridden },
            relation: "encodes",
            provenance: "judged",
          },
        ],
        CUTOFF,
        { eligibleForRelation: "unrestricted" },
      );

      const view = buildSegmentTimelineView(db, { segmentId, view: "milestones", pageSize: 10 });
      const keptIds = view.keptMilestones.map((row) => row.member.turnId);
      expect(keptIds).not.toContain(overridden);
      expect(keptIds).toContain(plain);
    });

    test("key 1: encodesCount ranks desc, filling pageSize with the strongest-encoded turns first", () => {
      const strong = makeTurn(1, { title: "strongly encoded" });
      const weak = makeTurn(2, { title: "weakly encoded" });
      const none = makeTurn(3, { title: "no encodes" });
      addSegmentMembers(db, segmentId, [strong, weak, none], CUTOFF);
      const e1 = makeTurn(4, { title: "e1" });
      const e2 = makeTurn(5, { title: "e2" });
      const e3 = makeTurn(6, { title: "e3" });
      const w1 = makeTurn(7, { title: "w1" });
      writeMemoryEdges(
        db,
        [
          { citing: { kind: "turn", id: e1 }, cited: { kind: "turn", id: strong }, relation: "encodes", provenance: "judged" },
          { citing: { kind: "turn", id: e2 }, cited: { kind: "turn", id: strong }, relation: "encodes", provenance: "judged" },
          { citing: { kind: "turn", id: e3 }, cited: { kind: "turn", id: strong }, relation: "encodes", provenance: "judged" },
          { citing: { kind: "turn", id: w1 }, cited: { kind: "turn", id: weak }, relation: "encodes", provenance: "judged" },
        ],
        CUTOFF,
        { eligibleForRelation: "unrestricted" },
      );

      const view = buildSegmentTimelineView(db, { segmentId, view: "milestones", pageSize: 2 });
      // Ranking admits [strong, weak]; DISPLAY stays event order (strong's
      // member ordinal precedes weak's).
      expect(view.keptMilestones.map((row) => row.member.turnId)).toEqual([strong, weak]);
      expect(view.keptMilestones.map((row) => row.member.turnId)).not.toContain(none);
      expect(view.demotedCount).toBe(1);
    });

    test("key 2: refinesExcess — the decision bucket outranks the delivery bucket at equal encodes", () => {
      const decisionHeavy = makeTurn(1, { title: "decision-refined" });
      const deliveryHeavy = makeTurn(2, { title: "delivery-refined" });
      addSegmentMembers(db, segmentId, [decisionHeavy, deliveryHeavy], CUTOFF);

      // Baseline (1st) refines edge contributes nothing — only EXCESS
      // (2nd+) counts, per the excess-in-degree rule.
      const baselineA = makeTurn(3, { title: "baseline a" });
      const baselineB = makeTurn(4, { title: "baseline b" });
      const decisionRefiner = makeTurn(5, { title: "decision refiner", type: "design" });
      const deliveryRefiner = makeTurn(6, { title: "delivery refiner", type: "implement" });

      writeMemoryEdges(
        db,
        [
          { citing: { kind: "turn", id: baselineA }, cited: { kind: "turn", id: decisionHeavy }, relation: "refines", provenance: "judged" },
          { citing: { kind: "turn", id: decisionRefiner }, cited: { kind: "turn", id: decisionHeavy }, relation: "refines", provenance: "judged" },
          { citing: { kind: "turn", id: baselineB }, cited: { kind: "turn", id: deliveryHeavy }, relation: "refines", provenance: "judged" },
          { citing: { kind: "turn", id: deliveryRefiner }, cited: { kind: "turn", id: deliveryHeavy }, relation: "refines", provenance: "judged" },
        ],
        CUTOFF,
        { eligibleForRelation: "unrestricted" },
      );

      const view = buildSegmentTimelineView(db, { segmentId, view: "milestones", pageSize: 1 });
      expect(view.keptMilestones.map((row) => row.member.turnId)).toEqual([decisionHeavy]);
    });

    test("edge-free graph degrades to flat chronological — every member fits within pageSize", () => {
      const t1 = makeTurn(1, { title: "no edges 1" });
      const t2 = makeTurn(2, { title: "no edges 2" });
      const t3 = makeTurn(3, { title: "no edges 3" });
      addSegmentMembers(db, segmentId, [t1, t2, t3], CUTOFF);

      const view = buildSegmentTimelineView(db, { segmentId, view: "milestones", pageSize: 10 });
      expect(view.keptMilestones.map((row) => row.member.turnId)).toEqual([t1, t2, t3]);
      expect(view.demotedCount).toBe(0);
    });

    test("a legacy-era turn (before the task-causality cutoff) exits milestone rendering entirely", () => {
      const legacy = makeTurn(1, { title: "legacy member" });
      db.query("UPDATE turns SET created_at_epoch = ? WHERE id = ?").run(CUTOFF - 100, legacy);
      const modern = makeTurn(2, { title: "modern member" });
      addSegmentMembers(db, segmentId, [legacy, modern], CUTOFF);

      const view = buildSegmentTimelineView(db, {
        segmentId,
        view: "milestones",
        pageSize: 10,
        taskCausalityEraCutoffEpoch: CUTOFF,
      });
      const keptIds = view.keptMilestones.map((row) => row.member.turnId);
      expect(keptIds).not.toContain(legacy);
      expect(keptIds).toContain(modern);
    });

    test("pageSize (not pageBudget) drives admission — overflow demotes, still no pagination parameter reaches it", () => {
      const t1 = makeTurn(1, { title: "member one" });
      const t2 = makeTurn(2, { title: "member two" });
      const t3 = makeTurn(3, { title: "member three" });
      addSegmentMembers(db, segmentId, [t1, t2, t3], CUTOFF);

      const view = buildSegmentTimelineView(db, { segmentId, view: "milestones", pageSize: 1 });
      expect(view.keptMilestones).toHaveLength(1);
      expect(view.demotedCount).toBe(2);
      const rendered = renderSegmentTimeline(view);
      expect(rendered).toMatch(/… \+2 more/);
    });
  });

  describe("turns view", () => {
    test("every member renders one-per-line, in event order, with its ordinal, S/T home and prompt excerpt", () => {
      const t1 = makeTurn(1, { title: "first", promptText: "please build the first thing" });
      const t2 = makeTurn(2, { title: "second", promptText: "now the second thing" });
      addSegmentMembers(db, segmentId, [t1, t2], CUTOFF);

      const output = timelineQuery(db, { id: `E${segmentId}`, view: "turns" });
      expect(output).toContain(`[S${sessionId}/T1]`);
      expect(output).toContain("please build the first thing");
      expect(output).toContain("first");
      expect(output).toContain(`[S${sessionId}/T2]`);
      expect(output).toContain("now the second thing");

      const lines = output.split("\n");
      const i1 = lines.findIndex((line) => line.includes(`[S${sessionId}/T1]`));
      const i2 = lines.findIndex((line) => line.includes(`[S${sessionId}/T2]`));
      expect(i1).toBeGreaterThan(-1);
      expect(i2).toBeGreaterThan(i1);
    });

    test("overflow paginates — every member is reachable across pages, never dropped", () => {
      const ids: number[] = [];
      for (let index = 1; index <= 5; index += 1) {
        ids.push(makeTurn(index, { title: `member ${index}` }));
      }
      addSegmentMembers(db, segmentId, ids, CUTOFF);

      const seen = new Set<number>();
      let page = 1;
      for (;;) {
        const view = buildSegmentTimelineView(db, {
          segmentId,
          view: "turns",
          page,
          pageSize: 2,
        });
        for (const entry of view.pageMembers) {
          seen.add(entry.turn.promptNumber);
        }
        if (page >= view.pageCount) {
          break;
        }
        page += 1;
      }
      expect(seen).toEqual(new Set([1, 2, 3, 4, 5]));
    });

    test("pageBudget bounds a page's token size, shrinking it below pageSize — rolling the rest to another page, not dropping it", () => {
      const ids: number[] = [];
      for (let index = 1; index <= 3; index += 1) {
        ids.push(
          makeTurn(index, {
            title: `member with a longer title to cost real tokens ${index}`,
            promptText: `a longer prompt excerpt to cost real tokens as well ${index}`,
          }),
        );
      }
      addSegmentMembers(db, segmentId, ids, CUTOFF);

      const roomyView = buildSegmentTimelineView(db, {
        segmentId,
        view: "turns",
        pageSize: 10,
        pageBudget: 100_000,
      });
      expect(roomyView.pageMembers.length).toBe(3);

      const oneRowLine = renderSegmentTimeline(roomyView)
        .split("\n")
        .find((line) => line.includes("member with a longer title to cost real tokens 1"))!;
      const oneRowCost = estimateDiaryTokens(oneRowLine);

      const tightView = buildSegmentTimelineView(db, {
        segmentId,
        view: "turns",
        pageSize: 10,
        pageBudget: oneRowCost + 5,
      });
      expect(tightView.pageMembers.length).toBeLessThan(3);
      expect(tightView.pageCount).toBeGreaterThan(1);

      // Walking every page under the tight budget still reaches all 3 —
      // the budget only ever shrinks page SIZE, never filters an item out.
      const seen = new Set<number>();
      let page = 1;
      for (;;) {
        const view = buildSegmentTimelineView(db, {
          segmentId,
          view: "turns",
          page,
          pageSize: 10,
          pageBudget: oneRowCost + 5,
        });
        for (const entry of view.pageMembers) {
          seen.add(entry.turn.promptNumber);
        }
        if (page >= view.pageCount) {
          break;
        }
        page += 1;
      }
      expect(seen).toEqual(new Set([1, 2, 3]));
    });
  });
});
