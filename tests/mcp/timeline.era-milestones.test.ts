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
 * this admission rule onto the SAME lexicographic edge-signal selector the
 * standalone `E<n>` route uses (`selectSegmentMilestonesByEdgeSignals`,
 * ticket 09) — replacing the old state-citation/token-budget rule this file
 * used to exercise (`selectSegmentMilestoneRows`, retired along with its own
 * dedicated unit tests in tests/mcp/timeline.segment-views.test.ts). Key
 * order and edge-free degradation are proven directly against the pure
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
 *                                a `supersedes` VICTIM (correction alone is
 *                                not an exclusion signal any more than it is
 *                                an admission one).
 *                          — T20 : plain member, admits by flat chronology.
 *                          — T21 : a corrector (supersedes T19) — admits the
 *                                same way T20 does; the ⚑ flag is a display
 *                                marker, independent of admission.
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
      {
        citing: { kind: "turn" as const, id: ids.corrector! },
        cited: { kind: "turn" as const, id: ids.overridden! },
        relation: "supersedes" as const,
        provenance: "judged" as const,
      },
    ],
    CUTOFF,
    { eligibleForRelation: "unrestricted" },
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

describe("milestone rows nest under segment lines, lexicographic edge-signal admission", () => {
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

  test("admission: edge-signal-ranked members appear; an overridden member is excluded outright", () => {
    const output = renderArc();

    expect(output).toContain("bootstrap the arc"); // encoded
    expect(output).toContain("quiet middle step"); // edge-free, flat chronology
    expect(output).toContain("a second quiet step"); // edge-free, flat chronology
    expect(output).toContain("ship the corrected change"); // edge-free, flat chronology
    expect(output).toContain("correct the approach"); // edge-free, flat chronology
    // Overridden outright — even though it is also a `supersedes` VICTIM, the
    // exclusion comes from key 0 (`overridden`), not from victimhood.
    expect(output).not.toContain("the overridden attempt");
  });

  test("correction (`supersedes`) is not itself an admission signal — the ⚑ flag is a display marker only", () => {
    const output = renderArc();
    const correctorRow = output.split("\n").find((line) => line.includes("correct the approach"))!;
    expect(correctorRow).toContain("⚑");
    const citedRow = output.split("\n").find((line) => line.includes("ship the corrected change"))!;
    expect(citedRow).not.toContain("⚑");
  });

  test("minimal row: no grade label, no prompt excerpt, and `↳` carries ADDRESSES", () => {
    const output = renderArc();
    const spineBlock = output.split("── legacy era")[0]!;
    // The grade DISPLAY is retired on EVERY surface now, legacy block included.
    expect(spineBlock).not.toMatch(/G[0-4]/);
    expect(output).not.toMatch(/G[0-4]/);
    expect(spineBlock).not.toContain("the user asked something"); // the shared prompt text — never on a milestone row
    // Spec 金样例: `↳` is a pure address index, never a `+N 前件` count.
    expect(spineBlock).toContain("↳ T19");
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

    // Same admitted titles, same exclusion (the overridden victim absent from
    // both), same corrector flag.
    for (const title of ["ship the corrected change", "correct the approach"]) {
      expect(sOutput).toContain(title);
      expect(eOutput).toContain(title);
    }
    expect(sOutput).not.toContain("the overridden attempt");
    expect(eOutput).not.toContain("the overridden attempt");

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
});
