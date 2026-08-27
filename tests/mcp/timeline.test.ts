import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { insertLane } from "../../src/db/lanes";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession, type UpsertSessionInput } from "../../src/db/sessions";
import { getTurn, type TurnRecord } from "../../src/db/turns";
import { resolveTranscriptPath } from "../../src/shared/paths";
import { TYPE_GLYPH } from "../../src/shared/type-vocabulary";
import {
  buildContextTimelineView,
  buildSegmentTimelineView,
  buildTimelineView,
  cleanPromptForLabel,
  computeTypesDistribution,
  renderTypesDistribution,
  detectBrokenPromptPairs,
  detectShapeSignals,
  formatDuration,
  formatGap,
  formatLocalDate,
  formatLocalTime,
  getSystemTimezone,
  extractSourceTags,
  isVersionBumpTurn,
  milestoneMarker,
  OUTCOME_TAGS,
  parseContentReferences,
  parseTimelineId,
  renderTimeline,
  compareMilestoneRank,
  DEFAULT_TITLE_CAP,
  MILESTONE_NOTIFICATION_MARKER,
  MILESTONE_OVER_BUDGET_NOTE,
  MILESTONE_PROMPT_PREFIX_CAP,
  MILESTONE_UNIT_PULLED_CAP,
  MILESTONE_UNIT_TOKEN_CAP,
  resolveWindow,
  segmentPhases,
  selectMilestoneTurns,
  timelineQuery,
  truncateToTokens,
  type KeptMilestone,
  type MilestoneSelection,
  type TimelineView,
} from "../../src/mcp/timeline";
import type { LaneEdgeInput } from "../../src/shared/milestone-election";
import { laneEdge as buildLaneEdge } from "../support/lane-edge-fixtures";
import { estimateDiaryTokens } from "../../src/diary/domain";
import { timelineInputSchema } from "../../src/mcp/definitions";
import { WORKER_TOOL_RESULT_MAX_CHARS } from "../../src/mcp/handlers";
import { LARGE_SPINE_SEGMENT_COUNT, seedLargeEraSpine } from "../support/large-corpus";
// `truncateText` comes from the renderer it is shared with: timeline used to
// export a second function of the same name, and the two cut differently.
import { NAVIGATION_LEGEND, truncateText } from "../../src/mcp/format";
import { type CitationRelation } from "../../src/db/citations";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";

// `type` accepts a single string as a convenience (ticket 02, spec B5 widened
// storage to a list; most call sites below predate that and pass one word).
type TurnOverrides = Partial<Omit<TurnRecord, "type">> & {
  type?: string | string[] | null;
};

function normalizeTypeOverride(
  value: string | string[] | null | undefined,
): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function turn(overrides: TurnOverrides = {}): TurnRecord {
  const { type, ...rest } = overrides;
  return {
    id: 1,
    sessionId: 1,
    promptNumber: 1,
    contentPromptId: null,
    transcriptLineStart: null,
    wasInterrupted: false,
    wasRolledBack: false,
    status: "extracted",
    userPrompt: null,
    assistantResponse: null,
    title: null,
    content: null,
    insight: null,
    type: [],
    significanceGrade: null,
    tags: [],
    filesRead: [],
    filesModified: [],
    toolCallCount: 0,
    parentTurnId: null,
    createdAtEpoch: 1000,
    updatedAtEpoch: null,
    ...rest,
    type: normalizeTypeOverride(type),
  };
}

