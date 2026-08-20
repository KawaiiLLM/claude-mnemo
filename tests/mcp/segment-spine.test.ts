import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { deriveDominantType, type SegmentSpineRow } from "../../src/db/segment-rank";
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
import { NAVIGATION_LEGEND } from "../../src/mcp/format";
import { renderSpineRow } from "../../src/mcp/segment-spine";
import { buildTimelineView, renderTimeline } from "../../src/mcp/timeline";

/**
 * Spec D11. The era boundary is a TURN-level comparison, so one session view can
 * carry both halves — the point of these tests is that the two halves never
 * blend: the spine block holds every era row, the legacy block holds every
 * pre-cutoff row, and a divider says which is which.
 */
const CUTOFF = 1_900_000_000;

/**
 * One session that straddles the cutoff: two pre-cutoff turns, five era turns,
 * a segment over three of them, a delivered segment over one, and an unclaimed
 * era turn something cites.
 *
 * `transcriptPath` stays derived except for the byte pin below, which passes a
 * literal so the rendered `raw:` line does not move with $HOME. It is not the
 * default because the header's width is part of what the budget tests measure.
 */
function seedEraFixture(
  db: Database,
  transcriptPath: string | null = null,
): {
  sessionId: number;
  ids: Record<string, number>;
} {
  const sessionId = upsertSession(db, {
    contentSessionId: "session-era",
    project: "/tmp/project",
    transcriptPath,
    title: "Era session",
    content: null,
    insight: null,
    nextSteps: null,
    createdAtEpoch: CUTOFF - 10_000,
    updatedAtEpoch: CUTOFF + 5_000,
    completedAtEpoch: null,
  }).id;

  const makeTurn = (
    promptNumber: number,
    options: {
      type?: string | null;
      createdAtEpoch?: number;
      title?: string | null;
      grade?: number | null;
      tags?: string[];
    } = {},
  ): number =>
    db
      .query<
        { id: number },
        [number, number, string, number, string | null, number | null, string]
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
        options.type ? JSON.stringify([options.type]) : "[]",
        options.createdAtEpoch ?? CUTOFF + promptNumber,
        options.title ?? `title ${promptNumber}`,
        options.grade ?? null,
        JSON.stringify(options.tags ?? []),
      )!.id;

  const ids: Record<string, number> = {};
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

  // Ticket 14 (spec K5a): a segment's tags and type are DERIVED from its
  // members, so the row's facets have to be seeded on the turns. Frequency
  // orders them — extraction-redesign on all three members, rendering on two.
  ids.research = makeTurn(10, {
    type: "research",
    title: "research the spine",
    tags: ["extraction-redesign"],
  });
  ids.design = makeTurn(11, {
    type: "design",
    title: "design the spine",
    tags: ["extraction-redesign", "rendering"],
  });
  ids.implement = makeTurn(12, {
    type: "implement",
    title: "implement the spine",
    tags: ["extraction-redesign", "rendering"],
  });
  ids.orphan = makeTurn(13, { type: "fix", title: "fix the watchdog race" });
  ids.citer = makeTurn(14, { type: "review", title: "review the fix" });

  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: ids.citer! },
        cited: { kind: "turn", id: ids.orphan! },
        relation: "depends-on",
        provenance: "judged",
      },
    ],
    CUTOFF,
  );

  const segment = createSegment(db, {
    title: "implement the segment spine",
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
    status: "delivered",
    nowEpoch: CUTOFF,
  });
  ids.deliveredSegment = delivered.id;
  addSegmentMembers(db, delivered.id, [ids.citer!], CUTOFF);

  return { sessionId, ids };
}

