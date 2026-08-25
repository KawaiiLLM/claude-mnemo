import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { buildTimelineView, renderTimeline, timelineQuery } from "../../src/mcp/timeline";

/**
 * Milestone rows nest under each segment line on the era side of an `S<n>`
 * view (ticket 03's own mechanism). Ticket 12 (`会话视图里程碑并轨`) unified
 * this admission rule onto the SAME selector the standalone `E<n>` route
 * uses (`selectSegmentMilestonesByEdgeSignals`, ticket 09) — replacing the
 * old state-citation/token-budget rule this file used to exercise
 * (`selectSegmentMilestoneRows`, retired along with its own dedicated unit
 * tests in tests/mcp/timeline.segment-views.test.ts). That selector's own
 * ranking is, since milestone-election spec ticket 03, `shared/milestone-election.ts`'s
 * `electMilestones` — ticket 09's original lexicographic edge-signal rule is
 * itself retired (tests/mcp/timeline.election-retirement.test.ts's
 * grep-guards); only the selector's NAME survived that rewrite. Key order
 * and edge-free degradation are proven directly against the pure
 * function in that file; this file proves the WIRING — that the `S<n>`
 * nested route reaches the identical selection a standalone `E<n>` call
 * would for the same segment, `pageSize` and era boundary.
 *
 * This fixture builds ONE session, following `seedEraFixture`'s construction
 * pattern (tests/mcp/segment-spine.test.ts): raw turn inserts, segments via
 * `createSegment`/`addSegmentMembers`, structured `encodes`/`override`/
 * `supersedes` edges via `writeMemoryEdges`. It is a SEPARATE fixture rather
 * than an edit to `seedEraFixture`, so as not to disturb that file's own
 * passing assertions.
 *
 * Three era segments, each isolating one acceptance criterion:
 *
 *   E1 "encoded segment"   — T5 : admitted via a live `encodes` edge from an
 *                                external turn (T6, not a segment member).
 *   E2 "quiet segment"     — T10, T11 : neither turn carries any edge —
 *                                BOTH admit, in event order (edge-free
 *                                degrades to flat chronology, spec's own
 *                                phrase — the opposite of the old
 *                                state-citation rule's "nothing admits by
 *                                default").
 *   E3 "corrector segment" — T19 : overridden by an external turn (T22) —
 *                                excluded outright, even though it is also
 *                                the target of a second correction
 *                                (correction alone is not an exclusion signal
 *                                any more than it is an admission one).
 *                          — T20 : plain member, admits by flat chronology.
 *                          — T21 : a corrector (overrides T19) — admits the
 *                                same way T20 does. It used to also carry the
 *                                ⚑ display flag; that flag read an outgoing
 *                                `supersedes`, and lane-model-v12 ticket 03
 *                                retired the word and the flag together.
 */
const CUTOFF = 1_950_000_000;