function seedSession(db: Database) {
  initializeSchema(db);

  const session = upsertSession(db, {
    contentSessionId: "abc-uuid-timeline",
    project: "/tmp/claude-mnemo-test",
    title: "timeline fixture",
    insight: null,
    createdAtEpoch: 1_700_000_000,
    updatedAtEpoch: 1_700_000_100,
    completedAtEpoch: null,
  });

  const insertTurn = db.query(
    `INSERT INTO turns (
      session_id,
      prompt_number,
      content_prompt_id,
      transcript_line_start,
      status,
      user_prompt,
      assistant_response,
      title,
      content,
      insight,
      type,
      tags,
      files_read,
      files_modified,
      tool_call_count,
      created_at_epoch,
      updated_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (let promptNumber = 1; promptNumber <= 21; promptNumber += 1) {
    const type =
      promptNumber === 6 || promptNumber === 19 || promptNumber === 20
        ? "decision"
        : promptNumber >= 19
          ? null
          : "discovery";

    insertTurn.run(
      session.id,
      promptNumber,
      null,
      promptNumber * 10,
      "extracted",
      `raw prompt ${promptNumber}`,
      null,
      type === null ? null : `title for T${promptNumber}`,
      null,
      null,
      type === null ? "[]" : JSON.stringify([type]),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      promptNumber === 5 || promptNumber === 11 ? 15 : 2,
      1_700_000_000 + promptNumber * 100,
      null,
    );
  }

  return session;
}

function seedLongSession(db: Database, count: number) {
  initializeSchema(db);

  const session = upsertSession(db, {
    contentSessionId: "long-context-session",
    project: "/tmp/claude-mnemo-test",
    title: "long timeline fixture",
    insight: null,
    createdAtEpoch: 1_700_100_000,
    updatedAtEpoch: 1_700_100_100,
    completedAtEpoch: null,
  });

  const insertTurn = db.query(
    `INSERT INTO turns (
      session_id,
      prompt_number,
      content_prompt_id,
      transcript_line_start,
      status,
      user_prompt,
      assistant_response,
      title,
      content,
      insight,
      type,
      tags,
      files_read,
      files_modified,
      tool_call_count,
      created_at_epoch,
      updated_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (let promptNumber = 1; promptNumber <= count; promptNumber += 1) {
    insertTurn.run(
      session.id,
      promptNumber,
      null,
      promptNumber * 10,
      "extracted",
      `long prompt ${promptNumber} ${"x".repeat(120)}`,
      null,
      `title for T${promptNumber}`,
      null,
      null,
      promptNumber >= count - 2 ? "[]" : JSON.stringify(["discovery"]),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      1,
      1_700_100_000 + promptNumber * 60,
      null,
    );
  }

  return session;
}

function seedTimelineSession(
  db: Database,
  rows: TurnRecord[],
  overrides: Partial<UpsertSessionInput> = {},
) {
  initializeSchema(db);

  const firstEpoch =
    rows.length > 0
      ? Math.min(...rows.map((row) => row.createdAtEpoch))
      : 1_779_781_860;
  const lastEpoch =
    rows.length > 0
      ? Math.max(...rows.map((row) => row.createdAtEpoch))
      : firstEpoch;

  const session = upsertSession(db, {
    contentSessionId: "custom-timeline-fixture",
    project: "/tmp/claude-mnemo-test",
    title: "custom timeline fixture",
    insight: null,
    createdAtEpoch: firstEpoch,
    updatedAtEpoch: lastEpoch,
    completedAtEpoch: null,
    ...overrides,
  });

  const insertTurn = db.query(
    `INSERT INTO turns (
      session_id,
      prompt_number,
      content_prompt_id,
      transcript_line_start,
      was_interrupted,
      was_rolled_back,
      status,
      user_prompt,
      assistant_response,
      title,
      content,
      insight,
      type,
      tags,
      files_read,
      files_modified,
      tool_call_count,
      parent_turn_id,
      created_at_epoch,
      updated_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of rows) {
    insertTurn.run(
      session.id,
      row.promptNumber,
      row.contentPromptId,
      row.transcriptLineStart,
      row.wasInterrupted ? 1 : 0,
      row.wasRolledBack ? 1 : 0,
      row.status,
      row.userPrompt,
      row.assistantResponse,
      row.title,
      row.content,
      row.insight,
      JSON.stringify(row.type),
      JSON.stringify(row.tags),
      JSON.stringify(row.filesRead),
      JSON.stringify(row.filesModified),
      row.toolCallCount,
      row.parentTurnId,
      row.createdAtEpoch,
      row.updatedAtEpoch,
    );
  }

  return session;
}

describe("parseTimelineId", () => {
  it("parses plain session id", () => {
    expect(parseTimelineId("S42")).toEqual({
      sessionId: 42,
      range: { kind: "none" },
    });
  });

  it("parses wildcard T*", () => {
    expect(parseTimelineId("S42/T*")).toEqual({
      sessionId: 42,
      range: { kind: "all" },
    });
  });

  it("parses closed range", () => {
    expect(parseTimelineId("S42/T10..30")).toEqual({
      sessionId: 42,
      range: { kind: "closed", start: 10, end: 30 },
    });
  });

  it("parses closed range with the repeated T ([S15069/T1021])", () => {
    expect(parseTimelineId("S42/T10..T30")).toEqual({
      sessionId: 42,
      range: { kind: "closed", start: 10, end: 30 },
    });
  });

  it("parses open-start range", () => {
    expect(parseTimelineId("S42/T..20")).toEqual({
      sessionId: 42,
      range: { kind: "openStart", end: 20 },
    });
  });

  it("parses open-end range", () => {
    expect(parseTimelineId("S42/T30..")).toEqual({
      sessionId: 42,
      range: { kind: "openEnd", start: 30 },
    });
  });

  it("rejects single-turn forms", () => {
    expect(() => parseTimelineId("S42/T10")).toThrow(/single turn/i);
  });

  it("rejects invalid range bounds", () => {
    expect(() => parseTimelineId("S42/T10..5")).toThrow(/start must be <= end/i);
    expect(() => parseTimelineId("S42/T..0")).toThrow(/positive integers/i);
    expect(() => parseTimelineId("S42/T0..")).toThrow(/positive integers/i);
  });

  it("rejects malformed input", () => {
    expect(() => parseTimelineId("foo")).toThrow();
    expect(() => parseTimelineId("S42/bogus")).toThrow();
    expect(() => parseTimelineId("")).toThrow();
  });
});

describe("resolveWindow", () => {
  it("defaults to the full candidate range when range is none", () => {
    const window = resolveWindow({ kind: "none" }, 120);

    expect(window.startPromptNumber).toBe(1);
    expect(window.endPromptNumber).toBe(120);
  });

  it("returns whole short session when total is within cap", () => {
    const window = resolveWindow({ kind: "none" }, 21);

    expect(window.startPromptNumber).toBe(1);
    expect(window.endPromptNumber).toBe(21);
  });

  it("treats T* the same as none", () => {
    const noneWindow = resolveWindow({ kind: "none" }, 120);
    const allWindow = resolveWindow({ kind: "all" }, 120);

    expect(allWindow).toEqual(noneWindow);
  });

  it("respects a closed range without truncation", () => {
    const window = resolveWindow({ kind: "closed", start: 10, end: 30 }, 120);

    expect(window.startPromptNumber).toBe(10);
    expect(window.endPromptNumber).toBe(30);
  });

  it("keeps the full closed range when it exceeds the old cap", () => {
    const window = resolveWindow({ kind: "closed", start: 10, end: 50 }, 120);

    expect(window.startPromptNumber).toBe(10);
    expect(window.endPromptNumber).toBe(50);
  });

  it("clips a closed range only at the session end", () => {
    const window = resolveWindow({ kind: "closed", start: 100, end: 150 }, 120);

    expect(window.startPromptNumber).toBe(100);
    expect(window.endPromptNumber).toBe(120);
  });

  it("keeps open-end ranges through the session end", () => {
    const window = resolveWindow({ kind: "openEnd", start: 30 }, 120);

    expect(window.startPromptNumber).toBe(30);
    expect(window.endPromptNumber).toBe(120);
  });

  it("ends open-start ranges at the requested turn", () => {
    const window = resolveWindow({ kind: "openStart", end: 20 }, 120);

    expect(window.startPromptNumber).toBe(1);
    expect(window.endPromptNumber).toBe(20);
  });

  it("keeps open-start ranges without truncation", () => {
    const window = resolveWindow({ kind: "openStart", end: 50 }, 120);

    expect(window.startPromptNumber).toBe(1);
    expect(window.endPromptNumber).toBe(50);
  });

  it("returns a zero-length window for empty sessions", () => {
    const window = resolveWindow({ kind: "none" }, 0);

    expect(window.startPromptNumber).toBe(1);
    expect(window.endPromptNumber).toBe(0);
  });

  it("rejects malformed programmatic range specs", () => {
    expect(() =>
      resolveWindow({ kind: "closed", start: 10, end: 5 }, 120),
    ).toThrow();
    expect(() => resolveWindow({ kind: "openStart", end: 0 }, 120)).toThrow();
    expect(() => resolveWindow({ kind: "openEnd", start: 0 }, 120)).toThrow();
  });
});

describe("cleanPromptForLabel", () => {
  it("returns empty string for null", () => {
    expect(cleanPromptForLabel(null)).toBe("");
  });

  it("passes through short Chinese prompts", () => {
    expect(cleanPromptForLabel("可以")).toBe("可以");
    expect(cleanPromptForLabel("方案 A 是什么")).toBe("方案 A 是什么");
  });

  it("takes the first non-empty line only", () => {
    expect(cleanPromptForLabel("line1\nline2\nline3")).toBe("line1");
    expect(cleanPromptForLabel("\n\n  first  \n\nsecond")).toBe("first");
  });

  it("extracts command-name wrappers", () => {
    const input = `<command-name>/plugin</command-name>
      <command-message>plugin</command-message>
      <command-args></command-args>`;

    expect(cleanPromptForLabel(input)).toBe("/plugin");
  });

  it("strips local-command wrapper blocks", () => {
    const input = `<local-command-caveat>Caveat: blah blah</local-command-caveat>`;

    expect(cleanPromptForLabel(input)).toBe("");
  });

  it("collapses internal whitespace runs", () => {
    expect(cleanPromptForLabel("foo    bar\t\tbaz")).toBe("foo bar baz");
  });

  it("preserves CJK and emoji", () => {
    expect(cleanPromptForLabel("🔵 测试 emoji")).toBe("🔵 测试 emoji");
  });
});

// These cases were written against timeline's own `truncateText`, which hard-cut
// at the limit. They now run against the one truncator every read surface uses,
// so the cases survive and the expectations follow the shared rule: the cuts
// below all land on whitespace or on an unbroken run, which is where the two
// implementations already agreed.
describe("truncateText", () => {
  it("returns shorter text unchanged", () => {
    expect(truncateText("hello", { limit: 10 })).toBe("hello");
  });

  it("truncates longer text and appends an ellipsis", () => {
    expect(truncateText("hello world", { limit: 5 })).toBe("hello…");
  });

  it("keeps exactly-max text unchanged", () => {
    expect(truncateText("hello", { limit: 5 })).toBe("hello");
  });

  it("handles an empty string", () => {
    expect(truncateText("", { limit: 10 })).toBe("");
  });

  it("retreats to a word boundary, as every other surface now does", () => {
    // The defect this replaced: timeline cut mid-word ("…the wrapp…") while
    // recall, rendering the same string, cut at the space before it.
    expect(truncateText("hello wonderful world", { limit: 17 })).toBe(
      "hello wonderful…",
    );
  });
});

describe("formatDuration", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("formats sub-hour durations as minutes and seconds", () => {
    expect(formatDuration(2 * 60 * 1000 + 16_000)).toBe("2m16s");
    expect(formatDuration(13 * 60 * 1000 + 45_000)).toBe("13m45s");
  });

  it("formats multi-hour durations as hours and minutes", () => {
    expect(formatDuration(60 * 60 * 1000 + 46 * 60 * 1000)).toBe("1h 46m");
    expect(formatDuration(3 * 60 * 60 * 1000 + 45 * 60 * 1000)).toBe("3h 45m");
  });
});

describe("formatGap", () => {
  it("returns (start) with no previous turn", () => {
    expect(formatGap(1000, null)).toBe("(start)");
  });

  it("prefixes formatted durations with plus", () => {
    expect(formatGap(120, 108)).toBe("+12s");
    expect(formatGap(1000, 864)).toBe("+2m16s");
  });
});

describe("formatLocalDate", () => {
  it("renders an epoch as YYYY-MM-DD", () => {
    const output = formatLocalDate(
      Math.floor(Date.parse("2026-04-11T01:50:47Z") / 1000),
    );

    expect(output).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("formatLocalTime", () => {
  it("renders an epoch as HH:MM in the local timezone", () => {
    const output = formatLocalTime(
      Math.floor(Date.parse("2026-04-11T01:50:47Z") / 1000),
    );

    expect(output).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("extractSourceTags", () => {
  it("returns only source tags without the prefix", () => {
    expect(
      extractSourceTags(["source:codex", "foo", "source:slack", "bar"]),
    ).toEqual(["codex", "slack"]);
  });
});

describe("getSystemTimezone", () => {
  it("returns a display name and offset label", () => {
    const timezone = getSystemTimezone();

    expect(timezone.name).toBeTruthy();
    expect(timezone.offsetLabel).toMatch(/^[+-]\d{2}:\d{2}$/);
  });

  it("uses the supplied reference epoch when resolving the timezone", () => {
    const referenceEpochSeconds = Math.floor(
      Date.parse("2026-07-01T12:00:00Z") / 1000,
    );
    const observedEpochs: number[] = [];

    const timezone = getSystemTimezone(referenceEpochSeconds, {
      timeZone: "America/New_York",
      resolveTimeZoneName: (epoch) => {
        observedEpochs.push(epoch);
        return epoch === referenceEpochSeconds ? "EDT" : "EST";
      },
      resolveOffsetMinutes: (epoch) => {
        observedEpochs.push(epoch);
        return epoch === referenceEpochSeconds ? -240 : -300;
      },
    });

    expect(timezone).toEqual({
      name: "EDT",
      offsetLabel: "-04:00",
    });
    expect(observedEpochs.every((epoch) => epoch === referenceEpochSeconds)).toBe(
      true,
    );
  });
});

describe("skipped turns", () => {
  it("excludes skipped turns from live aggregates", () => {
    const turns = [
      turn({ promptNumber: 1, type: "discovery", createdAtEpoch: 1000 }),
      turn({
        promptNumber: 2,
        status: "skipped",
        type: "decision",
        createdAtEpoch: 1100,
      }),
      turn({ promptNumber: 3, type: "discovery", createdAtEpoch: 1200 }),
    ];

    expect(computeTypesDistribution(turns)).toEqual({
      words: { discovery: 2 },
      none: 0,
    });

    expect(segmentPhases(turns)).toHaveLength(1);

    const signals = detectShapeSignals(turns);
    expect(signals.fastestGap).toEqual({
      afterPromptNumber: 1,
      ms: 200_000,
    });
    expect(signals.longestGap).toEqual({
      afterPromptNumber: 1,
      ms: 200_000,
    });
  });

  it("filters skipped turns out without a marker or summary", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);

    db.query(
      "UPDATE turns SET status = 'skipped' WHERE session_id = ? AND prompt_number = 19",
    ).run(session.id);

    const view = buildTimelineView(db, { id: "S1/T19..21" });
    const output = renderTimeline(view);

    expect(output).not.toContain("⏭");
    expect(output).not.toContain("T19 |");
  });
});

// Ticket 06 (view-render-repair, ruling [S15069/T1084]): rolled-back joins
// skipped as a full timeline exclusion — mirrors the "skipped turns" block
// above turn for turn, so the two conditions are proven under the SAME
// shape rather than only through the shared `isTimelineExcludedTurn` unit.
describe("rolled-back turns", () => {
  it("excludes rolled-back turns from live aggregates (gap computation unaffected by a neighbour's exclusion)", () => {
    const turns = [
      turn({ promptNumber: 1, type: "discovery", createdAtEpoch: 1000 }),
      turn({
        promptNumber: 2,
        wasRolledBack: true,
        type: "decision",
        createdAtEpoch: 1100,
      }),
      turn({ promptNumber: 3, type: "discovery", createdAtEpoch: 1200 }),
    ];

    expect(computeTypesDistribution(turns)).toEqual({
      words: { discovery: 2 },
      none: 0,
    });

    expect(segmentPhases(turns)).toHaveLength(1);

    // The gap either side of T2 collapses into ONE T1→T3 gap, exactly as if
    // T2 were never there — a rolled-back turn does not split or shorten a
    // neighbour's gap.
    const signals = detectShapeSignals(turns);
    expect(signals.fastestGap).toEqual({
      afterPromptNumber: 1,
      ms: 200_000,
    });
    expect(signals.longestGap).toEqual({
      afterPromptNumber: 1,
      ms: 200_000,
    });
  });

  it("filters rolled-back turns out without a marker or summary", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);

    db.query(
      "UPDATE turns SET was_rolled_back = 1 WHERE session_id = ? AND prompt_number = 19",
    ).run(session.id);

    const view = buildTimelineView(db, { id: "S1/T19..21" });
    const output = renderTimeline(view);

    expect(output).not.toContain("[rewind]");
    expect(output).not.toContain("T19 |");
    expect(output).not.toMatch(/\[T19\]/);
  });

  it("consumes no page budget: excluding a rolled-back OR skipped turn lets the same page fit more live turns", () => {
    const db = createDatabase(":memory:");
    seedTimelineSession(db, [
      turn({ promptNumber: 1, type: "decision", createdAtEpoch: 1_779_782_400 }),
      turn({ promptNumber: 2, type: "decision", wasRolledBack: true, createdAtEpoch: 1_779_782_460 }),
      turn({ promptNumber: 3, type: "decision", status: "skipped", createdAtEpoch: 1_779_782_520 }),
      turn({ promptNumber: 4, type: "decision", createdAtEpoch: 1_779_782_580 }),
      turn({ promptNumber: 5, type: "decision", createdAtEpoch: 1_779_782_640 }),
    ]);

    // pageSize 3 over 5 raw rows, but only 3 of them are live: both excluded
    // turns consume no seat, so the one page holds every live turn instead
    // of overflowing to a second page the way 5 raw rows normally would.
    const view = buildTimelineView(db, { id: "S1", view: "turns", page: 1, pageSize: 3 });

    expect(view.viewItemTotal).toBe(3);
    expect(view.pageCount).toBe(1);
    expect(view.pageTurns.map((row) => row.promptNumber)).toEqual([1, 4, 5]);
  });
});

describe("segmentPhases", () => {
  it("returns empty for no turns", () => {
    expect(segmentPhases([])).toEqual([]);
  });

  it("turns a single typed turn into one phase", () => {
    const phases = segmentPhases([
      turn({ promptNumber: 1, type: "discovery", createdAtEpoch: 1000 }),
    ]);

    expect(phases).toHaveLength(1);
    expect(phases[0].type).toEqual(["discovery"]);
  });

  // ticket 02 (spec B5): a turn may state more than one activity; the phase
  // renders it as more than one glyph rather than picking one to show.
  it("a multi-valued type renders as a multi-glyph phase, not a single pick", () => {
    const phases = segmentPhases([
      turn({ promptNumber: 1, type: ["review", "ops"], createdAtEpoch: 1000 }),
    ]);

    expect(phases).toHaveLength(1);
    expect(phases[0].type).toEqual(["review", "ops"]);
    expect(phases[0].emoji).toBe(`${TYPE_GLYPH.review}${TYPE_GLYPH.ops}`);
  });

  // ticket 02 (spec B5): grouping is over the ORDERED list as a whole — two
  // turns whose lists contain the same words in a different order are two
  // distinct statements, not one phase, matching `typeListsEqual`'s contract.
  it("two turns with the same words in a different order do not merge into one phase", () => {
    const phases = segmentPhases([
      turn({ promptNumber: 1, type: ["review", "ops"], createdAtEpoch: 1000 }),
      turn({ promptNumber: 2, type: ["ops", "review"], createdAtEpoch: 1100 }),
    ]);

    expect(phases).toHaveLength(2);
    expect(phases[0].type).toEqual(["review", "ops"]);
    expect(phases[1].type).toEqual(["ops", "review"]);
  });

  it("run-length encodes adjacent same-type runs", () => {
    const phases = segmentPhases([
      turn({ promptNumber: 1, type: "discovery", createdAtEpoch: 1000 }),
      turn({ promptNumber: 2, type: "discovery", createdAtEpoch: 1100 }),
      turn({ promptNumber: 3, type: "discovery", createdAtEpoch: 1200 }),
      turn({ promptNumber: 4, type: "decision", createdAtEpoch: 1300 }),
      turn({ promptNumber: 5, type: "discovery", createdAtEpoch: 1400 }),
    ]);

    expect(phases).toHaveLength(3);
    expect(phases[0]).toMatchObject({
      type: ["discovery"],
      startPromptNumber: 1,
      endPromptNumber: 3,
    });
    expect(phases[1]).toMatchObject({
      type: ["decision"],
      startPromptNumber: 4,
      endPromptNumber: 4,
    });
    expect(phases[2]).toMatchObject({
      type: ["discovery"],
      startPromptNumber: 5,
      endPromptNumber: 5,
    });
  });

  it("records startEpoch and endEpoch for each phase", () => {
    const phases = segmentPhases([
      turn({ promptNumber: 1, type: "discovery", createdAtEpoch: 1_000 }),
      turn({ promptNumber: 2, type: "discovery", createdAtEpoch: 1_100 }),
      turn({ promptNumber: 3, type: "decision", createdAtEpoch: 1_300 }),
    ]);

    expect(phases[0]).toMatchObject({
      startPromptNumber: 1,
      endPromptNumber: 2,
      startEpoch: 1_000,
      endEpoch: 1_100,
    });
    expect(phases[1]).toMatchObject({
      startPromptNumber: 3,
      endPromptNumber: 3,
      startEpoch: 1_300,
      endEpoch: 1_300,
    });
  });

  it("skips undone turns transparently", () => {
    const phases = segmentPhases([
      turn({ promptNumber: 1, type: "discovery", createdAtEpoch: 1000 }),
      turn({
        promptNumber: 2,
        type: "discovery",
        createdAtEpoch: 1100,
        status: "undone",
      }),
      turn({ promptNumber: 3, type: "discovery", createdAtEpoch: 1200 }),
    ]);

    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({
      type: ["discovery"],
      startPromptNumber: 1,
      endPromptNumber: 3,
      turnCount: 2,
    });
  });

  it("treats null types as a pending phase", () => {
    const phases = segmentPhases([
      turn({ promptNumber: 1, type: "discovery", createdAtEpoch: 1000 }),
      turn({ promptNumber: 2, type: null, createdAtEpoch: 1100 }),
      turn({ promptNumber: 3, type: null, createdAtEpoch: 1200 }),
    ]);

    expect(phases).toHaveLength(2);
    expect(phases[0].kind).toBe("typed");
    expect(phases[1]).toMatchObject({
      kind: "pending",
      type: [],
      turnCount: 2,
    });
  });

  it("aggregates stats and external inputs per phase", () => {
    const phases = segmentPhases([
      turn({
        promptNumber: 1,
        type: "discovery",
        toolCallCount: 9,
        filesRead: ["a", "b"],
        filesModified: ["c"],
        tags: ["source:codex"],
        createdAtEpoch: 1000,
      }),
      turn({
        promptNumber: 2,
        type: "discovery",
        toolCallCount: 3,
        filesRead: ["d"],
        filesModified: ["e", "f"],
        tags: ["source:slack", "source:codex"],
        createdAtEpoch: 1100,
      }),
    ]);

    expect(phases[0].totalToolCalls).toBe(12);
    expect(phases[0].totalFilesRead).toBe(3);
    expect(phases[0].totalFilesModified).toBe(3);
    expect(phases[0].durationMs).toBe(100_000);
    expect(phases[0].externalInputs).toEqual(["codex", "slack"]);
  });

  it("sorts unsorted input before segmenting phases", () => {
    const phases = segmentPhases([
      turn({ promptNumber: 3, type: "decision", createdAtEpoch: 1300 }),
      turn({ promptNumber: 1, type: "discovery", createdAtEpoch: 1000 }),
      turn({ promptNumber: 2, type: "discovery", createdAtEpoch: 1100 }),
      turn({ promptNumber: 4, type: null, createdAtEpoch: 1400 }),
    ]);

    expect(phases).toHaveLength(3);
    expect(phases[0]).toMatchObject({
      type: ["discovery"],
      startPromptNumber: 1,
      endPromptNumber: 2,
      durationMs: 100_000,
    });
    expect(phases[1]).toMatchObject({
      kind: "typed",
      type: ["decision"],
      startPromptNumber: 3,
      endPromptNumber: 3,
    });
    expect(phases[2]).toMatchObject({
      kind: "pending",
      type: [],
      startPromptNumber: 4,
      endPromptNumber: 4,
    });
  });
});

describe("computeTypesDistribution", () => {
  it("counts known types and pending turns", () => {
    const distribution = computeTypesDistribution([
      turn({ promptNumber: 1, type: "discovery" }),
      turn({ promptNumber: 2, type: "discovery" }),
      turn({ promptNumber: 3, type: "decision" }),
      turn({ promptNumber: 4, type: "change" }),
      turn({ promptNumber: 5, type: "compact" }),
      turn({ promptNumber: 6, type: null }),
      turn({ promptNumber: 7, type: null }),
    ]);

    expect(distribution).toEqual({
      words: { discovery: 2, decision: 1, change: 1, compact: 1 },
      none: 2,
    });
  });

  it("excludes undone turns from the counts", () => {
    const distribution = computeTypesDistribution([
      turn({ promptNumber: 1, type: "discovery" }),
      turn({ promptNumber: 2, type: "discovery", status: "undone" }),
    ]);

    expect(distribution.words.discovery).toBe(1);
  });

  // The regression ticket 02 introduced: the buckets were a closed LEGACY set
  // read off `type[0]`, so a session written entirely in the current
  // vocabulary counted toward nothing at all — not even the empty bucket,
  // since those turns DO state a word. The header line rendered zeros for
  // exactly the sessions it exists to describe.
  it("counts current-vocabulary words, which the closed legacy bucket set dropped entirely", () => {
    const distribution = computeTypesDistribution([
      turn({ promptNumber: 1, type: ["design"] }),
      turn({ promptNumber: 2, type: ["implement"] }),
      turn({ promptNumber: 3, type: ["implement"] }),
      turn({ promptNumber: 4, type: ["review"] }),
    ]);

    expect(distribution).toEqual({
      words: { design: 1, implement: 2, review: 1 },
      none: 0,
    });
  });

  it("counts a multi-valued turn once in EVERY word it states, not just the first", () => {
    const distribution = computeTypesDistribution([
      turn({ promptNumber: 1, type: ["refactor", "fix"] }),
      turn({ promptNumber: 2, type: ["fix"] }),
    ]);

    // Reading `type[0]` would report one refactor and one fix, making the
    // two-activity turn look like pure refactoring.
    expect(distribution.words).toEqual({ refactor: 1, fix: 2 });
    // The counts deliberately sum to more than the turn total.
    expect(distribution.words.refactor! + distribution.words.fix!).toBe(3);
  });
});

describe("renderTypesDistribution", () => {
  it("orders current vocabulary first, then legacy, and omits empty buckets", () => {
    expect(
      renderTypesDistribution({
        words: { discovery: 4, fix: 2, design: 1 },
        none: 0,
      }),
    ).toEqual(["⚖️1", "🔴2", "🔵4"]);
  });

  it("separates 'stated nothing' from 'stated something unrecognised'", () => {
    // Both would resolve to `•` through typeWordGlyph, and a counting line
    // cannot let two different facts share a glyph.
    expect(
      renderTypesDistribution({
        words: { fix: 1, "some-hand-written-word": 3 },
        none: 5,
      }),
    ).toEqual(["🔴1", "?3", "•5"]);
  });
});

describe("detectBrokenPromptPairs", () => {
  it("detects consecutive prompts with a long shared prefix and short gap", () => {
    const pairs = detectBrokenPromptPairs([
      turn({
        promptNumber: 1,
        userPrompt:
          "选 2,不过 -Users-zhaoqixuan-.claude-mnemo-agent-workdir 怎么这么长",
        createdAtEpoch: 1000,
      }),
      turn({
        promptNumber: 2,
        userPrompt:
          "选 2,不过 -Users-zhaoqixuan-.claude-mnemo-agent-workdir 怎么这么长,不是已经",
        createdAtEpoch: 1040,
      }),
    ]);

    expect(pairs).toEqual([{ first: 1, second: 2 }]);
  });

  it("rejects prompts with a short shared prefix", () => {
    const pairs = detectBrokenPromptPairs([
      turn({ promptNumber: 1, userPrompt: "foo bar baz", createdAtEpoch: 1000 }),
      turn({ promptNumber: 2, userPrompt: "qux quux", createdAtEpoch: 1040 }),
    ]);

    expect(pairs).toEqual([]);
  });

  it("rejects prompts with a gap of five minutes or more", () => {
    const pairs = detectBrokenPromptPairs([
      turn({ promptNumber: 1, userPrompt: "x".repeat(30), createdAtEpoch: 1000 }),
      turn({
        promptNumber: 2,
        userPrompt: "x".repeat(30),
        createdAtEpoch: 1000 + 5 * 60 + 1,
      }),
    ]);

    expect(pairs).toEqual([]);
  });

  it("skips undone turns while comparing consecutive live prompts", () => {
    const pairs = detectBrokenPromptPairs([
      turn({ promptNumber: 1, userPrompt: "x".repeat(30), createdAtEpoch: 1000 }),
      turn({
        promptNumber: 2,
        userPrompt: "x".repeat(30),
        createdAtEpoch: 1030,
        status: "undone",
      }),
      turn({
        promptNumber: 3,
        userPrompt: `${"x".repeat(30)} extra`,
        createdAtEpoch: 1060,
      }),
    ]);

    expect(pairs).toEqual([{ first: 1, second: 3 }]);
  });

  it("sorts unsorted input before comparing prompts", () => {
    const pairs = detectBrokenPromptPairs([
      turn({
        promptNumber: 3,
        userPrompt: `${"x".repeat(30)} third`,
        createdAtEpoch: 1200,
      }),
      turn({
        promptNumber: 1,
        userPrompt: `${"x".repeat(30)} first`,
        createdAtEpoch: 1000,
      }),
      turn({
        promptNumber: 2,
        userPrompt: `${"x".repeat(30)} second`,
        createdAtEpoch: 1100,
      }),
    ]);

    expect(pairs).toEqual([
      { first: 1, second: 2 },
      { first: 2, second: 3 },
    ]);
  });
});

describe("detectShapeSignals", () => {
  it("finds fastest and longest gaps while excluding undone turns from rankings", () => {
    const signals = detectShapeSignals([
      turn({ promptNumber: 1, createdAtEpoch: 1000 }),
      turn({ promptNumber: 2, createdAtEpoch: 1010 }),
      turn({ promptNumber: 3, createdAtEpoch: 1900 }),
      turn({ promptNumber: 4, createdAtEpoch: 1912 }),
      turn({ promptNumber: 5, createdAtEpoch: 3412, status: "undone" }),
      turn({ promptNumber: 6, createdAtEpoch: 3500 }),
    ]);

    expect(signals.fastestGap).toMatchObject({
      afterPromptNumber: 1,
      ms: 10_000,
    });
    expect(signals.longestGap).toMatchObject({
      afterPromptNumber: 4,
      ms: 1_588_000,
    });
  });

  it("measures gaps across live turns even when an undone turn sits between them", () => {
    const signals = detectShapeSignals([
      turn({ promptNumber: 1, createdAtEpoch: 1000 }),
      turn({
        promptNumber: 2,
        createdAtEpoch: 1300,
        status: "undone",
      }),
      turn({ promptNumber: 3, createdAtEpoch: 1600 }),
    ]);

    expect(signals.fastestGap).toMatchObject({
      afterPromptNumber: 1,
      ms: 600_000,
    });
    expect(signals.longestGap).toMatchObject({
      afterPromptNumber: 1,
      ms: 600_000,
    });
  });

  it("computes tool burst median, threshold, top N, broken pairs, undone turns, and external inputs", () => {
    const signals = detectShapeSignals([
      turn({
        promptNumber: 1,
        toolCallCount: 2,
        createdAtEpoch: 1000,
        userPrompt: "alpha prefix alpha prefix 111",
      }),
      turn({
        promptNumber: 2,
        toolCallCount: 3,
        createdAtEpoch: 1010,
        userPrompt: "alpha prefix alpha prefix 222",
        tags: ["source:codex"],
      }),
      turn({
        promptNumber: 3,
        toolCallCount: 2,
        createdAtEpoch: 1020,
      }),
      turn({
        promptNumber: 4,
        toolCallCount: 18,
        createdAtEpoch: 1030,
        tags: ["source:slack"],
      }),
      turn({
        promptNumber: 5,
        toolCallCount: 15,
        createdAtEpoch: 1040,
      }),
      turn({
        promptNumber: 6,
        toolCallCount: 3,
        createdAtEpoch: 1050,
        status: "undone",
      }),
      turn({
        promptNumber: 7,
        toolCallCount: 20,
        createdAtEpoch: 1060,
      }),
      turn({
        promptNumber: 8,
        toolCallCount: 22,
        createdAtEpoch: 1070,
      }),
    ]);

    expect(signals.toolBurstMedian).toBe(15);
    expect(signals.toolBurstThreshold).toBe(30);
    expect(signals.toolBursts).toEqual([]);
    expect(signals.brokenPromptPairs).toEqual([{ first: 1, second: 2 }]);
    expect(signals.undoneTurns).toEqual([6]);
    expect(signals.externalInputs).toEqual([
      { promptNumber: 2, source: "codex" },
      { promptNumber: 4, source: "slack" },
    ]);
  });

  it("limits tool bursts to the top N entries", () => {
    const signals = detectShapeSignals([
      turn({ promptNumber: 1, toolCallCount: 1 }),
      turn({ promptNumber: 2, toolCallCount: 1 }),
      turn({ promptNumber: 3, toolCallCount: 1 }),
      turn({ promptNumber: 4, toolCallCount: 2 }),
      turn({ promptNumber: 5, toolCallCount: 3 }),
      turn({ promptNumber: 6, toolCallCount: 20 }),
      turn({ promptNumber: 7, toolCallCount: 19 }),
      turn({ promptNumber: 8, toolCallCount: 18 }),
      turn({ promptNumber: 9, toolCallCount: 17 }),
    ]);

    expect(signals.toolBurstMedian).toBe(3);
    expect(signals.toolBurstThreshold).toBe(6);
    expect(signals.toolBursts).toEqual([
      { promptNumber: 6, toolCallCount: 20 },
      { promptNumber: 7, toolCallCount: 19 },
      { promptNumber: 8, toolCallCount: 18 },
    ]);
  });

  it("returns empty signals for empty input", () => {
    const signals = detectShapeSignals([]);

    expect(signals.fastestGap).toBeNull();
    expect(signals.longestGap).toBeNull();
    expect(signals.toolBursts).toEqual([]);
  });

  it("sorts unsorted input before deriving shape signals", () => {
    const signals = detectShapeSignals([
      turn({
        promptNumber: 3,
        createdAtEpoch: 1300,
        toolCallCount: 9,
        userPrompt: `${"x".repeat(30)} third`,
      }),
      turn({
        promptNumber: 1,
        createdAtEpoch: 1000,
        toolCallCount: 2,
        userPrompt: `${"x".repeat(30)} first`,
      }),
      turn({
        promptNumber: 2,
        createdAtEpoch: 1120,
        toolCallCount: 4,
        userPrompt: `${"x".repeat(30)} second`,
      }),
      turn({
        promptNumber: 4,
        createdAtEpoch: 1500,
        status: "undone",
      }),
    ]);

    expect(signals.fastestGap).toMatchObject({
      afterPromptNumber: 1,
      ms: 120_000,
    });
    expect(signals.longestGap).toMatchObject({
      afterPromptNumber: 2,
      ms: 180_000,
    });
    expect(signals.brokenPromptPairs).toEqual([
      { first: 1, second: 2 },
      { first: 2, second: 3 },
    ]);
    expect(signals.undoneTurns).toEqual([4]);
    expect(signals.externalInputs).toEqual([]);
  });
});

describe("milestoneMarker", () => {
  it("returns invalidated for undone or interrupted turns (precedence over all)", () => {
    expect(milestoneMarker(turn({ status: "undone", wasRolledBack: true }))).toBe("invalidated");
    expect(milestoneMarker(turn({ wasInterrupted: true }))).toBe("invalidated");
  });

  it("returns reversed for rolled-back-but-live turns", () => {
    expect(milestoneMarker(turn({ wasRolledBack: true, status: "extracted" }))).toBe("reversed");
  });

  it("returns reversed for the literal rolled-back role tag on any live type", () => {
    expect(milestoneMarker(turn({ type: "discovery", tags: ["rolled-back"] }))).toBe("reversed");
    expect(milestoneMarker(turn({ type: "feature", tags: ["rolled-back"] }))).toBe("reversed");
  });

  it("returns outcome only when not invalidated/reversed", () => {
    expect(milestoneMarker(turn({ type: "change", tags: ["merged"] }))).toBe("outcome");
    expect(milestoneMarker(turn({ wasRolledBack: true, tags: ["merged"] }))).toBe("reversed");
  });

  it("ignores topic tags and the invalidated: namespace", () => {
    expect(milestoneMarker(turn({ type: "decision", tags: ["rollback", "revert", "milestone"] }))).toBeNull();
    expect(milestoneMarker(turn({ tags: ["invalidated:notified:rollback"] }))).toBeNull();
  });

  it("reads reversal keyword tags only when enabled and only on decisions", () => {
    const decision = turn({ type: "decision", tags: ["design-pivot"] });
    const discovery = turn({ type: "discovery", tags: ["design-pivot"] });
    expect(milestoneMarker(decision)).toBeNull();
    expect(milestoneMarker(decision, { enableReversalKeyword: true })).toBe("reversed");
    expect(milestoneMarker(discovery, { enableReversalKeyword: true })).toBeNull();
  });

  it("returns outcome for the `release` tag stem", () => {
    expect(milestoneMarker(turn({ type: "feature", tags: ["release"] }))).toBe("outcome");
  });

  it("returns outcome for released/shipped tags (no regression)", () => {
    expect(milestoneMarker(turn({ type: "feature", tags: ["released"] }))).toBe("outcome");
    expect(milestoneMarker(turn({ type: "feature", tags: ["shipped"] }))).toBe("outcome");
  });

  it("returns outcome for a version-bump turn with no outcome tag (backstop)", () => {
    expect(
      milestoneMarker(
        turn({
          type: "feature",
          tags: ["push"],
          filesModified: ["package.json", "plugin/.claude-plugin/plugin.json"],
        }),
      ),
    ).toBe("outcome");
  });

  it("does NOT return outcome for bare push/merge verbs with no version files", () => {
    expect(milestoneMarker(turn({ type: "feature", tags: ["pushed"] }))).toBeNull();
    expect(milestoneMarker(turn({ type: "feature", tags: ["push"] }))).toBeNull();
    expect(milestoneMarker(turn({ type: "feature", tags: ["merge"] }))).toBeNull();
    expect(milestoneMarker(turn({ type: "feature", tags: ["ship"] }))).toBeNull();
  });
});

describe("isVersionBumpTurn", () => {
  it("is true when package.json + a plugin/marketplace manifest are modified", () => {
    expect(
      isVersionBumpTurn(["package.json", "plugin/.claude-plugin/plugin.json"]),
    ).toBe(true);
    expect(isVersionBumpTurn(["package.json", "marketplace.json"])).toBe(true);
  });

  it("matches on path suffix (relative or absolute stored paths)", () => {
    expect(
      isVersionBumpTurn([
        "/Users/me/proj/package.json",
        "/Users/me/proj/.claude-plugin/marketplace.json",
      ]),
    ).toBe(true);
  });

  it("is false without a package.json", () => {
    expect(isVersionBumpTurn(["plugin/.claude-plugin/plugin.json"])).toBe(false);
  });

  it("is false for package.json alone (no manifest)", () => {
    expect(isVersionBumpTurn(["package.json"])).toBe(false);
    expect(isVersionBumpTurn(["package.json", "src/mcp/timeline.ts"])).toBe(false);
  });

  it("is false for an empty file set", () => {
    expect(isVersionBumpTurn([])).toBe(false);
  });
});

describe("selectMilestoneTurns (lane election, milestone-election spec ticket 03)", () => {
  const BASE = 1_800_000_000;
  const laneEdge = (
    citingId: number,
    relation: string,
    citedId: number,
    tags: string[] = [],
    sides?: { tailTag: string; headTag: string },
  ): LaneEdgeInput => buildLaneEdge({ citingId, citedId, relation, tags, ...(sides ?? {}) });
  const w = (id: number, type: string, extra: TurnOverrides = {}): TurnRecord =>
    turn({ id, promptNumber: id, type, createdAtEpoch: BASE + id, ...extra });

  // lane-model-v12 ticket 04: an override VICTIM used to leave candidacy
  // entirely (the global-repudiation reading of an untagged override). That
  // arm is deleted, so the victim is an ordinary candidate here — this route
  // still delegates to `electMilestones`, and delegation is exactly why the
  // deletion shows up unchanged at this layer.
  it("delegates candidacy to electMilestones: an override VICTIM now stays in both `kept` and `ranked`", () => {
    const rows = [w(1, "design"), w(2, "design")];
    const laneEdges = [laneEdge(2, "override", 1)];
    const result = selectMilestoneTurns({ windowTurns: rows, laneEdges, budget: 5 });
    expect(result.kept.map((row) => row.turn.promptNumber).sort()).toEqual([1, 2]);
    expect(result.ranked.map((row) => row.turn.promptNumber).sort()).toEqual([1, 2]);
  });

  it("a rolled-back or skipped turn never reaches candidacy (ticket 06 exclusion, unchanged by the election rewrite)", () => {
    const rows = [
      w(1, "design", { wasRolledBack: true }),
      w(2, "design", { status: "skipped" }),
      w(3, "design"),
    ];
    const result = selectMilestoneTurns({ windowTurns: rows, laneEdges: [], budget: 5 });
    expect(result.kept.map((row) => row.turn.promptNumber)).toEqual([3]);
  });

  it("a compact marker holds no kept slot and never joins the election", () => {
    const rows = [w(1, "compact"), w(2, "design"), w(3, "compact")];
    const result = selectMilestoneTurns({ windowTurns: rows, laneEdges: [], budget: 5 });
    expect(result.kept.map((row) => row.turn.promptNumber)).toEqual([2]);
  });

  it("`budget` cuts the election's own rank to the top N, then re-sorts to TIME order for display (spec step 5) — never score order", () => {
    // Two untagged-indexes releases (tier 1): T5 has the higher in-degree via
    // a third turn's `grounds`, so it wins a budget-1 cut over T2 despite
    // being earlier — but with budget 2 BOTH are kept and DISPLAY still runs
    // chronological (T2 before T5), the opposite of election-rank order.
    const rows = [w(1, "design"), w(2, "design"), w(3, "design"), w(5, "design"), w(6, "design")];
    const laneEdges = [
      laneEdge(2, "indexes", 1),
      laneEdge(5, "indexes", 6),
      laneEdge(3, "grounds", 5),
    ];
    const budgetOne = selectMilestoneTurns({ windowTurns: rows, laneEdges, budget: 1 });
    expect(budgetOne.kept.map((row) => row.turn.promptNumber)).toEqual([5]);

    const budgetTwo = selectMilestoneTurns({ windowTurns: rows, laneEdges, budget: 2 });
    // Election rank has T5 (in-degree 1) ahead of T2 (in-degree 0), but the
    // DISPLAYED kept array is chronological: T2 before T5.
    expect(budgetTwo.kept.map((row) => row.turn.promptNumber)).toEqual([2, 5]);
  });

  it("edgeless window degrades to recent-N (tier ⑤, zero degree, the LATER-turn tiebreak alone) — the module's own emergent recency, no special case", () => {
    const rows = [w(1, "design"), w(2, "design"), w(3, "design"), w(4, "design")];
    const result = selectMilestoneTurns({ windowTurns: rows, laneEdges: [], budget: 2 });
    expect(result.kept.map((row) => row.turn.promptNumber)).toEqual([3, 4]);
    expect(result.kept.every((row) => row.tier === 5)).toBe(true);
  });

  it("↳ addresses list only cited turns that are THEMSELVES elected; an unelected cited turn is omitted entirely — never promoted to a row of its own (no pulled-antecedent resurrection)", () => {
    // T4 used to win its seat as a lane TERMINUS (tier 2). Tier ② seats nobody
    // since lane-state-retirement ticket 01, so the fixture gives T4 the seat
    // its own way: one extra UNSETTLED `indexes` makes it a tier-① release.
    // The property under test is untouched — an elected row citing an
    // UNELECTED turn must not resurrect it as a ↳ row of its own.
    const rows = [w(1, "design"), w(2, "design"), w(3, "design"), w(4, "design")];
    const laneEdges = [
      laneEdge(4, "extends", 1, ["x"]),
      laneEdge(4, "indexes", 1, ["x"]),
      laneEdge(4, "grounds", 2),
      laneEdge(4, "grounds", 3),
      laneEdge(4, "indexes", 3), // UNSETTLED both sides -> tier ① release
    ];
    // Ticket 10: lane {x}'s members are the TURNS that carry its tag, so the
    // fixture has to say so — the two tagged edges below no longer enrol
    // anyone by themselves, and without this map lane {x} does not exist and
    // T4 is not a terminus of anything.
    const result = selectMilestoneTurns({
      windowTurns: rows,
      laneEdges,
      laneTagsByTurnId: new Map([
        [1, ["x"]],
        [4, ["x"]],
      ]),
      budget: 3,
    });

    expect(result.kept.map((row) => row.turn.promptNumber)).toEqual([1, 3, 4]);
    const row4 = result.kept.find((row) => row.turn.promptNumber === 4)!;
    expect(row4.tier).toBe(1);
    // T2 cited by T4 (a `grounds` edge exists) but is NOT elected — omitted.
    // T4's own `extends`+`indexes` edges onto T1 (edge-read-surface spec,
    // ticket 01) both name T1, so the pair renders one address with both
    // words, alphabetical.
    expect(row4.antecedents).toEqual(["T1(extends,indexes)", "T3(grounds,indexes)"]);
    // T2 never appears anywhere in the selection, elected or otherwise.
    expect(result.kept.some((row) => row.turn.promptNumber === 2)).toBe(false);
    expect(
      result.overflowByDay.some((day) => day.firstPrompt <= 2 && day.lastPrompt >= 2),
    ).toBe(true);
  });

  it("the ↳ line's budget cost is attributed to the CITING row — no separate pulled-antecedent object exists to home", () => {
    // Two elected rows (T2, T3) both cite the same elected T1: each carries
    // its own `T1` address on its OWN `antecedents` array, not a shared
    // object one of them "hosts" for the other.
    const rows = [w(1, "design"), w(2, "design"), w(3, "design")];
    const laneEdges = [laneEdge(2, "grounds", 1), laneEdge(3, "grounds", 1)];
    const result = selectMilestoneTurns({ windowTurns: rows, laneEdges, budget: 3 });
    const row2 = result.kept.find((row) => row.turn.promptNumber === 2)!;
    const row3 = result.kept.find((row) => row.turn.promptNumber === 3)!;
    expect(row2.antecedents).toEqual(["T1(grounds)"]);
    expect(row3.antecedents).toEqual(["T1(grounds)"]);
  });
});

/**
 * The golden-nine end-to-end guard (milestone-election spec, ticket 03's own
 * acceptance criterion): the SAME S15069/T900-1001 fixture ticket 02's own
 * `tests/shared/milestone-election.test.ts` runs the pure `electMilestones`
 * core against, now loaded into a real DB and read back through BOTH surface
 * routes — `buildTimelineView` (S-view) and `buildSegmentTimelineView`
 * (E-view, the whole fixture as one segment's membership) — at budget 9. Both
 * routes must independently reproduce the identical golden nine
 * `tests/shared/milestone-election.test.ts` already pins, proving the
 * integration (DB adapter + selection wiring), not re-proving the algorithm
 * itself.
 */
describe("S-view and E-view integration — golden nine (milestone-election spec, ticket 03)", () => {
  // RE-BASELINED AGAIN BY lane-state-retirement TICKET 02, which gives tier ②
  // its replacement rule ("this node declares an `index`", any tag state,
  // decision 1) after ticket 01 left it seating nobody. Measured, not chosen:
  // it lands back on the SAME nine ids the fixture carried before ticket 01
  // ever ran (two tier-① releases plus seven tier-② seats) — every node that
  // used to win "closed lane terminus" on this fixture also writes an
  // `indexes` edge itself, so the node-level rule recovers the same set for a
  // different reason (`declares-index`, never `closed-terminus`). Ticket 01's
  // interim baseline, `[945, 946, 970, 972, 982, 989, 992, 998, 1001]`, is
  // superseded — `tests/shared/milestone-election.test.ts` carries the same
  // re-baseline, with the per-node accounting, at the pure-core seam.
  const GOLDEN_NINE = [922, 929, 939, 946, 981, 984, 990, 998, 1001];
  const FIXTURE_BASE = 1_800_000_000;

  interface GoldenFixture {
    turns: Array<{ id: number; type: string[]; tags: string[]; title: string }>;
    edges: Array<{ citingId: number; relation: string; citedId: number; tags: string[] }>;
  }

  function loadGoldenFixture(): GoldenFixture {
    return JSON.parse(
      readFileSync(
        join(process.cwd(), ".scratch/rubric-v10/fixtures/t900-1001-lane-sim.json"),
        "utf8",
      ),
    );
  }

  // Fixture ids double as prompt numbers (auto-increment DB ids start at 1,
  // not 900) — the graph's own STRUCTURE (order, tags, relations) is what
  // the election reads, never the raw id value, so this substitution cannot
  // change which turns win. `id` ascending already IS the fixture's own
  // chronological order (same convention ticket 02's own pure-module test
  // relies on via `LaneTurnInput`'s "no `order` field needed" default).
  function seedGoldenFixtureSession(db: Database): { sessionId: number } {
    const fixture = loadGoldenFixture();
    // MEMBERSHIP IS A NODE FACT (lane-model-v12 ticket 10): a turn carries the
    // lane tags ITS OWN SIDE of the fixture's edges names, one segment owns
    // every turn, and that segment declares those lanes. Derived from the
    // fixture's own edges rather than from its `turns[].tags` — the recorded
    // production tags are far richer than the hand-judged lane membership
    // (900 alone carries six words), so declaring all of them would enrol
    // turns in lanes the corpus never judged them into and move the golden
    // set for a reason that has nothing to do with the election.
    const laneTagsByTurn = new Map<number, Set<string>>();
    const claim = (turnId: number, tag: string): void => {
      if (tag === "") return;
      const bucket = laneTagsByTurn.get(turnId) ?? new Set<string>();
      bucket.add(tag);
      laneTagsByTurn.set(turnId, bucket);
    };
    for (const edge of fixture.edges) {
      const sides = deriveSideTags(edge.tags);
      claim(edge.citingId, sides.tailTag);
      claim(edge.citedId, sides.headTag);
    }
    const rows: TurnRecord[] = fixture.turns.map((fixtureTurn) =>
      turn({
        id: fixtureTurn.id,
        promptNumber: fixtureTurn.id,
        type: fixtureTurn.type,
        tags: [...(laneTagsByTurn.get(fixtureTurn.id) ?? [])],
        title: fixtureTurn.title,
        createdAtEpoch: FIXTURE_BASE + fixtureTurn.id,
      }),
    );
    const session = seedTimelineSession(db, rows);
    const laneSegmentId = createSegment(db, {
      title: "T900-1001 lane home",
      nowEpoch: FIXTURE_BASE,
    }).id;
    addSegmentMembers(
      db,
      laneSegmentId,
      fixture.turns.map((fixtureTurn) => turnDbId(db, session.id, fixtureTurn.id)),
      FIXTURE_BASE,
    );
    for (const tag of new Set([...laneTagsByTurn.values()].flatMap((tags) => [...tags]))) {
      insertLane(db, laneSegmentId, tag, FIXTURE_BASE);
    }
    for (const edge of fixture.edges) {
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn" as const, id: turnDbId(db, session.id, edge.citingId) },
            cited: { kind: "turn" as const, id: turnDbId(db, session.id, edge.citedId) },
            relation: edge.relation as CitationRelation,
            provenance: "judged" as const,
            ...deriveSideTags(edge.tags),
          },
        ],
        FIXTURE_BASE,
      );
    }
    return { sessionId: session.id };
  }

  it("S-view: timeline(id, view='milestones', pageSize=9) renders exactly the golden nine, in ascending time order", () => {
    const db = createDatabase(":memory:");
    const { sessionId } = seedGoldenFixtureSession(db);

    const view = buildTimelineView(db, { id: `S${sessionId}`, view: "milestones", pageSize: 9 });
    expect(view.pagedMilestones.map((row) => row.turn.promptNumber)).toEqual(GOLDEN_NINE);

    const rendered = renderTimeline(view);
    for (const promptNumber of GOLDEN_NINE) {
      expect(rendered).toContain(`[T${promptNumber}]`);
    }
  });

  it("E-view: the whole fixture as one segment's membership, budget (pageSize) 9, reproduces the same golden nine in event order", () => {
    const db = createDatabase(":memory:");
    const { sessionId } = seedGoldenFixtureSession(db);
    const fixture = loadGoldenFixture();
    const segment = createSegment(db, {
      title: "T900-1001 lane simulation",
      type: ["design"],
      nowEpoch: FIXTURE_BASE,
    });
    const memberIds = fixture.turns.map((fixtureTurn) => turnDbId(db, sessionId, fixtureTurn.id));
    addSegmentMembers(db, segment.id, memberIds, FIXTURE_BASE);

    const view = buildSegmentTimelineView(db, { segmentId: segment.id, view: "milestones", pageSize: 9 });
    expect(view.keptMilestones.map((row) => row.member.promptNumber)).toEqual(GOLDEN_NINE);
    expect(view.demotedCount).toBeGreaterThan(0);
  });
});

describe("buildTimelineView", () => {
  it("returns a view for a plain S id", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1" });

    expect(view.totalTurns).toBe(21);
    expect(view.totalToolCalls).toBe(68);
    expect(view.typesDistribution).toEqual({
      words: { discovery: 17, decision: 3 },
      none: 1,
    });
    expect(view.window.startPromptNumber).toBe(1);
    expect(view.window.endPromptNumber).toBe(21);
    expect(view.windowTurns).toHaveLength(21);
    expect(segmentPhases(view.windowTurns).length).toBeGreaterThan(1);
    expect(view.jsonlPath).toBe(
      resolveTranscriptPath("/tmp/claude-mnemo-test", "abc-uuid-timeline"),
    );
    expect(view.tz.name).toEqual(expect.any(String));
    expect(view.tz.name.length).toBeGreaterThan(0);
    expect(view.tz.offsetLabel).toMatch(/^[+-]\d{2}:\d{2}$/);
  });

  it("prefers the recorded transcript path over the cwd-derived one", () => {
    const db = createDatabase(":memory:");

    seedSession(db);
    // The session cd'ed after it started: `project` moved, the transcript did
    // not. Deriving from project would point at a file that does not exist.
    const recorded =
      "/Users/me/.claude/projects/-tmp-claude-mnemo-test/abc-uuid-timeline.jsonl";
    db.query<unknown, [string, string]>(
      "UPDATE sessions SET transcript_path = ?, project = ? WHERE id = 1",
    ).run(recorded, "/tmp/somewhere-else");

    expect(buildTimelineView(db, { id: "S1" }).jsonlPath).toBe(recorded);
  });

  it("falls back to deriving from project when no transcript path is recorded", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    expect(buildTimelineView(db, { id: "S1" }).jsonlPath).toBe(
      resolveTranscriptPath("/tmp/claude-mnemo-test", "abc-uuid-timeline"),
    );
  });

  it("respects closed range", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T5..10" });

    expect(view.window.startPromptNumber).toBe(5);
    expect(view.window.endPromptNumber).toBe(10);
    expect(view.windowTurns).toHaveLength(6);
    expect(view.windowSignals).toEqual({
      fastestGap: { afterPromptNumber: 5, ms: 100000 },
      longestGap: { afterPromptNumber: 5, ms: 100000 },
      toolBursts: [{ promptNumber: 5, toolCallCount: 15 }],
      toolBurstMedian: 2,
      toolBurstThreshold: 4,
      brokenPromptPairs: [],
      undoneTurns: [],
      externalInputs: [],
    });
  });

  it("paginates the turns view over non-skipped rows and anchors to the first visible page row", () => {
    const db = createDatabase(":memory:");
    seedTimelineSession(db, [
      turn({ promptNumber: 1, type: "decision", createdAtEpoch: 1_779_782_400 }),
      turn({ promptNumber: 2, type: "decision", createdAtEpoch: 1_779_782_460 }),
      turn({
        promptNumber: 3,
        type: "decision",
        status: "skipped",
        createdAtEpoch: 1_779_782_520,
      }),
      turn({ promptNumber: 4, type: "decision", createdAtEpoch: 1_779_782_580 }),
      turn({ promptNumber: 5, type: "decision", createdAtEpoch: 1_779_782_640 }),
    ]);

    const view = buildTimelineView(db, {
      id: "S1",
      view: "turns",
      page: 2,
      pageSize: 2,
    });

    expect(view.view).toBe("turns");
    expect(view.viewItemTotal).toBe(4);
    expect(view.pageCount).toBe(2);
    expect(view.pageAnchorEpoch).toBe(1_779_782_580);
    expect(view.pageTurns.map((row) => row.promptNumber)).toEqual([4, 5]);
  });

  it("bounds the milestones view over an election budget, not raw turns", () => {
    const db = createDatabase(":memory:");
    // Milestone-election spec, ticket 03: `pageSize` is now BOTH the
    // election's own budget and the pagination size, so `kept` can never
    // exceed it — there is no more "curated kept set wider than one page"
    // shape to paginate over. 10 raw turns, budget 3: only the THREE most
    // recent (no lane edges at all, so election rank is pure recency) win a
    // seat, always as exactly one page.
    seedTimelineSession(
      db,
      Array.from({ length: 10 }, (_, index) =>
        turn({
          promptNumber: index + 1,
          type: index % 3 === 0 ? "decision" : "discovery",
          title: `row ${index + 1}`,
          createdAtEpoch: 1_779_782_400 + index * 60,
        }),
      ),
    );

    const view = buildTimelineView(db, {
      id: "S1",
      view: "milestones",
      pageSize: 3,
    });

    expect(view.view).toBe("milestones");
    expect(view.viewItemTotal).toBe(3);
    expect(view.pageCount).toBe(1);
    expect(view.pagedMilestones.map((item) => item.turn.promptNumber)).toEqual([
      8, 9, 10,
    ]);
  });

  it("rejects unknown session ids", () => {
    const db = createDatabase(":memory:");

    initializeSchema(db);

    expect(() => buildTimelineView(db, { id: "S999" })).toThrow(/session/i);
  });

  it("includes the compact boundary when the session stores one", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);

    db.query("UPDATE sessions SET last_compact_turn = 15 WHERE id = ?").run(
      session.id,
    );

    const view = buildTimelineView(db, { id: "S1" });

    expect(view.compactBoundaries).toContain(15);
  });

  it("prefers compact turn rows over the session fallback for compact boundaries", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);

    db.query(
      `UPDATE turns
       SET type = '["compact"]',
           status = 'extracted',
           transcript_line_start = 210,
           tags = ?,
           tool_call_count = 0
       WHERE session_id = ? AND prompt_number = 21`,
    ).run(
      JSON.stringify(["compact:pre_tokens=357000", "compact:trigger=auto"]),
      session.id,
    );
    db.query("UPDATE sessions SET last_compact_turn = 15 WHERE id = ?").run(
      session.id,
    );

    const view = buildTimelineView(db, { id: "S1" });

    expect(view.compactBoundaries).toEqual([21]);
  });

  it("dedupes and sorts compact boundaries from compact turn rows", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);

    db.query(
      `UPDATE turns
       SET type = '["compact"]',
           status = 'extracted',
           tags = ?,
           tool_call_count = 0
       WHERE session_id = ? AND prompt_number IN (6, 15, 21)`,
    ).run(
      JSON.stringify(["compact:pre_tokens=357000", "compact:trigger=auto"]),
      session.id,
    );
    db.query("UPDATE sessions SET last_compact_turn = 15 WHERE id = ?").run(
      session.id,
    );

    const view = buildTimelineView(db, { id: "S1" });

    expect(view.compactBoundaries).toEqual([6, 15, 21]);
  });

  it("rejects ranges that start beyond the session end", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    expect(() => buildTimelineView(db, { id: "S1/T30..40" })).toThrow(
      /starts beyond session end/i,
    );
  });

  it("buildContextTimelineView returns the last page by row count", () => {
    const db = createDatabase(":memory:");
    const session = seedLongSession(db, 40);

    const view = buildContextTimelineView(db, session.id);

    expect(view.window.startPromptNumber).toBe(11);
    expect(view.window.endPromptNumber).toBe(40);
  });
});

describe("buildContextTimelineView milestone tail", () => {
  it("elects over the full session (not a raw trailing 30-turn window), bounded to the default election budget", () => {
    const db = createDatabase(":memory:");
    const session = seedLongSession(db, 40);

    const view = buildContextTimelineView(db, session.id, "milestones");
    const kept = view.pagedMilestones.map((m) => m.turn.promptNumber);

    // Milestone-election spec, ticket 03: endpoints are no longer an
    // unconditional always-keep anchor (visibility is now a budget outcome —
    // spec's own retirement note). With no lane edges at all, election rank
    // IS recency, so the default budget (30, clamped from `pageSize`) keeps
    // the 30 MOST RECENT turns of the full 40-turn session — proving
    // full-session election (T40 present) without a raw-window artifact
    // (T1..T10, outside a naive last-30 turn WINDOW, are correctly absent
    // from the ELECTION too, since they never outrank T11-T40 on recency).
    expect(kept).toContain(40);
    expect(kept).toHaveLength(30);
    expect(view.milestoneTail).toBe(true);
    // window stays full-session so shape signals read "= full session".
    expect(view.window.startPromptNumber).toBe(1);
    expect(view.window.endPromptNumber).toBe(40);
  });

  it("bounds `kept` to the election budget even in tail mode — there is no wider curated set left to hint an earlier page at", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    const rows = Array.from({ length: 40 }, (_, i) =>
      turn({
        promptNumber: i + 1,
        type: "decision",
        title: `m ${i + 1}`,
        createdAtEpoch: base + i * 60,
      }),
    );
    seedTimelineSession(db, rows);

    // Milestone-election spec, ticket 03: `pageSize` clamps the election
    // budget itself (see `buildTimelineView`'s own doc comment on the
    // clamp) — `kept` can never exceed it, so `milestoneTail`'s "trailing
    // slice of a WIDER kept set" behavior retires along with the grade
    // threshold that used to make `kept` wider than one page. The trailing
    // THREE most recent turns win the budget-3 election outright.
    const view = buildTimelineView(db, {
      id: "S1",
      view: "milestones",
      pageSize: 3,
      milestoneTail: true,
    });

    expect(view.pagedMilestones.map((m) => m.turn.promptNumber)).toEqual([38, 39, 40]);
    expect(view.viewItemTotal).toBe(3);
    expect(view.hasEarlier).toBe(false);
    expect(view.milestoneTail).toBe(true);
  });
});

describe("milestoneDayGroups (pagination)", () => {
  it("never splits a day across a page boundary any more (milestone-election spec, ticket 03: `kept` is capped at the election budget, so the milestones view is always exactly one page)", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    const rows = Array.from({ length: 40 }, (_, i) =>
      turn({
        promptNumber: i + 1,
        type: "decision",
        title: `m ${i + 1}`,
        createdAtEpoch: base + i * 60,
      }),
    );
    seedTimelineSession(db, rows);

    const page1 = buildTimelineView(db, { id: "S1", view: "milestones", page: 1, pageSize: 15 });
    const page2 = buildTimelineView(db, { id: "S1", view: "milestones", page: 2, pageSize: 15 });

    expect(page1.pageCount).toBe(1);
    expect(page1.milestoneDayGroups).toHaveLength(1);
    // A day group is always both the first AND final slice for its day now.
    const g1 = page1.milestoneDayGroups[0]!;
    expect(g1.continued).toBe(false);
    expect(g1.isFinalSliceForDay).toBe(true);
    // There is no page 2 to hold anything: `kept` (≤ 15) already fit on page 1.
    expect(page2.milestoneDayGroups).toHaveLength(0);
  });

  it("keeps a single-page day's overflow on its only (final) slice", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    // 10 turns, no lane edges: election rank is pure recency, and a
    // budget-6 cut keeps the six most recent — the other four fold into the
    // day's own overflow count.
    const rows = Array.from({ length: 10 }, (_, i) =>
      turn({
        promptNumber: i + 1,
        type: "decision",
        title: `m ${i + 1}`,
        createdAtEpoch: base + i * 60,
      }),
    );
    seedTimelineSession(db, rows);

    const view = buildTimelineView(db, { id: "S1", view: "milestones", page: 1, pageSize: 6 });

    expect(view.milestoneDayGroups).toHaveLength(1);
    const g = view.milestoneDayGroups[0]!;
    expect(g.keptCount).toBe(6);
    expect(view.pagedMilestones.map((row) => row.turn.promptNumber)).toEqual([5, 6, 7, 8, 9, 10]);
    // `promptLo`/`promptHi` span the KEPT rows on this day, not every raw
    // candidate — T1-T4 lost the budget cut, so the day's own frame starts
    // at its earliest SURVIVING row.
    expect(g.promptLo).toBe(5);
    expect(g.promptHi).toBe(10);
    expect(g.continued).toBe(false);
    expect(g.isFinalSliceForDay).toBe(true);
    expect(g.overflow).not.toBeNull();
    expect(g.overflow!.count).toBe(4);
  });
});

describe("renderTimeline", () => {
  it("omits the showing line when the candidate set fits on one page", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1" });
    const output = renderTimeline(view);

    expect(output).toMatch(/- \[S1\]/);
    expect(output).toMatch(/\| \d+ turns \| \d+ tool_calls/);
    expect(output).toMatch(/types: .+\(session-wide\)/);
    expect(output).not.toMatch(/showing:/);
    expect(output).not.toMatch(/\n\s+phases[:(]/);
    expect(output).toMatch(/tz: .+/);
    expect(output).toMatch(/raw: .+\.jsonl/);
  });

  it("renders turn table header with line anchors between T# and time", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T1..5" });
    const output = renderTimeline(view);

    expect(output).toMatch(TURN_VIEW_ROW_RE);
  });

  it("showing line reports page counts when the candidate set exceeds pageSize", () => {
    const db = createDatabase(":memory:");

    seedLongSession(db, 45);

    const view = buildTimelineView(db, { id: "S1", pageSize: 30 });
    const output = renderTimeline(view);

    expect(output).toMatch(/showing: turns .*page 1\s*\/\s*2.*45.*\d{4}-\d{2}-\d{2}/);
  });

  it("shows the second page of a paginated timeline", () => {
    const db = createDatabase(":memory:");
    seedLongSession(db, 45);

    const view = buildTimelineView(db, { id: "S1", page: 2, pageSize: 30 });
    const output = renderTimeline(view);

    expect(output).toMatch(/showing: turns .*page 2\s*\/\s*2.*45.*\d{4}-\d{2}-\d{2}/);
    expect(output).toContain("T31");
    expect(output).toContain("T45");
    expect(output).not.toContain("T30");
  });

  it("showing line uses page counts for non-1-based sessions", () => {
    const db = createDatabase(":memory:");
    const session = seedLongSession(db, 45);

    db.query(
      `UPDATE turns
       SET prompt_number = prompt_number + 135
       WHERE session_id = ?`,
    ).run(session.id);

    const view = buildTimelineView(db, { id: "S1", page: 2, pageSize: 30 });
    const output = renderTimeline(view);

    expect(view.lastPromptNumber).toBe(180);
    expect(output).toMatch(/showing: turns .*page 2\s*\/\s*2.*45.*\d{4}-\d{2}-\d{2}/);
  });

  it("keeps shape signals scoped to the full selected range instead of the current page", () => {
    const db = createDatabase(":memory:");
    seedLongSession(db, 60);

    const view = buildTimelineView(db, { id: "S1/T20..50", page: 2, pageSize: 10 });
    const output = renderTimeline(view);

    expect(output).toMatch(/showing: turns .*page 2\s*\/\s*4.*31.*\d{4}-\d{2}-\d{2}/);
    expect(output).toMatch(/shape signals \(window T20-T50\):/);
    expect(output).toContain("T30");
    expect(output).toContain("T39");
    expect(output).not.toContain("T29");
    expect(output).not.toContain("T40");
  });

  it("pending turns render ⏳ in the title column for S1/T19..21", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T19..21" });
    const output = renderTimeline(view);
    const turn21Line = turnBlock(output, 21);

    expect(turn21Line).toBeDefined();
    expect(turn21Line).toContain("⏳");
  });

  it("a titled turn renders its title even when it has no type", () => {
    // The shape every turn has between landing and its settlement review: a
    // title, no type. Gating the title on the type column hid these behind ⏳
    // for as long as nothing wrote types, and no test noticed — this is that
    // missing test.
    const db = createDatabase(":memory:");

    seedSession(db);
    db.query("UPDATE turns SET title = ? WHERE prompt_number = ?").run(
      "reviewed later",
      21,
    );

    const output = renderTimeline(buildTimelineView(db, { id: "S1/T19..21" }));
    const turn21Line = turnBlock(output, 21);

    // Ticket 05: the row is `[T21] <stamp> <glyph> title` — the type glyph is
    // part of every row now (spec's own title: "time, type, title"), so an
    // untyped turn's row still carries `⏳` as its GLYPH; what this test
    // guards is that the glyph no longer substitutes for a present title.
    expect(turn21Line).toContain("reviewed later");
    expect(turn21Line).toMatch(/⏳ reviewed later$/);
  });

  it("the turn table carries no transcript line anchor ([S15069/T1020])", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T1..1" });
    const output = renderTimeline(view);
    const turn1Line = turnBlock(output, 1);

    expect(turn1Line).toBeDefined();
    // The seeded turn's transcript_line_start is 10; no rendered coordinate.
    expect(turn1Line).not.toContain("L10");
    expect(output).not.toContain("| line |");
  });

  it("extracted turns render emoji plus title in the title column", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T1..1" });
    const output = renderTimeline(view);
    const turn1Line = turnBlock(output, 1);

    expect(turn1Line).toBeDefined();
    // Ticket 05: bare `[T1]` — the session's own transition line (`[S1]
    // title`) states the session once, above the row; a per-row
    // `[S<n>][T<n>]` prefix is a milestone-view-only device this ticket's
    // golden samples never show on the direct `S<n>` route.
    expect(turn1Line).toMatch(/^ {4}\[T1\] \d{2}-\d{2} \d{2}:\d{2} 🔵 title for T1$/);
  });

  it("renders titles longer than the legacy 37-char cap without truncation", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);
    // 58 chars: beyond the legacy 37-char effective cap, within the raised ~77.
    const longTitle = "Hardened spec across delivery paths and notify gates ahead";
    expect(longTitle.length).toBeGreaterThan(37);
    expect(longTitle.length).toBeLessThanOrEqual(77);
    db.query(
      "UPDATE turns SET title = ? WHERE session_id = ? AND prompt_number = 1",
    ).run(longTitle, session.id);

    const view = buildTimelineView(db, { id: "S1/T1..1" });
    const output = renderTimeline(view);
    const turn1Line = turnBlock(output, 1);

    expect(turn1Line).toBeDefined();
    expect(turn1Line).toContain(longTitle);
    expect(turn1Line).not.toContain("…");
  });

  it("undone turns render a marker and strikethrough title", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);

    db.query("UPDATE turns SET status = 'undone' WHERE session_id = ? AND prompt_number = 19").run(
      session.id,
    );

    const view = buildTimelineView(db, { id: "S1/T19..21" });
    const output = renderTimeline(view);
    const turn19Line = turnBlock(output, 19);

    expect(turn19Line).toBeDefined();
    expect(turn19Line).toContain("~~title for T19~~");
  });

  // Ticket 06 (view-render-repair, ruling [S15069/T1084]): with rewind and
  // skip retired, an unsettled turn — no note yet, never skipped — is the
  // fallback's ONLY remaining live case, so it must keep working. T21 in
  // `seedSession` already carries no type and no title (unsettled), status
  // `extracted` (not skipped), so it renders normally with its prompt as the
  // label instead of vanishing or showing `(untitled)`.
  it("an unsettled turn (no note yet, never skipped) still renders, label falling back to its prompt", () => {
    const db = createDatabase(":memory:");
    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T21..21" });
    const output = renderTimeline(view);
    const turn21Line = turnBlock(output, 21);

    expect(turn21Line).toBeDefined();
    expect(turn21Line).toContain("raw prompt 21");
    expect(view.pageTurns.map((row) => row.promptNumber)).toEqual([21]);
  });

  it("renders compact turns as structural rows with line anchors and parsed tags", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);

    db.query(
      `UPDATE turns
       SET type = '["compact"]',
           status = 'extracted',
           user_prompt = 'ignored raw summary wrapper',
           title = '/compact',
           transcript_line_start = 210,
           tags = ?,
           tool_call_count = 0
       WHERE session_id = ? AND prompt_number = 21`,
    ).run(
      JSON.stringify(["compact:pre_tokens=357000", "compact:trigger=auto"]),
      session.id,
    );

    const view = buildTimelineView(db, { id: "S1/T19..21" });
    const output = renderTimeline(view);
    const compactLine = turnBlock(output, 21);

    expect(compactLine).toBeDefined();
    expect(compactLine).toContain("/compact");
    expect(compactLine).toContain("⏸ /compact 357k tokens, auto");
    expect(compactLine).not.toContain("ignored raw summary wrapper");
  });

  it("renders shape signals as a window-scoped block", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T5..10" });
    const output = renderTimeline(view);

    expect(output).toMatch(/shape signals \(window T5-T10\):/);
    expect(output).toMatch(/fastest gap:/);
    expect(output).toMatch(/tool bursts:/);
  });

  it("dispatches default, turns, and milestones views to separate bodies", () => {
    const db = createDatabase(":memory:");
    seedTimelineSession(db, [
      turn({ promptNumber: 1, type: "discovery", title: "start", createdAtEpoch: 1_779_782_400 }),
      turn({ promptNumber: 2, type: "discovery", title: "routine note", createdAtEpoch: 1_779_782_460 }),
      turn({ promptNumber: 3, type: "decision", title: "choose path", createdAtEpoch: 1_779_782_520 }),
      turn({ promptNumber: 4, type: "discovery", title: "routine follow-up", createdAtEpoch: 1_779_782_580 }),
      turn({ promptNumber: 5, type: "discovery", title: "current state", createdAtEpoch: 1_779_782_640 }),
    ]);

    const turnPromptNumbers = (output: string) =>
      output
        .split("\n")
        .filter((line) => TURN_VIEW_ROW_RE.test(line))
        .map((line) => Number(line.match(/\[T(\d+)\]/)?.[1]));
    // Milestone rows are day-grouped `[T<n>] <date> <time> <emoji> <title>`
    // lines at the DEEP (8-space) indent; the turn view's own rows are told
    // apart by the shallow (4-space) indent `TURN_VIEW_ROW_RE` matches
    // (ticket 05: both views render the SAME row shape now, so indent depth
    // — not a metadata line — is what still tells them apart).
    const milestonePromptNumbers = (output: string) =>
      output
        .split("\n")
        .map((line) => line.match(/^ {8}(?:\S+ )?\[T(\d+)\] \d/)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number);

    const defaultOutput = renderTimeline(buildTimelineView(db, { id: "S1" }));
    const turnsOutput = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "turns" }),
    );
    // A smaller election budget (milestone-election spec, ticket 03: `pageSize`
    // bounds `kept`) than the 5-turn window, so the milestones body is
    // genuinely narrower than the turns body — with no lane edges at all,
    // every turn is tier ⑤ and election rank is pure recency, so the budget-3
    // cut keeps the THREE most recent turns.
    const milestoneOutput = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "milestones", pageSize: 3 }),
    );

    expect(defaultOutput).toMatch(TURN_VIEW_ROW_RE);
    expect(defaultOutput).toContain("shape signals");
    expect(defaultOutput).not.toMatch(/\n\s+phases[:(]/);
    expect(turnsOutput).toMatch(TURN_VIEW_ROW_RE);
    expect(turnsOutput).toContain("shape signals");
    expect(turnsOutput).not.toMatch(/\n\s+phases[:(]/);
    expect(turnPromptNumbers(turnsOutput)).toEqual([1, 2, 3, 4, 5]);
    expect(milestonePromptNumbers(milestoneOutput)).toEqual([3, 4, 5]);
    expect(milestoneOutput).not.toMatch(TURN_VIEW_ROW_RE);
    expect(milestoneOutput).toContain("shape signals");
    expect(milestoneOutput).not.toMatch(/\n\s+phases[:(]/);
  });

  it("renders cross-day header dates and day dividers for turns and milestones", () => {
    const db = createDatabase(":memory:");
    seedTimelineSession(
      db,
      [
        turn({
          promptNumber: 1,
          type: "decision",
          title: "first day",
          createdAtEpoch: 1_779_781_860,
        }),
        turn({
          promptNumber: 2,
          type: "decision",
          title: "next day",
          createdAtEpoch: 1_779_843_600,
        }),
        turn({
          promptNumber: 3,
          type: "decision",
          title: "after idle day",
          createdAtEpoch: 1_780_016_400,
        }),
      ],
      {
        createdAtEpoch: 1_779_781_860,
        updatedAtEpoch: 1_780_739_280,
      },
    );

    const turnsOutput = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "turns" }),
    );
    const milestoneOutput = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "milestones" }),
    );

    expect(turnsOutput).toContain(
      `${formatLocalDate(1_779_781_860)} ${formatLocalTime(1_779_781_860)} → ${formatLocalDate(1_780_739_280)} ${formatLocalTime(1_780_739_280)}`,
    );
    expect(turnsOutput).toContain("2026-05-27 Wed");
    expect(turnsOutput).toContain("2026-05-29 Fri");
    expect(turnsOutput).not.toContain("2026-05-28");
    expect(milestoneOutput).toContain("2026-05-27 Wed");
    expect(milestoneOutput).toContain("2026-05-29 Fri");
  });

  it("adds the view label and page anchor date to showing only on multipage views", () => {
    const db = createDatabase(":memory:");
    seedTimelineSession(db, [
      turn({ promptNumber: 1, type: "decision", createdAtEpoch: 1_779_781_860 }),
      turn({ promptNumber: 2, type: "decision", createdAtEpoch: 1_779_843_600 }),
      turn({ promptNumber: 3, type: "decision", createdAtEpoch: 1_780_016_400 }),
    ]);

    const multipageOutput = renderTimeline(
      buildTimelineView(db, {
        id: "S1",
        view: "turns",
        page: 2,
        pageSize: 1,
      }),
    );
    const singlePageOutput = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "turns", pageSize: 10 }),
    );

    expect(multipageOutput).toMatch(
      /showing: turns .*page 2\s*\/\s*3.*3.*2026-05-27 Wed/,
    );
    expect(singlePageOutput).not.toContain("showing:");
  });

  // `RenderTimelineOptions.promptCap` retired with ticket 05: the turn row no
  // longer carries an independent prompt excerpt (only a title, or the
  // prompt as a FALLBACK when there is no title), so there is nothing left
  // for a separate prompt-column cap to bound — `titleCap` governs the row's
  // whole label now, and its own truncation is covered by "cuts a
  // turn-table title on a word boundary" below.

  it("renders a compact pipe-delimited header without the separator row", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T19..21" });
    const output = renderTimeline(view);

    expect(output).toMatch(TURN_VIEW_ROW_RE);
    expect(output).not.toContain("───");
  });

  it("sanitizes prompt delimiters inside the merged prompt-title field", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);

    db.query(
      "UPDATE turns SET user_prompt = ? WHERE session_id = ? AND prompt_number = 21",
    ).run("rg foo | sed\nrest ignored", session.id);

    const view = buildTimelineView(db, { id: "S1/T21..21" });
    const output = renderTimeline(view);
    const line = turnBlock(output, 21);

    expect(line).toBeDefined();
    expect(line).toContain("rg foo / sed");
    expect(line).not.toContain("rg foo | sed");
  });

  it("sanitizes title delimiters inside the merged prompt-title field", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);

    db.query(
      "UPDATE turns SET type = '[\"discovery\"]', title = ? WHERE session_id = ? AND prompt_number = 21",
    ).run("left → right", session.id);

    const view = buildTimelineView(db, { id: "S1/T21..21" });
    const output = renderTimeline(view);
    const line = turnBlock(output, 21);

    expect(line).toBeDefined();
    // Ticket 05: bare `[T21]` (no `[S1]` prefix — see the golden-sample
    // test), title sanitized. AC#4: a titled turn's row never carries the
    // raw prompt at all any more (no `- prompt:` field, no fallback — the
    // fallback only fires when there is NO title).
    expect(line).toMatch(/\[T21\] \d{2}-\d{2} \d{2}:\d{2} 🔵 left -> right$/);
    expect(line).not.toContain("- prompt:");
    expect(line).not.toContain("raw prompt 21");
    expect(line).not.toContain("left → right");
  });

  it("keeps skipped turns in gap tracking without a trailing summary", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);

    db.query(
      "UPDATE turns SET status = 'skipped' WHERE session_id = ? AND prompt_number = 20",
    ).run(session.id);
    db.query(
      `UPDATE turns
       SET created_at_epoch = CASE prompt_number
         WHEN 19 THEN 1700000000
         WHEN 20 THEN 1700000010
         WHEN 21 THEN 1700000060
         ELSE created_at_epoch
       END
       WHERE session_id = ? AND prompt_number IN (19, 20, 21)`,
    ).run(session.id);

    const view = buildTimelineView(db, { id: "S1/T19..21" });
    const output = renderTimeline(view);
    const turn21Line = turnBlock(output, 21);

    // Ticket 05: the gap/stats `metadata` line is gone (composeTurnMetadata
    // is recall's field now, not timeline's row) — what this test still
    // guards is that a skipped turn is invisible on the turns view (no row,
    // no placeholder marker) while its live neighbours render normally.
    expect(view.viewItemTotal).toBe(2);
    expect(view.pageTurns.map((row) => row.promptNumber)).toEqual([19, 21]);
    expect(turn21Line).toBeDefined();
    expect(output).not.toContain("⏭");
    expect(output).not.toContain("T20 |");
    expect(output).not.toMatch(/\[T20\]/);
  });

  it("renderTimeline shows earlier hint when rendering the last page", () => {
    const db = createDatabase(":memory:");
    const session = seedLongSession(db, 40);

    const view = buildContextTimelineView(db, session.id);
    const output = renderTimeline(view, { showEarlierHint: true });

    expect(output).toContain('earlier: timeline(id="S1/T1..10") or recall(id="S1")');
    expect(output).not.toMatch(/\n\s+phases[:(]/);
    expect(output).toMatch(/\n  earlier: timeline\(id="S1\/T1\.\.10"\) or recall\(id="S1"\)/);
  });

  it("view=milestones renders the milestone digest without phases or the full table", () => {
    const db = createDatabase(":memory:");
    seedSession(db);
    // Milestone-election spec, ticket 03: T6 an untagged-`indexes` writer
    // (tier ①, a guaranteed seat regardless of the budget cut) plus a small
    // election budget — the same shape the old grade-driven fixture wanted
    // (T6 kept, the bulk of the 21-turn window excluded), reproduced through
    // the election instead of a stored grade.
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: turnDbId(db, 1, 6) },
          cited: { kind: "turn", id: turnDbId(db, 1, 1) },
          relation: "indexes",
          provenance: "judged",
        },
      ],
      1_700_000_000,
    );

    // Ticket 05: both views render the SAME row shape now (address, inline
    // stamp, glyph, title) — the turn view's own rows sit at the SHALLOW
    // (4-space) indent (`TURN_VIEW_ROW_RE`, no `[E<n>]`/spine ancestor on the
    // direct `S<n>` route), while the legacy (no era cutoff) milestone body
    // stays at the deep (8-space) indent — so indent depth still tells the
    // two views' rows apart.
    const turnRowCount = (s: string) =>
      s.split("\n").filter((l) => TURN_VIEW_ROW_RE.test(l)).length;
    const milestoneRowCount = (s: string) =>
      s.split("\n").filter((l) => /^ {8}(?:\S+ )?\[T\d+\] \d/.test(l)).length;

    const full = renderTimeline(buildTimelineView(db, { id: "S1", view: "turns" }));
    const milestone = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "milestones", pageSize: 5 }),
    );

    expect(milestoneRowCount(milestone)).toBeLessThan(turnRowCount(full));
    expect(milestone).not.toMatch(TURN_VIEW_ROW_RE);
    // T6 is kept (its tier-① seat is guaranteed regardless of the cut); T2
    // and T11 lose the budget-5 cut to the more recent turns.
    expect(milestone).toMatch(/^ {8}(?:\S+ )?\[T6\] /m);
    expect(milestone).not.toMatch(/^ {8}(?:\S+ )?\[T11\] /m);
    expect(milestone).not.toMatch(/^ {8}(?:\S+ )?\[T2\] /m);
    expect(milestone).not.toMatch(/\n\s+phases[:(]/);
  });

});