describe("timeline dual-path rendering across the era boundary", () => {
  let db: Database;
  let sessionId: number;
  let ids: Record<string, number>;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    ({ sessionId, ids } = seedEraFixture(db));
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

    // The glyph is 🔍 (research), not 🔧: the three members carry one activity
    // each, so there is no member mode, and `deriveDominantType` falls back to
    // the segment's own first type word — which since ticket 14 is the DERIVED
    // union's first entry (frequency, then vocabulary order), not a type the
    // settlement pass stated over its members' heads (spec K5a).
    expect(row).toBe(
      "[E1] 🔍 #extraction-redesign #rendering implement the segment spine [open] · 3 turns · T10–T12 · 🔍→⚖️→🔧",
    );
  });

  test("an unclaimed turn with a hard signal gets its own row", () => {
    const output = renderArc(CUTOFF);

    expect(output).toContain("⚑ T13 🔴 fix the watchdog race (cited 1)");
    // A claimed turn is represented by its segment, never twice.
    expect(output).not.toContain("⚑ T14");
    expect(output).toContain("1 orphan anchor");
  });

  test("a segment reaching back across the cutoff contributes only its era half", () => {
    // Nothing stops the settlement pass from claiming a turn written before the
    // switch. When it does, the spine row must still describe the era side
    // ALONE: the pre-cutoff member is a legacy arc row, and a turn cannot be
    // counted on both sides of the divider.
    addSegmentMembers(db, ids.segment!, [ids.legacyFeature!], CUTOFF);
    const output = renderArc(CUTOFF);

    expect(output.split("\n").find((line) => line.includes(`[E${ids.segment}]`))).toBe(
      "[E1] 🔍 #extraction-redesign #rendering implement the segment spine [open] · 3 turns · T10–T12 · 🔍→⚖️→🔧",
    );
    expect(output.split("── legacy era")[1]).toContain("legacy feature two");
  });

  test("a range view carries only the segments and orphans its window holds", () => {
    const output = renderTimeline(
      buildTimelineView(db, {
        id: `S${sessionId}/T10..12`,
        view: "milestones",
        eraCutoffEpoch: CUTOFF,
      }),
    );

    expect(output).toContain(`[E${ids.segment}]`);
    // T14 (the delivered segment's only member) and T13 (the orphan) are both
    // outside T10..T12; a range that excludes them from the legacy body must
    // exclude them from the spine too.
    expect(output).not.toContain(`[E${ids.deliveredSegment}]`);
    expect(output).not.toContain("⚑ T13");
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
    //
    // Step 5, not 25. The window where both segments fit and the orphan does
    // not is only about fifteen tokens wide in this fixture, so a coarser
    // sweep finds the witness by luck: widening the `types:` header line by a
    // few tokens moved the ladder and a step of 25 jumped straight over the
    // window, failing the non-vacuity assertion while the property itself was
    // entirely intact.
    const observed: Array<{ budget: number; orphan: boolean; segments: number }> = [];
    for (let budget = 50; budget <= 800; budget += 5) {
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

  test("the turn view is the unified row form — no tabular surface, no grade cell on either side of the cutoff", () => {
    const output = renderTimeline(
      buildTimelineView(db, {
        id: `S${sessionId}`,
        view: "turns",
        eraCutoffEpoch: CUTOFF,
      }),
    );

    // Spec 补充裁决: the turns TABLE dissolved, and the `G` column dissolved
    // with the grade DISPLAY — so there is no cell left for either era to
    // disagree about.
    const rows = output.split("\n").filter((line) => /\[T\d+\]/.test(line));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toContain(" | ");
    }
    expect(output).not.toMatch(/\bG[0-4]\b/);
    // Ticket 05: the row is `[T<n>] <stamp> <glyph> <title>` at the SHALLOW
    // (4-space) indent this direct `S<n>` route uses (no `[E<n>]`/spine
    // ancestor above its own session transition line) — no per-row
    // `[S<n>][T<n>]` form anywhere; the session's own transition line states
    // it once (spec 金样例).
    expect(output).toContain("    [T12] ");
    expect(output).not.toContain("[S1][T1]");
    expect(output).toMatch(/^ {4}\[T1\] \d{2}-\d{2} \d{2}:\d{2} /m);
  });
});

/**
 * The byte pin behind "a null cutoff changes nothing". Marker absence only
 * proves the NEW blocks stay silent; it says nothing about whether the legacy
 * arc still emits the same characters. `PRE_SEGMENT_ARC` was captured by
 * running commit 5acdf4a — the last commit before the spine existed — over this
 * exact fixture:
 *
 *   renderTimeline(buildTimelineView(db, { id: `S<n>`, view: "milestones" }))
 *
 * Regenerate it the same way if the LEGACY arc renderer ever changes on
 * purpose; a diff here that nobody intended is the regression this guards.
 *
 * TZ is pinned because the arc prints local dates and the header's UTC offset,
 * and the fixture pins `transcriptPath` because the test HOME is a fresh
 * mkdtemp on every run.
 */
