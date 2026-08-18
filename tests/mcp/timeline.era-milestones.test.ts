import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  applySegmentWrites,
  createSegment,
  getSegment,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { buildTimelineView, renderTimeline } from "../../src/mcp/timeline";

/**
 * Milestone rows nest under each segment line on the era side of an `S<n>`
 * view (ticket 03's own mechanism), rendered with the SAME admission rule
 * and the SAME minimal row a standalone `E<n>` view uses
 * (tests/mcp/timeline.segment-views.test.ts): state-cited admits
 * unconditionally, overflow demotes rather than paginating. This replaces
 * the pre-ticket-05 effGrade/day-budget nested renderer entirely — see that
 * file's own module comment for why a minimal row has nothing left for the
 * old two-phase degradation ladder to do.
 *
 * TICKET 06 (ownership-and-note-cadence spec, "选举机器拆除"): the election
 * A/B-tier half of the admission rule this fixture used to exercise
 * (`election_tier`, `src/election.ts`) is GONE — dead code cleanup, not a
 * rendering redesign, since tier never carried real production data. What
 * used to be "A-tier, not cited" and "two B-tier members" fixture turns are
 * now state-cited instead, which is the only admission mechanism left; the
 * budget-demote sweep (E4) still exercises the SAME shrink loop
 * (`selectSegmentMilestoneRows`'s `keptAlways`), just over cited rows
 * instead of B-tier ones.
 *
 * This fixture builds ONE session, following `seedEraFixture`'s construction
 * pattern (tests/mcp/segment-spine.test.ts): raw turn inserts, segments via
 * `createSegment`/`addSegmentMembers`, a structured `supersedes` edge via
 * `writeMemoryEdges`. It is a SEPARATE fixture rather than an edit to
 * `seedEraFixture`, so as not to disturb that file's own passing assertions.
 *
 * Four era segments, each isolating one acceptance criterion:
 *
 *   E1 "cited segment"    — T5  : state-cited (named in E1's own `content`).
 *   E2 "quiet segment"    — T10, T11 : neither turn is cited — admits
 *                                NOTHING. The byte-identical regression
 *                                segment.
 *   E3 "corrector segment" — T20 : state-cited.
 *                          — T21 : state-cited AND a corrector (supersedes
 *                                T19), so its ⚑ flag is directly visible.
 *                          — T19 : the superseded victim, deliberately NOT
 *                                cited — proves no ↳ pull-through: a turn
 *                                merely cited BY a corrector never surfaces
 *                                on its own.
 *   E4 "budget segment"   — T30, T31 : two state-cited members, used to
 *                                exercise the demote-under-budget-pressure
 *                                sweep.
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

  // An era compact marker: never a segment member, and — since the
  // admission rule never reads `type` at all — it has no bearing on whether
  // anything renders either way. Kept to prove it stays absent regardless.
  ids.compactMarker = makeTurn(3, { type: "compact", title: null });

  ids.cited = makeTurn(5, { type: "research", title: "bootstrap the arc" });
  ids.quietOne = makeTurn(10, { type: "design", title: "quiet middle step" });
  ids.quietTwo = makeTurn(11, { type: "design", title: "a second quiet step" });
  ids.correctorCited = makeTurn(20, { type: "implement", title: "ship the corrected change" });
  ids.corrector = makeTurn(21, { type: "implement", title: "correct the approach" });
  ids.victim = makeTurn(19, { type: "implement", title: "the superseded attempt" });
  ids.budgetEarly = makeTurn(30, { type: "review", title: "budget row one" });
  ids.budgetLate = makeTurn(31, { type: "review", title: "budget row two" });

  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn" as const, id: ids.corrector! },
        cited: { kind: "turn" as const, id: ids.victim! },
        relation: "supersedes" as const,
        provenance: "judged" as const,
      },
    ],
    CUTOFF,
    { eligibleForRelation: "unrestricted" },
  );

  const citedSeg = createSegment(db, {
    title: "cited segment",
    type: ["research"],
    nowEpoch: CUTOFF,
  });
  ids.segCited = citedSeg.id;
  addSegmentMembers(db, citedSeg.id, [ids.cited!], CUTOFF);
  applySegmentWrites(
    db,
    [
      {
        segmentId: citedSeg.id,
        expectedRevision: getSegment(db, citedSeg.id)!.revision,
        content: `Load-bearing: [S${sessionId}/T5].`,
      },
    ],
    { nowEpoch: CUTOFF },
  );

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
    [ids.correctorCited!, ids.corrector!, ids.victim!],
    CUTOFF,
  );
  applySegmentWrites(
    db,
    [
      {
        segmentId: correctorSeg.id,
        expectedRevision: getSegment(db, correctorSeg.id)!.revision,
        content: `Load-bearing: [S${sessionId}/T20], [S${sessionId}/T21].`,
      },
    ],
    { nowEpoch: CUTOFF },
  );

  const budgetSeg = createSegment(db, {
    title: "budget segment",
    type: ["review"],
    nowEpoch: CUTOFF,
  });
  ids.segBudget = budgetSeg.id;
  addSegmentMembers(db, budgetSeg.id, [ids.budgetEarly!, ids.budgetLate!], CUTOFF);
  applySegmentWrites(
    db,
    [
      {
        segmentId: budgetSeg.id,
        expectedRevision: getSegment(db, budgetSeg.id)!.revision,
        content: `Load-bearing: [S${sessionId}/T30], [S${sessionId}/T31].`,
      },
    ],
    { nowEpoch: CUTOFF },
  );

  return { sessionId, ids };
}

describe("milestone rows nest under segment lines, minimal-row admission", () => {
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
    const eCited = lines.findIndex((line) => line.includes(`[E${ids.segCited}]`));
    const eCorrector = lines.findIndex((line) => line.includes(`[E${ids.segCorrector}]`));
    const t5 = lines.findIndex((line) => line.includes("bootstrap the arc"));
    const t20 = lines.findIndex((line) => line.includes("ship the corrected change"));
    const t21 = lines.findIndex((line) => line.includes("correct the approach"));

    expect(t5).toBeGreaterThan(eCited);
    expect(t5).toBeLessThan(eCorrector);
    expect(t20).toBeGreaterThan(eCorrector);
    expect(t21).toBeGreaterThan(t20);
  });

  test("admission: state-cited members appear; uncited members — including a corrector's own victim — never do", () => {
    const output = renderArc();

    expect(output).toContain("bootstrap the arc"); // state-cited
    expect(output).toContain("ship the corrected change"); // state-cited
    expect(output).toContain("correct the approach"); // state-cited AND a corrector
    expect(output).not.toContain("quiet middle step"); // uncited
    expect(output).not.toContain("a second quiet step"); // uncited
    // No ↳ pull-through — a turn that is merely cited BY a corrector (not
    // itself state-cited) never surfaces, unlike the old effGrade-based
    // antecedent mechanism.
    expect(output).not.toContain("the superseded attempt");
  });

  test("minimal row: no grade label, no prompt excerpt, no antecedent counters; ⚑ marks a corrector, and only a corrector", () => {
    const output = renderArc();
    // Scoped to the era spine block (before the legacy divider): the LEGACY
    // block still prints its own pre-existing `G<n>` grade column — this
    // only strips it from the NEW segment-nested rows.
    const spineBlock = output.split("── legacy era")[0]!;
    expect(spineBlock).not.toMatch(/G[0-4]/);
    expect(spineBlock).not.toContain("the user asked something"); // the shared prompt text — never on a milestone row
    expect(spineBlock).not.toContain("↳");

    const correctorRow = output.split("\n").find((line) => line.includes("correct the approach"))!;
    expect(correctorRow).toContain("⚑");
    const citedRow = output.split("\n").find((line) => line.includes("ship the corrected change"))!;
    expect(citedRow).not.toContain("⚑");
  });

  test("a segment whose members are never cited renders byte-identically: the segment row alone, nothing nested", () => {
    const output = renderArc();
    const lines = output.split("\n");
    const quietIndex = lines.findIndex((line) => line.includes(`[E${ids.segQuiet}]`));
    const nextSegmentIndex = lines.findIndex(
      (line, index) => index > quietIndex && line.startsWith("   [E"),
    );
    expect(quietIndex).toBeGreaterThan(-1);
    expect(nextSegmentIndex).toBe(quietIndex + 1);
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
    ]) {
      expect(legacyBlock).not.toContain(eraTitle);
    }
  });

  test("state-cited rows demote under a tight pageBudget — overflow demotes, never paginates", () => {
    const roomy = renderArc({ pageBudget: 100_000 });
    expect(roomy).toContain("budget row one");
    expect(roomy).toContain("budget row two");

    const oneRowLine = roomy.split("\n").find((line) => line.includes("budget row one"))!;
    // `estimateDiaryTokens` is exercised indirectly here through the same
    // renderer; a budget of roughly one row's worth should admit at most one
    // of the two cited candidates and demote the other.
    const tight = renderArc({ pageBudget: Math.ceil(oneRowLine.length * 0.9) });
    const budgetSegmentBlock = tight.split(`[E${ids.segBudget}]`)[1]?.split("[E")[0] ?? "";
    const bothPresent =
      budgetSegmentBlock.includes("budget row one") &&
      budgetSegmentBlock.includes("budget row two");
    expect(bothPresent).toBe(false);
    expect(budgetSegmentBlock).toMatch(/… \+\d+ more/);
  });

  test("segment/orphan LINES survive a small pageBudget on their own — pageBudget only governs each segment's NESTED content", () => {
    // No `tokenBudget` is set, so `shedSpineToBudget` never runs at all: every
    // `[E<n>]` line in the spine is present regardless of how tight
    // `pageBudget` (the per-segment nested-row governor) gets.
    const output = renderArc({ pageBudget: 1 });
    for (const segId of [ids.segCited, ids.segQuiet, ids.segCorrector, ids.segBudget]) {
      expect(output).toContain(`[E${segId}]`);
    }
  });

  test("an outer tokenBudget still sheds whole segment/orphan lines (shedSpineToBudget, unchanged) once nested content cannot shrink further", () => {
    const generous = renderArc({ tokenBudget: 100_000 });
    const segmentCount = ["segCited", "segQuiet", "segCorrector", "segBudget"].filter((key) =>
      generous.includes(`[E${ids[key]!}]`),
    ).length;
    expect(segmentCount).toBe(4);

    const tiny = renderArc({ tokenBudget: 10 });
    const tinySegmentCount = ["segCited", "segQuiet", "segCorrector", "segBudget"].filter((key) =>
      tiny.includes(`[E${ids[key]!}]`),
    ).length;
    expect(tinySegmentCount).toBeLessThan(4);
  });
});