// bounded-read-surfaces ticket 01. `timeline(id="S<n>", view="milestones")`'s
// era SEGMENT SPINE (`view.segmentSpine`/`view.orphanAnchors`,
// `listSegmentSpineForSession`/`listOrphanAnchorTurns`, db/segment-rank.ts)
// carries a session's WHOLE era history with no count cap of its own.
// `shedSpineToBudget` already existed to bound it, but only ever ran behind
// the internal-only SessionStart `tokenBudget` knob — no MCP `timeline()`
// caller ever sets it, so every real call took the "renders in full" branch.
// `lane_check`'s own trap (`6e668da`): the upper-bound assertion and the
// shedding assertion must be INDEPENDENT — a fixture small enough that the
// default call already shows everything makes both green even with the fix
// entirely dead. `LARGE_SPINE_SEGMENT_COUNT` (200, `seedLargeEraSpine`) is
// sized so the default page budget genuinely forces shedding.
describe("S<n> era spine size bound (bounded-read-surfaces ticket 01)", () => {
  const BASE = 1_720_000_000;

  function seedSpineSession(db: Database): { sessionId: number } {
    initializeSchema(db);
    const session = upsertSession(db, {
      contentSessionId: "spine-bulk-session",
      project: "/tmp/spine-bulk",
      title: "spine bulk session",
      content: null,
      insight: null,
      createdAtEpoch: BASE,
      updatedAtEpoch: BASE,
      completedAtEpoch: null,
    });
    seedLargeEraSpine(db, session.id, BASE);
    return { sessionId: session.id };
  }

  function countSpineRows(text: string): number {
    return (text.match(/\[E\d+\] .*bulk segment/g) ?? []).length;
  }

  it("SHEDDING is alive: the default call folds SOME segments while a larger pageBudget shows more — no segment line is ever cut mid-row", () => {
    const db = createDatabase(":memory:");
    const { sessionId } = seedSpineSession(db);

    const defaultOutput = timelineQuery(db, {
      id: `S${sessionId}`,
      view: "milestones",
      eraCutoffEpoch: BASE - 1,
    });
    const wideOutput = timelineQuery(db, {
      id: `S${sessionId}`,
      view: "milestones",
      eraCutoffEpoch: BASE - 1,
      pageBudget: 1_000_000,
    });

    // Real shedding, not a coincidence of small content: strictly fewer
    // segment rows than the wide call, and a fold line saying so.
    expect(defaultOutput).toMatch(/… \+\d+ earlier segments?/);
    const defaultCount = countSpineRows(defaultOutput);
    const wideCount = countSpineRows(wideOutput);
    expect(defaultCount).toBeGreaterThan(0);
    expect(defaultCount).toBeLessThan(wideCount);
    expect(wideCount).toBe(LARGE_SPINE_SEGMENT_COUNT);
  });

  it("the UPPER BOUND holds independently: the default call's byte count stays under the worker tool-result cap", () => {
    const db = createDatabase(":memory:");
    const { sessionId } = seedSpineSession(db);

    const output = timelineQuery(db, {
      id: `S${sessionId}`,
      view: "milestones",
      eraCutoffEpoch: BASE - 1,
    });
    expect(output.length).toBeLessThan(WORKER_TOOL_RESULT_MAX_CHARS);
  });

  it("a session with no era cutoff is unaffected — the spine stays empty, same as before this ticket", () => {
    const db = createDatabase(":memory:");
    seedSession(db);

    const view = buildTimelineView(db, { id: "S1", view: "milestones" });
    const output = renderTimeline(view);
    expect(output).not.toMatch(/segment spine/);
  });
});