describe("a null era cutoff is byte-identical to the pre-segment renderer", () => {
  // Updated for the recall-render-legend spec (ticket 02, D4): the day-group
  // hint's repeated `→ timeline(...)` command is gone (said once now, in the
  // response-level legend appended below) — this is an intentional legacy
  // renderer change, per the comment above, so the pin moved with it.
  //
  // Updated again for the settlement-agentic spec (ticket 02, B5): glyph
  // resolution now covers the full current-vocabulary word set, not only the
  // legacy 6-word render map — a "review"-typed turn gets its own glyph (✅)
  // instead of falling through to the generic • placeholder. `review` was
  // already a legal value on this column before this ticket; only the
  // renderer's blind spot for it is what changed.
  const PRE_SEGMENT_ARC = `- [S1] 2030-03-17 15:00 → 19:10 (4h 10m)
  /tmp/project | 7 turns | 0 tool_calls
  types: 🔍1 ⚖️2 🔧1 🔴1 ✅1 🟣1 (session-wide)
  tz: UTC (+00:00)
  raw: /tmp/project/session-era.jsonl

── 2030-03-17 Sun · T1–T14 · 2 kept ──
        [T1] 03-17 16:23 ⚖️ legacy decision one · "the user asked something"
            body text
        [T14] 03-17 17:46 ✅ review the fix · "the user asked something"
            body text
            ↳ T13
        … +4 more @ within T2..T12

  shape signals (window T1-T14 = full session):
    - fastest gap:   after T10 (+1s)
    - longest gap:   after T2 (+1h 6m)
    - broken-prompt: T10→T11, T11→T12, T12→T13, T13→T14

${NAVIGATION_LEGEND}`;

  let db: Database;
  let sessionId: number;
  // Bun resolves the zone from `process.env.TZ` on every read, and DELETING the
  // variable does not put the system zone back — the name has to be written
  // back explicitly or every later test file renders in UTC.
  const originalTz =
    process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  beforeAll(() => {
    process.env.TZ = "UTC";
  });

  afterAll(() => {
    process.env.TZ = originalTz;
  });

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    ({ sessionId } = seedEraFixture(db, "/tmp/project/session-era.jsonl"));
  });

  afterEach(() => {
    db.close();
  });

  test("the whole arc comes back unchanged", () => {
    expect(
      renderTimeline(
        buildTimelineView(db, {
          id: `S${sessionId}`,
          view: "milestones",
          eraCutoffEpoch: null,
        }),
      ),
    ).toBe(PRE_SEGMENT_ARC);
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

  test("a tie with no segment type of its own resolves to nothing, not to arrival order", () => {
    // A segment whose title matches no type prefix is stored with an EMPTY type
    // list (`resolveTypeDraft`), so this is the ordinary shape, not a corner
    // case. With no mode and no declared type there is nothing to defer to, and
    // "whichever member happened to be written first" is not an answer.
    expect(deriveDominantType(["research", "implement"], [])).toBeNull();
    expect(deriveDominantType(["implement", "research"], [])).toBeNull();
    expect(deriveDominantType(["fix", "fix", "ops", "ops"], [])).toBeNull();
  });
});

describe("spine rows cut like every other field", () => {
  const title = `${"alpha beta gamma ".repeat(20)}supplementary`;
  const row: SegmentSpineRow = {
    segment: {
      id: 47,
      title,
      content: null,
      type: [],
      tags: [],
      status: "open",
      revision: 1,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: CUTOFF,
    },
    dominantType: "implement",
    memberCount: 3,
    sessionMemberCount: 3,
    firstPromptNumber: 12,
    lastPromptNumber: 87,
    firstEpoch: CUTOFF,
    lastEpoch: CUTOFF,
    phaseTrace: ["implement"],
  };

  test("a spine title retreats to a word boundary", () => {
    // The spine held a third copy of the same three-line hard cut — the ticket
    // named only the timeline's. A P2-era session reads through THIS renderer,
    // so leaving it would have kept the defect on the surface that matters most.
    const rendered = renderSpineRow(row, 60);
    const shown = rendered.slice(rendered.indexOf(title.slice(0, 5)), rendered.indexOf(" [open]"));

    expect(shown).toEndWith("…");
    const kept = shown.slice(0, -1);
    expect(title.startsWith(kept)).toBe(true);
    expect(title.charAt(kept.length)).toBe(" ");
  });
});
