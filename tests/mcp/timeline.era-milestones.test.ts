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
 * Ticket 05 (spec "Tools"/ADR-0006, S15069 T838-T839): milestone rows nest
 * under each segment line on the era side of an `S<n>` view (ticket 03's own
 * mechanism), rendered with the SAME admission rule and the SAME minimal row
 * a standalone `E<n>` view uses (tests/mcp/timeline.segment-views.test.ts):
 * state-cited ∪ A-tier admits unconditionally, B-tier fills the segment's own
 * `pageBudget` (default 1000) in event order, overflow demotes rather than
 * paginating. This replaces the pre-ticket-05 effGrade/day-budget nested
 * renderer entirely — see that file's own module comment for why a minimal
 * row has nothing left for the old two-phase degradation ladder to do.
 *
 * This fixture builds ONE session, following `seedEraFixture`'s construction
 * pattern (tests/mcp/segment-spine.test.ts): raw turn inserts, segments via
 * `createSegment`/`addSegmentMembers`, a structured `supersedes` edge via
 * `writeMemoryEdges`. It is a SEPARATE fixture rather than an edit to
 * `seedEraFixture`, so as not to disturb that file's own passing assertions.
 *
 * Four era segments, each isolating one acceptance criterion:
 *
 *   E1 "cited segment"   — T5  : state-cited (named in E1's own `content`),
 *                                no election tier at all.
 *   E2 "quiet segment"   — T10 : neither cited nor tiered (C-tier) — admits
 *                                NOTHING. The byte-identical regression
 *                                segment.
 *   E3 "tiered segment"  — T20 : A-tier, not cited.
 *                        — T21 : a corrector (supersedes T20's neighbour in a
 *                                different segment is irrelevant here; T21
 *                                supersedes nothing in this segment — it is
 *                                its OWN outgoing edge that matters) and
 *                                A-tier, so its ⚑ flag is directly visible.
 *   E4 "budget segment"  — T30, T31 : two B-tier members, used to exercise
 *                                the demote-under-budget-pressure sweep.
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
      electionTier?: "A" | "B" | "C" | null;
    } = {},
  ): number =>
    db
      .query<
        { id: number },
        [number, number, string, number, string | null, string | null, string]
      >(
        `INSERT INTO turns (
           session_id, prompt_number, status, type, created_at_epoch, title,
           election_tier, tags, user_prompt, content, files_modified
         ) VALUES (?, ?, 'extracted', ?, ?, ?, ?, '[]', 'the user asked something',
                   'body text', '[]')
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.type ? JSON.stringify([options.type]) : "[]",
        options.createdAtEpoch ?? CUTOFF + promptNumber,
        options.title ?? `title ${promptNumber}`,
        options.electionTier ?? null,
      )!.id;

  const ids: Record<string, number> = {};
  ids.legacy = makeTurn(1, {
    type: "decision",
    createdAtEpoch: CUTOFF - 5_000,
    title: "legacy anchor",
  });

  // An era compact marker: never a segment member, and — since the new
  // admission rule never reads `type` at all — it has no bearing on whether
  // anything renders either way. Kept to prove it stays absent regardless.
  ids.compactMarker = makeTurn(3, { type: "compact", title: null });

  ids.cited = makeTurn(5, { type: "research", title: "bootstrap the arc" });
  ids.quietUntiered = makeTurn(10, { type: "design", title: "quiet middle step" });
  ids.quietCTier = makeTurn(11, {
    type: "design",
    title: "c-tier does not admit",
    electionTier: "C",
  });
  ids.aTier = makeTurn(20, { type: "implement", title: "ship the tiered change" });
  ids.corrector = makeTurn(21, { type: "implement", title: "correct the approach" });
  ids.victim = makeTurn(19, { type: "implement", title: "the superseded attempt" });
  ids.bTierEarly = makeTurn(30, { type: "review", title: "b-tier row one" });
  ids.bTierLate = makeTurn(31, { type: "review", title: "b-tier row two" });

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

  // `db.query(...).run` for election_tier on the A-tier rows (set post-insert
  // so `makeTurn`'s own signature — shared with the untiered/C-tier rows
  // above — stays uniform); simpler to pass `electionTier: "A"` directly.
  db.query(`UPDATE turns SET election_tier = 'A' WHERE id IN (?, ?)`).run(
    ids.aTier!,
    ids.corrector!,
  );
  db.query(`UPDATE turns SET election_tier = 'B' WHERE id IN (?, ?)`).run(
    ids.bTierEarly!,
    ids.bTierLate!,
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
  addSegmentMembers(db, quietSeg.id, [ids.quietUntiered!, ids.quietCTier!], CUTOFF);

  const tieredSeg = createSegment(db, {
    title: "tiered segment",
    type: ["implement"],
    nowEpoch: CUTOFF,
  });
  ids.segTiered = tieredSeg.id;
  addSegmentMembers(db, tieredSeg.id, [ids.aTier!, ids.corrector!, ids.victim!], CUTOFF);

  const budgetSeg = createSegment(db, {
    title: "budget segment",
    type: ["review"],
    nowEpoch: CUTOFF,
  });
  ids.segBudget = budgetSeg.id;
  addSegmentMembers(db, budgetSeg.id, [ids.bTierEarly!, ids.bTierLate!], CUTOFF);

  return { sessionId, ids };
}

describe("milestone rows nest under segment lines, minimal-row admission (ticket 05)", () => {
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
    const eTiered = lines.findIndex((line) => line.includes(`[E${ids.segTiered}]`));
    const t5 = lines.findIndex((line) => line.includes("bootstrap the arc"));
    const t20 = lines.findIndex((line) => line.includes("ship the tiered change"));
    const t21 = lines.findIndex((line) => line.includes("correct the approach"));

    expect(t5).toBeGreaterThan(eCited);
    expect(t5).toBeLessThan(eTiered);
    expect(t20).toBeGreaterThan(eTiered);
    expect(t21).toBeGreaterThan(t20);
  });

  test("admission: state-cited without any tier, A-tier without citation, neither excludes", () => {
    const output = renderArc();

    expect(output).toContain("bootstrap the arc"); // state-cited, no tier
    expect(output).toContain("ship the tiered change"); // A-tier, not cited
    expect(output).not.toContain("quiet middle step"); // neither
    expect(output).not.toContain("c-tier does not admit"); // C-tier is not A/B
    // No ↳ pull-through any more — a turn that is merely cited BY a corrector
    // (not itself state-cited or tiered) never surfaces, unlike the old
    // effGrade-based antecedent mechanism.
    expect(output).not.toContain("the superseded attempt");
  });

  test("minimal row: no tier label, no prompt excerpt, no antecedent counters; ⚑ marks a corrector, and only a corrector", () => {
    const output = renderArc();
    // Scoped to the era spine block (before the legacy divider): the LEGACY
    // block still prints its own pre-existing `G<n>` grade column — this
    // ticket only strips it from the NEW segment-nested rows.
    const spineBlock = output.split("── legacy era")[0]!;
    expect(spineBlock).not.toMatch(/G[0-4]/);
    expect(spineBlock).not.toContain("the user asked something"); // the shared prompt text — never on a milestone row
    expect(spineBlock).not.toContain("↳");

    const correctorRow = output.split("\n").find((line) => line.includes("correct the approach"))!;
    expect(correctorRow).toContain("⚑");
    const aTierRow = output.split("\n").find((line) => line.includes("ship the tiered change"))!;
    expect(aTierRow).not.toContain("⚑");
  });

  test("a segment whose members are neither cited nor A/B-tiered renders byte-identically: the segment row alone, nothing nested", () => {
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
      "ship the tiered change",
      "correct the approach",
      "quiet middle step",
    ]) {
      expect(legacyBlock).not.toContain(eraTitle);
    }
  });

  test("B-tier rows demote under a tight pageBudget — overflow demotes, never paginates", () => {
    const roomy = renderArc({ pageBudget: 100_000 });
    expect(roomy).toContain("b-tier row one");
    expect(roomy).toContain("b-tier row two");

    const oneRowLine = roomy.split("\n").find((line) => line.includes("b-tier row one"))!;
    // `estimateDiaryTokens` is exercised indirectly here through the same
    // renderer; a budget of roughly one row's worth should admit at most one
    // of the two B-tier candidates and demote the other.
    const tight = renderArc({ pageBudget: Math.ceil(oneRowLine.length * 0.9) });
    const budgetSegmentBlock = tight.split(`[E${ids.segBudget}]`)[1]?.split("[E")[0] ?? "";
    const bothPresent =
      budgetSegmentBlock.includes("b-tier row one") &&
      budgetSegmentBlock.includes("b-tier row two");
    expect(bothPresent).toBe(false);
    expect(budgetSegmentBlock).toMatch(/… \+\d+ more/);
  });

  test("segment/orphan LINES survive a small pageBudget on their own — pageBudget only governs each segment's NESTED content", () => {
    // No `tokenBudget` is set, so `shedSpineToBudget` never runs at all: every
    // `[E<n>]` line in the spine is present regardless of how tight
    // `pageBudget` (the per-segment nested-row governor) gets.
    const output = renderArc({ pageBudget: 1 });
    for (const segId of [ids.segCited, ids.segQuiet, ids.segTiered, ids.segBudget]) {
      expect(output).toContain(`[E${segId}]`);
    }
  });

  test("an outer tokenBudget still sheds whole segment/orphan lines (shedSpineToBudget, unchanged) once nested content cannot shrink further", () => {
    const generous = renderArc({ tokenBudget: 100_000 });
    const segmentCount = ["segCited", "segQuiet", "segTiered", "segBudget"].filter((key) =>
      generous.includes(`[E${ids[key]!}]`),
    ).length;
    expect(segmentCount).toBe(4);

    const tiny = renderArc({ tokenBudget: 10 });
    const tinySegmentCount = ["segCited", "segQuiet", "segTiered", "segBudget"].filter((key) =>
      tiny.includes(`[E${ids[key]!}]`),
    ).length;
    expect(tinySegmentCount).toBeLessThan(4);
  });
});