describe("renderMilestoneDigest layout", () => {
  it("renders day-grouped spine rows with front-gutter markers, no turn-table columns", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    // T2's "reversed" marker comes from the ROLE TAG here, not the DB rewind
    // column (ticket 06, ruling [S15069/T1084], keeps these two separate: a
    // `was_rolled_back` turn is excluded entirely — see the dedicated test
    // below — while a tag-marked reversal is a normal, visible, always-keep
    // row, unaffected by this ticket).
    const rows = [
      turn({ promptNumber: 1, type: "decision", title: "kick off the design", userPrompt: "PROMPTTEXT", createdAtEpoch: base }),
      turn({ promptNumber: 2, type: "decision", title: "pivot the approach", tags: ["rolled-back"], createdAtEpoch: base + 60 }),
      turn({ promptNumber: 3, type: "feature", title: "shipped it", tags: ["merged"], filesModified: ["a.ts"], createdAtEpoch: base + 120 }),
    ];
    seedTimelineSession(db, rows);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));

    // The spine row now carries the user's own words (spec §D): the reader sees
    // the turn-of-phrase that opened the turn, not just the extractor's title.
    expect(out).toContain('kick off the design · "PROMPTTEXT"');
    expect(out).not.toContain("T# | line | time | gap"); // not the turn table
    expect(out).toContain("↩️ [T2]"); // reversed marker in front gutter
    expect(out).toContain("🏁 [T3]"); // outcome marker in front gutter
    expect(out).toContain("✏️a.ts"); // modified-file basenames ride the row
    expect(out).toMatch(/── \d{4}-\d{2}-\d{2} \w{3} · T1–T3 · \d+ kept/); // day header (full date, matches day-divider style)
  });

  it("a rolled-back turn (turns.was_rolled_back) never gets a row here, marked or not (ticket 06, ruling [S15069/T1084])", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    const rows = [
      turn({ promptNumber: 1, type: "decision", title: "kick off the design", createdAtEpoch: base }),
      turn({ promptNumber: 2, type: "decision", title: "pivot the approach", wasRolledBack: true, createdAtEpoch: base + 60 }),
      turn({ promptNumber: 3, type: "feature", title: "shipped it", tags: ["merged"], filesModified: ["a.ts"], createdAtEpoch: base + 120 }),
    ];
    seedTimelineSession(db, rows);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));

    // Not greyed, not marked — absent. No `[T2]` row of any kind, and the
    // day's kept count reflects only the two turns that still exist for
    // the timeline.
    expect(out).not.toContain("[T2]");
    expect(out).not.toContain("pivot the approach");
    expect(out).not.toContain("↩️");
    expect(out).toMatch(/── \d{4}-\d{2}-\d{2} \w{3} · T1–T3 · 2 kept/);
  });
});

