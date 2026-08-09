import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { deriveDominantType } from "../../src/db/segment-rank";
import {
  addSegmentMembers,
  applySegmentWrites,
  createSegment,
  getSegment,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { estimateDiaryTokens } from "../../src/diary/domain";
import {
  MILESTONE_INJECTION_TOKEN_BUDGET,
  renderSessionMilestoneInjection,
} from "../../src/hooks/milestone-injection";
import { buildTimelineView, renderTimeline } from "../../src/mcp/timeline";

/**
 * Spec D11. The era boundary is a TURN-level comparison, so one session view can
 * carry both halves — the point of these tests is that the two halves never
 * blend: the spine block holds every era row, the legacy block holds every
 * pre-cutoff row, and a divider says which is which.
 */
describe("timeline dual-path rendering across the era boundary", () => {
  let db: Database;
  let sessionId: number;
  const CUTOFF = 1_900_000_000;
  const ids: Record<string, number> = {};

  function makeTurn(
    promptNumber: number,
    options: {
      type?: string | null;
      createdAtEpoch?: number;
      title?: string | null;
      grade?: number | null;
      tags?: string[];
    } = {},
  ): number {
    return db
      .query<
        { id: number },
        [number, number, string | null, number, string | null, number | null, string]
      >(
        `INSERT INTO turns (
           session_id, prompt_number, status, type, created_at_epoch, title,
           significance_grade, tags, user_prompt, content, files_modified
         ) VALUES (?, ?, 'extracted', ?, ?, ?, ?, ?, 'the user asked something',
                   'body text', '[]')
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.type ?? null,
        options.createdAtEpoch ?? CUTOFF + promptNumber,
        options.title ?? `title ${promptNumber}`,
        options.grade ?? null,
        JSON.stringify(options.tags ?? []),
      )!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-era",
      project: "/tmp/project",
      title: "Era session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF - 10_000,
      updatedAtEpoch: CUTOFF + 5_000,
      completedAtEpoch: null,
    }).id;

    ids.legacyDecision = makeTurn(1, {
      type: "decision",
      createdAtEpoch: CUTOFF - 5_000,
      title: "legacy decision one",
      grade: 3,
    });
    ids.legacyFeature = makeTurn(2, {
      type: "feature",
      createdAtEpoch: CUTOFF - 4_000,
      title: "legacy feature two",
      grade: 2,
    });

    ids.research = makeTurn(10, { type: "research", title: "research the spine" });
    ids.design = makeTurn(11, { type: "design", title: "design the spine" });
    ids.implement = makeTurn(12, { type: "implement", title: "implement the spine" });
    ids.orphan = makeTurn(13, { type: "fix", title: "fix the watchdog race" });
    ids.citer = makeTurn(14, { type: "review", title: "review the fix" });

    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: ids.citer! },
          cited: { kind: "turn", id: ids.orphan! },
          relation: "builds-on",
          provenance: "judged",
        },
      ],
      CUTOFF,
    );

    const segment = createSegment(db, {
      title: "implement the segment spine",
      type: ["implement"],
      tags: ["extraction-redesign", "rendering"],
      nowEpoch: CUTOFF,
    });
    ids.segment = segment.id;
    addSegmentMembers(db, segment.id, [ids.research!, ids.design!, ids.implement!], CUTOFF);
    applySegmentWrites(
      db,
      [
        {
          segmentId: segment.id,
          expectedRevision: getSegment(db, segment.id)!.revision,
          content: `Spine ships. Load-bearing: [S${sessionId}/T12].`,
        },
      ],
      { nowEpoch: CUTOFF },
    );

    const delivered = createSegment(db, {
      title: "review pass",
      type: ["review"],
      tags: ["rendering"],
      status: "delivered",
      nowEpoch: CUTOFF,
    });
    ids.deliveredSegment = delivered.id;
    addSegmentMembers(db, delivered.id, [ids.citer!], CUTOFF);
  });

  afterEach(() => {
    db.close();
  });

  function renderArc(eraCutoffEpoch: number | null): string {
    return renderTimeline(
      buildTimelineView(db, {
        id: `S${sessionId}`,
        view: "milestones",
        eraCutoffEpoch,
      }),
    );
  }

  test("a null cutoff renders exactly what the pre-segment renderer rendered", () => {
    const output = renderArc(null);

    expect(output).not.toContain("segment spine");
    expect(output).not.toContain("legacy era");
    expect(output).not.toContain("[E");
    // Every turn is still a legacy candidate, era-side ones included.
    expect(output).toContain("T14");
  });

  test("era turns render as segments and legacy turns keep the day-grouped arc", () => {
    const output = renderArc(CUTOFF);
    const lines = output.split("\n");

    const spineHeader = lines.findIndex((line) => line.includes("── segment spine"));
    const legacyHeader = lines.findIndex((line) => line.includes("── legacy era"));
    expect(spineHeader).toBeGreaterThan(-1);
    expect(legacyHeader).toBeGreaterThan(spineHeader);

    const spineBlock = lines.slice(spineHeader, legacyHeader).join("\n");
    const legacyBlock = lines.slice(legacyHeader).join("\n");

    // No mixed reading: an era turn is never a legacy row, and vice versa.
    expect(spineBlock).toContain(`[E${ids.segment}]`);
    expect(spineBlock).toContain("T10–T12");
    expect(legacyBlock).toContain("legacy decision one");
    expect(legacyBlock).toContain("legacy feature two");
    expect(legacyBlock).not.toContain("research the spine");
    expect(legacyBlock).not.toContain("implement the spine");
    expect(legacyBlock).not.toContain("review the fix");
  });

  test("the day view is removed on the era side only", () => {
    const output = renderArc(CUTOFF);
    const lines = output.split("\n");
    const spineHeader = lines.findIndex((line) => line.includes("── segment spine"));
    const legacyHeader = lines.findIndex((line) => line.includes("── legacy era"));

    const dayHeader = /^── \d{4}-\d{2}-\d{2} \w{3} · T/;
    expect(lines.slice(spineHeader, legacyHeader).some((line) => dayHeader.test(line))).toBe(
      false,
    );
    expect(lines.slice(legacyHeader).some((line) => dayHeader.test(line))).toBe(true);
  });

  test("a segment row carries glyph, tag, title, status, count/span and phase trace", () => {
    const row = renderArc(CUTOFF)
      .split("\n")
      .find((line) => line.includes(`[E${ids.segment}]`))!;

    expect(row).toBe(
      "   [E1] 🔧 #extraction-redesign #rendering implement the segment spine [open] · 3 turns · T10–T12 · 🔍→⚖️→🔧",
    );
  });

  test("an unclaimed turn with a hard signal gets its own row", () => {
    const output = renderArc(CUTOFF);

    expect(output).toContain("⚑ T13 🔴 fix the watchdog race (cited 1)");
    // A claimed turn is represented by its segment, never twice.
    expect(output).not.toContain("⚑ T14");
    expect(output).toContain("1 orphan anchor");
  });

  test("the era side takes no rows from a session with no segments yet", () => {
    const empty = upsertSession(db, {
      contentSessionId: "session-empty",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    db.query(
      `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch,
         user_prompt, title, tags, files_modified)
       VALUES (?, 1, 'extracted', ?, 'p', 'quiet turn', '[]', '[]')`,
    ).run(empty, CUTOFF + 1);

    const output = renderTimeline(
      buildTimelineView(db, { id: `S${empty}`, view: "milestones", eraCutoffEpoch: CUTOFF }),
    );
    expect(output).not.toContain("segment spine");
  });

  test("the SessionStart injection stays inside the existing budget contract", () => {
    const injected = renderSessionMilestoneInjection(db, sessionId, {
      eraCutoffEpoch: CUTOFF,
    });

    expect(injected).toContain("── segment spine");
    expect(estimateDiaryTokens(injected)).toBeLessThanOrEqual(
      MILESTONE_INJECTION_TOKEN_BUDGET,
    );
  });

  test("a budget too small to hold the spine sheds rows and says how many", () => {
    const injected = renderSessionMilestoneInjection(db, sessionId, {
      eraCutoffEpoch: CUTOFF,
      tokenBudget: 60,
    });

    // Orphans go before segments: the safety net is not the structure.
    expect(injected).toContain("+1 orphan anchor");
    expect(injected).toContain("+2 earlier segments");
    expect(injected).not.toContain(`[E${ids.segment}]`);
  });

  test("the spine sheds orphans before segments, at every budget", () => {
    // A property, not a magic number: whenever the orphan row survives, every
    // segment row has survived too. Sweeping the budget makes the claim about
    // the ORDER of the ladder rather than about one lucky measurement.
    const observed: Array<{ budget: number; orphan: boolean; segments: number }> = [];
    for (let budget = 50; budget <= 800; budget += 25) {
      const view = buildTimelineView(db, {
        id: `S${sessionId}`,
        view: "milestones",
        pageSize: Number.MAX_SAFE_INTEGER,
        eraCutoffEpoch: CUTOFF,
      });
      const output = renderTimeline(view, { tokenBudget: budget });
      observed.push({
        budget,
        orphan: output.includes("⚑ T13"),
        segments: [ids.segment, ids.deliveredSegment].filter((id) =>
          output.includes(`[E${id}]`),
        ).length,
      });
    }

    for (const step of observed) {
      if (step.orphan) {
        expect(step.segments).toBe(2);
      }
    }
    // Non-vacuous: some budget keeps both segments while the orphan is folded.
    expect(
      observed.some((step) => !step.orphan && step.segments === 2),
    ).toBe(true);
    expect(observed.some((step) => step.orphan)).toBe(true);
  });

  test("the turn table refuses to give an era turn a legacy grade", () => {
    const output = renderTimeline(
      buildTimelineView(db, {
        id: `S${sessionId}`,
        view: "turns",
        eraCutoffEpoch: CUTOFF,
      }),
    );

    const eraRow = output.split("\n").find((line) => line.startsWith("T12 |"))!;
    const legacyRow = output.split("\n").find((line) => line.startsWith("T1 |"))!;
    expect(eraRow).toContain("| — |");
    expect(legacyRow).toContain("| G3 |");
  });
});

describe("deriveDominantType (spec D9's member-type mode)", () => {
  test("an unambiguous mode wins", () => {
    expect(
      deriveDominantType(["research", "implement", "implement"], ["research"]),
    ).toBe("implement");
  });

  test("a tie defers to the segment's own declared type", () => {
    expect(deriveDominantType(["research", "implement"], ["implement"])).toBe(
      "implement",
    );
  });

  test("no member type at all falls back to the segment's list, then to nothing", () => {
    expect(deriveDominantType([null, null], ["design"])).toBe("design");
    expect(deriveDominantType([null], [])).toBeNull();
  });
});
