import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { estimateDiaryTokens } from "../../src/diary/domain";
import {
  buildSegmentTimelineView,
  parseSegmentTimelineId,
  renderSegmentTimeline,
  timelineQuery,
} from "../../src/mcp/timeline";

/**
 * `timeline(id="E<n>")` addressing a segment directly, in both views, plus
 * the pure admission function (`selectSegmentMilestonesByEdgeSignals`) both
 * views share with the S<n> era spine's nested rows (ticket 12 — see
 * tests/mcp/timeline.era-milestones.test.ts, which covers that function's
 * ranking directly; this file exercises it through the
 * `E<n>` route). Ticket 09's lexicographic edge-signal rule this function
 * used to run has since been superseded outright by `shared/milestone-election.ts`'s
 * `electMilestones` (milestone-election spec, ticket 03) — see
 * tests/mcp/timeline.election-retirement.test.ts's own grep-guards.
 *
 * TICKET 06 (ownership-and-note-cadence spec, "选举机器拆除"): the election
 * A/B-tier half of the OLD state-citation admission rule (`election_tier`,
 * `src/election.ts`) was already dead code before ticket 09 replaced the
 * whole rule with the (then-current, now itself superseded per above)
 * lexicographic edge-signal one below. The old
 * state-citation/token-budget mechanism itself (`selectSegmentMilestoneRows`)
 * and its own dedicated unit tests retired in ticket 12, once its last
 * production caller (the S<n> era spine's nested rows) moved onto this same
 * function.
 */

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
    // [S15069/T1564]: a NARROWING trailing selector no longer parses here —
    // `timelineQuery` refuses it rather than silently rendering the whole
    // segment. `E<n>/T*` names every member, which IS what this route
    // renders, so it stays equivalent to the bare form.
    expect(parseSegmentTimelineId("E47/T3")).toBeNull();
    expect(parseSegmentTimelineId("E47/T3..7")).toBeNull();
    expect(parseSegmentTimelineId("E47/T*")).toEqual({ segmentId: 47 });
    // Ticket 10 (one-address-grammar spec): recall's own trailing grammar
    // moved from `E<n>/T<m>` to `E<n>/S<a>/T<b>` (one member) and
    // `E<n>/S<a>/T<b>..S<c>/T<d>` (a range) — this route accepts both new
    // shapes too, with the same "no separate meaning, equivalent to bare
    // E<n>" contract the old `/T...` shape already had.
    expect(parseSegmentTimelineId("E47/S12/T3")).toBeNull();
    expect(parseSegmentTimelineId("E47/S12/T3..S15/T7")).toBeNull();
    expect(parseSegmentTimelineId("E*")).toBeNull();
    expect(parseSegmentTimelineId("E1..9")).toBeNull();
  });

  test("timeline(id=\"E<n>/T*\") renders identically to timeline(id=\"E<n>\"), but a NARROWING selector refuses", () => {
    const t1 = makeTurn(1, { title: "equivalence member" });
    addSegmentMembers(db, segmentId, [t1], CUTOFF);

    const bare = timelineQuery(db, { id: `E${segmentId}`, view: "turns" });
    expect(timelineQuery(db, { id: `E${segmentId}/T*`, view: "turns" })).toBe(bare);
    // A window this route cannot honor is refused, never widened in silence
    // — the caller asked for part of a segment and would otherwise receive
    // all of it with nothing saying so ([S15069/T1564]).
    const narrowed = timelineQuery(db, { id: `E${segmentId}/S1/T1..S1/T9`, view: "turns" });
    expect(narrowed).toContain("timeline error");
    expect(narrowed).toContain("recall(id=");
    expect(timelineQuery(db, { id: `E${segmentId}/T1..9`, view: "turns" })).toContain("timeline error");
  });

  test("timelineQuery reports an error for a segment that does not exist", () => {
    const output = timelineQuery(db, { id: "E999999" });
    expect(output).toContain("timeline error");
  });

  // Ticket 09 (read-write-contract spec, "里程碑") introduced the standalone
  // `E<n>` milestones view's admission rule as a lexicographic ranking over
  // `getTurnEdgeSignals` (`selectSegmentMilestonesByEdgeSignals`), filling
  // `pageSize` — replacing the old state-citation/token-budget rule these
  // tests used to assert. Milestone-election spec ticket 03 then superseded
  // THAT rule too: `selectSegmentMilestonesByEdgeSignals` now delegates the
  // whole ranking to `shared/milestone-election.ts`'s `electMilestones` (see
  // tests/mcp/timeline.election-retirement.test.ts's grep-guards) — its name
  // is the one thing that did not change. Ticket 12 unified the `S<n>`
  // session view's own nested per-segment rows onto this SAME function (see
  // tests/mcp/timeline.era-milestones.test.ts's dual-assertion test), so
  // what this describe block proves through the `E<n>` route now holds for
  // both routes.
  describe("milestones view (election-based selection)", () => {
    test("minimal row: no grade label, no prompt excerpt, no antecedent counters, and no corrector flag", () => {
      const t1 = makeTurn(1, { title: "first member" });
      const t2 = makeTurn(2, { title: "corrects an earlier approach" });
      addSegmentMembers(db, segmentId, [t1, t2], CUTOFF);
      writeMemoryEdges(
        db,
        [
          // `grounds` is what the election reads for the `↳` address
          // (milestone-election spec, ticket 03). The second row used to be
          // `supersedes`, the word the ⚑ corrector flag read; lane-model-v12
          // ticket 03 retired both the word and the flag, so `override` — the
          // word it merged into — stands in its place and marks nothing.
          {
            citing: { kind: "turn", id: t2 },
            cited: { kind: "turn", id: t1 },
            relation: "override",
            provenance: "judged",
          },
          {
            citing: { kind: "turn", id: t2 },
            cited: { kind: "turn", id: t1 },
            relation: "grounds",
            provenance: "judged",
          },
        ],
        CUTOFF,
      );

      const output = timelineQuery(db, { id: `E${segmentId}`, view: "milestones" });

      expect(output).toContain("first member");
      expect(output).toContain("corrects an earlier approach");
      // No tier/grade label anywhere on a milestone row.
      expect(output).not.toMatch(/G[0-4]/);
      // No prompt excerpt.
      expect(output).not.toContain("user prompt text");
      // `↳` carries antecedent ADDRESSES now (spec 金样例 `↳ T811, T812`) —
      // never a `+N 前件` count, and never a titled sub-row.
      expect(output).toContain("            ↳ T1");
      expect(output).not.toContain("前件");

      // No flag either: `⚑` marked an outgoing `supersedes`, a word that no
      // longer exists in the vocabulary or in the table's CHECK.
      const correctorLine = output
        .split("\n")
        .find((line) => line.includes("corrects an earlier approach"))!;
      expect(correctorLine).not.toContain("⚑");
      expect(output).not.toContain("⚑");
    });

    test("every kept row exposes its bracketed session address, date and time", () => {
      const t1 = makeTurn(1, { title: "first member" });
      addSegmentMembers(db, segmentId, [t1], CUTOFF);

      const output = timelineQuery(db, { id: `E${segmentId}`, view: "milestones" });
      const row = output.split("\n").find((line) => line.includes("first member"))!;
      // Spec 金样例: the row's address is its SESSION prompt number, bracketed
      // — the segment ordinal is a selection handle and never occupies a row.
      expect(row).toContain("[T1] ");
      expect(row).toMatch(/\d{2}-\d{2}/);
      expect(row).toMatch(/\d{2}:\d{2}/);
      expect(output.split("\n")).toContain(`    [S${sessionId}] E-view session`);
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
            relation: "grounds",
            provenance: "judged",
          },
        ],
        CUTOFF,
      );

      // lane-model-v12 ticket 04: an untagged override is no longer a global
      // repudiation, so its target is not excluded from candidacy — it ranks
      // on whatever signal it earns, here a strong incoming `grounds`.
      const view = buildSegmentTimelineView(db, { segmentId, view: "milestones", pageSize: 10 });
      const keptIds = view.keptMilestones.map((row) => row.member.turnId);
      expect(keptIds).toContain(overridden);
      expect(keptIds).toContain(plain);
    });

    test("in-degree ranks desc within a tier, filling pageSize with the most-cited turns first (milestone-election spec, ticket 03)", () => {
      // Milestone-election spec: in-degree is counted only among the edges
      // `electMilestones` is fed — for the segment route that is edges among
      // this SEGMENT's own members plus real metadata for any external
      // endpoint an OR-scoped edge reaches (`getRelationEdgesAmongTurns`,
      // R1 #1's `fetchExternalElectionTurns`) — so every CITER counted here
      // is itself a member; an external citer's edge still contributes to
      // the CITED member's own in-degree, but the external citer never
      // seats (unlike the retired `getTurnEdgeSignals`'s whole-DB scan,
      // which had no such distinction at all).
      const strong = makeTurn(1, { title: "strongly cited" });
      const weak = makeTurn(2, { title: "weakly cited" });
      const none = makeTurn(3, { title: "not cited" });
      const c1 = makeTurn(4, { title: "citer 1" });
      const c2 = makeTurn(5, { title: "citer 2" });
      addSegmentMembers(db, segmentId, [strong, weak, none, c1, c2], CUTOFF);
      writeMemoryEdges(
        db,
        [
          { citing: { kind: "turn", id: c1 }, cited: { kind: "turn", id: strong }, relation: "grounds", provenance: "judged" },
          { citing: { kind: "turn", id: c2 }, cited: { kind: "turn", id: strong }, relation: "verifies", provenance: "judged" },
          { citing: { kind: "turn", id: c1 }, cited: { kind: "turn", id: weak }, relation: "grounds", provenance: "judged" },
        ],
        CUTOFF,
      );

      const view = buildSegmentTimelineView(db, { segmentId, view: "milestones", pageSize: 2 });
      // Ranking admits [strong (in-degree 2), weak (in-degree 1)]; DISPLAY
      // stays event order (strong's member ordinal precedes weak's).
      expect(view.keptMilestones.map((row) => row.member.turnId)).toEqual([strong, weak]);
      expect(view.keptMilestones.map((row) => row.member.turnId)).not.toContain(none);
      expect(view.demotedCount).toBeGreaterThan(0);
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

    test("a legacy-era turn now competes on the SAME footing as a modern one (milestone-election spec, ticket 03: era gating retired from candidacy) — `taskCausalityEraCutoffEpoch` is accepted but no longer excludes it", () => {
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
      expect(keptIds).toContain(legacy);
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

    // Ticket 06 (view-render-repair, ruling [S15069/T1084]): the same
    // exclusion `timeline.test.ts` proves against the plain `S<n>` route and
    // `selectMilestoneTurns` directly, proven here through the SHARED
    // selection function this route and the `S<n>` nested rows both call
    // (`selectSegmentMilestonesByEdgeSignals`).
    test("a rolled-back or skipped member is excluded outright — no seat, no `demotedCount`, election unaffected by its edge (ticket 06)", () => {
      const rewound = makeTurn(1, { title: "rewound member" });
      db.query("UPDATE turns SET was_rolled_back = 1 WHERE id = ?").run(rewound);
      const skipped = makeTurn(2, { title: "skipped member" });
      db.query("UPDATE turns SET status = 'skipped' WHERE id = ?").run(skipped);
      const survivor = makeTurn(3, { title: "plain survivor" });
      addSegmentMembers(db, segmentId, [rewound, skipped, survivor], CUTOFF);
      // Both excluded members carry a live encodes edge — an excluded turn's
      // own edge must not buy it (or anyone else) a seat.
      const encoder = makeTurn(4, { title: "encoder" });
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: encoder },
            cited: { kind: "turn", id: rewound },
            relation: "grounds",
            provenance: "judged",
          },
        ],
        CUTOFF,
      );

      const view = buildSegmentTimelineView(db, { segmentId, view: "milestones", pageSize: 10 });
      const keptIds = view.keptMilestones.map((row) => row.member.turnId);
      expect(keptIds).not.toContain(rewound);
      expect(keptIds).not.toContain(skipped);
      expect(keptIds).toContain(survivor);
      // Neither excluded member ever reached candidacy, so neither is
      // counted as a demoted overflow either — it consumed no seat to lose.
      expect(view.demotedCount).toBe(0);
    });
  });

  describe("turns view", () => {
    test("every member renders in the ONE milestone row form (ticket 05), in event order, under its session transition line — no metadata line, no `- content:`", () => {
      const t1 = makeTurn(1, { title: "first", promptText: "please build the first thing" });
      const t2 = makeTurn(2, { title: "second", promptText: "now the second thing" });
      addSegmentMembers(db, segmentId, [t1, t2], CUTOFF);

      const output = timelineQuery(db, { id: `E${segmentId}`, view: "turns" });
      const lines = output.split("\n");
      // Spec 补充裁决 "turns 表溶解": no tabular surface — the `S<n>/T<m>`
      // citation is split across a transition line and a bare `[T<m>]` row.
      expect(output).not.toContain(" | ");
      expect(lines).toContain(`    [S${sessionId}] E-view session`);
      // Ticket 05: the turns view row is now the milestone row (address, stamp,
      // type glyph, title) — no metadata line, no `- content:`/`- prompt:`
      // field row. `type` was never set on these members, so the glyph is the
      // pending placeholder (`⏳`).
      expect(output).toMatch(/^ {8}\[T1\] \d{2}-\d{2} \d{2}:\d{2} ⏳ first$/m);
      expect(output).toMatch(/^ {8}\[T2\] \d{2}-\d{2} \d{2}:\d{2} ⏳ second$/m);
      expect(output).not.toContain("- content:");
      expect(output).not.toContain("- prompt:");
      expect(output).not.toContain("please build the first thing");

      const i1 = lines.findIndex((line) => line.includes("[T1]") && line.includes("first"));
      const i2 = lines.findIndex((line) => line.includes("[T2]") && line.includes("second"));
      expect(i1).toBeGreaterThan(-1);
      expect(i2).toBeGreaterThan(i1);
    });

    // Ticket 06 (view-render-repair, ruling [S15069/T1084]): the turns view
    // reads `members` through the SAME already-filtered list the milestones
    // view above does (`buildSegmentTimelineView`'s single `members`
    // assignment), so this proves the exclusion on the OTHER branch that
    // never calls `selectSegmentMilestonesByEdgeSignals` at all.
    test("a rolled-back or skipped member never renders here either, and consumes no page budget (ticket 06)", () => {
      const rewound = makeTurn(1, { title: "rewound member" });
      db.query("UPDATE turns SET was_rolled_back = 1 WHERE id = ?").run(rewound);
      const skipped = makeTurn(2, { title: "skipped member" });
      db.query("UPDATE turns SET status = 'skipped' WHERE id = ?").run(skipped);
      const survivor1 = makeTurn(3, { title: "plain survivor one" });
      const survivor2 = makeTurn(4, { title: "plain survivor two" });
      addSegmentMembers(db, segmentId, [rewound, skipped, survivor1, survivor2], CUTOFF);

      const view = buildSegmentTimelineView(db, { segmentId, view: "turns", pageSize: 2 });
      // pageSize 2 over 4 raw members, but only 2 are live: the one page
      // holds both survivors instead of overflowing to a second page.
      expect(view.totalMembers).toBe(2);
      expect(view.pageCount).toBe(1);
      expect(view.pageMembers.map((row) => row.member.turnId)).toEqual([survivor1, survivor2]);

      const output = renderSegmentTimeline(view);
      expect(output).not.toContain("rewound member");
      expect(output).not.toContain("skipped member");
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
          seen.add(entry.member.promptNumber);
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
          seen.add(entry.member.promptNumber);
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

describe("golden sample (ticket 05, .scratch/view-render-repair/05-timeline-one-row-form.md)", () => {
  // The ticket's own verbatim fixture is `timeline(id="E31/T1...")`:
  //
  //   [E31] title
  //       [S15069]
  //           [T821] 08-17 18:19 ⚖️ title
  //               ↳ T811, T812
  //           [T822] 08-17 18:20 ⚖️ title
  //       [S15088]
  //           [T21] 08-18 18:19 ⚖️ title
  //           [T22] 08-19 18:19 ⚖️ title
  //       [S15069]
  //           [T823] 08-20 10:19 ⚖️ title
  //
  // Same caveat as the S<n> golden sample (tests/mcp/timeline.test.ts): the
  // specific ids are the ticket author's own illustrative session and are not
  // reproducible here (auto-increment) — this fixture reconstructs the SAME
  // shape (a titled segment spanning two untitled sessions, re-visiting the
  // first, with one antecedent citation) and asserts the rendered block
  // byte-for-byte against a literal expected string. `E<n>/T1...` defaults to
  // `view: "turns"` (ticket 09), which is exactly what this sample exercises —
  // it is never a `view: "milestones"` call.
  test("byte-for-byte: [E<n>] title / [S<n>] (bare, re-emitted per run) / [T<n>] stamp glyph title / ↳ addresses", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionA = upsertSession(db, {
      contentSessionId: "golden-e-session-a",
      project: "/tmp/golden",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: Math.floor(Date.UTC(2026, 7, 16, 9, 0) / 1000),
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const sessionB = upsertSession(db, {
      contentSessionId: "golden-e-session-b",
      project: "/tmp/golden",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: Math.floor(Date.UTC(2026, 7, 18, 18, 0) / 1000),
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    const insertTurn = (sid: number, promptNumber: number, epoch: number): number =>
      db
        .query<{ id: number }, [number, number, number]>(
          `INSERT INTO turns (
             session_id, prompt_number, status, type, title, created_at_epoch,
             user_prompt, assistant_response, content, files_read, files_modified, tags
           ) VALUES (?, ?, 'extracted', '["decision"]', 'title', ?, 'the user asked something',
                     'assistant response text', 'turn body', '[]', '[]', '[]')
           RETURNING id`,
        )
        .get(sid, promptNumber, epoch)!.id;

    const t811Epoch = Math.floor(Date.UTC(2026, 7, 16, 9, 0) / 1000);
    const t812Epoch = Math.floor(Date.UTC(2026, 7, 16, 9, 5) / 1000);
    const t821Epoch = Math.floor(Date.UTC(2026, 7, 17, 18, 19) / 1000);
    const t822Epoch = Math.floor(Date.UTC(2026, 7, 17, 18, 20) / 1000);
    const t21Epoch = Math.floor(Date.UTC(2026, 7, 18, 18, 19) / 1000);
    const t22Epoch = Math.floor(Date.UTC(2026, 7, 19, 18, 19) / 1000);
    const t823Epoch = Math.floor(Date.UTC(2026, 7, 20, 10, 19) / 1000);

    const t811 = insertTurn(sessionA, 811, t811Epoch);
    const t812 = insertTurn(sessionA, 812, t812Epoch);
    const t821 = insertTurn(sessionA, 821, t821Epoch);
    const t822 = insertTurn(sessionA, 822, t822Epoch);
    const t21 = insertTurn(sessionB, 21, t21Epoch);
    const t22 = insertTurn(sessionB, 22, t22Epoch);
    const t823 = insertTurn(sessionA, 823, t823Epoch);

    writeMemoryEdges(
      db,
      [
        { citing: { kind: "turn", id: t821 }, cited: { kind: "turn", id: t811 }, relation: "consume", provenance: "judged" },
        { citing: { kind: "turn", id: t821 }, cited: { kind: "turn", id: t812 }, relation: "consume", provenance: "judged" },
      ],
      t821Epoch,
    );

    const segment = createSegment(db, { title: "title", type: ["implement"], nowEpoch: t811Epoch });
    // Event order, NOT insertion order: S15069(T821,T822), S15088(T21,T22),
    // S15069(T823) again — the interleaving the sample's own repeated
    // `[S15069]` line depends on.
    addSegmentMembers(db, segment.id, [t821, t822, t21, t22, t823], t823Epoch);

    // The sample's own prose wrote `E31/T1...` with an ellipsis meaning "and
    // so on"; the CALL it illustrates is the bare segment card.
    const output = timelineQuery(db, { id: `E${segment.id}` });

    expect(output).toContain(
      [
        `[E${segment.id}] title`,
        `    [S${sessionA}]`,
        "        [T821] 08-17 18:19 ⚖️ title",
        "            ↳ T811(consume), T812(consume)",
        "        [T822] 08-17 18:20 ⚖️ title",
        `    [S${sessionB}]`,
        "        [T21] 08-18 18:19 ⚖️ title",
        "        [T22] 08-19 18:19 ⚖️ title",
        `    [S${sessionA}]`,
        "        [T823] 08-20 10:19 ⚖️ title",
      ].join("\n"),
    );
  });
});