describe("golden sample (ticket 05, .scratch/view-render-repair/05-timeline-one-row-form.md)", () => {
  // The ticket's own verbatim fixture is `timeline(id="S15069/T1...")`:
  //
  //   [S15069] title
  //       [T821] 08-17 18:19 ⚖️ title
  //           ↳ T811, T812
  //       [T822] 08-17 18:20 ⚖️ title
  //
  // The specific session/prompt numbers (S15069, T821/T822/T811/T812) are the
  // ticket author's own illustrative session — unreproducible here (ids are
  // DB auto-increment) — so this fixture reconstructs the SAME shape (a
  // titled session, two same-day decision turns, the first citing two
  // earlier turns as antecedents) and asserts the rendered block byte-for-
  // byte against a literal expected string, which is the strongest form of
  // "byte fixture" available without forcing specific row ids.
  it("S<n> direct route: [S<n>] title / [T<n>] stamp glyph title / ↳ addresses, zero-indented at the top", () => {
    const db = createDatabase(":memory:");
    const t811Epoch = Math.floor(Date.UTC(2026, 7, 16, 9, 0) / 1000);
    const t812Epoch = Math.floor(Date.UTC(2026, 7, 16, 9, 5) / 1000);
    const t821Epoch = Math.floor(Date.UTC(2026, 7, 17, 18, 19) / 1000);
    const t822Epoch = Math.floor(Date.UTC(2026, 7, 17, 18, 20) / 1000);
    const session = seedTimelineSession(
      db,
      [
        turn({ promptNumber: 811, type: "decision", title: "title", createdAtEpoch: t811Epoch }),
        turn({ promptNumber: 812, type: "decision", title: "title", createdAtEpoch: t812Epoch }),
        turn({ promptNumber: 821, type: "decision", title: "title", createdAtEpoch: t821Epoch }),
        turn({ promptNumber: 822, type: "decision", title: "title", createdAtEpoch: t822Epoch }),
      ],
      { title: "title" },
    );
    const t821Id = getTurn(db, session.id, 821)!.id;
    const t811Id = getTurn(db, session.id, 811)!.id;
    const t812Id = getTurn(db, session.id, 812)!.id;
    writeMemoryEdges(
      db,
      [
        { citing: { kind: "turn", id: t821Id }, cited: { kind: "turn", id: t811Id }, relation: "consume", provenance: "judged" },
        { citing: { kind: "turn", id: t821Id }, cited: { kind: "turn", id: t812Id }, relation: "consume", provenance: "judged" },
      ],
      t821Epoch,
    );

    const output = renderTimeline(buildTimelineView(db, { id: `S${session.id}/T821..822` }));

    expect(output).toContain(
      [
        `[S${session.id}] title`,
        "    [T821] 08-17 18:19 ⚖️ title",
        "        ↳ T811(consume), T812(consume)",
        "    [T822] 08-17 18:20 ⚖️ title",
      ].join("\n"),
    );
  });
});

/**
 * Relation-matrix spec, "自引用" (ticket 05): a self edge is now a legal
 * storable fact, and the ticket's own render-safety requirement is that a
 * turn carrying one renders without error or loop — it may show itself on
 * the antecedent line, but it must not recurse.
 */
describe("a self edge can no longer reach this renderer at all (v12 D2)", () => {
  it("the write is refused at storage, so the turn renders with no self ↳ line to loop on", () => {
    const db = createDatabase(":memory:");
    const epoch = Math.floor(Date.UTC(2026, 7, 18, 9, 0) / 1000);
    const session = seedTimelineSession(
      db,
      [
        turn({
          promptNumber: 1,
          // Multi-phase (research=evidence, review=delivery): legal to self-encodes.
          type: ["research", "review"],
          title: "self-encoding turn",
          createdAtEpoch: epoch,
        }),
      ],
      { title: "title" },
    );
    const turnId = getTurn(db, session.id, 1)!.id;
    const written = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "turn", id: turnId },
          relation: "grounds",
          provenance: "asserted",
        },
      ],
      epoch,
    );
    // The render-safety question is now moot at its source: the row cannot be
    // stored, so `resolveTurnRowLinks` — a direct `memory_edges` reader with
    // no self-exclusion of its own, which is what made ticket 05's loop
    // question real — has nothing to resolve.
    expect(written.rejected.map((entry) => entry.reason)).toEqual(["self-loop"]);

    let output = "";
    expect(() => {
      output = renderTimeline(buildTimelineView(db, { id: `S${session.id}/T1..` }));
    }).not.toThrow();
    expect(output).not.toContain("↳ T1");
  });
});

/**
 * Ticket 10 (edge-mechanism-revision, peer 终审必改 4). D2 gave one pair one
 * row PER RELATION, and the `↳` aggregation pushed a row at a time, so a citer
 * that declared two relations about the same antecedent rendered its address
 * twice — and spent two of the cap's four slots on one turn. The `↳` line is a
 * pure address index ("箭头标记是纯地址索引"), so the fix is de-duplication at
 * the aggregation, with the relation detail still feeding the ⚑ test.
 */
describe("↳ antecedents de-duplicate by (citing, cited) pair", () => {
  const dayEpoch = (minute: number): number =>
    Math.floor(Date.UTC(2026, 7, 17, 9, minute) / 1000);

  const seedCiter = (
    db: ReturnType<typeof createDatabase>,
    antecedentCount: number,
  ): { sessionId: number; citerId: number; antecedentIds: number[] } => {
    const rows = [
      ...Array.from({ length: antecedentCount }, (_unused, index) =>
        turn({
          promptNumber: 801 + index,
          type: "decision",
          title: "antecedent",
          createdAtEpoch: dayEpoch(index),
        }),
      ),
      turn({
        promptNumber: 821,
        type: "decision",
        title: "the landing",
        createdAtEpoch: dayEpoch(30),
      }),
    ];
    const session = seedTimelineSession(db, rows, { title: "title" });
    return {
      sessionId: session.id,
      citerId: getTurn(db, session.id, 821)!.id,
      antecedentIds: Array.from(
        { length: antecedentCount },
        (_unused, index) => getTurn(db, session.id, 801 + index)!.id,
      ),
    };
  };

  it("renders a doubly-classified antecedent once, and still names both its relations", () => {
    const db = createDatabase(":memory:");
    const { sessionId, citerId, antecedentIds } = seedCiter(db, 1);
    writeMemoryEdges(
      db,
      [
        { citing: { kind: "turn", id: citerId }, cited: { kind: "turn", id: antecedentIds[0]! }, relation: "consume", provenance: "asserted" },
        { citing: { kind: "turn", id: citerId }, cited: { kind: "turn", id: antecedentIds[0]! }, relation: "override", provenance: "judged" },
      ],
      dayEpoch(30),
    );

    const output = renderTimeline(
      buildTimelineView(db, { id: `S${sessionId}/T821..821` }),
    );

    // One address, one occurrence — not `↳ T801, T801`.
    expect(output).toContain("↳ T801");
    expect(output).not.toContain("↳ T801, T801");
    expect(
      output.split("\n").filter((line) => line.trim().startsWith("↳")),
    ).toHaveLength(1);
    // The relation detail the aggregation de-duplicated is NOT lost: the
    // collapsed pair still names both words on its one line. (This used to be
    // asserted through the `⚑` corrector flag instead — that flag read the
    // `supersedes` word and went with it, lane-model-v12 ticket 03.)
    expect(output).toContain("↳ T801(consume,override)");
  });

  it("spends the cap and the +N fold on DISTINCT antecedents", () => {
    const db = createDatabase(":memory:");
    const { sessionId, citerId, antecedentIds } = seedCiter(db, 5);
    writeMemoryEdges(
      db,
      [
        ...antecedentIds.map((citedId) => ({
          citing: { kind: "turn" as const, id: citerId },
          cited: { kind: "turn" as const, id: citedId },
          relation: "consume" as const,
          provenance: "asserted" as const,
        })),
        // A second relation on the FIRST pair. Pre-fix this consumed a slot
        // and pushed the fold to `+2`, hiding a turn nothing else showed.
        { citing: { kind: "turn" as const, id: citerId }, cited: { kind: "turn" as const, id: antecedentIds[0]! }, relation: "grounds" as const, provenance: "asserted" as const },
      ],
      dayEpoch(30),
    );

    const output = renderTimeline(
      buildTimelineView(db, { id: `S${sessionId}/T821..821` }),
    );

    // Cap is 4 addresses; 5 distinct antecedents fold exactly one. T801 carries
    // both `consume` and `grounds` (edge-read-surface spec, ticket 01: each
    // word named once, alphabetical); the rest carry `consume` alone.
    expect(output).toContain("↳ T801(consume,grounds), T802(consume), T803(consume), T804(consume), +1");
  });

  // Edge-read-surface spec, ticket 01: `resolveTurnRowLinks`' own `↳` feed
  // (unlike the milestone views' `laneEdges`, which only ever carry a
  // relation word) still counts a pair's BARE row toward `↳` — "an
  // antecedent is a turn this row was built on, whatever relation the writer
  // named" (see that function's own doc comment). A pair with NO relation
  // word at all has nothing to put in parens, so it keeps the plain `T<n>`
  // form rather than an empty `T<n>()`.
  it("a bare (unclassified) antecedent keeps the plain T<n> form; a classified one gets its word", () => {
    const db = createDatabase(":memory:");
    const { sessionId, citerId, antecedentIds } = seedCiter(db, 2);
    writeMemoryEdges(
      db,
      [
        { citing: { kind: "turn", id: citerId }, cited: { kind: "turn", id: antecedentIds[0]! }, relation: null, provenance: "text-ref" },
        { citing: { kind: "turn", id: citerId }, cited: { kind: "turn", id: antecedentIds[1]! }, relation: "extends", provenance: "asserted" },
      ],
      dayEpoch(30),
    );

    const output = renderTimeline(
      buildTimelineView(db, { id: `S${sessionId}/T821..821` }),
    );

    expect(output).toContain("↳ T801, T802(extends)");
  });
});