function seedSegmentMilestoneFixture(db: Database): {
  sessionId: number;
  ids: Record<string, number>;
} {
  const sessionId = upsertSession(db, {
    contentSessionId: "session-era-milestones",
    project: "/tmp/project",
    transcriptPath: "/tmp/project/session-era-milestones.jsonl",
    title: "Era milestones session",
    content: null,
    insight: null,
    nextSteps: null,
    createdAtEpoch: CUTOFF - 10_000,
    updatedAtEpoch: CUTOFF + 30_000,
    completedAtEpoch: null,
  }).id;

  const makeTurn = (
    promptNumber: number,
    options: {
      type?: string | null;
      createdAtEpoch?: number;
      title?: string | null;
    } = {},
  ): number =>
    db
      .query<
        { id: number },
        [number, number, string, number, string | null, string]
      >(
        `INSERT INTO turns (
           session_id, prompt_number, status, type, created_at_epoch, title,
           tags, user_prompt, content, files_modified
         ) VALUES (?, ?, 'extracted', ?, ?, ?, '[]', 'the user asked something',
                   'body text', '[]')
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.type ? JSON.stringify([options.type]) : "[]",
        options.createdAtEpoch ?? CUTOFF + promptNumber,
        options.title ?? `title ${promptNumber}`,
      )!.id;

  const ids: Record<string, number> = {};
  ids.legacy = makeTurn(1, {
    type: "decision",
    createdAtEpoch: CUTOFF - 5_000,
    title: "legacy anchor",
  });

  ids.encoded = makeTurn(5, { type: "research", title: "bootstrap the arc" });
  ids.encoder = makeTurn(6, { type: "review", title: "encoder of E1" });
  ids.quietOne = makeTurn(10, { type: "design", title: "quiet middle step" });
  ids.quietTwo = makeTurn(11, { type: "design", title: "a second quiet step" });
  ids.overridden = makeTurn(19, { type: "implement", title: "the overridden attempt" });
  ids.correctorCited = makeTurn(20, { type: "implement", title: "ship the corrected change" });
  ids.corrector = makeTurn(21, { type: "implement", title: "correct the approach" });
  ids.overrider = makeTurn(22, { type: "review", title: "overrides the attempt" });

  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn" as const, id: ids.encoder! },
        cited: { kind: "turn" as const, id: ids.encoded! },
        relation: "encodes" as const,
        provenance: "judged" as const,
      },
      {
        citing: { kind: "turn" as const, id: ids.overrider! },
        cited: { kind: "turn" as const, id: ids.overridden! },
        relation: "override" as const,
        provenance: "judged" as const,
      },
      // A second edge, corrector -> overridden, used to stand here under
      // `supersedes`: it existed ONLY to raise the ⚑ corrector flag, which
      // lane-model-v12 ticket 03 deleted along with the word. Re-pointing it at
      // any live word would put T19 on the corrector's `↳` line (that line
      // indexes every outgoing edge, whatever the word), changing what the
      // rendering tests below are looking at — so it is removed rather than
      // relabelled.
    ],
    CUTOFF,
  );

  const encodedSeg = createSegment(db, {
    title: "encoded segment",
    type: ["research"],
    nowEpoch: CUTOFF,
  });
  ids.segEncoded = encodedSeg.id;
  addSegmentMembers(db, encodedSeg.id, [ids.encoded!], CUTOFF);

  const quietSeg = createSegment(db, {
    title: "quiet segment",
    type: ["design"],
    nowEpoch: CUTOFF,
  });
  ids.segQuiet = quietSeg.id;
  addSegmentMembers(db, quietSeg.id, [ids.quietOne!, ids.quietTwo!], CUTOFF);

  const correctorSeg = createSegment(db, {
    title: "corrector segment",
    type: ["implement"],
    nowEpoch: CUTOFF,
  });
  ids.segCorrector = correctorSeg.id;
  addSegmentMembers(
    db,
    correctorSeg.id,
    [ids.overridden!, ids.correctorCited!, ids.corrector!],
    CUTOFF,
  );

  return { sessionId, ids };
}

describe("milestone rows nest under segment lines, election-based admission", () => {
  let db: Database;
  let sessionId: number;
  let ids: Record<string, number>;
  const originalTz =
    process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  beforeEach(() => {
    process.env.TZ = "UTC";
    db = createDatabase(":memory:");
    initializeSchema(db);
    ({ sessionId, ids } = seedSegmentMilestoneFixture(db));
  });

  afterEach(() => {
    db.close();
    process.env.TZ = originalTz;
  });

  function renderArc(overrides: { pageBudget?: number; tokenBudget?: number } = {}): string {
    return renderTimeline(
      buildTimelineView(db, {
        id: `S${sessionId}`,
        view: "milestones",
        eraCutoffEpoch: CUTOFF,
      }),
      { pageBudget: overrides.pageBudget, tokenBudget: overrides.tokenBudget },
    );
  }

  test("milestone rows appear under their own segment line, in event order", () => {
    const output = renderArc();
    const lines = output.split("\n");
    const eEncoded = lines.findIndex((line) => line.includes(`[E${ids.segEncoded}]`));
    const eCorrector = lines.findIndex((line) => line.includes(`[E${ids.segCorrector}]`));
    const t5 = lines.findIndex((line) => line.includes("bootstrap the arc"));
    const t20 = lines.findIndex((line) => line.includes("ship the corrected change"));
    const t21 = lines.findIndex((line) => line.includes("correct the approach"));

    expect(t5).toBeGreaterThan(eEncoded);
    expect(t5).toBeLessThan(eCorrector);
    expect(t20).toBeGreaterThan(eCorrector);
    expect(t21).toBeGreaterThan(t20);
  });

  // lane-model-v12 ticket 04 re-baselines the exclusion half of this test.
  // An untagged override was the rubric's GLOBAL REPUDIATION and removed its
  // target from candidacy; there is no such thing now, so "the overridden
  // attempt" is admitted like any other member of a small segment.
  test("admission: election-ranked members appear, an override target among them (v12: no candidacy exclusion by edge)", () => {
    const output = renderArc();

    expect(output).toContain("bootstrap the arc"); // encoded
    expect(output).toContain("quiet middle step"); // edge-free, flat chronology
    expect(output).toContain("a second quiet step"); // edge-free, flat chronology
    expect(output).toContain("ship the corrected change"); // edge-free, flat chronology
    expect(output).toContain("correct the approach"); // edge-free, flat chronology
    expect(output).toContain("the overridden attempt");
  });

  // Lane-model-v12 ticket 03 deleted the ⚑ corrector flag with the
  // `supersedes` word it read, so what is left to pin is the ADMISSION half:
  // a corrector is admitted the same way any flat-chronology member is, and
  // its row carries no marker distinguishing it.
  test("correction is not an admission signal, and no longer carries a display marker either", () => {
    const output = renderArc();
    const correctorRow = output.split("\n").find((line) => line.includes("correct the approach"))!;
    expect(correctorRow).toBeDefined();
    expect(output).not.toContain("⚑");
  });

  test("minimal row: no grade label, no prompt excerpt, and `↳` carries ADDRESSES", () => {
    // Milestone-election spec, ticket 03: T19 is override-excluded, so it can
    // never appear on ANY `↳` line — an unelected cited turn is omitted
    // entirely (spec step 5), never named regardless. `corrector`'s own edge
    // to T19 (`supersedes`) is also outside the election's vocabulary. This
    // test's own `↳` demonstration therefore needs a real, in-vocabulary
    // edge between two turns that ARE both elected — `corrector` (T21)
    // `grounds` `correctorCited` (T20).
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn" as const, id: ids.corrector! },
          cited: { kind: "turn" as const, id: ids.correctorCited! },
          relation: "grounds" as const,
          provenance: "judged" as const,
        },
      ],
      CUTOFF,
    );
    const output = renderArc();
    const spineBlock = output.split("── legacy era")[0]!;
    // The grade DISPLAY is retired on EVERY surface now, legacy block included.
    expect(spineBlock).not.toMatch(/G[0-4]/);
    expect(output).not.toMatch(/G[0-4]/);
    expect(spineBlock).not.toContain("the user asked something"); // the shared prompt text — never on a milestone row
    // Spec 金样例: `↳` is a pure address index, never a `+N 前件` count.
    expect(spineBlock).toContain("↳ T20");
    expect(spineBlock).not.toContain("↳ T19");
    expect(output).not.toContain("前件");
  });

  test("an edge-free segment admits all its members, in event order — edge-free degrades to flat chronology", () => {
    const output = renderArc();
    const quietBlock = output.split(`[E${ids.segQuiet}]`)[1]!.split("[E")[0]!;
    expect(quietBlock).toContain("quiet middle step");
    expect(quietBlock).toContain("a second quiet step");
    expect(quietBlock.indexOf("quiet middle step")).toBeLessThan(
      quietBlock.indexOf("a second quiet step"),
    );
  });

  test("the legacy selection still runs over legacy turns alone, unaffected by the era-side redesign", () => {
    const output = renderArc();
    const legacyBlock = output.split("── legacy era")[1]!;
    expect(legacyBlock).toContain("legacy anchor");
    for (const eraTitle of [
      "bootstrap the arc",
      "ship the corrected change",
      "correct the approach",
      "quiet middle step",
      "the overridden attempt",
    ]) {
      expect(legacyBlock).not.toContain(eraTitle);
    }
  });

  test("RenderTimelineOptions.pageBudget no longer affects the nested rows (ticket 12: pageSize governs selection, not this render-time budget)", () => {
    const tight = renderArc({ pageBudget: 1 });
    const roomy = renderArc({ pageBudget: 100_000 });
    expect(tight).toBe(roomy);
  });

  test("an outer tokenBudget still sheds whole segment/orphan lines (shedSpineToBudget, unchanged) once nested content cannot shrink further", () => {
    const generous = renderArc({ tokenBudget: 100_000 });
    const segmentCount = ["segEncoded", "segQuiet", "segCorrector"].filter((key) =>
      generous.includes(`[E${ids[key]!}]`),
    ).length;
    expect(segmentCount).toBe(3);

    const tiny = renderArc({ tokenBudget: 10 });
    const tinySegmentCount = ["segEncoded", "segQuiet", "segCorrector"].filter((key) =>
      tiny.includes(`[E${ids[key]!}]`),
    ).length;
    expect(tinySegmentCount).toBeLessThan(3);
  });

  test("dual assertion: the S<n> nested rows for a segment select IDENTICALLY to the standalone E<n> route, given the same pageSize and era boundary", () => {
    const sOutput = renderArc();
    const eOutput = timelineQuery(db, {
      id: `E${ids.segCorrector}`,
      view: "milestones",
    });

    // Same admitted titles on both routes, same corrector flag. The override
    // target is now among them on both (lane-model-v12 ticket 04) — the point
    // of this test is that the two routes AGREE, whatever they admit.
    for (const title of ["ship the corrected change", "correct the approach", "the overridden attempt"]) {
      expect(sOutput).toContain(title);
      expect(eOutput).toContain(title);
    }

    // Row-for-row: the nested block under `[E<segCorrector>]` in the S<n>
    // view and the standalone E<n> view's own row list are the SAME lines
    // (`renderSegmentMilestoneRow` with the same titleCap default in both —
    // DEFAULT_TITLE_CAP), proving the two routes share not just the
    // admission decision but its exact rendering. Filtered to actual `T<n>`
    // rows so the spine header line, the legacy block and the shape-signals
    // footer — everything else the two full renders otherwise disagree on —
    // never enter the comparison.
    const rowPattern = /^\s*(⚑ )?\[T\d+\] /;
    const nestedLines = sOutput
      .split(`[E${ids.segCorrector}]`)[1]!
      .split("── legacy era")[0]!
      .split("\n")
      .filter((line) => rowPattern.test(line));
    const standaloneLines = eOutput.split("\n").filter((line) => rowPattern.test(line));
    expect(nestedLines.length).toBeGreaterThan(0);
    expect(nestedLines).toEqual(standaloneLines);
  });

  test("the plain S<n> turns view carries no corrector flag either (lane-model-v12 ticket 03)", () => {
    // Ticket 05 collapsed both turn views onto the milestone row, and the two
    // routes computed the ⚑ flag DIFFERENTLY: the `E<n>` route read it off
    // `RankedSegmentMember`, the plain `S<n>` route re-derived it from its own
    // edge query. Both readings were the same outgoing-`supersedes` predicate,
    // and lane-model-v12 ticket 03 deleted the word — so the pin that used to
    // hold the two routes in agreement now holds their shared ABSENCE, on the
    // route that had its own independent implementation to lose.
    const rendered = timelineQuery(db, { id: `S${sessionId}`, view: "turns", pageSize: 50 });

    const correctorRow = rendered
      .split("\n")
      .find((line) => line.includes("correct the approach"));
    expect(correctorRow).toBeDefined();
    expect(rendered).not.toContain("⚑");
  });

  test("election is provably grade-free (view-render-repair ticket 02, [S15069/T1035]): under OPPOSED significance_grade assignments the E<n> selection stays byte-identical", () => {
    // `pageSize: 1` is what makes this test able to fail. The corrector
    // segment has two live candidates (the third is override-excluded), so at
    // the default page size BOTH are admitted and no ranking key — grade
    // included — can change the output. Capping the page to one seat forces
    // the rank comparator to pick a winner, so any grade term in it becomes
    // observable as a different row.
    const query = () =>
      timelineQuery(db, { id: `E${ids.segCorrector}`, view: "milestones", pageSize: 1 });
    const setGrades = (grade: (index: number) => number) => {
      db.query<{ id: number }, []>("SELECT id FROM turns")
        .all()
        .forEach((row, index) => {
          db.query<unknown, [number, number]>(
            "UPDATE turns SET significance_grade = ? WHERE id = ?",
          ).run(grade(index), row.id);
        });
    };

    // Ungraded baseline, then two assignments that INVERT each other's order
    // on every turn. One scramble alone proves nothing: it can hand the real
    // winner the top grade by luck and leave a grade-ranked election looking
    // stable. Two opposed assignments cannot both agree with a grade term —
    // whichever way it sorted, reversing every grade must move some pair.
    const ungraded = query();
    setGrades((index) => index % 5);
    const ascending = query();
    setGrades((index) => 4 - (index % 5));
    const descending = query();

    expect(ascending).toBe(ungraded);
    expect(descending).toBe(ungraded);
    // The seat really is contested — otherwise the equalities above are vacuous.
    expect(ungraded.match(/\[T\d+\]/g) ?? []).toHaveLength(1);
  });
});
