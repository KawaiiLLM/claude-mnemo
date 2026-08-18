import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import type { RankedSegmentMember } from "../../src/db/segment-rank";
import { addSegmentMembers, applySegmentWrites, createSegment, getSegment } from "../../src/db/segments";
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

  test("parseSegmentTimelineId matches E<n> case-insensitively and rejects any range/wildcard", () => {
    expect(parseSegmentTimelineId("E47")).toEqual({ segmentId: 47 });
    expect(parseSegmentTimelineId("e47")).toEqual({ segmentId: 47 });
    expect(parseSegmentTimelineId("S47")).toBeNull();
    expect(parseSegmentTimelineId("E47/T3")).toBeNull();
    expect(parseSegmentTimelineId("E*")).toBeNull();
    expect(parseSegmentTimelineId("E1..9")).toBeNull();
  });

  test("timelineQuery reports an error for a segment that does not exist", () => {
    const output = timelineQuery(db, { id: "E999999" });
    expect(output).toContain("timeline error");
  });

  describe("milestones view", () => {
    test("minimal row: no grade label, no prompt excerpt, no antecedent counters; the corrector flag and overflow pointer survive", () => {
      const cited = makeTurn(1, { title: "cited state row" });
      const secondCited = makeTurn(2, { title: "a second cited row" });
      const corrector = makeTurn(3, { title: "corrects an earlier approach" });
      const victim = makeTurn(4, { title: "the superseded attempt" }); // never cited
      addSegmentMembers(db, segmentId, [cited, secondCited, corrector, victim], CUTOFF);
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: corrector },
            cited: { kind: "turn", id: victim },
            relation: "supersedes",
            provenance: "judged",
          },
        ],
        CUTOFF,
        { eligibleForRelation: "unrestricted" },
      );
      applySegmentWrites(
        db,
        [
          {
            segmentId,
            expectedRevision: getSegment(db, segmentId)!.revision,
            content: `Load-bearing: [S${sessionId}/T1], [S${sessionId}/T2], [S${sessionId}/T3].`,
          },
        ],
        { nowEpoch: CUTOFF },
      );

      const output = timelineQuery(db, { id: `E${segmentId}`, view: "milestones" });

      expect(output).toContain("cited state row");
      expect(output).toContain("a second cited row");
      expect(output).toContain("corrects an earlier approach");
      // Never admitted (no state citation) — and there is no ↳ pull-through
      // mechanism any more to surface it as an antecedent.
      expect(output).not.toContain("the superseded attempt");
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
      const nonCorrectorLine = output
        .split("\n")
        .find((line) => line.includes("a second cited row"))!;
      expect(nonCorrectorLine).not.toContain("⚑");
    });

    test("every kept row exposes its segment ordinal, date and time", () => {
      const t1 = makeTurn(1, { title: "first member" });
      addSegmentMembers(db, segmentId, [t1], CUTOFF);
      applySegmentWrites(
        db,
        [
          {
            segmentId,
            expectedRevision: getSegment(db, segmentId)!.revision,
            content: `[S${sessionId}/T1].`,
          },
        ],
        { nowEpoch: CUTOFF },
      );

      const output = timelineQuery(db, { id: `E${segmentId}`, view: "milestones" });
      const row = output.split("\n").find((line) => line.includes("first member"))!;
      expect(row).toContain("T1 ");
      expect(row).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(row).toMatch(/\d{2}:\d{2}/);
    });

    test("overflow demotes cited rows under a tight budget, oldest first — never paginates", () => {
      const citedOne = makeTurn(1, { title: "cited row one" }); // oldest, demoted first
      const citedTwo = makeTurn(2, { title: "cited row two" });
      const citedThree = makeTurn(3, { title: "cited row three" }); // newest, survives a one-row budget
      addSegmentMembers(db, segmentId, [citedOne, citedTwo, citedThree], CUTOFF);
      applySegmentWrites(
        db,
        [
          {
            segmentId,
            expectedRevision: getSegment(db, segmentId)!.revision,
            content: `[S${sessionId}/T1], [S${sessionId}/T2], [S${sessionId}/T3].`,
          },
        ],
        { nowEpoch: CUTOFF },
      );

      const roomyView = buildSegmentTimelineView(db, {
        segmentId,
        view: "milestones",
        pageBudget: 100_000,
      });
      expect(roomyView.keptMilestones.length).toBe(3);

      const oneRowLine = renderSegmentTimeline(roomyView)
        .split("\n")
        .find((line) => line.includes("cited row three"))!;
      const oneRowCost = estimateDiaryTokens(oneRowLine);

      const tightView = buildSegmentTimelineView(db, {
        segmentId,
        view: "milestones",
        pageBudget: oneRowCost + 2,
      });
      expect(tightView.keptMilestones.map((row) => row.member.turnId)).toEqual([citedThree]);
      expect(tightView.demotedCount).toBe(2);

      const rendered = renderSegmentTimeline(tightView);
      expect(rendered).toMatch(/… \+2 more/);
      expect(rendered).not.toContain("cited row one");
      expect(rendered).not.toContain("cited row two");
      // No `page` field on `SegmentTimelineInput` changes this outcome — the
      // milestones view has no pagination parameter to reach the demoted rows.
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
