import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { replaceTurnCitations } from "../../src/db/citations";
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
 * Ticket 03 (segment-grading spec, issue 03): milestone rows nest under each
 * segment line on the era side, in prompt order, reusing the exact selection
 * (`selectMilestoneTurns`) and row renderer (`renderUnitFitted`) the legacy
 * day-grouped body uses — only the scoping unit changes, day to segment.
 *
 * This fixture builds ONE session, following `seedEraFixture`'s construction
 * pattern (tests/mcp/segment-spine.test.ts): raw turn inserts, segments via
 * `createSegment`/`addSegmentMembers`, a structured `supersedes` edge via
 * `replaceTurnCitations`. It is a SEPARATE fixture rather than an edit to
 * `seedEraFixture`, so as not to disturb that file's 18 passing assertions
 * (several of which pin exact segment-row text and exact budget-shedding
 * counts that a shared-fixture edit could shift).
 *
 * Four era segments, deliberately shaped so every acceptance criterion has a
 * segment that isolates it:
 *
 *   E1 "bracket early"  — T5  : the window's global FIRST turn (endpoint,
 *                                always-keep) — G0, ungraded.
 *   E2 "quiet segment"  — T10 : ungraded, no corrector/reversed/endpoint
 *                                status — admits NOTHING. This is the
 *                                byte-identical regression segment.
 *   E3 "graded segment" — T20 : significance_grade 3 (spine admission)
 *                        — T21 : corrector of five earlier turns (promoted
 *                                to G3, victims demoted and pulled through,
 *                                one beyond the 4-antecedent cap folds).
 *   E4 "bracket late"   — T30 : the window's global LAST-titled turn
 *                                (endpoint, always-keep) — G0, ungraded.
 *
 * Plus two turns that stay OUTSIDE every segment: a `compact` marker (never a
 * main-row candidate at all) and a G4 always-keep turn with no segment
 * membership (kept by selection, but produces no nested row — spec D9).
 */
const CUTOFF = 1_950_000_000;