describe("timelineQuery", () => {
  it("builds and renders the timeline for a valid session id", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const output = timelineQuery(db, { id: "S1" });

    expect(output).toContain("- [S1]");
    expect(output).not.toContain("showing:");
  });

  it("returns a timeline error string when the view builder throws", () => {
    const db = createDatabase(":memory:");

    initializeSchema(db);

    expect(timelineQuery(db, { id: "S999" })).toBe(
      "timeline error: timeline: session S999 not found",
    );
  });

  it("forwards the view enum into the rendered timeline", () => {
    const db = createDatabase(":memory:");
    seedSession(db);

    expect(timelineQuery(db, { id: "S1" })).not.toMatch(/\n\s+phases[:(]/);

    // The milestone view dispatches to the day-grouped digest, not the turn table.
    const milestoneOut = timelineQuery(db, { id: "S1", view: "milestones" });
    expect(milestoneOut).not.toMatch(TURN_VIEW_ROW_RE);
    expect(milestoneOut).toMatch(/── \d{4}-\d{2}-\d{2} \w{3} · T\d+–T\d+ · \d+ kept/);
  });

  it("shows the navigation legend on the turn table when a title truncates, even with no hidden turns", () => {
    const db = createDatabase(":memory:");
    seedTimelineSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        title: "x".repeat(DEFAULT_TITLE_CAP + 20),
        userPrompt: "short prompt",
        createdAtEpoch: 1_700_000_000,
      }),
    ]);

    // Default view is "turns": no day-folding, no budget — the turn table's own
    // `truncateText` (title column, via renderTitleCell) is the only source of
    // truncation here, and it used to carry no legend at all (spec D1 only
    // wired the milestone body's hiddenTurns signal into this view kind).
    const out = timelineQuery(db, { id: "S1" });

    expect(out).toContain(`${"x".repeat(DEFAULT_TITLE_CAP)}…`);
    expect(out).toContain(NAVIGATION_LEGEND);
  });

  it("cuts a turn-table title on a word boundary, as recall does", () => {
    const db = createDatabase(":memory:");
    const title = `${"alpha beta gamma ".repeat(20)}supplementary`;
    seedTimelineSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        title,
        userPrompt: "short prompt",
        createdAtEpoch: 1_700_000_000,
      }),
    ]);

    const out = timelineQuery(db, { id: "S1" });
    const row = out.split("\n").find((line) => line.includes("alpha"))!;
    // The title is the rest of the row after its address, stamp and type
    // glyph (spec 金样例 `[T821] 08-17 18:19 ⚖️ title`, ticket 05).
    const shown = row.match(/^\s*\[T\d+\] \d{2}-\d{2} \d{2}:\d{2} \S+ (.*)$/)![1]!;

    expect(shown).toEndWith("…");
    // Whatever survived is whole words: it is a prefix of the source that ends
    // where the source has a space.
    const kept = shown.slice(0, -1);
    expect(title.startsWith(kept)).toBe(true);
    expect(title.charAt(kept.length)).toBe(" ");
  });

  it("omits the navigation legend on the turn table when nothing truncates", () => {
    const db = createDatabase(":memory:");
    seedTimelineSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        title: "short title",
        userPrompt: "short prompt",
        createdAtEpoch: 1_700_000_000,
      }),
    ]);

    const out = timelineQuery(db, { id: "S1" });

    expect(out).not.toContain(NAVIGATION_LEGEND);
  });
});