function seedGradedEraFixture(db: Database): {
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
      grade?: number | null;
      filesModified?: string[];
    } = {},
  ): number =>
    db
      .query<
        { id: number },
        [number, number, string | null, number, string | null, number | null, string]
      >(
        `INSERT INTO turns (
           session_id, prompt_number, status, type, created_at_epoch, title,
           significance_grade, tags, user_prompt, content, files_modified
         ) VALUES (?, ?, 'extracted', ?, ?, ?, ?, '[]', 'the user asked something',
                   'body text', ?)
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.type ?? null,
        options.createdAtEpoch ?? CUTOFF + promptNumber,
        options.title ?? `title ${promptNumber}`,
        options.grade ?? null,
        JSON.stringify(options.filesModified ?? []),
      )!.id;

  const ids: Record<string, number> = {};
  ids.legacy = makeTurn(1, {
    type: "decision",
    createdAtEpoch: CUTOFF - 5_000,
    title: "legacy anchor",
    grade: 3,
  });

  // An era compact marker: never a main-row candidate regardless of segment
  // membership (selectMilestoneTurns filters `type === 'compact'` out of its
  // candidate set entirely), and it joins no segment either way.
  ids.compactMarker = makeTurn(3, { type: "compact", title: null });

  ids.bracketEarly = makeTurn(5, { type: "research", title: "bootstrap the arc" });
  ids.target = makeTurn(10, { type: "design", title: "quiet middle step" });
  ids.victim1 = makeTurn(15, { type: "implement", title: "historical attempt 1" });
  ids.victim2 = makeTurn(16, { type: "implement", title: "historical attempt 2" });
  ids.victim3 = makeTurn(17, { type: "implement", title: "historical attempt 3" });
  ids.victim4 = makeTurn(18, { type: "implement", title: "historical attempt 4" });
  ids.victim5 = makeTurn(19, { type: "implement", title: "historical attempt 5" });
  ids.graded = makeTurn(20, {
    type: "implement",
    title: "ship the graded change",
    grade: 3,
    filesModified: ["core.ts"],
  });
  ids.corrector = makeTurn(21, { type: "implement", title: "correct the approach" });
  // An always-keep G4 anchor that joins no segment: kept by selection, but
  // spec D9 says a turn with no segment produces no NESTED row (it may still
  // be reachable through the orphan-anchor mechanism, which is unrelated).
  ids.unsegmentedAnchor = makeTurn(25, {
    type: "fix",
    title: "unsegmented always-keep anchor",
    grade: 4,
  });
  ids.bracketLate = makeTurn(30, { type: "review", title: "close out the arc" });

  replaceTurnCitations(
    db,
    ids.corrector!,
    [
      { id: ids.victim1!, relation: "supersedes" },
      { id: ids.victim2!, relation: "supersedes" },
      { id: ids.victim3!, relation: "supersedes" },
      { id: ids.victim4!, relation: "supersedes" },
      { id: ids.victim5!, relation: "supersedes" },
    ],
    CUTOFF,
  );

  const bracketEarly = createSegment(db, {
    title: "bracket early",
    type: ["research"],
    nowEpoch: CUTOFF,
  });
  ids.segBracketEarly = bracketEarly.id;
  addSegmentMembers(db, bracketEarly.id, [ids.bracketEarly!], CUTOFF);

  const target = createSegment(db, {
    title: "quiet segment",
    type: ["design"],
    nowEpoch: CUTOFF,
  });
  ids.segTarget = target.id;
  addSegmentMembers(db, target.id, [ids.target!], CUTOFF);

  const graded = createSegment(db, {
    title: "graded segment",
    type: ["implement"],
    nowEpoch: CUTOFF,
  });
  ids.segGraded = graded.id;
  addSegmentMembers(db, graded.id, [ids.graded!, ids.corrector!], CUTOFF);
  applySegmentWrites(
    db,
    [
      {
        segmentId: graded.id,
        expectedRevision: getSegment(db, graded.id)!.revision,
        content: `Ships the change and corrects the earlier approach. Load-bearing: [S${sessionId}/T20].`,
      },
    ],
    { nowEpoch: CUTOFF },
  );

  const bracketLate = createSegment(db, {
    title: "bracket late",
    type: ["review"],
    nowEpoch: CUTOFF,
  });
  ids.segBracketLate = bracketLate.id;
  addSegmentMembers(db, bracketLate.id, [ids.bracketLate!], CUTOFF);

  return { sessionId, ids };
}

describe("milestone rows nest under segment lines (ticket 03)", () => {
  let db: Database;
  let sessionId: number;
  let ids: Record<string, number>;
  const originalTz =
    process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  beforeEach(() => {
    process.env.TZ = "UTC";
    db = createDatabase(":memory:");
    initializeSchema(db);
    ({ sessionId, ids } = seedGradedEraFixture(db));
  });

  afterEach(() => {
    db.close();
    process.env.TZ = originalTz;
  });

  function renderArc(tokenBudget?: number): string {
    return renderTimeline(
      buildTimelineView(db, {
        id: `S${sessionId}`,
        view: "milestones",
        eraCutoffEpoch: CUTOFF,
      }),
      tokenBudget === undefined ? {} : { tokenBudget },
    );
  }

  test("milestone rows appear under their own segment line, in prompt order", () => {
    const output = renderArc();
    const lines = output.split("\n");
    const e1 = lines.findIndex((line) => line.includes(`[E${ids.segBracketEarly}]`));
    const e3 = lines.findIndex((line) => line.includes(`[E${ids.segGraded}]`));
    const t5 = lines.findIndex((line) => line.includes("T5 ") && line.includes("bootstrap the arc"));
    const t20 = lines.findIndex((line) => line.includes("T20 ") && line.includes("ship the graded change"));
    const t21 = lines.findIndex((line) => line.includes("T21 ") && line.includes("correct the approach"));

    // T5's row sits directly under E1, before E3 even starts.
    expect(t5).toBeGreaterThan(e1);
    expect(t5).toBeLessThan(e3);
    // T20 then T21, in prompt order, both under E3 and before the next segment.
    expect(t20).toBeGreaterThan(e3);
    expect(t21).toBeGreaterThan(t20);
  });

  test("admission is effGrade >= 3 plus structural always-keep, not a parallel rule", () => {
    const output = renderArc();

    // T10: ungraded, no corrector/reversed/endpoint status — never admitted.
    expect(output).not.toContain("quiet middle step");
    // T20: significance_grade 3 clears the spine gate.
    expect(output).toContain("ship the graded change");
    // T5 / T30: structural endpoints, admitted at G0.
    expect(output).toContain("bootstrap the arc");
    expect(output).toContain("close out the arc");
    const t5Row = output.split("\n").find((line) => line.includes("bootstrap the arc"))!;
    expect(t5Row).toContain(" G0 ");
  });

  test("the printed grade is effGrade after corrector promotion, not the stored (null) grade", () => {
    const output = renderArc();
    const correctorRow = output
      .split("\n")
      .find((line) => line.includes("correct the approach"))!;
    // T21's stored significance_grade is null; the corrector rule forces
    // effGrade to >= 3, and that promoted value is what prints.
    expect(correctorRow).toContain(" G3 ");
  });

  test("an overturned era turn renders as a demoted casualty beneath its corrector", () => {
    const output = renderArc();
    const lines = output.split("\n");
    const correctorIndex = lines.findIndex((line) => line.includes("correct the approach"));
    expect(correctorIndex).toBeGreaterThan(-1);

    const victimLine = lines[correctorIndex + 1]!;
    expect(victimLine).toContain("↳ 🚫 T15");
    expect(victimLine).toContain("historical attempt 1");
    expect(victimLine).toContain(`→被T${21}推翻`);
  });

  test("antecedents beyond the per-unit cap collapse to a count", () => {
    const output = renderArc();
    // Five victims cite into T21; the per-unit renderer (shared with the
    // legacy body, unmodified) folds whatever does not fit into `+N 前件`.
    expect(output).toMatch(/↳ \+\d+ 前件/);
  });

  test("era turns belonging to no segment produce no nested row", () => {
    const output = renderArc();
    // The compact marker is never a main-row candidate at all — it may still
    // appear in the header/shape-signals as a compact boundary, but never as
    // a rendered milestone row (`T3 •`, the row-renderer's own format).
    expect(output).not.toContain("T3 •");
    // The G4 anchor IS selected (always-keep) but joins no segment, so it
    // gets no NESTED row under any segment line.
    expect(output).not.toContain("unsegmented always-keep anchor");
  });

  test("the legacy selection still runs over legacy turns alone", () => {
    const output = renderArc();
    const legacyBlock = output.split("── legacy era")[1]!;
    expect(legacyBlock).toContain("legacy anchor");
    for (const eraTitle of [
      "bootstrap the arc",
      "quiet middle step",
      "ship the graded change",
      "correct the approach",
      "historical attempt 1",
      "unsegmented always-keep anchor",
      "close out the arc",
    ]) {
      expect(legacyBlock).not.toContain(eraTitle);
    }
  });

  test("under budget pressure, milestone rows degrade before any segment line is touched", () => {
    // Property, not a magic number (mirrors the existing orphan-before-segment
    // sweep in segment-spine.test.ts): whenever ANY nested row survives, every
    // segment line has already survived too, at every budget swept.
    const segmentIds = [ids.segBracketEarly!, ids.segTarget!, ids.segGraded!, ids.segBracketLate!];
    const observed: Array<{ budget: number; anyRow: boolean; segmentCount: number }> = [];
    for (let budget = 40; budget <= 900; budget += 20) {
      const output = renderArc(budget);
      const segmentCount = segmentIds.filter((id) => output.includes(`[E${id}]`)).length;
      const anyRow =
        output.includes("bootstrap the arc") ||
        output.includes("ship the graded change") ||
        output.includes("correct the approach") ||
        output.includes("close out the arc");
      observed.push({ budget, anyRow, segmentCount });
    }

    for (const step of observed) {
      if (step.anyRow) {
        expect(step.segmentCount).toBe(4);
      }
    }
    // Non-vacuous: some tight budget keeps every segment line while shedding
    // every nested row, and some looser budget keeps at least one row.
    expect(observed.some((step) => !step.anyRow && step.segmentCount === 4)).toBe(true);
    expect(observed.some((step) => step.anyRow)).toBe(true);
  });

  /**
   * The byte-identical regression (spec D6/D9): a segment whose members carry
   * no grades, and hit no structural always-keep rule, must render with
   * exactly one line — the segment row itself, produced by the unmodified
   * `renderSpineRow` — and nothing nested beneath it.
   *
   * The "before" bytes were captured by running the PRE-CHANGE renderer (git
   * blob `HEAD:src/mcp/timeline.ts` + `HEAD:src/mcp/segment-spine.ts`, from
   * before this ticket's edits) against this exact fixture, in an isolated
   * directory with symlinks back to the untouched `db`/`shared`/`diary`
   * modules (`git show` only — no working-tree mutation). That run printed:
   *
   *   [E2] ⚖️ quiet segment [open] · 1 turn · T10 · ⚖️
   *
   * as a standalone line with the next segment's `[E3] ...` line immediately
   * after it — no nested content. This test pins that exact line and its
   * immediate neighbour.
   */
  test("a segment whose members carry no grades renders byte-identically to today", () => {
    const output = renderArc();
    const lines = output.split("\n");
    const e2Index = lines.findIndex((line) => line.includes(`[E${ids.segTarget}]`));
    const e3Index = lines.findIndex((line) => line.includes(`[E${ids.segGraded}]`));
    expect(e2Index).toBeGreaterThan(-1);
    expect(e3Index).toBeGreaterThan(e2Index);

    expect(lines[e2Index]).toBe(
      `   [E${ids.segTarget}] ⚖️ quiet segment [open] · 1 turn · T10 · ⚖️`,
    );
    // Nothing rendered between the segment row and the next segment's row.
    expect(e3Index).toBe(e2Index + 1);
  });
});