describe("fork-lineage breadcrumb in timeline", () => {
  it("renders breadcrumb and earlier pointer for a forked session", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);

    const parent = upsertSession(db, {
      contentSessionId: "tl-parent",
      project: "/tmp/test",
      title: "TL Parent",
      insight: null,
      createdAtEpoch: 1_700_000_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    // Insert a parent turn at promptNumber=5
    const parentTurnId = db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, ?, 'extracted', ?)
         RETURNING id`,
      )
      .get(parent.id, 5, 1_700_000_050)!.id;

    const child = upsertSession(db, {
      contentSessionId: "tl-child",
      project: "/tmp/test",
      title: "TL Child",
      insight: null,
      createdAtEpoch: 1_700_001_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    db.query("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run(
      parent.id,
      child.id,
    );

    // Insert child's first turn with parent_turn_id
    db.query(
      `INSERT INTO turns (session_id, prompt_number, status, parent_turn_id, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?)`,
    ).run(child.id, 1, parentTurnId, 1_700_001_100);

    const view = buildTimelineView(db, { id: `S${child.id}` });
    const output = renderTimeline(view);

    // Breadcrumb in header
    expect(output).toContain(`continues from S${parent.id} (forked at T5)`);
    // Earlier pointer to parent
    expect(output).toContain(`earlier: recall(id="S${parent.id}")`);
  });

  it("renders breadcrumb without fork turn when parent_turn_id is null", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);

    const parent = upsertSession(db, {
      contentSessionId: "tl-parent-null",
      project: "/tmp/test",
      title: "TL Parent Null",
      insight: null,
      createdAtEpoch: 1_700_000_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const child = upsertSession(db, {
      contentSessionId: "tl-child-null",
      project: "/tmp/test",
      title: "TL Child Null",
      insight: null,
      createdAtEpoch: 1_700_001_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    db.query("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run(
      parent.id,
      child.id,
    );

    // First turn with NULL parent_turn_id
    db.query(
      `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
       VALUES (?, ?, 'extracted', ?)`,
    ).run(child.id, 1, 1_700_001_100);

    const view = buildTimelineView(db, { id: `S${child.id}` });
    const output = renderTimeline(view);

    expect(output).toContain(`continues from S${parent.id}`);
    expect(output).not.toContain("forked at");
    expect(output).toContain(`earlier: recall(id="S${parent.id}")`);
  });

  it("non-forked session shows no breadcrumb and no lineage pointer in timeline", () => {
    const db = createDatabase(":memory:");
    seedSession(db);

    const view = buildTimelineView(db, { id: "S1" });
    const output = renderTimeline(view);

    expect(output).not.toContain("continues from");
    expect(output).not.toMatch(/earlier: recall\(id="S\d+"\)/);
  });
});

describe("parseContentReferences", () => {
  const twelveRefs = Array.from({ length: 12 }, (_, i) => `[T${i + 1}]`).join(" ");

  it("applies the caller's cap; the shared grammar itself stays uncapped", () => {
    // The cap lives with the consumer, not in db/citations' grammar: the
    // settle/pull-through readers must see every id a legacy turn cites. There
    // is no milestone-display default to inherit any more — the arc view's ↳
    // rows come from the structured pull-through set, not from re-parsed prose.
    expect(parseContentReferences(twelveRefs, 8)).toHaveLength(8);
    expect(parseContentReferences(twelveRefs, 2)).toHaveLength(2);
  });

  it("resolves the wider shared forms too", () => {
    expect(parseContentReferences("[T8075, T9824]", 8)).toEqual([8075, 9824]);
  });
});

// ---------------------------------------------------------------------------
// Unified row renderer (spec §D)
// ---------------------------------------------------------------------------

/** Comfortably inside the task-causality era, so stored grades are read verbatim. */
/**
 * One turn's whole rendered unit in the turn view (ticket 05, spec 金样例): the
 * address+stamp+glyph+title row, plus its `↳` line when it has antecedents.
 * The table row this replaces was one line, so every assertion that used to
 * `.find(line.startsWith("T21 |"))` reads the block instead.
 */
function turnBlock(output: string, promptNumber: number): string | undefined {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => /\[T\d+\]/.test(line) && line.includes(`[T${promptNumber}]`));
  if (start === -1) {
    return undefined;
  }
  const block = [lines[start]!];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*(?:⨯ )?\[[ST]\d+\]/.test(lines[index]!) || lines[index]!.trim() === "") {
      break;
    }
    block.push(lines[index]!);
  }
  return block.join("\n");
}

/**
 * The plain `S<n>` turns view's own row signature (ticket 05): the address's
 * stamp is inline now, same as a milestone row, but at the SHALLOW indent
 * (`DIRECT_TURN_INDENT`, 4 spaces) this route uses — no `[E<n>]`/spine
 * ancestor sits above it. A milestone row (legacy body OR era-nested) is
 * always 8 spaces, so the indent alone still tells the two views apart
 * without a metadata line to look for.
 */
const TURN_VIEW_ROW_RE = /^ {4}(?:⚑ )?(?:⨯ )?\[T\d+\] \d{2}-\d{2} \d{2}:\d{2}/m;

const ERA_BASE = 1_785_000_000;

/**
 * Era fixture seeder. Writes the stored grade for every row that has one.
 * Citation reads no longer gate on any per-turn flag — `getEffectiveCitations`
 * always unions structured edges with the inline `[T<n>]` parse — so there is
 * nothing else to state here.
 */
function seedArcSession(
  db: Database,
  rows: TurnRecord[],
  overrides: Partial<UpsertSessionInput> = {},
) {
  const session = seedTimelineSession(db, rows, overrides);
  const setGrade = db.query(
    "UPDATE turns SET significance_grade = ? WHERE session_id = ? AND prompt_number = ?",
  );
  for (const row of rows) {
    if (row.significanceGrade !== null) {
      setGrade.run(row.significanceGrade, session.id, row.promptNumber);
    }
  }
  return session;
}

function turnDbId(db: Database, sessionId: number, promptNumber: number): number {
  const record = getTurn(db, sessionId, promptNumber);
  if (record === null) throw new Error(`no turn S${sessionId}/T${promptNumber}`);
  return record.id;
}

// `replaceTurnCitations` (the old generic body-free structured-edge write) was
// retired under spec C6/ticket 06 in favour of a body-derived recompute, which
// this test file's fixtures have no body prose for. Writing straight through
// `writeMemoryEdges` — the same stable primitive `recomputeTurnCitedPairs`
// itself now builds on — sidesteps that churn entirely.
function citeTurns(
  db: Database,
  sessionId: number,
  citingPrompt: number,
  cites: Array<[number, CitationRelation]>,
): void {
  const citingId = turnDbId(db, sessionId, citingPrompt);
  writeMemoryEdges(
    db,
    cites.map(([promptNumber, relation]) => ({
      citing: { kind: "turn" as const, id: citingId },
      cited: { kind: "turn" as const, id: turnDbId(db, sessionId, promptNumber) },
      relation,
      provenance: "judged" as const,
    })),
    ERA_BASE,
  );
}

// A spine row is `        <marker?>[T<n>] <date> <time> <emoji> <title>` (spec
// 金样例); the `↳` address line, desc lines and the `… +N more` hint all sit
// further in and never match.
const SPINE_ROW_RE = /^ {8}(?:.{1,2} )?\[T\d+\] /u;
const PULLED_ROW_RE = /^\s+↳ /u;
const OVERFLOW_HINT_RE = /^\s+… \+(\d+) more/u;
// The same count also rides the one line a run of zero-row days collapses to,
// which is a day frame and so starts at column 0 — hence no leading anchor here.
const HIDDEN_COUNT_RE = /… \+(\d+) more/u;

function spineRowLines(output: string): string[] {
  return output.split("\n").filter((line) => SPINE_ROW_RE.test(line));
}

function spinePromptNumbers(output: string): number[] {
  return spineRowLines(output).map((line) => Number(line.match(/T(\d+)/)![1]));
}

function pulledRowLines(output: string): string[] {
  return output.split("\n").filter((line) => PULLED_ROW_RE.test(line));
}

/** Every antecedent ADDRESS on every `↳` line, in order (spec 金样例 `↳ T811, T812`). */
function pulledPromptNumbers(output: string): number[] {
  return pulledRowLines(output).flatMap((line) =>
    [...line.matchAll(/T(\d+)/g)].map((match) => Number(match[1])),
  );
}

/** Every `+N more` hint's N, summed — the fully hidden turns. */
function hiddenTurnTotal(output: string): number {
  return output
    .split("\n")
    .map((line) => line.match(HIDDEN_COUNT_RE))
    .filter((match): match is RegExpMatchArray => match !== null)
    .reduce((sum, match) => sum + Number(match[1]), 0);
}

/** Every day-group header line in the arc body. */
function dayHeaderLines(output: string): string[] {
  return output.split("\n").filter((line) => /^── .+ kept.* ──$/u.test(line));
}

/** Every `↳ …, +N` address fold's N, summed. */
function foldedAntecedentTotal(output: string): number {
  return pulledRowLines(output)
    .flatMap((line) => [...line.matchAll(/\+(\d+)/g)])
    .reduce((sum, match) => sum + Number(match[1]), 0);
}

/** Groups the body into render units: a spine row plus the lines homed under it. */
function renderUnitBlocks(output: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;

  for (const line of output.split("\n")) {
    if (SPINE_ROW_RE.test(line)) {
      current = [line];
      blocks.push(current);
      continue;
    }
    if (current === null) continue;
    if (OVERFLOW_HINT_RE.test(line)) {
      current = null;
      continue;
    }
    // The desc block and the `↳` address line both sit at the field rung.
    if (PULLED_ROW_RE.test(line) || /^ {12}\S/u.test(line)) {
      current.push(line);
      continue;
    }
    current = null;
  }

  return blocks;
}

function unitBlockFor(output: string, promptNumber: number): string[] {
  const block = renderUnitBlocks(output).find((lines) =>
    new RegExp(`\\[T${promptNumber}\\] `).test(lines[0]!),
  );
  if (block === undefined) throw new Error(`no render unit for T${promptNumber}`);
  return block;
}

/**
 * A design-iteration arc: origin → evidence → decision → the decision that
 * supersedes it → release, plus one dispatch turn that earns no row at all.
 */
function seedDesignArc(db: Database) {
  const rows = [
    turn({
      promptNumber: 1,
      type: "decision",
      significanceGrade: 4,
      userPrompt: "卷号锚定要解决什么",
      title: "Framed the slicing problem",
      content: "Opened the arc: what does downstream actually consume?",
      filesModified: ["docs/specs/slicing.md"],
      createdAtEpoch: ERA_BASE,
    }),
    turn({
      promptNumber: 2,
      type: "discovery",
      significanceGrade: 2,
      userPrompt: "先量误差",
      title: "12-14% error",
      content: "Sampled 200 cards; the error is structural, not noise.",
      createdAtEpoch: ERA_BASE + 60,
    }),
    turn({
      promptNumber: 3,
      type: "decision",
      significanceGrade: 3,
      userPrompt: "按卷号锚",
      title: "Volume anchoring",
      content: "Anchored slices on volume numbers.",
      createdAtEpoch: ERA_BASE + 120,
    }),
    turn({
      promptNumber: 4,
      type: "change",
      significanceGrade: 1,
      userPrompt: "接到 loader",
      title: "Wired the loader",
      content: "Mechanical wiring, no decision.",
      createdAtEpoch: ERA_BASE + 180,
    }),
    turn({
      promptNumber: 5,
      type: "decision",
      significanceGrade: 3,
      userPrompt: "没有卷数怎么办",
      title: "Cursor slicing",
      content:
        "User questioned whether volume numbers are even needed downstream.",
      createdAtEpoch: ERA_BASE + 240,
    }),
    turn({
      promptNumber: 6,
      type: "feature",
      significanceGrade: 2,
      userPrompt: "发布",
      title: "0.9.0 released",
      content: "Cut the release.",
      tags: ["release"],
      filesModified: ["package.json", ".claude-plugin/plugin.json"],
      createdAtEpoch: ERA_BASE + 300,
    }),
  ];
  const session = seedArcSession(db, rows);
  citeTurns(db, session.id, 3, [[2, "verifies"]]);
  citeTurns(db, session.id, 5, [
    [3, "supersedes"],
    [2, "verifies"],
  ]);
  return session;
}

describe("unified row renderer — row formats (spec §D)", () => {
  it("renders a spine row as T# emoji grade prompt → title ✏️files, with an indented desc block", () => {
    const db = createDatabase(":memory:");
    seedDesignArc(db);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));
    const block = unitBlockFor(out, 1);

    expect(block[0]).toBe(
      '        [T1] 07-25 ⚖️ Framed the slicing problem · "卷号锚定要解决什么"  ✏️slicing.md',
    );
    // The desc rides underneath, indented, carrying process and evidence.
    expect(block[1]).toMatch(/^ {12}Opened the arc: what does downstream/);
  });

  // Row-slimming ticket 01 (decision 2 + 3): the stamp drops `HH:mm` and the
  // glyph collapses to the FIRST stored type only — a turn that states two
  // activities still shows exactly one emoji in its row.
  it("collapses a multi-type turn's row to MM-DD plus the FIRST stored type's emoji only", () => {
    const db = createDatabase(":memory:");
    seedArcSession(db, [
      turn({
        promptNumber: 1,
        type: ["design", "research"],
        significanceGrade: 4,
        userPrompt: "开题",
        title: "Framed the slicing problem",
        createdAtEpoch: ERA_BASE,
      }),
    ]);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));
    const block = unitBlockFor(out, 1);

    // `design` is the FIRST stored type (⚖️); `research`'s own glyph (🔍) is
    // the one this row drops — it is asserted absent by name, not merely
    // "some second emoji is gone".
    expect(block[0]).toBe(
      '        [T1] 07-25 ⚖️ Framed the slicing problem · "开题"',
    );
    expect(block[0]).not.toContain(TYPE_GLYPH.research);
    expect(block[0]).not.toMatch(/\d{2}:\d{2}/);
  });

  it("renders a `↳` row as a bare address, title-only, no desc, no back-link (milestone-election spec, ticket 03: the line names ANOTHER elected row)", () => {
    const db = createDatabase(":memory:");
    seedDesignArc(db);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));

    expect(out).toContain("            ↳ T2");
    // ↳ rows are title-only: the antecedent's OWN desc never renders a second
    // time under its citer's row — T2's desc appears once, under T2's own row.
    expect(out).not.toMatch(/↳[^\n]*T2[^\n]*\n\s+Sampled 200 cards/);
  });

  it("collapses a harness-injected prompt to a marker instead of spending row budget", () => {
    const db = createDatabase(":memory:");
    seedArcSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        significanceGrade: 4,
        userPrompt:
          "<task-notification>\nAgent general-purpose (abc) completed\n</task-notification>",
        title: "Read the worker report and locked the plan",
        createdAtEpoch: ERA_BASE,
      }),
      turn({
        promptNumber: 2,
        type: "decision",
        significanceGrade: 3,
        userPrompt: "接着做",
        title: "Second decision",
        createdAtEpoch: ERA_BASE + 60,
      }),
    ]);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));

    expect(out).toContain(
      `[T1] 07-25 ⚖️ Read the worker report and locked the plan · "${MILESTONE_NOTIFICATION_MARKER}"`,
    );
    expect(out).not.toContain("task-notification>");
    expect(out).not.toContain("general-purpose");
  });

  it("renders a slash-command prompt as its command name, not the notify marker", () => {
    const db = createDatabase(":memory:");
    seedArcSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        significanceGrade: 4,
        userPrompt: "开题",
        title: "origin",
        createdAtEpoch: ERA_BASE,
      }),
      turn({
        promptNumber: 2,
        type: "decision",
        significanceGrade: 3,
        userPrompt:
          "<command-message>review-pr is running…</command-message>\n<command-name>/review-pr</command-name>\n<command-args>1421</command-args>",
        title: "Reviewed the PR and asked for a rebase",
        createdAtEpoch: ERA_BASE + 60,
      }),
    ]);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));

    // A slash-command envelope IS harness-injected XML, but which command ran is
    // a real user act — the same extraction the turns view does keeps it.
    expect(out).toContain('[T2] 07-25 ⚖️ Reviewed the PR and asked for a rebase · "/review-pr"');
    expect(out).not.toContain(MILESTONE_NOTIFICATION_MARKER);
    expect(out).not.toContain("command-name>");
    expect(out).not.toContain("1421");
  });

  it("collapses a command envelope with no command name left in it", () => {
    const db = createDatabase(":memory:");
    seedArcSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        significanceGrade: 4,
        userPrompt: "<local-command-stdout>ok</local-command-stdout>",
        title: "origin",
        createdAtEpoch: ERA_BASE,
      }),
      turn({
        promptNumber: 2,
        type: "decision",
        significanceGrade: 3,
        userPrompt: "继续",
        title: "second",
        createdAtEpoch: ERA_BASE + 60,
      }),
    ]);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));

    expect(out).toContain(`[T1] 07-25 ⚖️ origin · "${MILESTONE_NOTIFICATION_MARKER}"`);
  });

  it("the turns view row carries its stamp inline, and no grade anywhere (ticket 05)", () => {
    const db = createDatabase(":memory:");
    seedDesignArc(db);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "turns" }));

    // Ticket 05: no metadata line, no gap, no stats, no `G` column — the row's
    // own stamp (`TURN_VIEW_ROW_RE`) is the only time signal left, and it
    // rides the main line itself.
    expect(out).toMatch(TURN_VIEW_ROW_RE);
    expect(out).not.toMatch(/\bG[0-4]\b/);
    const block = turnBlock(out, 5)!;
    expect(block.split("\n")[0]).toMatch(TURN_VIEW_ROW_RE);
  });

  // Row-slimming ticket 01, decision 1: the scope fence. The SESSION-level
  // `turns` view (`renderPlainTurnRowLines`, distinct from the milestone row
  // renderer this ticket slims) is explicitly untouched — it still carries
  // `HH:mm` and the WHOLE type-list emoji cluster, not just the first.
  it("the turns view keeps MM-DD HH:mm and the FULL emoji cluster for a multi-type turn (scope fence holds)", () => {
    const db = createDatabase(":memory:");
    seedArcSession(db, [
      turn({
        promptNumber: 1,
        type: ["design", "research"],
        significanceGrade: 4,
        userPrompt: "开题",
        title: "Framed the slicing problem",
        createdAtEpoch: ERA_BASE,
      }),
    ]);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "turns" }));
    const block = turnBlock(out, 1)!;
    const headLine = block.split("\n")[0]!;

    expect(headLine).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
    expect(headLine).toContain(`${TYPE_GLYPH.design}${TYPE_GLYPH.research}`);
  });

  it("a turn with no main-row candidacy still renders its row and metadata", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);
    db.query(
      "UPDATE turns SET type = '[\"compact\"]', title = '/compact' WHERE session_id = ? AND prompt_number = 21",
    ).run(session.id);

    const out = renderTimeline(buildTimelineView(db, { id: "S1/T19..21" }));
    const block = turnBlock(out, 21)!;

    expect(block).toContain("/compact");
    expect(block).not.toMatch(/\bG[0-4]\b/);
  });

  it("caps the prompt prefix by characters and the ✏️ tail by file count", () => {
    const db = createDatabase(":memory:");
    seedArcSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        significanceGrade: 4,
        userPrompt: "长".repeat(120),
        title: "origin",
        filesModified: ["a/one.ts", "b/two.ts", "c/three.ts", "d/four.ts", "e/five.ts"],
        createdAtEpoch: ERA_BASE,
      }),
      turn({
        promptNumber: 2,
        type: "decision",
        significanceGrade: 3,
        userPrompt: "p2",
        title: "end",
        createdAtEpoch: ERA_BASE + 60,
      }),
    ]);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));
    const head = unitBlockFor(out, 1)[0]!;

    expect(head).toContain(`origin · "${"长".repeat(MILESTONE_PROMPT_PREFIX_CAP)}…"`);
    expect(head).not.toContain("长".repeat(MILESTONE_PROMPT_PREFIX_CAP + 1));
    // Basenames, capped, with the remainder as a count — the row is a pointer.
    expect(head).toContain("✏️one.ts,two.ts,three.ts+2");
  });

  it("truncateToTokens is Han-aware and always terminates", () => {
    // 1.1 weight per Han code point × 1.2: 20 tokens buys ~15 Han characters,
    // which is why titleCap alone cannot bound a unit.
    const han = "锚".repeat(200);
    expect(estimateDiaryTokens(truncateToTokens(han, 20))).toBeLessThanOrEqual(20);
    expect(truncateToTokens(han, 20).endsWith("…")).toBe(true);
    expect(truncateToTokens(han, 20).length).toBeLessThan(han.length);
    // ASCII of the same token budget fits nearly twice as much text.
    expect([...truncateToTokens("x".repeat(200), 20)].length).toBeGreaterThan(
      [...truncateToTokens(han, 20)].length,
    );
    // Degenerate budgets return something renderable rather than looping.
    expect(truncateToTokens(han, 0)).toBe("");
    expect(truncateToTokens("short", 999)).toBe("short");
  });

  it("treats titleCap as the char-level cap in every view, defaulting to 100", () => {
    const db = createDatabase(":memory:");
    const longTitle = "x".repeat(140);
    seedArcSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        significanceGrade: 4,
        userPrompt: "p1",
        title: longTitle,
        createdAtEpoch: ERA_BASE,
      }),
      turn({
        promptNumber: 2,
        type: "decision",
        significanceGrade: 3,
        userPrompt: "p2",
        title: longTitle,
        createdAtEpoch: ERA_BASE + 60,
      }),
    ]);

    for (const view of ["milestones", "turns"] as const) {
      const timelineView = buildTimelineView(db, { id: "S1", view });
      expect(renderTimeline(timelineView)).toContain(`${"x".repeat(DEFAULT_TITLE_CAP)}…`);
      expect(renderTimeline(timelineView, { titleCap: 24 })).toContain(
        `${"x".repeat(24)}…`,
      );
      expect(renderTimeline(timelineView, { titleCap: 24 })).not.toContain(
        "x".repeat(25),
      );
    }
  });
});

describe("unified row renderer — per-unit hard cap (spec §D)", () => {
  it("pins the hard cap at 150 tokens", () => {
    // Pinned as a literal exactly once, here: every other assertion reads the
    // constant, so without this one line the whole cap suite would happily
    // re-derive itself from a wrong value. 150 and not 100 because a unit is the
    // spine row PLUS its ↳ rows — see the constant's own note.
    expect(MILESTONE_UNIT_TOKEN_CAP).toBe(150);
  });

  it("lets a spine row keep two ↳ antecedents intact inside the cap", () => {
    // Milestone-election spec, ticket 03: `↳` addresses now name OTHER
    // elected rows (not a lower-tier turn "pulled in" for lack of a row of
    // its own) — with a small window and the default election budget, T2/T3
    // are elected in their own right too, but T4's own `↳` line still names
    // them (the cross-reference is informative regardless).
    const db = createDatabase(":memory:");
    const rows = [
      turn({
        promptNumber: 1,
        type: "decision",
        significanceGrade: 4,
        userPrompt: "开题",
        title: "Framed the slicing problem",
        content: "Opened the arc: what does downstream actually consume?",
        createdAtEpoch: ERA_BASE,
      }),
      turn({
        promptNumber: 2,
        type: "discovery",
        significanceGrade: 2,
        userPrompt: "先量误差",
        title: "12-14% error",
        content: "Sampled 200 cards; the error is structural, not noise.",
        createdAtEpoch: ERA_BASE + 60,
      }),
      turn({
        promptNumber: 3,
        type: "discovery",
        significanceGrade: 1,
        userPrompt: "按卷号锚",
        title: "Volume anchoring",
        content: "Anchored slices on volume numbers.",
        createdAtEpoch: ERA_BASE + 120,
      }),
      turn({
        promptNumber: 4,
        type: "decision",
        significanceGrade: 3,
        userPrompt: "没有卷数怎么办",
        title: "Cursor slicing",
        content: "User questioned whether volume numbers are even needed downstream.",
        createdAtEpoch: ERA_BASE + 180,
      }),
    ];
    const session = seedArcSession(db, rows);
    citeTurns(db, session.id, 4, [
      [2, "verifies"],
      [3, "verifies"],
    ]);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));
    const block = unitBlockFor(out, 4);

    // The 100-token cap could not have fitted this: a full spine row plus two
    // ~25-32-token antecedents overruns it, so both ↳ rows would have folded
    // into `+2 前件` and pull-through would have been decorative.
    const pulledLines = block.filter((line) => PULLED_ROW_RE.test(line));
    expect(pulledLines).toHaveLength(1);
    expect([...pulledLines[0]!.matchAll(/T\d+/g)]).toHaveLength(2);
    expect(block.join("\n")).not.toContain("前件");
    expect(estimateDiaryTokens(block.join("\n"))).toBeLessThanOrEqual(
      MILESTONE_UNIT_TOKEN_CAP,
    );
    expect(estimateDiaryTokens(block.join("\n"))).toBeGreaterThan(100);
  });

  it("keeps every render unit inside the hard cap on a real arc", () => {
    const db = createDatabase(":memory:");
    seedDesignArc(db);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));

    for (const block of renderUnitBlocks(out)) {
      expect(estimateDiaryTokens(block.join("\n"))).toBeLessThanOrEqual(
        MILESTONE_UNIT_TOKEN_CAP,
      );
    }
  });

  it("truncates the desc of an oversized single row instead of dropping the row", () => {
    const db = createDatabase(":memory:");
    seedArcSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        significanceGrade: 4,
        userPrompt: "开题",
        title: "The origin decision",
        content: "证据".repeat(600),
        createdAtEpoch: ERA_BASE,
      }),
      turn({
        promptNumber: 2,
        type: "decision",
        significanceGrade: 3,
        userPrompt: "继续",
        title: "The follow-up decision",
        createdAtEpoch: ERA_BASE + 60,
      }),
    ]);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));
    const block = unitBlockFor(out, 1);

    expect(block[0]).toContain("The origin decision");
    expect(estimateDiaryTokens(block.join("\n"))).toBeLessThanOrEqual(
      MILESTONE_UNIT_TOKEN_CAP,
    );
    expect(block.slice(1).join("")).toContain("…"); // desc truncated, not dropped
  });

  it("terminates on four max-length Han titles by token-truncating the title lines", () => {
    const db = createDatabase(":memory:");
    const maxHanTitle = "锚".repeat(DEFAULT_TITLE_CAP + 40);
    const rows = [
      turn({
        promptNumber: 1,
        type: "decision",
        significanceGrade: 4,
        userPrompt: "开题",
        title: "origin",
        createdAtEpoch: ERA_BASE,
      }),
      ...[2, 3, 4, 5].map((promptNumber) =>
        turn({
          promptNumber,
          type: "discovery",
          significanceGrade: 2,
          userPrompt: `p${promptNumber}`,
          title: maxHanTitle,
          createdAtEpoch: ERA_BASE + promptNumber * 60,
        }),
      ),
      turn({
        promptNumber: 6,
        type: "decision",
        significanceGrade: 3,
        userPrompt: "定稿",
        title: maxHanTitle,
        createdAtEpoch: ERA_BASE + 360,
      }),
    ];
    const session = seedArcSession(db, rows);
    citeTurns(
      db,
      session.id,
      6,
      [2, 3, 4, 5].map((promptNumber) => [promptNumber, "verifies"]),
    );

    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));
    const block = unitBlockFor(out, 6);

    // Termination, not overflow: the unit is inside the hard cap even though
    // titleCap alone would have allowed 5 × 100 Han characters (~660 tokens).
    expect(estimateDiaryTokens(block.join("\n"))).toBeLessThanOrEqual(
      MILESTONE_UNIT_TOKEN_CAP,
    );
    expect(block[0]).toContain("…"); // token-level title truncation fired
    // Folding the ↳ rows into the counter is what freed the room for it.
    expect(block.join("\n")).toContain("↳ +4");
  });

  it("drops a pathological ✏️ tail rather than let it breach the cap", () => {
    const db = createDatabase(":memory:");
    const monstrousBasename = `${"generated-fixture-".repeat(20)}.ts`;
    seedArcSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        significanceGrade: 4,
        userPrompt: "开题",
        title: "origin",
        createdAtEpoch: ERA_BASE,
      }),
      turn({
        promptNumber: 2,
        type: "feature",
        significanceGrade: 3,
        userPrompt: "生成",
        title: "Generated the fixture set",
        filesModified: [`src/generated/${monstrousBasename}`],
        createdAtEpoch: ERA_BASE + 60,
      }),
    ]);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));
    const block = unitBlockFor(out, 2);

    // Step ③ of the ladder: the file count is capped but a basename is not, so a
    // single generated name can outweigh the row. It goes whole — no half name,
    // no `+N` stub.
    expect(estimateDiaryTokens(block.join("\n"))).toBeLessThanOrEqual(
      MILESTONE_UNIT_TOKEN_CAP,
    );
    expect(block[0]).not.toContain("✏️");
    expect(block[0]).not.toContain("generated-fixture-");
    expect(block).toHaveLength(1);
    // The point of the reorder: the decorative tail is sacrificed BEFORE the
    // title steps, so the row keeps the text it exists to carry instead of
    // arriving at the tail already stripped to its identity columns.
    expect(block[0]).toBe('        [T2] 07-25 🟣 Generated the fixture set · "生成"');
  });

  it("caps rendered ↳ rows at four and folds the rest into +N 前件", () => {
    const db = createDatabase(":memory:");
    const rows = [
      turn({
        promptNumber: 1,
        type: "decision",
        significanceGrade: 4,
        userPrompt: "o",
        title: "o",
        createdAtEpoch: ERA_BASE,
      }),
      ...[2, 3, 4, 5, 6, 7].map((promptNumber) =>
        turn({
          promptNumber,
          type: "discovery",
          significanceGrade: 2,
          userPrompt: "p",
          title: "a",
          createdAtEpoch: ERA_BASE + promptNumber * 60,
        }),
      ),
      turn({
        promptNumber: 8,
        type: "decision",
        significanceGrade: 3,
        userPrompt: "p",
        title: "x",
        createdAtEpoch: ERA_BASE + 480,
      }),
    ];
    const session = seedArcSession(db, rows);
    citeTurns(
      db,
      session.id,
      8,
      [2, 3, 4, 5, 6, 7].map((promptNumber) => [promptNumber, "verifies"]),
    );

    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));
    const block = unitBlockFor(out, 8);

    // One `↳` LINE holds every address (spec 金样例), so the cap is counted in
    // addresses on that line, not in rows.
    const pulledLine = block.find((line) => PULLED_ROW_RE.test(line))!;
    expect([...pulledLine.matchAll(/T\d+/g)]).toHaveLength(MILESTONE_UNIT_PULLED_CAP);
    expect(block.join("\n")).toContain("↳ T2(verifies), T3(verifies), T4(verifies), T5(verifies), +2");
  });

  it("a cited turn that is ITSELF elected renders both its own main row AND a ↳ cross-reference under its citer (milestone-election spec, ticket 03: `↳` names elected rows, no exclusivity with holding a row of its own)", () => {
    const db = createDatabase(":memory:");
    const rows = [
      turn({
        promptNumber: 1,
        type: "discovery",
        userPrompt: "p1",
        title: "the row that is also an antecedent",
        createdAtEpoch: ERA_BASE,
      }),
      turn({
        promptNumber: 2,
        type: "decision",
        userPrompt: "p2",
        title: "cites the earlier row",
        createdAtEpoch: ERA_BASE + 60,
      }),
    ];
    const session = seedArcSession(db, rows);
    citeTurns(db, session.id, 2, [[1, "verifies"]]);

    const view = buildTimelineView(db, { id: "S1", view: "milestones" });
    const out = renderTimeline(view);

    // Both turns are elected (a two-turn window, default budget): T1 holds
    // its own main row, and T2's own row separately names it via `↳`.
    expect(spinePromptNumbers(out)).toEqual([1, 2]);
    expect(pulledPromptNumbers(out)).toEqual([1]);
    expect(view.pagedMilestones.map((row) => row.turn.promptNumber)).toEqual([1, 2]);
  });
});

/**
 * A small tokenBudget-degradation fixture. Milestone-election spec, ticket
 * 03: nothing is structurally exempt from a `tokenBudget` any more (always-
 * keep retired), and there is no more antecedent RE-HOMING (a `↳` address
 * names another elected row directly, never a separately-homed object) — so
 * this fixture is deliberately small rather than the old 900-row re-homing
 * stress shape, which tested a mechanism this ticket removes outright.
 */
/**
 * An 8-day, 8-row fixture for `tokenBudget` degradation (milestone-election
 * spec, ticket 03): no lane edges at all, so every row is tier ⑤ at zero
 * degree and election rank IS recency — T1 (earliest) ranks worst, T8
 * (latest) ranks best, exactly matching `milestoneDegradationOrder`'s own
 * "worst rank first" removal order. One turn per day keeps day-frame
 * collapsing observable. There is no more antecedent RE-HOMING to stress
 * (a `↳` address names another elected row directly, never a separately
 * homed object) — that whole mechanism retires with this ticket, so this
 * fixture is deliberately plain rather than the old re-homing stress shape.
 * Token costs below are measured against this EXACT fixture, not estimated.
 */
function seedBudgetDegradationArc(db: Database) {
  const day = 86_400;
  const rows = Array.from({ length: 8 }, (_unused, index) =>
    turn({
      promptNumber: index + 1,
      type: "decision",
      userPrompt: `p${index + 1}`,
      title: `decision ${index + 1}`,
      content: `desc ${index + 1} `.repeat(4),
      createdAtEpoch: ERA_BASE + index * day,
    }),
  );
  return seedArcSession(db, rows);
}

describe("unified row renderer — global token budget (spec §D)", () => {
  it("is off by default: MCP views are bounded by pagination alone", () => {
    const db = createDatabase(":memory:");
    seedBudgetDegradationArc(db);
    const view = buildTimelineView(db, { id: "S1", view: "milestones" });
    const out = renderTimeline(view);
    expect(out).not.toContain(MILESTONE_OVER_BUDGET_NOTE);
    for (let promptNumber = 1; promptNumber <= 8; promptNumber += 1) {
      expect(out).toContain(`[T${promptNumber}]`);
    }
  });

  it("degrades desc before removing anything, every row still present", () => {
    const db = createDatabase(":memory:");
    seedBudgetDegradationArc(db);
    const view = buildTimelineView(db, { id: "S1", view: "milestones" });
    const full = renderTimeline(view);
    const fullTokens = estimateDiaryTokens(full);

    // A moderate haircut: every row still fits, but only once its desc has
    // shrunk (measured against this exact fixture: full ~1027, 800 keeps all
    // eight with trimmed desc bodies).
    const tight = renderTimeline(view, { tokenBudget: 800 });
    expect(estimateDiaryTokens(tight)).toBeLessThan(fullTokens);
    for (let promptNumber = 1; promptNumber <= 8; promptNumber += 1) {
      expect(tight).toContain(`[T${promptNumber}]`);
    }
    // The repeated desc text is shorter than the untrimmed original.
    expect(tight).not.toContain("desc 1 desc 1 desc 1 desc 1");
    expect(tight).not.toContain(MILESTONE_OVER_BUDGET_NOTE);
  });

  it("removes the lowest-ranked (earliest) removable unit first and conserves it into `+N more`", () => {
    const db = createDatabase(":memory:");
    seedBudgetDegradationArc(db);
    const view = buildTimelineView(db, { id: "S1", view: "milestones" });
    const out = renderTimeline(view, { tokenBudget: 700 });
    // T1-T5 (worst election rank: earliest, zero degree) are gone; T6-T8
    // (best rank: latest) survive. Row-slimming ticket 01 shrank each row
    // (`MM-DD`, one emoji), so the SAME 700-token budget now fits one more
    // row than before the slimming (T6 used to fall on the wrong side of the
    // cut) — an expected consequence of decision 4 ("no semantic change"):
    // the fitter's LOGIC is untouched, only the row byte cost it measures is
    // smaller.
    for (const promptNumber of [1, 2, 3, 4, 5]) {
      expect(out).not.toContain(`[T${promptNumber}]`);
    }
    for (const promptNumber of [6, 7, 8]) {
      expect(out).toContain(`[T${promptNumber}]`);
    }
    expect(hiddenTurnTotal(out)).toBe(5);
  });

  it("gives a day whose every candidate turn was hidden a section of its own", () => {
    const db = createDatabase(":memory:");
    seedBudgetDegradationArc(db);
    const view = buildTimelineView(db, { id: "S1", view: "milestones" });
    // T1's own day loses its only row; T7-T8's days each keep theirs.
    const out = renderTimeline(view, { tokenBudget: 700 });
    expect(dayHeaderLines(out).length).toBeGreaterThan(0);
    expect(hiddenTurnTotal(out)).toBeGreaterThan(0);
  });

  it("collapses a run of consecutive zero-row days into one combined line", () => {
    const db = createDatabase(":memory:");
    seedBudgetDegradationArc(db);
    const view = buildTimelineView(db, { id: "S1", view: "milestones" });
    // T1-T6's six consecutive days all lose their only row — one combined
    // line, not six separate zero-row headers.
    const out = renderTimeline(view, { tokenBudget: 700 });
    const collapsedRun = out.split("\n").find((line) => /^── .+–.+ · 0 kept ·/u.test(line));
    expect(collapsedRun).toBeDefined();
    expect(dayHeaderLines(out).filter((line) => line.includes("0 kept"))).toHaveLength(1);
  });

  it("nothing is exempt from removal any more (milestone-election spec, ticket 03: always-keep retires) — an extreme budget removes every row", () => {
    const db = createDatabase(":memory:");
    seedBudgetDegradationArc(db);
    const view = buildTimelineView(db, { id: "S1", view: "milestones" });
    const extreme = renderTimeline(view, { tokenBudget: 1 });
    for (let promptNumber = 1; promptNumber <= 8; promptNumber += 1) {
      expect(extreme).not.toContain(`[T${promptNumber}]`);
    }
  });

  it("computes a moderately large window without pathological blowup", () => {
    const db = createDatabase(":memory:");
    const rows = Array.from({ length: 120 }, (_unused, index) =>
      turn({
        promptNumber: index + 1,
        type: "decision",
        userPrompt: `p${index + 1}`,
        title: `decision ${index + 1}`,
        content: "desc ".repeat(4),
        createdAtEpoch: ERA_BASE + index * 300,
      }),
    );
    seedArcSession(db, rows);
    const view = buildTimelineView(db, { id: "S1", view: "milestones", pageSize: 30 });
    const start = performance.now();
    const out = renderTimeline(view, { tokenBudget: 2_000 });
    expect(performance.now() - start).toBeLessThan(2_000);
    expect(out.length).toBeGreaterThan(0);
  });

  it("degrades monotonically as the budget shrinks (a looser budget never produces a SMALLER output than a tighter one)", () => {
    const db = createDatabase(":memory:");
    seedBudgetDegradationArc(db);
    const view = buildTimelineView(db, { id: "S1", view: "milestones" });
    const budgets = [500, 600, 700, 800, 900, 1_200];
    const sizes = budgets.map((tokenBudget) =>
      estimateDiaryTokens(renderTimeline(view, { tokenBudget })),
    );
    for (let index = 1; index < sizes.length; index += 1) {
      expect(sizes[index]!).toBeGreaterThanOrEqual(sizes[index - 1]!);
    }
  });

  it("orders equal-score rows by prompt number alone — tool count is no longer a signal", () => {
    const left = {
      turn: { toolCallCount: 3, promptNumber: 10 },
      score: 3,
    } as unknown as KeptMilestone;
    const right = {
      turn: { toolCallCount: 3, promptNumber: 4 },
      score: 3,
    } as unknown as KeptMilestone;
    // Under the old three-tier comparator (score, tool count, prompt), this
    // row's tool count (9) would have ranked it ABOVE both `left` and
    // `right` despite its prompt (99) being the latest of the three. That
    // tier was removed (measured at chance, AUC 0.53, against a gold set
    // blind to it — see compareMilestoneRank's comment), so prompt number
    // alone decides once score ties: the earlier prompt wins regardless of
    // tool count.
    const busier = {
      turn: { toolCallCount: 9, promptNumber: 99 },
      score: 3,
    } as unknown as KeptMilestone;

    expect([left, right, busier].sort(compareMilestoneRank)).toEqual([
      right,
      left,
      busier,
    ]);
    // Degradation walks this order backwards, so the latest prompt is cut
    // first — even though it has by far the highest tool count.
    expect([left, right, busier].sort(compareMilestoneRank).reverse()[0]).toBe(busier);
  });
});

describe("unified row renderer — view preservation matrix (spec §D)", () => {
  it("keeps the three view names and their bodies distinct", () => {
    const db = createDatabase(":memory:");
    seedDesignArc(db);
    const views = (["turns", "milestones"] as const).map((view) => ({
      view,
      out: renderTimeline(buildTimelineView(db, { id: "S1", view })),
    }));

    for (const { view, out } of views) {
      // Shape signals survive on every view.
      expect(out).toContain("shape signals (window T1-T6");
      if (view === "turns") {
        expect(out).toMatch(TURN_VIEW_ROW_RE);
      } else {
        expect(out).not.toMatch(TURN_VIEW_ROW_RE);
      }
      // ticket 04: `phases` retired — no view emits its digest header any more.
      expect(out).not.toContain("# | date | type | turns | span | work | lead title");
    }
  });

  it("counts main rows against pageSize; ↳ rows ride along without a page slot", () => {
    const db = createDatabase(":memory:");
    seedDesignArc(db);
    const view = buildTimelineView(db, {
      id: "S1",
      view: "milestones",
      pageSize: 2,
    });
    const out = renderTimeline(view);

    // Milestone-election spec, ticket 03: `pageSize` is now BOTH the
    // election's own budget and the pagination size — `kept` can never
    // exceed `pageSize`, so the milestones view is always exactly one page
    // (the old multi-page "large kept pool, paginated" shape retires along
    // with the grade-threshold eligibility that used to produce a `kept` set
    // wider than any one page).
    expect(view.pageSize).toBe(2);
    expect(view.pageCount).toBe(1);
    expect(spinePromptNumbers(out)).toHaveLength(2);
    // Both of T5's antecedents render on this page anyway.
    expect(pulledRowLines(out).length).toBeGreaterThan(0);
  });

  it("renders +N more as a sparse min..max, not a contiguous range", () => {
    const db = createDatabase(":memory:");
    const rows = [
      turn({
        promptNumber: 1,
        type: "decision",
        significanceGrade: 4,
        userPrompt: "p1",
        title: "origin",
        createdAtEpoch: ERA_BASE,
      }),
      ...[2, 3, 4].map((promptNumber) =>
        turn({
          promptNumber,
          type: "change",
          significanceGrade: 1,
          userPrompt: `p${promptNumber}`,
          title: `chore ${promptNumber}`,
          createdAtEpoch: ERA_BASE + promptNumber * 60,
        }),
      ),
      turn({
        promptNumber: 5,
        type: "decision",
        significanceGrade: 3,
        userPrompt: "p5",
        title: "mid decision",
        createdAtEpoch: ERA_BASE + 300,
      }),
      turn({
        promptNumber: 6,
        type: "change",
        significanceGrade: 1,
        userPrompt: "p6",
        title: "chore 6",
        createdAtEpoch: ERA_BASE + 360,
      }),
      turn({
        promptNumber: 7,
        type: "decision",
        significanceGrade: 3,
        userPrompt: "p7",
        title: "end",
        createdAtEpoch: ERA_BASE + 420,
      }),
    ];
    const session = seedArcSession(db, rows);
    // Milestone-election spec, ticket 03: T1/T5/T7 each an untagged-`indexes`
    // writer (tier ①, a guaranteed seat) — the same sparse-hidden shape
    // {T2,T3,T4,T6} the old grade-driven fixture wanted, reproduced through
    // the election with an explicit budget-3 cut instead of a stored grade.
    for (const citingPrompt of [1, 5, 7]) {
      citeTurns(db, session.id, citingPrompt, [[2, "indexes"]]);
    }
    const out = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "milestones", pageSize: 3 }),
    );

    // Hidden turns are T2, T3, T4, T6 — sparse, so the hint reports bounds.
    expect(out).toContain(
      '… +4 more @ within T2..T6',
    );
    expect(out).not.toContain("@ T2–T6");
  });

  it("keeps titleCap and tokenBudget out of the public MCP schema", () => {
    expect(() =>
      timelineInputSchema.parse({ id: "S42", titleCap: 100 }),
    ).toThrow();
    expect(() =>
      timelineInputSchema.parse({ id: "S42", tokenBudget: 2500 }),
    ).toThrow();
  });
});

describe("unified row renderer — frozen shapes", () => {
  const bodyRows = (output: string): string[] =>
    output
      .split("\n")
      .filter(
        (line) =>
          SPINE_ROW_RE.test(line) ||
          PULLED_ROW_RE.test(line) ||
          OVERFLOW_HINT_RE.test(line),
      );

  it("design-iteration arc: no grade-driven exclusion or supersession back-link any more — every non-excluded turn wins its own seat under the default budget", () => {
    const db = createDatabase(":memory:");
    seedDesignArc(db);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));

    // Milestone-election spec, ticket 03: `supersedes` is not part of the
    // election's edge vocabulary (`EDGE_RELATIONS`, the eight-word current
    // set) — T5's `supersedes T3` edge grants no candidacy exclusion and no
    // back-link (that whole mechanism retires). T3 and T5 each carry a
    // `verifies T2` edge instead, so both independently name T2 on their own
    // `↳` line — T2 is elected too (it holds its own row), matching spec
    // step 5: a `↳` address names another elected row, never a promotion.
    expect(bodyRows(out)).toEqual([
      '        [T1] 07-25 ⚖️ Framed the slicing problem · "卷号锚定要解决什么"  ✏️slicing.md',
      '        [T2] 07-25 🔵 12-14% error · "先量误差"',
      '        [T3] 07-25 ⚖️ Volume anchoring · "按卷号锚"',
      "            ↳ T2(verifies)",
      '        [T4] 07-25 ✅ Wired the loader · "接到 loader"',
      '        [T5] 07-25 ⚖️ Cursor slicing · "没有卷数怎么办"',
      "            ↳ T2(verifies)",
      '        🏁 [T6] 07-25 🟣 0.9.0 released · "发布"  ✏️package.json,plugin.json',
    ]);
  });

  it("research shape with notification prompts", () => {
    const db = createDatabase(":memory:");
    const rows = [
      turn({
        promptNumber: 1,
        type: "decision",
        significanceGrade: 4,
        userPrompt: "调研一下三种切分方案",
        title: "Opened the slicing survey",
        createdAtEpoch: ERA_BASE,
      }),
      turn({
        promptNumber: 2,
        type: "discovery",
        significanceGrade: 2,
        userPrompt: "<task-notification>worker A done</task-notification>",
        title: "Worker A: cursor slicing wins on recall",
        createdAtEpoch: ERA_BASE + 60,
      }),
      turn({
        promptNumber: 3,
        type: "discovery",
        significanceGrade: 1,
        userPrompt: "<task-notification>worker B done</task-notification>",
        title: "Worker B: inconclusive",
        createdAtEpoch: ERA_BASE + 120,
      }),
      turn({
        promptNumber: 4,
        type: "decision",
        significanceGrade: 3,
        userPrompt: "<task-notification>worker C done</task-notification>",
        title: "Picked cursor slicing on the survey evidence",
        createdAtEpoch: ERA_BASE + 180,
      }),
    ];
    const session = seedArcSession(db, rows);
    citeTurns(db, session.id, 4, [[2, "verifies"]]);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));

    // Milestone-election spec, ticket 03: no grade-driven exclusion any more
    // — all four turns are elected under the default budget, T2 and T3 each
    // winning their own row (T2 additionally named on T4's `↳` line, since
    // it is ALSO elected).
    expect(bodyRows(out)).toEqual([
      '        [T1] 07-25 ⚖️ Opened the slicing survey · "调研一下三种切分方案"',
      '        [T2] 07-25 🔵 Worker A: cursor slicing wins on recall · "⟨notify⟩"',
      '        [T3] 07-25 🔵 Worker B: inconclusive · "⟨notify⟩"',
      '        [T4] 07-25 ⚖️ Picked cursor slicing on the survey evidence · "⟨notify⟩"',
      "            ↳ T2(verifies)",
    ]);
  });

  it("legacy pre-era session with inline citations and no stored grades", () => {
    const db = createDatabase(":memory:");
    const preEra = 1_779_782_400;
    const rows = [
      turn({
        promptNumber: 1,
        type: "discovery",
        userPrompt: "先看看现状",
        title: "surveyed the loader",
        createdAtEpoch: preEra,
      }),
      turn({
        promptNumber: 2,
        type: "decision",
        userPrompt: "就这么定",
        title: "legacy decision",
        createdAtEpoch: preEra + 60,
      }),
      turn({
        promptNumber: 3,
        type: "feature",
        userPrompt: "实现",
        title: "legacy feature",
        filesModified: ["src/loader.ts"],
        createdAtEpoch: preEra + 120,
      }),
    ];
    // No seedArcSession here on purpose: no structured edges are written for
    // this session, so the union's structured side is empty and the legacy
    // inline `[T<n>]` grammar is the only citation source.
    const session = seedTimelineSession(db, rows);
    db.query(
      "UPDATE turns SET content = ? WHERE session_id = ? AND prompt_number = 2",
    ).run(`Builds on [T${turnDbId(db, session.id, 1)}].`, session.id);

    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));

    expect(bodyRows(out)).toEqual([
      '        [T1] 05-26 🔵 surveyed the loader · "先看看现状"',
      '        [T2] 05-26 ⚖️ legacy decision · "就这么定"',
      '        [T3] 05-26 🟣 legacy feature · "实现"  ✏️loader.ts',
    ]);
    // A legacy grade never reaches 4: it can never claim the anchor tier.
    expect(out).not.toContain("G4");
  });
});

describe("navigation legend across folded day groups (spec D1/D4)", () => {
  it("shows the legend exactly once even when several day groups fold", () => {
    const db = createDatabase(":memory:");
    const day = 86_400;
    const session = seedArcSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        userPrompt: "开题",
        title: "day0 anchor",
        createdAtEpoch: ERA_BASE,
      }),
      turn({
        promptNumber: 2,
        type: "change",
        userPrompt: "噪音",
        title: "day0 noise",
        createdAtEpoch: ERA_BASE + 60,
      }),
      turn({
        promptNumber: 3,
        type: "decision",
        userPrompt: "第二天决定",
        title: "day1 kept",
        createdAtEpoch: ERA_BASE + day,
      }),
      turn({
        promptNumber: 4,
        type: "change",
        userPrompt: "噪音2",
        title: "day1 noise",
        createdAtEpoch: ERA_BASE + day + 60,
      }),
      turn({
        promptNumber: 5,
        type: "decision",
        userPrompt: "收尾",
        title: "day2 anchor",
        createdAtEpoch: ERA_BASE + 2 * day,
      }),
    ]);
    // Milestone-election spec, ticket 03: T1/T3/T5 each an untagged-`indexes`
    // writer (tier ①, guaranteed seats) plus a budget-3 cut — the same
    // shape the old grade-driven fixture wanted (T2 hidden under day0, T4
    // hidden under day1), reproduced through the election.
    for (const citingPrompt of [1, 3, 5]) {
      citeTurns(db, session.id, citingPrompt, [[2, "indexes"]]);
    }
    const view = buildTimelineView(db, { id: "S1", view: "milestones", pageSize: 3 });
    const out = renderTimeline(view);

    // Two separate days each hide one low-grade turn (T2 under day0, T4 under
    // day1) — two distinct hint lines, not one collapsed run.
    const foldLines = out
      .split("\n")
      .filter((line) => /… \+\d+ more @ within/u.test(line));
    expect(foldLines.length).toBe(2);
    for (const line of foldLines) {
      // The drill-down command and session id used to repeat on every one of
      // these lines (spec D4); now only the count and range do.
      expect(line).not.toContain("timeline(");
      expect(line).not.toContain("S1");
    }

    // One legend for the whole response, said once regardless of how many
    // day groups folded — and it is where the drill-down command now lives.
    const legendOccurrences = out.split(NAVIGATION_LEGEND).length - 1;
    expect(legendOccurrences).toBe(1);
    expect(out).toContain('timeline(id="S<n>", view="turns")');
  });

  it("shows no legend when nothing is hidden", () => {
    const db = createDatabase(":memory:");
    seedArcSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        significanceGrade: 4,
        userPrompt: "开题",
        title: "only turn",
        createdAtEpoch: ERA_BASE,
      }),
    ]);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));

    expect(out).not.toContain("Legend:");
    expect(out).not.toContain(NAVIGATION_LEGEND);
  });
});

// Ticket 04 (spec "Tools"): the shared filter grammar — {type, tag, session,
// time, file} — AND-composed with each other and with the id selector's
// range. Narrows `windowTurns` (turn table + milestone selection candidate
// set) the same way `recall`'s `S<n>/T*` id route narrows its own turn
// listing (see recall.test.ts's "filter unification" describe block for the
// cross-tool equivalence check).
describe("timeline filter (ticket 04, spec \"Tools\")", () => {
  function seedFilterFixture(db: Database) {
    seedTimelineSession(db, [
      turn({
        promptNumber: 1,
        type: "discovery",
        tags: ["auth"],
        filesModified: ["src/auth.ts"],
        createdAtEpoch: 1_000, // 1970-01-01
      }),
      turn({
        promptNumber: 2,
        type: "decision",
        tags: ["auth"],
        filesModified: [],
        createdAtEpoch: 2_000, // 1970-01-01
      }),
      turn({
        promptNumber: 3,
        type: "discovery",
        tags: ["billing"],
        filesModified: ["src/billing.ts"],
        createdAtEpoch: 90_000, // 1970-01-02
      }),
      turn({
        promptNumber: 4,
        type: "decision",
        tags: ["billing"],
        filesModified: [],
        createdAtEpoch: 91_000, // 1970-01-02
      }),
    ]);
  }

  const turnLine = (output: string, n: number) =>
    new RegExp(`^ {4}(?:⚑ )?(?:⨯ )?\\[T${n}\\] `, "m").test(output);

  it("with no filter, every turn renders (the mutation baseline)", () => {
    const db = createDatabase(":memory:");
    seedFilterFixture(db);

    const output = renderTimeline(buildTimelineView(db, { id: "S1", view: "turns" }));

    expect(turnLine(output, 1)).toBe(true);
    expect(turnLine(output, 2)).toBe(true);
    expect(turnLine(output, 3)).toBe(true);
    expect(turnLine(output, 4)).toBe(true);
  });

  it("filter.type narrows the turn table to matching turns only", () => {
    const db = createDatabase(":memory:");
    seedFilterFixture(db);

    const output = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "turns", filter: { type: "decision" } }),
    );

    expect(turnLine(output, 1)).toBe(false);
    expect(turnLine(output, 2)).toBe(true);
    expect(turnLine(output, 3)).toBe(false);
    expect(turnLine(output, 4)).toBe(true);
  });

  it("filter.tag narrows the turn table to matching turns only", () => {
    const db = createDatabase(":memory:");
    seedFilterFixture(db);

    const output = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "turns", filter: { tag: "billing" } }),
    );

    expect(turnLine(output, 1)).toBe(false);
    expect(turnLine(output, 2)).toBe(false);
    expect(turnLine(output, 3)).toBe(true);
    expect(turnLine(output, 4)).toBe(true);
  });

  it("filter.file substring-matches files_modified", () => {
    const db = createDatabase(":memory:");
    seedFilterFixture(db);

    const output = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "turns", filter: { file: "billing" } }),
    );

    expect(turnLine(output, 1)).toBe(false);
    expect(turnLine(output, 2)).toBe(false);
    expect(turnLine(output, 3)).toBe(true);
    expect(turnLine(output, 4)).toBe(false);
  });

  it("filter.time AND-composes with the id selector — same grammar as recall's", () => {
    const db = createDatabase(":memory:");
    seedFilterFixture(db);

    const output = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "turns", filter: { time: "1970-01-02" } }),
    );

    expect(turnLine(output, 1)).toBe(false);
    expect(turnLine(output, 2)).toBe(false);
    expect(turnLine(output, 3)).toBe(true);
    expect(turnLine(output, 4)).toBe(true);
  });

  // Mutation check (method: "disable one filter member → red"): two filter
  // members together admit STRICTLY FEWER turns than either alone — proving
  // the composition is AND, never OR. T4 (decision/billing) is excluded only
  // when BOTH members apply at once.
  it("two filter members AND-compose — narrower than either alone", () => {
    const db = createDatabase(":memory:");
    seedFilterFixture(db);

    const typeOnly = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "turns", filter: { type: "decision" } }),
    );
    const tagOnly = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "turns", filter: { tag: "auth" } }),
    );
    const both = renderTimeline(
      buildTimelineView(db, {
        id: "S1",
        view: "turns",
        filter: { type: "decision", tag: "auth" },
      }),
    );

    // RED: type alone still admits T4 (decision/billing) — disabling the tag
    // member brings it back.
    expect(turnLine(typeOnly, 4)).toBe(true);
    // RED: tag alone still admits T1 (discovery/auth) — disabling the type
    // member brings it back.
    expect(turnLine(tagOnly, 1)).toBe(true);
    // GREEN: both members together admit only T2 (decision AND auth).
    expect(turnLine(both, 1)).toBe(false);
    expect(turnLine(both, 2)).toBe(true);
    expect(turnLine(both, 3)).toBe(false);
    expect(turnLine(both, 4)).toBe(false);
  });

  it("filter.session AND-composes with the id selector — a mismatched session empties the window", () => {
    const db = createDatabase(":memory:");
    seedFilterFixture(db);

    const matched = buildTimelineView(db, {
      id: "S1",
      view: "turns",
      filter: { session: "S1" },
    });
    const mismatched = buildTimelineView(db, {
      id: "S1",
      view: "turns",
      filter: { session: "S999" },
    });

    expect(matched.windowTurns.length).toBe(4);
    expect(mismatched.windowTurns.length).toBe(0);
  });

  it("an invalid filter.time is a timeline error, same grammar as recall's", () => {
    const db = createDatabase(":memory:");
    seedFilterFixture(db);

    const output = timelineQuery(db, {
      id: "S1",
      filter: { time: "yesterday" },
    });

    expect(output).toBe('timeline error: invalid time selector "yesterday"');
  });

  // Ticket 05 (blocked by this ticket) retires the phases VIEW; the
  // underlying `segmentPhases` grouping utility is unrelated to `filter` and
  // stays live (its own `describe("segmentPhases")` suite above), so this
  // filter suite does not touch it.
});
