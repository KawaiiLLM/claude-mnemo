import { describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession, type UpsertSessionInput } from "../../src/db/sessions";
import { getTurn, type TurnRecord } from "../../src/db/turns";
import { resolveTranscriptPath } from "../../src/shared/paths";
import {
  buildContextTimelineView,
  buildTimelineView,
  cleanPromptForLabel,
  computeTypesDistribution,
  detectBrokenPromptPairs,
  buildCorrectionGraph,
  detectShapeSignals,
  formatDuration,
  formatGap,
  formatLocalDate,
  formatLocalTime,
  getSystemTimezone,
  extractSourceTags,
  isVersionBumpTurn,
  milestoneEffGrade,
  milestoneMarker,
  milestoneTieBreak,
  OUTCOME_TAGS,
  parseContentReferences,
  parseTimelineId,
  renderTimeline,
  MILESTONE_REFERENCE_CAP,
  MILESTONE_REFERENCE_PARSE_CAP,
  resolveWindow,
  segmentPhases,
  selectMilestoneTurns,
  timelineQuery,
  truncateText,
  type MilestoneSelection,
  type TimelineView,
} from "../../src/mcp/timeline";

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
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
    type: null,
    significanceGrade: null,
    tags: [],
    filesRead: [],
    filesModified: [],
    toolCallCount: 0,
    parentTurnId: null,
    citesRecorded: false,
    createdAtEpoch: 1000,
    updatedAtEpoch: null,
    ...overrides,
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
      type,
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
      promptNumber >= count - 2 ? null : "discovery",
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
      row.type,
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

/**
 * Hand-built stand-in for `getSessionEffectiveCitations`: `{ citingId: [[citedId,
 * relation], ...] }`. Turns absent from the map cite nothing, which is what the
 * real reader returns for a turn with no edges and no inline `[T<n>]`.
 */
function structuredCitations(
  spec: Record<number, Array<[number, string]>>,
): Map<number, { source: "structured"; citedTurnIds: number[]; edges: unknown[] }> {
  const map = new Map<
    number,
    { source: "structured"; citedTurnIds: number[]; edges: unknown[] }
  >();
  for (const [citing, edges] of Object.entries(spec)) {
    const citingTurnId = Number(citing);
    map.set(citingTurnId, {
      source: "structured",
      citedTurnIds: [...new Set(edges.map(([citedTurnId]) => citedTurnId))],
      edges: edges.map(([citedTurnId, relation]) => ({
        citingTurnId,
        citedTurnId,
        relation,
        createdAtEpoch: 0,
      })),
    });
  }
  return map;
}

/**
 * The legacy half of the same seam: `cites_recorded = 0`, so the ids came out of
 * the inline `[T<n>]` grammar and carry no relation at all.
 */
function inlineCitations(
  spec: Record<number, number[]>,
): Map<number, { source: "inline"; citedTurnIds: number[]; edges: unknown[] }> {
  const map = new Map<
    number,
    { source: "inline"; citedTurnIds: number[]; edges: unknown[] }
  >();
  for (const [citing, citedTurnIds] of Object.entries(spec)) {
    map.set(Number(citing), {
      source: "inline",
      citedTurnIds: [...new Set(citedTurnIds)],
      edges: [],
    });
  }
  return map;
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

describe("truncateText", () => {
  it("returns shorter text unchanged", () => {
    expect(truncateText("hello", 10)).toBe("hello");
  });

  it("truncates longer text and appends an ellipsis", () => {
    expect(truncateText("hello world", 5)).toBe("hello…");
  });

  it("keeps exactly-max text unchanged", () => {
    expect(truncateText("hello", 5)).toBe("hello");
  });

  it("handles an empty string", () => {
    expect(truncateText("", 10)).toBe("");
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
      bugfix: 0,
      feature: 0,
      refactor: 0,
      change: 0,
      discovery: 2,
      decision: 0,
      compact: 0,
      pending: 0,
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

describe("segmentPhases", () => {
  it("returns empty for no turns", () => {
    expect(segmentPhases([])).toEqual([]);
  });

  it("turns a single typed turn into one phase", () => {
    const phases = segmentPhases([
      turn({ promptNumber: 1, type: "discovery", createdAtEpoch: 1000 }),
    ]);

    expect(phases).toHaveLength(1);
    expect(phases[0].type).toBe("discovery");
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
      type: "discovery",
      startPromptNumber: 1,
      endPromptNumber: 3,
    });
    expect(phases[1]).toMatchObject({
      type: "decision",
      startPromptNumber: 4,
      endPromptNumber: 4,
    });
    expect(phases[2]).toMatchObject({
      type: "discovery",
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
      type: "discovery",
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
      type: null,
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
      type: "discovery",
      startPromptNumber: 1,
      endPromptNumber: 2,
      durationMs: 100_000,
    });
    expect(phases[1]).toMatchObject({
      kind: "typed",
      type: "decision",
      startPromptNumber: 3,
      endPromptNumber: 3,
    });
    expect(phases[2]).toMatchObject({
      kind: "pending",
      type: null,
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
      bugfix: 0,
      feature: 0,
      refactor: 0,
      change: 1,
      discovery: 2,
      decision: 1,
      compact: 1,
      pending: 2,
    });
  });

  it("excludes undone turns from the counts", () => {
    const distribution = computeTypesDistribution([
      turn({ promptNumber: 1, type: "discovery" }),
      turn({ promptNumber: 2, type: "discovery", status: "undone" }),
    ]);

    expect(distribution.discovery).toBe(1);
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

describe("milestoneEffGrade", () => {
  const era = 1_784_711_427;
  const legacy = (overrides: Partial<TurnRecord>) =>
    milestoneEffGrade(turn({ createdAtEpoch: era - 1, ...overrides }), era);
  const current = (overrides: Partial<TurnRecord>) =>
    milestoneEffGrade(turn({ createdAtEpoch: era, ...overrides }), era);

  it("takes an era turn's grade verbatim", () => {
    expect(current({ type: "discovery", significanceGrade: 4 })).toBe(4);
    expect(current({ type: "decision", significanceGrade: 1 })).toBe(1);
    expect(current({ type: "feature", significanceGrade: 0, filesModified: ["a.ts"] })).toBe(0);
  });

  it("treats an ungraded era turn as 0 (pool-ineligible until it is graded)", () => {
    expect(current({ type: "decision", significanceGrade: null })).toBe(0);
    expect(current({ type: "feature", significanceGrade: null, filesModified: ["a.ts"] })).toBe(0);
  });

  it("maps a legacy turn by type and ignores its stored grade entirely", () => {
    expect(legacy({ type: "decision" })).toBe(3);
    expect(legacy({ type: "feature", filesModified: ["a.ts"] })).toBe(2);
    expect(legacy({ type: "refactor", filesModified: ["a.ts"] })).toBe(2);
    expect(legacy({ type: "bugfix" })).toBe(2);
    expect(legacy({ type: "change", filesModified: ["a.ts"] })).toBe(1);
    expect(legacy({ type: "discovery" })).toBe(1);
    expect(legacy({ type: null })).toBe(0);
    // A stored grade on a pre-era turn carries pre-era semantics: never read.
    expect(legacy({ type: "discovery", significanceGrade: 4 })).toBe(1);
    expect(legacy({ type: "decision", significanceGrade: 0 })).toBe(3);
  });

  it("zeroes a legacy artifact type that modified no file", () => {
    expect(legacy({ type: "feature", filesModified: [] })).toBe(0);
    expect(legacy({ type: "refactor", filesModified: [] })).toBe(0);
    expect(legacy({ type: "change", filesModified: [] })).toBe(0);
    // bugfix/discovery/decision are not artifact types and keep their mapping.
    expect(legacy({ type: "bugfix", filesModified: [] })).toBe(2);
  });

  it("adds one for an insight but caps legacy at 3, so no legacy turn is ever an anchor", () => {
    expect(legacy({ type: "discovery", insight: "- finding" })).toBe(2);
    expect(legacy({ type: "bugfix", insight: "- finding" })).toBe(3);
    expect(legacy({ type: "decision", insight: "- finding" })).toBe(3);
  });

  it("flips at the era boundary for two otherwise identical turns", () => {
    const shape = { type: "decision" as const, significanceGrade: null };
    expect(legacy(shape)).toBe(3);
    expect(current(shape)).toBe(0);
  });
});

describe("milestoneTieBreak", () => {
  it("never reaches a whole grade tier even with every signal maxed", () => {
    const maxed = milestoneTieBreak(
      turn({ insight: "- x", filesModified: ["docs/plans/a.md"] }),
      99,
    );
    expect(maxed).toBeLessThan(1);
    expect(maxed).toBeCloseTo(0.9, 6);
  });

  it("counts distinct citers up to two", () => {
    const plain = turn({});
    expect(milestoneTieBreak(plain, 0)).toBe(0);
    expect(milestoneTieBreak(plain, 1)).toBeCloseTo(0.25, 6);
    expect(milestoneTieBreak(plain, 2)).toBeCloseTo(0.5, 6);
    expect(milestoneTieBreak(plain, 9)).toBeCloseTo(0.5, 6);
  });

  it("weights insight and pure-spec independently", () => {
    expect(milestoneTieBreak(turn({ insight: "- x" }))).toBeCloseTo(0.25, 6);
    expect(milestoneTieBreak(turn({ filesModified: ["docs/plans/a.md"] }))).toBeCloseTo(0.15, 6);
    // `[]` is the empty-insight sentinel, not an insight.
    expect(milestoneTieBreak(turn({ insight: "[]" }))).toBe(0);
  });
});

describe("buildCorrectionGraph", () => {
  const era = 1_784_711_427;
  const base = 1_779_782_400; // pre-era: the inline/tag adapter is live here

  it("derives victimhood from a supersedes edge alone, with no tag on the victim", () => {
    const seq = [
      turn({ id: 20, promptNumber: 2, type: "decision", title: "first conclusion", createdAtEpoch: era }),
      turn({ id: 30, promptNumber: 3, type: "decision", title: "overturns it", citesRecorded: true, createdAtEpoch: era + 60 }),
    ];
    const g = buildCorrectionGraph(seq, {
      citations: structuredCitations({ 30: [[20, "supersedes"]] }),
      taskCausalityEraCutoffEpoch: era,
    });
    expect([...g.correctors]).toEqual([30]);
    expect([...g.supersededVictims]).toEqual([20]);
    // Back-link data rides along: victim id → superseding turn ids.
    expect(g.supersededBy.get(20)).toEqual([30]);
  });

  it("ignores a non-supersedes relation (builds-on is consumption, not correction)", () => {
    const seq = [
      turn({ id: 20, promptNumber: 2, type: "decision", createdAtEpoch: era }),
      turn({ id: 30, promptNumber: 3, type: "feature", citesRecorded: true, createdAtEpoch: era + 60 }),
    ];
    const g = buildCorrectionGraph(seq, {
      citations: structuredCitations({ 30: [[20, "builds-on"], [20, "evidence-for"]] }),
      taskCausalityEraCutoffEpoch: era,
    });
    expect(g.correctors.size).toBe(0);
    expect(g.supersededVictims.size).toBe(0);
  });

  it("orders multiple superseders of one victim by prompt number", () => {
    const seq = [
      turn({ id: 20, promptNumber: 2, type: "decision", createdAtEpoch: era }),
      turn({ id: 90, promptNumber: 9, type: "decision", citesRecorded: true, createdAtEpoch: era + 120 }),
      turn({ id: 30, promptNumber: 3, type: "decision", citesRecorded: true, createdAtEpoch: era + 60 }),
    ];
    const g = buildCorrectionGraph(seq, {
      citations: structuredCitations({
        30: [[20, "supersedes"]],
        90: [[20, "supersedes"]],
      }),
      taskCausalityEraCutoffEpoch: era,
    });
    expect(g.supersededBy.get(20)).toEqual([30, 90]);
  });

  it("reads a pre-era citer's rolled-back victim through the legacy inline adapter", () => {
    const seq = [
      turn({ id: 20, promptNumber: 2, type: "discovery", tags: ["rolled-back"], createdAtEpoch: base }),
      turn({ id: 30, promptNumber: 3, type: "bugfix", content: "fixes [T20]", createdAtEpoch: base + 60 }),
    ];
    const g = buildCorrectionGraph(seq, { taskCausalityEraCutoffEpoch: era });
    expect([...g.correctors]).toEqual([30]);
    expect([...g.supersededVictims]).toEqual([20]);
  });

  it("does NOT apply the tag adapter to an era citer — edges are its only signal", () => {
    const seq = [
      turn({ id: 20, promptNumber: 2, type: "discovery", tags: ["rolled-back"], createdAtEpoch: era }),
      turn({ id: 30, promptNumber: 3, type: "bugfix", content: "fixes [T20]", createdAtEpoch: era + 60 }),
    ];
    const g = buildCorrectionGraph(seq, { taskCausalityEraCutoffEpoch: era });
    expect(g.correctors.size).toBe(0);
    expect(g.supersededVictims.size).toBe(0);
  });

  it("does NOT apply the tag adapter to a pre-era citer whose edges are structured", () => {
    // Created pre-era, extracted post-deployment: `cites_recorded = 1` makes the
    // edge table authoritative (spec §B), and the stated relation is consumption.
    // Era gating alone would misread this as a correction.
    const seq = [
      turn({ id: 20, promptNumber: 2, type: "discovery", tags: ["rolled-back"], createdAtEpoch: base }),
      turn({ id: 30, promptNumber: 3, type: "bugfix", citesRecorded: true, createdAtEpoch: base + 60 }),
    ];
    const g = buildCorrectionGraph(seq, {
      citations: structuredCitations({ 30: [[20, "builds-on"], [20, "evidence-for"]] }),
      taskCausalityEraCutoffEpoch: era,
    });
    expect(g.correctors.size).toBe(0);
    expect(g.supersededVictims.size).toBe(0);
    expect(g.supersededBy.size).toBe(0);
  });

  it("still applies the tag adapter to the same shape when the source is inline", () => {
    // Identical turns and identical cited ids; only the provenance differs.
    const seq = [
      turn({ id: 20, promptNumber: 2, type: "discovery", tags: ["rolled-back"], createdAtEpoch: base }),
      turn({ id: 30, promptNumber: 3, type: "bugfix", createdAtEpoch: base + 60 }),
    ];
    const g = buildCorrectionGraph(seq, {
      citations: inlineCitations({ 30: [20] }),
      taskCausalityEraCutoffEpoch: era,
    });
    expect([...g.correctors]).toEqual([30]);
    expect([...g.supersededVictims]).toEqual([20]);
    expect(g.supersededBy.get(20)).toEqual([30]);
  });

  it("ignores a legacy cite of a non-reversed predecessor (plain causal reference)", () => {
    const seq = [
      turn({ id: 20, promptNumber: 2, type: "decision", createdAtEpoch: base }),
      turn({ id: 30, promptNumber: 3, type: "feature", content: "builds on [T20]", createdAtEpoch: base + 60 }),
    ];
    const g = buildCorrectionGraph(seq, { taskCausalityEraCutoffEpoch: era });
    expect(g.correctors.size).toBe(0);
    expect(g.supersededVictims.size).toBe(0);
  });

  it("ignores forward edges (predecessor guard: a correction points backward)", () => {
    const seq = [
      turn({ id: 20, promptNumber: 2, type: "bugfix", citesRecorded: true, createdAtEpoch: era }),
      turn({ id: 30, promptNumber: 3, type: "discovery", createdAtEpoch: era + 60 }),
    ];
    const g = buildCorrectionGraph(seq, {
      citations: structuredCitations({ 20: [[30, "supersedes"]] }),
      taskCausalityEraCutoffEpoch: era,
    });
    expect(g.correctors.size).toBe(0);
    expect(g.supersededVictims.size).toBe(0);
  });

  it("ignores an edge that resolves to no turn at all", () => {
    const seq = [
      turn({ id: 30, promptNumber: 3, type: "bugfix", citesRecorded: true, createdAtEpoch: era }),
    ];
    const g = buildCorrectionGraph(seq, {
      citations: structuredCitations({ 30: [[999, "supersedes"]] }),
      taskCausalityEraCutoffEpoch: era,
    });
    expect(g.correctors.size).toBe(0);
    expect(g.supersededVictims.size).toBe(0);
  });

  it("promotes a corrector and demotes its victim even when the victim is out of window", () => {
    // Ranged view: the victim is resolved from the full session, not from `turns`.
    const victim = turn({ id: 5, promptNumber: 5, type: "decision", createdAtEpoch: era });
    const seq = [
      turn({ id: 15, promptNumber: 15, type: "bugfix", citesRecorded: true, createdAtEpoch: era + 60 }),
    ];
    const g = buildCorrectionGraph(seq, {
      citations: structuredCitations({ 15: [[5, "supersedes"]] }),
      resolveCited: (id) => (id === 5 ? victim : undefined),
      taskCausalityEraCutoffEpoch: era,
    });
    expect([...g.correctors]).toEqual([15]);
    // It holds no main-row slot to lose, but the demotion still governs whether
    // pull-through revives it as a ↳ row.
    expect([...g.supersededVictims]).toEqual([5]);
    expect(g.supersededBy.get(5)).toEqual([15]);
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

describe("selectMilestoneTurns (grade-first arc)", () => {
  const era = 1_784_711_427;
  const legacyBase = 1_779_782_400;

  const select = (
    rows: TurnRecord[],
    options: Record<string, unknown> = {},
  ): MilestoneSelection =>
    selectMilestoneTurns({
      windowTurns: rows,
      windowSignals: detectShapeSignals(rows),
      compactBoundaries: [],
      taskCausalityEraCutoffEpoch: era,
      ...options,
    } as Parameters<typeof selectMilestoneTurns>[0]);

  const kept = (selection: MilestoneSelection): number[] =>
    selection.kept.map((row) => row.turn.promptNumber);
  const rankedPrompts = (selection: MilestoneSelection): number[] =>
    selection.ranked.map((row) => row.turn.promptNumber);
  const rowFor = (selection: MilestoneSelection, promptNumber: number) =>
    selection.kept.find((row) => row.turn.promptNumber === promptNumber);

  it("admits era turns on grade alone; an ungraded era turn is out and G2 is scored but not admitted", () => {
    const rows = [
      turn({ id: 1, promptNumber: 1, type: "decision", title: "arc origin", significanceGrade: 4, createdAtEpoch: era }),
      turn({ id: 2, promptNumber: 2, type: "decision", title: "not yet graded", significanceGrade: null, createdAtEpoch: era + 60 }),
      turn({ id: 3, promptNumber: 3, type: "discovery", title: "locked the mechanism", significanceGrade: 3, createdAtEpoch: era + 120 }),
      turn({ id: 4, promptNumber: 4, type: "discovery", title: "supporting evidence", significanceGrade: 2, createdAtEpoch: era + 180 }),
      turn({ id: 5, promptNumber: 5, type: "change", title: "end", significanceGrade: 1, filesModified: ["a.ts"], createdAtEpoch: era + 240 }),
    ];

    const result = select(rows);
    // T5 is the window's last titled row → structural endpoint despite G1.
    expect(kept(result)).toEqual([1, 3, 5]);
    expect(rowFor(result, 3)?.effGrade).toBe(3);
    expect(rowFor(result, 1)?.alwaysKeep).toBe(true);
    // G2 clears the pool gate and is ranked, but the spine bar is G3.
    expect(rankedPrompts(result)).toContain(4);
    expect(rankedPrompts(result)).not.toContain(2);
  });

  it("flips selection at the era boundary for two identically shaped decisions", () => {
    const build = (createdAtEpoch: number): TurnRecord[] => [
      turn({ id: 1, promptNumber: 1, type: "discovery", title: "start", significanceGrade: 3, createdAtEpoch: era + 1_000 }),
      turn({ id: 2, promptNumber: 2, type: "decision", title: "subject", significanceGrade: null, createdAtEpoch }),
      turn({ id: 3, promptNumber: 3, type: "discovery", title: "end", significanceGrade: 3, createdAtEpoch: era + 2_000 }),
    ];

    // Pre-era: the type map says decision = G3 → spine.
    expect(kept(select(build(era - 1)))).toContain(2);
    // Era: ungraded means ungraded, not "infer from type".
    expect(kept(select(build(era)))).not.toContain(2);
  });

  it("keeps legacy window endpoints structurally, whatever their grade", () => {
    const rows = [
      turn({ id: 1, promptNumber: 1, type: null, title: "legacy start", createdAtEpoch: legacyBase }),
      turn({ id: 2, promptNumber: 2, type: "discovery", title: "legacy noise", createdAtEpoch: legacyBase + 60 }),
      turn({ id: 3, promptNumber: 3, type: "change", title: "legacy end", filesModified: [], createdAtEpoch: legacyBase + 120 }),
    ];

    const result = select(rows);
    expect(kept(result)).toEqual([1, 3]);
    expect(rowFor(result, 1)?.effGrade).toBe(0);
    expect(rowFor(result, 1)?.alwaysKeep).toBe(true);
    expect(rowFor(result, 1)?.spine).toBe(false);
  });

  it("gives a compact marker no kept slot and no endpoint claim", () => {
    const rows = [
      turn({ id: 1, promptNumber: 1, type: "compact", title: "/compact", createdAtEpoch: era }),
      turn({ id: 2, promptNumber: 2, type: "discovery", title: "graded work", significanceGrade: 3, createdAtEpoch: era + 60 }),
      turn({ id: 3, promptNumber: 3, type: "compact", title: "/compact", createdAtEpoch: era + 120 }),
    ];

    const result = select(rows);
    expect(kept(result)).toEqual([2]);
    expect(result.ranked.map((row) => row.turn.type)).not.toContain("compact");
  });

  it("promotes a G0 corrector to the spine and demotes what it supersedes into a ↳ antecedent", () => {
    const rows = [
      turn({ id: 1, promptNumber: 1, type: "discovery", title: "start", significanceGrade: 3, createdAtEpoch: era }),
      turn({ id: 2, promptNumber: 2, type: "decision", title: "first conclusion", significanceGrade: 3, createdAtEpoch: era + 60 }),
      turn({ id: 3, promptNumber: 3, type: "discovery", title: "the correction", significanceGrade: 0, citesRecorded: true, createdAtEpoch: era + 120 }),
      turn({ id: 4, promptNumber: 4, type: "discovery", title: "end", significanceGrade: 3, createdAtEpoch: era + 180 }),
    ];

    const result = select(rows, {
      citations: structuredCitations({ 3: [[2, "supersedes"]] }),
    });

    expect(kept(result)).toEqual([1, 3, 4]);
    expect(rowFor(result, 3)?.effGrade).toBe(3);
    expect(rowFor(result, 3)?.alwaysKeep).toBe(true);
    expect(result.pulled.map((p) => [p.turn.promptNumber, p.citedByPromptNumber])).toEqual([
      [2, 3],
    ]);
    expect(result.pulled[0]!.effGrade).toBe(1);
    expect(result.pulled[0]!.supersededBy).toEqual([3]);
  });

  it("leaves a corrector demoted when it is itself superseded (① runs before ②)", () => {
    const rows = [
      turn({ id: 1, promptNumber: 1, type: "discovery", title: "start", significanceGrade: 3, createdAtEpoch: era }),
      turn({ id: 2, promptNumber: 2, type: "decision", title: "first answer", significanceGrade: 2, createdAtEpoch: era + 60 }),
      turn({ id: 3, promptNumber: 3, type: "decision", title: "second answer", significanceGrade: 3, citesRecorded: true, createdAtEpoch: era + 120 }),
      turn({ id: 4, promptNumber: 4, type: "decision", title: "final answer", significanceGrade: 0, citesRecorded: true, createdAtEpoch: era + 180 }),
      turn({ id: 5, promptNumber: 5, type: "discovery", title: "end", significanceGrade: 3, createdAtEpoch: era + 240 }),
    ];

    const result = select(rows, {
      citations: structuredCitations({
        3: [[2, "supersedes"]],
        4: [[3, "supersedes"]],
      }),
    });

    // T3 corrected T2 but was itself overturned. Its own G3 is floored to 1 —
    // demotion runs first, so the promotion it would otherwise earn never lands.
    expect(kept(result)).toEqual([1, 4, 5]);
    expect(rowFor(result, 4)?.alwaysKeep).toBe(true);
    const antecedent = result.pulled.find((p) => p.turn.promptNumber === 3);
    expect(antecedent?.effGrade).toBe(1);
    expect(antecedent?.supersededBy).toEqual([4]);
    // T2's only citer (T3) is not a kept row, so T2 is not pulled either: ↳ rows
    // hang off admitted rows, not off the whole citation graph.
    expect(result.pulled.map((p) => p.turn.promptNumber)).toEqual([3]);
  });

  it("moves the anchor from a superseded G4 to its corrector", () => {
    const rows = [
      turn({ id: 1, promptNumber: 1, type: "discovery", title: "start", significanceGrade: 3, createdAtEpoch: era }),
      turn({ id: 2, promptNumber: 2, type: "decision", title: "arc origin, later refounded", significanceGrade: 4, createdAtEpoch: era + 60 }),
      turn({ id: 3, promptNumber: 3, type: "decision", title: "refoundation", significanceGrade: 2, citesRecorded: true, createdAtEpoch: era + 120 }),
      turn({ id: 4, promptNumber: 4, type: "discovery", title: "end", significanceGrade: 3, createdAtEpoch: era + 180 }),
    ];

    const result = select(rows, {
      citations: structuredCitations({ 3: [[2, "supersedes"]] }),
    });

    expect(kept(result)).toEqual([1, 3, 4]);
    // The G4 anchor claim dies with the demotion; the G2 corrector inherits it.
    expect(rowFor(result, 3)?.effGrade).toBe(3);
    expect(rowFor(result, 3)?.alwaysKeep).toBe(true);
    expect(result.pulled.map((p) => p.turn.promptNumber)).toEqual([2]);
  });

  it("keeps a victim that is also a window endpoint and hands it the back-link", () => {
    const rows = [
      turn({ id: 1, promptNumber: 1, type: "decision", title: "opening premise", significanceGrade: 4, createdAtEpoch: era }),
      turn({ id: 2, promptNumber: 2, type: "decision", title: "overturns the premise", significanceGrade: 3, citesRecorded: true, createdAtEpoch: era + 60 }),
    ];

    const result = select(rows, {
      citations: structuredCitations({ 2: [[1, "supersedes"]] }),
    });

    expect(kept(result)).toEqual([1, 2]);
    expect(rowFor(result, 1)?.effGrade).toBe(1);
    expect(rowFor(result, 1)?.spine).toBe(false);
    expect(rowFor(result, 1)?.supersededBy).toEqual([2]);
    // Already a main row, so it is not ALSO pulled in as its corrector's ↳.
    expect(result.pulled).toHaveLength(0);
  });

  it("keeps a reversed turn nobody corrected, and marks it", () => {
    const rows = [
      turn({ id: 1, promptNumber: 1, type: "decision", title: "start", createdAtEpoch: legacyBase }),
      turn({ id: 2, promptNumber: 2, type: "discovery", title: "rewound direction", tags: ["rolled-back"], createdAtEpoch: legacyBase + 60 }),
      turn({ id: 3, promptNumber: 3, type: "decision", title: "end", createdAtEpoch: legacyBase + 120 }),
    ];

    const result = select(rows);
    expect(kept(result)).toContain(2);
    expect(rowFor(result, 2)?.marker).toBe("reversed");
    expect(rowFor(result, 2)?.alwaysKeep).toBe(true);
  });

  it("demotes a pre-era rolled-back victim through the legacy inline adapter", () => {
    const rows = [
      turn({ id: 10, promptNumber: 1, type: "decision", title: "start", createdAtEpoch: legacyBase }),
      turn({
        id: 20,
        promptNumber: 2,
        type: "discovery",
        title: "concluded overhead is 2.5%",
        tags: ["rolled-back"],
        createdAtEpoch: legacyBase + 60,
      }),
      turn({
        id: 30,
        promptNumber: 3,
        type: "bugfix",
        title: "pricing bug fixed; overhead is 7-10%",
        content: "Corrected the earlier figure [T20].",
        filesModified: ["a.ts"],
        createdAtEpoch: legacyBase + 120,
      }),
      turn({ id: 40, promptNumber: 4, type: "decision", title: "end", createdAtEpoch: legacyBase + 180 }),
    ];

    const result = select(rows);
    expect(kept(result)).toEqual([1, 3, 4]);
    expect(rowFor(result, 3)?.effGrade).toBe(3); // legacy bugfix G2, promoted
    expect(rowFor(result, 3)?.marker).toBeNull();
    expect(result.pulled.map((p) => p.turn.promptNumber)).toEqual([2]);
    expect(result.pulled[0]!.supersededBy).toEqual([3]);
  });

  it("revives a cited skipped turn as an antecedent with a prompt-prefix pseudo-title", () => {
    const longPrompt =
      "why does the extractor drop the boundary marker when the wrapper lands first and the turn is already claimed";
    const rows = [
      turn({ id: 1, promptNumber: 1, type: "discovery", title: "start", significanceGrade: 3, createdAtEpoch: era }),
      turn({
        id: 2,
        promptNumber: 2,
        status: "skipped",
        type: null,
        title: null,
        userPrompt: longPrompt,
        createdAtEpoch: era + 60,
      }),
      turn({ id: 3, promptNumber: 3, type: "decision", title: "the answer", significanceGrade: 3, citesRecorded: true, createdAtEpoch: era + 120 }),
    ];

    const result = select(rows, {
      citations: structuredCitations({ 3: [[2, "evidence-for"]] }),
    });

    expect(kept(result)).toEqual([1, 3]);
    const antecedent = result.pulled[0]!;
    expect(antecedent.turn.promptNumber).toBe(2);
    expect(antecedent.effGrade).toBe(0);
    expect(antecedent.label).toBe(`${longPrompt.slice(0, 60)}…`);
  });

  it("prefers a stored title over the prompt prefix for a ↳ label", () => {
    const rows = [
      turn({ id: 1, promptNumber: 1, type: "discovery", title: "start", significanceGrade: 3, createdAtEpoch: era }),
      turn({
        id: 2,
        promptNumber: 2,
        status: "skipped",
        type: null,
        title: "minimal title for a skipped turn",
        userPrompt: "raw prompt text that must not win",
        createdAtEpoch: era + 60,
      }),
      turn({ id: 3, promptNumber: 3, type: "decision", title: "the answer", significanceGrade: 3, citesRecorded: true, createdAtEpoch: era + 120 }),
    ];

    const result = select(rows, {
      citations: structuredCitations({ 3: [[2, "evidence-for"]] }),
    });
    expect(result.pulled[0]!.label).toBe("minimal title for a skipped turn");
  });

  it("assigns a shared antecedent to its earliest kept citer only", () => {
    const rows = [
      turn({ id: 1, promptNumber: 1, type: "discovery", title: "start", significanceGrade: 3, createdAtEpoch: era }),
      turn({ id: 2, promptNumber: 2, type: "discovery", title: "shared evidence", significanceGrade: 2, createdAtEpoch: era + 60 }),
      turn({ id: 3, promptNumber: 3, type: "decision", title: "first consumer", significanceGrade: 3, citesRecorded: true, createdAtEpoch: era + 120 }),
      turn({ id: 4, promptNumber: 4, type: "decision", title: "second consumer", significanceGrade: 3, citesRecorded: true, createdAtEpoch: era + 180 }),
    ];

    const result = select(rows, {
      citations: structuredCitations({
        3: [[2, "evidence-for"]],
        4: [[2, "evidence-for"]],
      }),
    });

    expect(result.pulled.map((p) => [p.turn.promptNumber, p.citedByPromptNumber])).toEqual([
      [2, 3],
    ]);
  });

  it("gates the pool on effGrade, so content bonuses cannot lift a G1 turn into it", () => {
    const rows = [
      turn({ id: 1, promptNumber: 1, type: "discovery", title: "start", significanceGrade: 3, createdAtEpoch: era }),
      turn({
        id: 2,
        promptNumber: 2,
        type: "change",
        title: "G1 carrying every bonus the old model scored",
        significanceGrade: 1,
        insight: "- a real insight",
        filesModified: ["docs/plans/scoring.md"],
        createdAtEpoch: era + 60,
      }),
      turn({ id: 3, promptNumber: 3, type: "discovery", title: "plain G2", significanceGrade: 2, createdAtEpoch: era + 120 }),
      turn({ id: 4, promptNumber: 4, type: "discovery", title: "citer a", significanceGrade: 0, citesRecorded: true, createdAtEpoch: era + 180 }),
      turn({ id: 5, promptNumber: 5, type: "discovery", title: "citer b", significanceGrade: 0, citesRecorded: true, createdAtEpoch: era + 240 }),
      turn({ id: 6, promptNumber: 6, type: "discovery", title: "end", significanceGrade: 3, createdAtEpoch: era + 300 }),
    ];

    const result = select(rows, {
      citations: structuredCitations({
        4: [[2, "builds-on"]],
        5: [[2, "builds-on"]],
      }),
    });

    // Old model: 1 base + 3 spec bonus + 2 citations = 6, well past any G3.
    expect(rankedPrompts(result)).not.toContain(2);
    expect(kept(result)).not.toContain(2);
    // A bare G2 with no bonuses at all still clears the gate.
    expect(rankedPrompts(result)).toContain(3);
  });

  it("ranks by score, then tool count, then the earlier prompt", () => {
    const rows = [
      turn({ id: 1, promptNumber: 1, type: "discovery", title: "start", significanceGrade: 3, toolCallCount: 0, createdAtEpoch: era }),
      turn({ id: 2, promptNumber: 2, type: "discovery", title: "five tools", significanceGrade: 3, toolCallCount: 5, createdAtEpoch: era + 60 }),
      turn({ id: 3, promptNumber: 3, type: "discovery", title: "five tools too", significanceGrade: 3, toolCallCount: 5, createdAtEpoch: era + 120 }),
      turn({ id: 4, promptNumber: 4, type: "discovery", title: "nine tools", significanceGrade: 3, toolCallCount: 9, createdAtEpoch: era + 180 }),
      turn({ id: 5, promptNumber: 5, type: "discovery", title: "insight tie-break", significanceGrade: 3, insight: "- finding", toolCallCount: 0, createdAtEpoch: era + 240 }),
      turn({ id: 6, promptNumber: 6, type: "discovery", title: "end", significanceGrade: 3, toolCallCount: 0, createdAtEpoch: era + 300 }),
    ];

    const result = select(rows);
    expect(rankedPrompts(result)).toEqual([5, 4, 2, 3, 1, 6]);
    // The tie-break rides inside the tier: everything is still a G3.
    expect(result.ranked.every((row) => row.effGrade === 3)).toBe(true);
    expect(result.ranked[0]!.score).toBeLessThan(4);
  });

  it("keeps every graded row on a heavy day — the budget moved to the renderer", () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      turn({
        id: index + 1,
        promptNumber: index + 1,
        type: "decision",
        title: `m${index + 1}`,
        significanceGrade: 3,
        createdAtEpoch: era + index * 60,
      }),
    );

    const result = select(rows);
    expect(result.kept).toHaveLength(30);
    expect(result.overflowByDay).toHaveLength(0);
  });

  it("reports the day's unrendered turns as the overflow hint, excluding pulled rows", () => {
    const day = 24 * 60 * 60;
    const rows = [
      // Day one: plain noise, nothing cited — every dropped row is invisible.
      turn({ id: 1, promptNumber: 1, type: "decision", title: "start", significanceGrade: 3, createdAtEpoch: era }),
      ...Array.from({ length: 5 }, (_, index) =>
        turn({
          id: index + 2,
          promptNumber: index + 2,
          type: "discovery",
          title: `noise ${index + 1}`,
          significanceGrade: 1,
          createdAtEpoch: era + (index + 1) * 60,
        }),
      ),
      turn({ id: 7, promptNumber: 7, type: "decision", title: "end of day one", significanceGrade: 3, createdAtEpoch: era + 360 }),
      // Day two: T8 gets no main row but IS rendered as T9's ↳ antecedent, so it
      // is visible and must not also be counted as hidden. T10 is the only turn
      // on that day with no row of any kind.
      turn({ id: 8, promptNumber: 8, type: "discovery", title: "cited evidence", significanceGrade: 2, createdAtEpoch: era + day }),
      turn({ id: 9, promptNumber: 9, type: "decision", title: "consumer", significanceGrade: 3, citesRecorded: true, createdAtEpoch: era + day + 60 }),
      turn({ id: 10, promptNumber: 10, type: "discovery", title: "day two noise", significanceGrade: 1, createdAtEpoch: era + day + 120 }),
      turn({ id: 11, promptNumber: 11, type: "decision", title: "end", significanceGrade: 3, createdAtEpoch: era + day + 180 }),
    ];

    const result = select(rows, {
      citations: structuredCitations({ 9: [[8, "evidence-for"]] }),
    });
    expect(kept(result)).toEqual([1, 7, 9, 11]);
    expect(result.pulled.map((p) => [p.turn.promptNumber, p.citedByPromptNumber])).toEqual([
      [8, 9],
    ]);

    expect(result.overflowByDay).toHaveLength(2);
    expect(result.overflowByDay[0]!.count).toBe(5);
    expect(result.overflowByDay[0]!.firstPrompt).toBe(2);
    expect(result.overflowByDay[0]!.lastPrompt).toBe(6);
    // 2 non-kept turns on day two, but only T10 is unrendered.
    expect(result.overflowByDay[1]!.count).toBe(1);
    expect(result.overflowByDay[1]!.firstPrompt).toBe(10);
    expect(result.overflowByDay[1]!.lastPrompt).toBe(10);
  });

  it("coalesces a same-day outcome chain so only its tail carries the outcome marker", () => {
    const rows = [
      turn({ id: 1, promptNumber: 1, type: "decision", title: "start", significanceGrade: 3, createdAtEpoch: era }),
      turn({ id: 2, promptNumber: 2, type: "feature", title: "0.2.38 implementation complete", significanceGrade: 3, tags: ["release"], filesModified: ["a.ts"], createdAtEpoch: era + 60 }),
      turn({ id: 3, promptNumber: 3, type: "feature", title: "0.2.38 verified", significanceGrade: 3, tags: ["released"], filesModified: ["b.ts"], createdAtEpoch: era + 120 }),
      turn({ id: 4, promptNumber: 4, type: "feature", title: "0.2.38 merged", significanceGrade: 3, tags: ["merged"], filesModified: ["c.ts"], createdAtEpoch: era + 180 }),
      turn({ id: 5, promptNumber: 5, type: "decision", title: "end", significanceGrade: 3, createdAtEpoch: era + 240 }),
    ];

    const result = select(rows);
    expect(
      result.kept.filter((row) => row.marker === "outcome").map((row) => row.turn.promptNumber),
    ).toEqual([4]);
  });

  it("keeps separate outcome markers when version or prompt gap breaks the chain", () => {
    const rows = [
      turn({ id: 1, promptNumber: 1, type: "decision", title: "start", significanceGrade: 3, createdAtEpoch: era }),
      turn({ id: 2, promptNumber: 2, type: "feature", title: "0.2.38 released", significanceGrade: 3, tags: ["release"], filesModified: ["a.ts"], createdAtEpoch: era + 60 }),
      turn({ id: 3, promptNumber: 3, type: "feature", title: "0.2.39 released", significanceGrade: 3, tags: ["release"], filesModified: ["b.ts"], createdAtEpoch: era + 120 }),
      turn({ id: 4, promptNumber: 10, type: "feature", title: "0.2.39 follow-up release", significanceGrade: 3, tags: ["release"], filesModified: ["c.ts"], createdAtEpoch: era + 180 }),
      turn({ id: 5, promptNumber: 11, type: "decision", title: "end", significanceGrade: 3, createdAtEpoch: era + 240 }),
    ];

    const result = select(rows);
    expect(
      result.kept.filter((row) => row.marker === "outcome").map((row) => row.turn.promptNumber),
    ).toEqual([2, 3, 10]);
  });

  it("resolves a corrector's out-of-window victim from the full-session set", () => {
    const victim = turn({ id: 5, promptNumber: 5, type: "decision", title: "early premise", significanceGrade: 4, createdAtEpoch: era });
    const windowRows = [
      turn({ id: 15, promptNumber: 15, type: "decision", title: "overturns it", significanceGrade: 0, citesRecorded: true, createdAtEpoch: era + 600 }),
      turn({ id: 16, promptNumber: 16, type: "discovery", title: "end", significanceGrade: 0, createdAtEpoch: era + 660 }),
    ];

    const result = select(windowRows, {
      sessionTurns: [victim, ...windowRows],
      citations: structuredCitations({ 15: [[5, "supersedes"]] }),
    });

    expect(rowFor(result, 15)?.effGrade).toBe(3);
    // The out-of-window victim is still pulled in as the corrector's ↳ row.
    expect(result.pulled.map((p) => p.turn.promptNumber)).toEqual([5]);
    expect(result.pulled[0]!.effGrade).toBe(1);
  });

  it("returns an empty selection for a window with no candidate rows", () => {
    const result = select([
      turn({ id: 1, promptNumber: 1, status: "skipped", type: null, title: null, createdAtEpoch: era }),
      turn({ id: 2, promptNumber: 2, type: "compact", title: "/compact", createdAtEpoch: era + 60 }),
    ]);
    expect(result).toEqual({ kept: [], ranked: [], pulled: [], overflowByDay: [] });
  });
});

function milestoneFixtureTurns(): TurnRecord[] {
  const day = 24 * 60 * 60;
  const base = 1_779_782_400; // fixed; never Date.now(). Pre-era on purpose.
  const rows: TurnRecord[] = [];
  let pn = 0;
  const add = (over: Partial<TurnRecord>, epoch: number) => {
    pn += 1;
    rows.push(turn({ id: pn, promptNumber: pn, createdAtEpoch: epoch, title: `t${pn}`, ...over }));
  };
  // 6 days × 20 turns = 120. Each day: 14 discovery (legacy G1) + a 5-long
  // decision run (legacy G3) + 1 merged feature with files (legacy G2).
  for (let d = 0; d < 6; d += 1) {
    const dayBase = base + d * day;
    for (let i = 0; i < 14; i += 1) add({ type: "discovery", toolCallCount: 0 }, dayBase + i * 60);
    for (let i = 0; i < 5; i += 1) add({ type: "decision" }, dayBase + (14 + i) * 60);
    add({ type: "feature", filesModified: ["a.ts"], tags: ["merged"] }, dayBase + 19 * 60);
  }
  return rows;
}

describe("milestone selection on a multi-day legacy fixture", () => {
  const result = selectMilestoneTurns({
    windowTurns: milestoneFixtureTurns(),
    windowSignals: detectShapeSignals(milestoneFixtureTurns()),
    compactBoundaries: [],
  });
  const rows = milestoneFixtureTurns();
  const keptPrompts = new Set(result.kept.map((row) => row.turn.promptNumber));

  it("keeps every legacy decision (G3) and no bare discovery (G1)", () => {
    for (const row of rows) {
      if (row.type === "decision") {
        expect(keptPrompts.has(row.promptNumber)).toBe(true);
      }
      if (row.type === "discovery" && row.promptNumber !== 1) {
        expect(keptPrompts.has(row.promptNumber)).toBe(false);
      }
    }
  });

  it("keeps both window endpoints and nothing else off-grade", () => {
    // T1 (first row) and T120 (last titled row) are structural; the other five
    // merged features are G2 and no longer force-kept by their outcome tag.
    expect(keptPrompts.has(1)).toBe(true);
    expect(keptPrompts.has(120)).toBe(true);
    expect(keptPrompts.has(20)).toBe(false);
    expect(result.kept).toHaveLength(32);
  });

  it("accounts for every non-kept day row in the overflow hints", () => {
    const overflowTotal = result.overflowByDay.reduce((sum, day) => sum + day.count, 0);
    expect(overflowTotal).toBe(rows.length - result.kept.length);
  });
});

/**
 * The end-to-end guard: one hand-built session that puts every §C rule on the
 * same board at once — two legacy days read through the inline adapter, two era
 * days read through structured edges, a supersession on each side, a shared
 * antecedent, a skipped turn revived by a citation, and three classes of
 * always-keep anchor (endpoint, corrector, reversed-with-no-corrector).
 *
 * Frozen by construction: fixed epochs, no `Date.now()`, `citesRecorded` set
 * explicitly on every row so the source of each turn's citations is stated
 * rather than inferred.
 */
function mixedArcFixtureTurns(): TurnRecord[] {
  const day = 24 * 60 * 60;
  const legacy = 1_779_782_400; // pre-era: the inline/tag adapter is live
  const era = 1_784_711_427; // task-causality cutoff: grades are authoritative
  const rows: TurnRecord[] = [];
  const add = (
    promptNumber: number,
    epoch: number,
    over: Partial<TurnRecord>,
  ) => {
    rows.push(turn({ id: promptNumber, promptNumber, createdAtEpoch: epoch, ...over }));
  };

  // ── Day A (legacy) ── an inline citation that is NOT a correction.
  add(1, legacy, { type: "discovery", title: "legacy kickoff" });
  add(2, legacy + 60, { type: "discovery", title: "legacy measurement" });
  add(3, legacy + 120, { type: "discovery", title: "legacy noise a" });
  add(4, legacy + 180, { type: "discovery", title: "legacy noise b" });
  add(5, legacy + 240, { type: "decision", title: "legacy conclusion" });
  add(6, legacy + 300, {
    type: "discovery",
    title: "legacy dead end nobody corrected",
    tags: ["rolled-back"],
  });

  // ── Day B (legacy) ── the tag adapter fires for inline provenance and stays
  // silent for a structured `builds-on`, on two turns of identical shape.
  add(7, legacy + day, {
    type: "discovery",
    title: "legacy hypothesis",
    tags: ["rolled-back"],
  });
  add(8, legacy + day + 60, { type: "bugfix", title: "legacy correction" });
  add(9, legacy + day + 120, {
    type: "discovery",
    title: "legacy parallel dead end",
    tags: ["rolled-back"],
  });
  add(10, legacy + day + 180, {
    type: "decision",
    title: "legacy consumer with structured edges",
    citesRecorded: true,
  });
  add(11, legacy + day + 240, { type: "discovery", title: "legacy noise c" });

  // ── Day C (era) ── graded rows, a pulled G2, and a revived skipped probe.
  add(12, era, { type: "decision", title: "arc origin", significanceGrade: 4 });
  add(13, era + 60, { type: "discovery", title: "supporting measurement", significanceGrade: 2 });
  add(14, era + 120, {
    type: "decision",
    title: "mechanism locked",
    significanceGrade: 3,
    citesRecorded: true,
  });
  add(15, era + 180, { type: "discovery", title: "era noise a", significanceGrade: 1 });
  add(16, era + 240, { type: "discovery", title: "era noise b", significanceGrade: 1 });
  add(17, era + 300, {
    status: "skipped",
    type: null,
    title: null,
    userPrompt: "check whether the watchdog ever observes a frozen timestamp",
  });
  add(18, era + 360, {
    type: "decision",
    title: "consumes a skipped probe",
    significanceGrade: 3,
    citesRecorded: true,
  });
  add(19, era + 420, { type: "discovery", title: "era noise c", significanceGrade: 1 });

  // ── Day D (era) ── a structured supersession that moves the anchor off a G4,
  // plus an antecedent shared by two kept rows.
  add(20, era + day, { type: "decision", title: "second premise", significanceGrade: 4 });
  add(21, era + day + 60, { type: "discovery", title: "shared evidence", significanceGrade: 2 });
  add(22, era + day + 120, {
    type: "decision",
    title: "refoundation",
    significanceGrade: 2,
    citesRecorded: true,
  });
  add(23, era + day + 180, {
    type: "decision",
    title: "second consumer of the shared evidence",
    significanceGrade: 3,
    citesRecorded: true,
  });
  add(24, era + day + 240, { type: "discovery", title: "era noise d", significanceGrade: 1 });
  add(25, era + day + 300, { type: "discovery", title: "era noise e", significanceGrade: 1 });
  add(26, era + day + 360, { type: "decision", title: "final wrap", significanceGrade: 3 });

  return rows;
}

function mixedArcCitations() {
  return new Map<number, unknown>([
    // Legacy prose: ids with no relation attached.
    ...inlineCitations({ 5: [2], 8: [7] }),
    // Structured edges: the relation is stated and authoritative.
    ...structuredCitations({
      10: [[9, "builds-on"]],
      14: [[13, "evidence-for"]],
      18: [[17, "builds-on"]],
      22: [
        [20, "supersedes"],
        [21, "evidence-for"],
      ],
      23: [[21, "evidence-for"]],
    }),
  ]);
}

describe("milestone selection on a mixed-era, multi-day arc (frozen fixture)", () => {
  const rows = mixedArcFixtureTurns();
  const result = selectMilestoneTurns({
    windowTurns: rows,
    windowSignals: detectShapeSignals(rows),
    compactBoundaries: [],
    taskCausalityEraCutoffEpoch: 1_784_711_427,
    citations: mixedArcCitations(),
  } as Parameters<typeof selectMilestoneTurns>[0]);
  const rowFor = (promptNumber: number) =>
    result.kept.find((row) => row.turn.promptNumber === promptNumber);

  it("pins the exact set of main rows", () => {
    expect(result.kept.map((row) => row.turn.promptNumber)).toEqual([
      1, 5, 6, 8, 9, 10, 12, 14, 18, 22, 23, 26,
    ]);
  });

  it("keeps each class of always-keep anchor for its own reason", () => {
    // Endpoints: legacy G1 first row, G3 last titled row — structural, off-grade.
    expect(rowFor(1)?.alwaysKeep).toBe(true);
    expect(rowFor(1)?.effGrade).toBe(1);
    expect(rowFor(1)?.spine).toBe(false);
    expect(rowFor(26)?.alwaysKeep).toBe(true);
    // Reversed with nobody correcting it: the dead end is the record.
    expect(rowFor(6)?.marker).toBe("reversed");
    expect(rowFor(6)?.alwaysKeep).toBe(true);
    expect(rowFor(6)?.spine).toBe(false);
    // Era G4.
    expect(rowFor(12)?.effGrade).toBe(4);
    expect(rowFor(12)?.alwaysKeep).toBe(true);
    // Correctors, promoted from legacy G2 and era G2 respectively.
    expect(rowFor(8)?.effGrade).toBe(3);
    expect(rowFor(8)?.alwaysKeep).toBe(true);
    expect(rowFor(22)?.effGrade).toBe(3);
    expect(rowFor(22)?.alwaysKeep).toBe(true);
  });

  it("demotes only the turns an actual supersession names", () => {
    // T7 fell to the legacy inline adapter; T9 carries the same tag and the same
    // citer shape but its edge says `builds-on`, so it keeps its own row.
    expect(result.kept.map((row) => row.turn.promptNumber)).not.toContain(7);
    expect(rowFor(9)?.marker).toBe("reversed");
    expect(rowFor(9)?.alwaysKeep).toBe(true);
    // T20's G4 anchor claim dies with the demotion; T22 inherits it.
    expect(result.kept.map((row) => row.turn.promptNumber)).not.toContain(20);
    expect(rowFor(22)?.spine).toBe(true);
  });

  it("pins the ↳ antecedents, their owners and their back-links", () => {
    expect(
      result.pulled.map((p) => [p.turn.promptNumber, p.citedByPromptNumber, p.effGrade]),
    ).toEqual([
      [2, 5, 1], // plain legacy causal reference
      [7, 8, 1], // demoted victim, legacy adapter
      [13, 14, 2], // era G2 evidence
      [17, 18, 0], // skipped probe revived
      [20, 22, 1], // demoted G4 victim, structured edge
      [21, 22, 2], // shared antecedent: earliest kept citer only
    ]);
    // Back-links ride on the victims and on nobody else.
    expect(result.pulled.filter((p) => p.supersededBy.length > 0).map((p) => [
      p.turn.promptNumber,
      p.supersededBy,
    ])).toEqual([
      [7, [8]],
      [20, [22]],
    ]);
    // T23 also cites T21, but a shared antecedent renders once.
    expect(result.pulled.filter((p) => p.citedByPromptNumber === 23)).toHaveLength(0);
    // A skipped turn has no title, so the ↳ label falls back to its prompt.
    expect(result.pulled[3]!.label).toBe(
      "check whether the watchdog ever observes a frozen timestamp",
    );
  });

  it("counts only turns with no rendered row at all in `+N more`", () => {
    expect(result.overflowByDay.map((d) => [d.count, d.firstPrompt, d.lastPrompt])).toEqual([
      [2, 3, 4], // day A: T2 is pulled, so only the two noise rows are hidden
      [1, 11, 11], // day B: T7 is pulled
      [3, 15, 19], // day C: T13 is pulled, T17 is skipped (never a candidate)
      [2, 24, 25], // day D: T20 and T21 are pulled
    ]);
  });

  it("conserves every candidate turn across kept, pulled and overflow", () => {
    const candidates = rows.filter((row) => row.status !== "skipped" && row.type !== "compact");
    const pulledInWindow = result.pulled.filter((p) => p.turn.status !== "skipped").length;
    const overflowTotal = result.overflowByDay.reduce((sum, d) => sum + d.count, 0);
    expect(result.kept.length + pulledInWindow + overflowTotal).toBe(candidates.length);
    expect(candidates).toHaveLength(25);
  });

  it("ranks the pool as kept rows plus the G2 band, and nothing below it", () => {
    const ranked = result.ranked.map((row) => row.turn.promptNumber);
    expect(ranked).toHaveLength(14);
    expect(ranked).toContain(13);
    expect(ranked).toContain(21);
    for (const promptNumber of [3, 4, 7, 11, 15, 16, 19, 20, 24, 25]) {
      expect(ranked).not.toContain(promptNumber);
    }
    // Score order never crosses a grade tier: the G4 anchor leads.
    expect(result.ranked[0]!.turn.promptNumber).toBe(12);
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
      bugfix: 0,
      feature: 0,
      refactor: 0,
      change: 0,
      discovery: 17,
      decision: 3,
      compact: 0,
      pending: 1,
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

  it("paginates the milestones view over kept milestones, not raw turns", () => {
    const db = createDatabase(":memory:");
    // 10 legacy turns on one day: decisions at T1/T4/T7/T10 (effGrade 3 → spine),
    // discoveries elsewhere (effGrade 1 → no row). The kept set is {1, 4, 7, 10} —
    // 4 milestones over 10 raw turns, which is the point of paginating over kept.
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
      page: 2,
      pageSize: 3,
    });

    expect(view.view).toBe("milestones");
    expect(view.viewItemTotal).toBe(4);
    expect(view.pageCount).toBe(2);
    expect(view.pageAnchorEpoch).toBe(1_779_782_400 + 9 * 60);
    expect(view.pagedMilestones.map((item) => item.turn.promptNumber)).toEqual([
      10,
    ]);
  });

  it("paginates the phases view over phases and anchors to the first phase start", () => {
    const db = createDatabase(":memory:");
    seedTimelineSession(db, [
      turn({ promptNumber: 1, type: "discovery", createdAtEpoch: 1_779_782_400 }),
      turn({ promptNumber: 2, type: "discovery", createdAtEpoch: 1_779_782_460 }),
      turn({ promptNumber: 3, type: "decision", createdAtEpoch: 1_779_782_520 }),
      turn({ promptNumber: 4, type: "feature", createdAtEpoch: 1_779_782_580 }),
      turn({ promptNumber: 5, type: "feature", createdAtEpoch: 1_779_782_640 }),
      turn({ promptNumber: 6, type: "bugfix", createdAtEpoch: 1_779_782_700 }),
    ]);

    const view = buildTimelineView(db, {
      id: "S1",
      view: "phases",
      page: 2,
      pageSize: 2,
    });

    expect(view.view).toBe("phases");
    expect(view.viewItemTotal).toBe(4);
    expect(view.pageCount).toBe(2);
    expect(view.pageAnchorEpoch).toBe(1_779_782_580);
    expect(view.pagedPhases.map((phase) => phase.startPromptNumber)).toEqual([
      4,
      6,
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
       SET type = 'compact',
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
       SET type = 'compact',
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
  it("selects milestones over the full session, not a trailing 30-turn window", () => {
    const db = createDatabase(":memory:");
    const session = seedLongSession(db, 40);

    const view = buildContextTimelineView(db, session.id, "milestones");
    const kept = view.pagedMilestones.map((m) => m.turn.promptNumber);

    // Full-session selection keeps the true first-live endpoint T1. The old
    // last-30-turns window (T11-T40) excluded T1 entirely and force-kept T11
    // as that window's first-live endpoint instead.
    expect(kept).toContain(1);
    expect(kept).not.toContain(11);
    expect(view.milestoneTail).toBe(true);
    // window stays full-session so shape signals read "= full session".
    expect(view.window.startPromptNumber).toBe(1);
    expect(view.window.endPromptNumber).toBe(40);
  });

  it("shows only the trailing pageSize kept milestones with an earlier hint", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    // 40 alternating legacy rows on one local day: the 20 odd decisions are
    // effGrade 3 (spine) and T40 is the last titled row (endpoint) → 21 kept.
    // Trailing 3 = {37, 39, 40}.
    const rows = Array.from({ length: 40 }, (_, i) =>
      turn({
        promptNumber: i + 1,
        type: i % 2 === 0 ? "decision" : "change",
        title: `m ${i + 1}`,
        filesModified: i % 2 === 0 ? [] : ["a.ts"],
        toolCallCount: 40 - i,
        createdAtEpoch: base + i * 60,
      }),
    );
    seedTimelineSession(db, rows);

    const view = buildTimelineView(db, {
      id: "S1",
      view: "milestones",
      pageSize: 3,
      milestoneTail: true,
    });

    expect(view.pagedMilestones.map((m) => m.turn.promptNumber)).toEqual([37, 39, 40]);
    expect(view.viewItemTotal).toBe(21);
    expect(view.hasEarlier).toBe(true);
    expect(view.milestoneTail).toBe(true);

    const output = renderTimeline(view, { showEarlierHint: true });
    // honest tail label (not "page X/Y"), earlier hint bounded by the first
    // shown milestone, and the day header still reports full-day kept + cont.
    expect(output).toContain("showing: milestones · last 3/21");
    expect(output).toContain('earlier: timeline(id="S1/T1..36") or recall(id="S1")');
    expect(output).toContain("· 21 kept (cont.) ──");
  });
});

describe("milestoneDayGroups (pagination)", () => {
  it("splits a day across a page boundary, repeats the day header, overflow once on final slice", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    // 40 alternating legacy turns on one local day → 21 kept rows (20 decisions
    // + the last titled row), split across two pages at pageSize 15.
    const rows = Array.from({ length: 40 }, (_, i) =>
      turn({
        promptNumber: i + 1,
        type: i % 2 === 0 ? "decision" : "change",
        title: `m ${i + 1}`,
        filesModified: i % 2 === 0 ? [] : ["a.ts"],
        toolCallCount: 40 - i,
        createdAtEpoch: base + i * 60,
      }),
    );
    seedTimelineSession(db, rows);

    const page1 = buildTimelineView(db, { id: "S1", view: "milestones", page: 1, pageSize: 15 });
    const page2 = buildTimelineView(db, { id: "S1", view: "milestones", page: 2, pageSize: 15 });

    expect(page1.milestoneDayGroups).toHaveLength(1);
    expect(page2.milestoneDayGroups).toHaveLength(1);
    const g1 = page1.milestoneDayGroups[0]!;
    const g2 = page2.milestoneDayGroups[0]!;

    // Full-day metadata is identical across both slices.
    expect(g1.date).toBe(g2.date);
    expect(g1.keptCount).toBe(21);
    expect(g2.keptCount).toBe(21);
    expect(g1.promptLo).toBe(1);
    expect(g1.promptHi).toBe(40);
    expect(g2.promptLo).toBe(g1.promptLo);
    expect(g2.promptHi).toBe(g1.promptHi);

    // First slice opens the day and is not the final slice → no overflow on it.
    expect(g1.continued).toBe(false);
    expect(g1.isFinalSliceForDay).toBe(false);
    expect(g1.overflow).toBeNull();

    // Second slice continues the day, is the final slice, and carries the one overflow.
    expect(g2.continued).toBe(true);
    expect(g2.isFinalSliceForDay).toBe(true);
    expect(g2.overflow).not.toBeNull();
    // `+N more` = the day's turns that got no main row: 40 − 21 kept.
    expect(g2.overflow!.count).toBe(19);

    // Overflow appears on exactly one slice across the whole day.
    const overflowSlices = [g1, g2].filter((g) => g.overflow !== null);
    expect(overflowSlices).toHaveLength(1);
  });

  it("keeps a single-page day's overflow on its only (final) slice", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    // 10 alternating legacy turns on one day → 6 kept (5 decisions + the last
    // titled row) and 4 turns with no main row.
    // A large pageSize fits all kept on one page, so the single group is BOTH the first
    // and final slice for the day: continued=false, isFinalSliceForDay=true, overflow!=null.
    const rows = Array.from({ length: 10 }, (_, i) =>
      turn({
        promptNumber: i + 1,
        type: i % 2 === 0 ? "decision" : "change",
        title: `m ${i + 1}`,
        filesModified: i % 2 === 0 ? [] : ["a.ts"],
        toolCallCount: 10 - i,
        createdAtEpoch: base + i * 60,
      }),
    );
    seedTimelineSession(db, rows);

    const view = buildTimelineView(db, { id: "S1", view: "milestones", page: 1, pageSize: 30 });

    expect(view.milestoneDayGroups).toHaveLength(1);
    const g = view.milestoneDayGroups[0]!;
    expect(g.keptCount).toBe(6);
    expect(g.promptLo).toBe(1);
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

    expect(output).toContain("T# | line | time | gap | stats | prompt → title");
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
    const turn21Line = output
      .split("\n")
      .find((line) => line.startsWith("T21 |"));

    expect(turn21Line).toBeDefined();
    expect(turn21Line).toContain("⏳");
  });

  it("renders transcript line anchors in the turn table", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T1..1" });
    const output = renderTimeline(view);
    const turn1Line = output
      .split("\n")
      .find((line) => line.startsWith("T1 |"));

    expect(turn1Line).toBeDefined();
    expect(turn1Line).toContain("L10");
  });

  it("extracted turns render emoji plus title in the title column", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T1..1" });
    const output = renderTimeline(view);
    const turn1Line = output
      .split("\n")
      .find((line) => line.startsWith("T1 |"));

    expect(turn1Line).toBeDefined();
    expect(turn1Line).toContain("🔵 title for T1");
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
    const turn1Line = output
      .split("\n")
      .find((line) => line.startsWith("T1 |"));

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
    const turn19Line = output
      .split("\n")
      .find((line) => line.startsWith("⨯ T19 |"));

    expect(turn19Line).toBeDefined();
    expect(turn19Line).toContain("~~⚖️ title for T19~~");
  });

  it("renders compact turns as structural rows with line anchors and parsed tags", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);

    db.query(
      `UPDATE turns
       SET type = 'compact',
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
    const compactLine = output
      .split("\n")
      .find((line) => line.startsWith("T21 |"));

    expect(compactLine).toBeDefined();
    expect(compactLine).toContain("L210");
    expect(compactLine).toContain("/compact");
    expect(compactLine).toContain("⏸ /compact 357k tokens, auto");
    expect(compactLine).not.toContain("ignored raw summary wrapper");
  });

  it("renders phases scoped to window only in the phases view", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T10..15", view: "phases" });
    const output = renderTimeline(view);

    expect(output).toContain("phases:");
    expect(output).toMatch(/shape signals \(window T10-T15\):/);
    expect(output).not.toContain("T# | line | time | gap | stats | prompt → title");
  });

  it("renders phases labeled session-wide only in the phases view", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1", view: "phases" });
    const output = renderTimeline(view);

    expect(output).toContain("phases:");
    expect(output).toMatch(/shape signals \(window T1-T21 = full session\):/);
    expect(output).not.toContain("T# | line | time | gap | stats | prompt → title");
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

  it("dispatches default, turns, milestones, and phases views to separate bodies", () => {
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
        .filter((line) => /^T\d+ \|/.test(line))
        .map((line) => Number(line.match(/^T(\d+)/)?.[1]));
    // Milestone rows are day-grouped, title-only, front-gutter lines:
    //   "   <glyph> T<n> <emoji> <title>" (no turn-table "|" columns).
    const milestonePromptNumbers = (output: string) =>
      output
        .split("\n")
        .map((line) => line.match(/^\s+(?:\S+ )?T(\d+) /)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number);

    const defaultOutput = renderTimeline(buildTimelineView(db, { id: "S1" }));
    const turnsOutput = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "turns" }),
    );
    const milestoneOutput = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "milestones" }),
    );
    const phasesOutput = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "phases" }),
    );

    expect(defaultOutput).toContain("T# | line | time | gap | stats | prompt → title");
    expect(defaultOutput).toContain("shape signals");
    expect(defaultOutput).not.toMatch(/\n\s+phases[:(]/);
    expect(turnsOutput).toContain("T# | line | time | gap | stats | prompt → title");
    expect(turnsOutput).toContain("shape signals");
    expect(turnsOutput).not.toMatch(/\n\s+phases[:(]/);
    expect(turnPromptNumbers(turnsOutput)).toEqual([1, 2, 3, 4, 5]);
    expect(milestonePromptNumbers(milestoneOutput)).toEqual([1, 3, 5]);
    expect(milestoneOutput).not.toContain("T# | line | time | gap | stats | prompt → title");
    expect(milestoneOutput).toContain("shape signals");
    expect(milestoneOutput).not.toMatch(/\n\s+phases[:(]/);
    expect(phasesOutput).toContain("phases:");
    expect(phasesOutput).toContain("shape signals");
    expect(phasesOutput).not.toContain("T# | line | time | gap | stats | prompt → title");
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

  it("renders phase dates, cross-day phase spans, and lead titles in the phases view", () => {
    const db = createDatabase(":memory:");
    seedTimelineSession(db, [
      turn({
        promptNumber: 1,
        type: "discovery",
        title: "same day research",
        createdAtEpoch: 1_779_782_400,
      }),
      turn({
        promptNumber: 2,
        type: "discovery",
        title: "same day follow-up",
        createdAtEpoch: 1_779_783_000,
      }),
      turn({
        promptNumber: 3,
        type: "feature",
        title: "cross-day feature",
        createdAtEpoch: 1_780_178_400,
      }),
      turn({
        promptNumber: 4,
        type: "feature",
        title: "feature after midnight",
        createdAtEpoch: 1_780_187_400,
      }),
      turn({
        promptNumber: 5,
        type: "decision",
        title: "next day decision",
        createdAtEpoch: 1_780_233_900,
      }),
    ]);

    const output = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "phases" }),
    );

    expect(output).toContain("05-26 Tue");
    expect(output).toContain("same day research");
    expect(output).toContain("05-30→05-31");
    expect(output).toContain("cross-day feature");
    expect(output).toContain("next day decision");
    expect(output).not.toContain("T# | line | time | gap | stats | prompt → title");
  });

  it("renderTimeline respects promptCap option", () => {
    const db = createDatabase(":memory:");
    const session = seedLongSession(db, 40);

    const view = buildContextTimelineView(db, session.id);
    const output = renderTimeline(view, { promptCap: 80, showEarlierHint: true });
    const turn40Line = output
      .split("\n")
      .find((line) => line.startsWith("T40 |"));

    expect(turn40Line).toBeDefined();
    expect(turn40Line).toContain("…");
  });

  it("renders a compact pipe-delimited header without the separator row", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T19..21" });
    const output = renderTimeline(view);

    expect(output).toContain("T# | line | time | gap | stats | prompt → title");
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
    const line = output
      .split("\n")
      .find((row) => row.startsWith("T21 |"));

    expect(line).toBeDefined();
    expect(line).toContain("rg foo / sed");
    expect(line).not.toContain("rg foo | sed");
  });

  it("sanitizes title delimiters inside the merged prompt-title field", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);

    db.query(
      "UPDATE turns SET type = 'discovery', title = ? WHERE session_id = ? AND prompt_number = 21",
    ).run("left → right", session.id);

    const view = buildTimelineView(db, { id: "S1/T21..21" });
    const output = renderTimeline(view);
    const line = output
      .split("\n")
      .find((row) => row.startsWith("T21 |"));

    expect(line).toBeDefined();
    expect(line).toContain("raw prompt 21 → 🔵 left -> right");
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
    const turn21Line = output
      .split("\n")
      .find((line) => line.startsWith("T21 |"));

    expect(view.viewItemTotal).toBe(2);
    expect(view.pageTurns.map((row) => row.promptNumber)).toEqual([19, 21]);
    expect(turn21Line).toBeDefined();
    expect(turn21Line).toContain("| +50s |");
    expect(output).not.toContain("⏭");
    expect(output).not.toContain("T20 |");
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

    const turnRowCount = (s: string) =>
      s.split("\n").filter((l) => /^T\d+ \|/.test(l)).length;
    // Milestone rows are day-grouped front-gutter lines, not turn-table "|" rows.
    const milestoneRowCount = (s: string) =>
      s.split("\n").filter((l) => /^\s+(?:\S+ )?T\d+ /.test(l)).length;

    const full = renderTimeline(buildTimelineView(db, { id: "S1", view: "turns" }));
    const milestone = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "milestones" }),
    );

    expect(milestoneRowCount(milestone)).toBeLessThan(turnRowCount(full));
    expect(milestone).not.toContain("T# | line | time | gap | stats | prompt → title");
    // T6 is kept (front-gutter milestone row); T2 is suppressed; T11 is folded
    // into the day's overflow rather than rendered as its own row.
    expect(milestone).toMatch(/^\s+(?:\S+ )?T6 /m);
    expect(milestone).not.toMatch(/^\s+(?:\S+ )?T11 /m);
    expect(milestone).not.toMatch(/^\s+(?:\S+ )?T2 /m);
    expect(milestone).not.toMatch(/\n\s+phases[:(]/);
  });

});

describe("renderMilestoneDigest layout", () => {
  it("renders day-grouped title-only rows with front-gutter markers, no prompt/stats columns", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    const rows = [
      turn({ promptNumber: 1, type: "decision", title: "kick off the design", userPrompt: "PROMPTTEXT", createdAtEpoch: base }),
      turn({ promptNumber: 2, type: "decision", title: "pivot the approach", wasRolledBack: true, createdAtEpoch: base + 60 }),
      turn({ promptNumber: 3, type: "feature", title: "shipped it", tags: ["merged"], filesModified: ["a.ts"], createdAtEpoch: base + 120 }),
    ];
    seedTimelineSession(db, rows);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));

    expect(out).not.toContain("PROMPTTEXT"); // no user prompt
    expect(out).not.toContain("T# | line | time | gap"); // not the turn table
    expect(out).toContain("↩️ T2"); // reversed marker in front gutter
    expect(out).toContain("🏁 T3"); // outcome marker in front gutter
    expect(out).toMatch(/── \d{4}-\d{2}-\d{2} \w{3} · T1–T3 · \d+ kept/); // day header (full date, matches day-divider style)
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
    expect(timelineQuery(db, { id: "S1", view: "phases" })).toContain("phases:");

    // The milestone view dispatches to the day-grouped digest, not the turn table.
    const milestoneOut = timelineQuery(db, { id: "S1", view: "milestones" });
    expect(milestoneOut).not.toContain("T# | line | time | gap | stats | prompt → title");
    expect(milestoneOut).toMatch(/── \d{4}-\d{2}-\d{2} \w{3} · T\d+–T\d+ · \d+ kept/);
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

describe("milestone causal references (Component 3)", () => {
  // DB ids are auto-assigned at insert; resolve the driver's real id by prompt
  // number, then embed `[T<dbid>]` into the milestone's content. This keeps the
  // citation in the agent's DB-id space (what remember() uses), not the
  // user-facing prompt number, exactly as the renderer must map.
  function dbId(db: Database, sessionId: number, promptNumber: number): number {
    const t = getTurn(db, sessionId, promptNumber);
    if (t === null) throw new Error(`no turn S${sessionId}/T${promptNumber}`);
    return t.id;
  }

  function setContent(
    db: Database,
    sessionId: number,
    promptNumber: number,
    content: string,
  ): void {
    db.query(
      "UPDATE turns SET content = ? WHERE session_id = ? AND prompt_number = ?",
    ).run(content, sessionId, promptNumber);
  }

  it("does not let dense citations promote a low-grade turn, but pulls it in as a ↳ antecedent", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    const rows = [
      turn({ promptNumber: 1, type: "decision", title: "start", createdAtEpoch: base }),
      turn({
        promptNumber: 2,
        type: "discovery",
        title: "low-grade finding that later work leans on",
        createdAtEpoch: base + 60,
      }),
      ...Array.from({ length: 3 }, (_, i) =>
        turn({
          promptNumber: i + 3,
          type: "discovery",
          title: `later citation ${i + 1}`,
          createdAtEpoch: base + (i + 2) * 60,
        }),
      ),
      turn({ promptNumber: 6, type: "decision", title: "the decision it fed", createdAtEpoch: base + 300 }),
      turn({ promptNumber: 7, type: "decision", title: "end", createdAtEpoch: base + 360 }),
    ];
    seedTimelineSession(db, rows);
    const driverId = dbId(db, 1, 2);
    for (const promptNumber of [3, 4, 5, 6]) {
      setContent(db, 1, promptNumber, `Builds on [T${driverId}].`);
    }

    const view = buildTimelineView(db, { id: "S1", view: "milestones" });
    // Four citers no longer buy a main row: the pool gate is on effGrade alone.
    expect(view.pagedMilestones.map((milestone) => milestone.turn.promptNumber)).not.toContain(2);
    // It survives under the earliest kept row that cites it (T6, a decision).
    expect(view.milestonePulled.map((p) => [p.turn.promptNumber, p.citedByPromptNumber])).toEqual([
      [2, 6],
    ]);
  });

  it("renders a ↳ sub-line for an in-session [T<dbid>] reference, mapped to its prompt number", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    const previousDay = base - 24 * 60 * 60;
    // Driver is at promptNumber 7 but inserted first (DB id 1), so the DB-id
    // space and prompt-number space genuinely differ — proving the renderer
    // maps id → prompt number rather than echoing the cited id.
    seedTimelineSession(db, [
      turn({
        promptNumber: 7,
        type: "discovery",
        title: "reference prompt has conflicting guidance",
        toolCallCount: 99,
        createdAtEpoch: previousDay,
      }),
      turn({
        promptNumber: 8,
        type: "feature",
        title: "0.2.32 released: reference field durable-pointers-only",
        tags: ["release"],
        filesModified: ["a.ts"],
        createdAtEpoch: base + 60,
      }),
    ]);
    const driverId = dbId(db, 1, 7);
    expect(driverId).not.toBe(7); // DB id != prompt number
    // T8 (kept outcome) cites the driver via its DB id.
    setContent(db, 1, 8, `Driven by [T${driverId}]. Final design.`);

    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));

    expect(out).toContain("🏁 T8");
    // Sub-line uses the driver's PROMPT number (T7), not the cited DB id.
    expect(out).toContain("      ↳ T7 reference prompt has conflicting guidance");
    expect(out).not.toContain(`↳ T${driverId} `); // not the DB id space
  });

  it("suppresses a same-day reference sub-line when the cited turn is already kept", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    seedTimelineSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        title: "kept design driver",
        createdAtEpoch: base,
      }),
      turn({
        promptNumber: 2,
        type: "feature",
        title: "release citing already-kept driver",
        tags: ["release"],
        filesModified: ["a.ts"],
        createdAtEpoch: base + 60,
      }),
    ]);
    const driverId = dbId(db, 1, 1);
    setContent(db, 1, 2, `Builds on [T${driverId}].`);

    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));
    expect(out).toContain("T1 ⚖️ kept design driver");
    expect(out).toContain("🏁 T2 🟣 release citing already-kept driver");
    expect(out).not.toContain("↳ T1 kept design driver");
  });

  it("caps at 2 sub-lines even when content cites 3 references", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    const previousDay = base - 24 * 60 * 60;
    seedTimelineSession(db, [
      turn({ promptNumber: 1, type: "discovery", title: "driver one", toolCallCount: 99, createdAtEpoch: previousDay }),
      turn({ promptNumber: 2, type: "discovery", title: "driver two", toolCallCount: 99, createdAtEpoch: previousDay + 60 }),
      turn({ promptNumber: 3, type: "discovery", title: "driver three", toolCallCount: 99, createdAtEpoch: previousDay + 120 }),
      turn({
        promptNumber: 4,
        type: "feature",
        title: "release citing three drivers",
        tags: ["release"],
        filesModified: ["a.ts"],
        createdAtEpoch: base + 180,
      }),
    ]);
    const a = dbId(db, 1, 1);
    const b = dbId(db, 1, 2);
    const c = dbId(db, 1, 3);
    setContent(db, 1, 4, `Builds on [T${a}], supersedes [T${b}], verifies [T${c}].`);

    const view = buildTimelineView(db, { id: "S1", view: "milestones" });
    const release = view.pagedMilestones.find((m) => m.turn.promptNumber === 4);
    expect(release?.references).toHaveLength(2);
    expect(release?.references?.map((r) => r.promptNumber)).toEqual([1, 2]);

    const out = renderTimeline(view);
    const subLines = out.split("\n").filter((l) => l.includes("↳"));
    expect(subLines).toHaveLength(2);
    expect(out).toContain("      ↳ T1 driver one");
    expect(out).toContain("      ↳ T2 driver two");
    expect(subLines.join("\n")).not.toContain("driver three");
  });

  it("prefixes the sub-line with the marker glyph when the cited turn is rolled back", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    const previousDay = base - 24 * 60 * 60;
    seedTimelineSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        title: "approach we later reversed",
        wasRolledBack: true,
        status: "extracted",
        toolCallCount: 99,
        createdAtEpoch: previousDay,
      }),
      turn({
        promptNumber: 2,
        type: "feature",
        title: "release superseding the reversed approach",
        tags: ["release"],
        filesModified: ["a.ts"],
        createdAtEpoch: base + 60,
      }),
    ]);
    const reversedId = dbId(db, 1, 1);
    setContent(db, 1, 2, `Supersedes [T${reversedId}].`);

    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));
    // ↩️ reversed glyph rides the sub-line; the edge is kept.
    expect(out).toContain("      ↳ ↩️ T1 approach we later reversed");
  });

  it("resolves a driver outside a ranged view's window via getTurnById, not the in-memory window", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    const rows: TurnRecord[] = [];
    // The driver lives at T1 (out of the requested range).
    rows.push(
      turn({
        promptNumber: 1,
        type: "discovery",
        title: "out-of-range driver discovery",
        toolCallCount: 99,
        createdAtEpoch: base,
      }),
    );
    // Filler so the in-range milestone is not also T1.
    for (let pn = 2; pn <= 9; pn += 1) {
      rows.push(
        turn({
          promptNumber: pn,
          type: "discovery",
          title: `noise ${pn}`,
          toolCallCount: 0,
          createdAtEpoch: base + pn * 60,
        }),
      );
    }
    rows.push(
      turn({
        promptNumber: 10,
        type: "feature",
        title: "in-range release citing the out-of-range driver",
        tags: ["release"],
        filesModified: ["a.ts"],
        createdAtEpoch: base + 600,
      }),
    );
    seedTimelineSession(db, rows);
    const driverId = dbId(db, 1, 1);
    setContent(db, 1, 10, `Driven by [T${driverId}].`);

    // Range excludes T1; the kept milestone T10 still resolves its driver.
    const view = buildTimelineView(db, { id: "S1/T5..10", view: "milestones" });
    expect(view.windowTurns.some((t) => t.promptNumber === 1)).toBe(false); // driver not in window
    const out = renderTimeline(view);

    expect(out).toContain("🏁 T10");
    expect(out).toContain("      ↳ T1 out-of-range driver discovery");
  });

  it("renders no sub-line for a reference that resolves to a different session", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;

    // Primary session S1 holds a kept release that will cite a FOREIGN turn id.
    seedTimelineSession(db, [
      turn({
        promptNumber: 1,
        type: "feature",
        title: "release citing a cross-session id",
        tags: ["release"],
        filesModified: ["a.ts"],
        createdAtEpoch: base + 60,
      }),
    ]);

    // A second session (S2) whose turn the milestone (wrongly) cites.
    const foreign = upsertSession(db, {
      contentSessionId: "foreign-session",
      project: "/tmp/claude-mnemo-test",
      title: "foreign",
      insight: null,
      createdAtEpoch: base,
      updatedAtEpoch: base,
      completedAtEpoch: null,
    });
    expect(foreign.id).not.toBe(1); // guarantee a genuine cross-session id
    db.query(
      `INSERT INTO turns (session_id, prompt_number, status, title, type, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, 'discovery', ?)`,
    ).run(foreign.id, 1, "foreign-session driver", base);
    const foreignTurnId = getTurn(db, foreign.id, 1)!.id;

    // S1's milestone cites the foreign turn's DB id; the session guard rejects it.
    setContent(db, 1, 1, `Driven by [T${foreignTurnId}].`);

    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));
    expect(out).toContain("🏁 T1"); // the milestone itself still renders
    expect(out).not.toContain("↳"); // cross-session cite produces no sub-line
    expect(out).not.toContain("foreign-session driver");
  });

  it("renders no sub-line for a self or future (non-predecessor) reference", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    seedTimelineSession(db, [
      turn({
        promptNumber: 1,
        type: "feature",
        title: "release citing itself and the future",
        tags: ["release"],
        filesModified: ["a.ts"],
        createdAtEpoch: base,
      }),
      turn({
        promptNumber: 2,
        type: "discovery",
        title: "a later non-driver",
        toolCallCount: 0,
        createdAtEpoch: base + 60,
      }),
    ]);
    const selfId = dbId(db, 1, 1);
    const futureId = dbId(db, 1, 2);
    // A causal reference must point backward; self (==) and future (>) are inert.
    setContent(db, 1, 1, `Self [T${selfId}] and future [T${futureId}].`);

    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));
    expect(out).toContain("🏁 T1");
    expect(out).not.toContain("↳"); // neither self nor future is a predecessor
  });

  it("surfaces a valid predecessor even when invalid refs (missing, future, self) are cited first", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    const rows: TurnRecord[] = [];
    rows.push(
      turn({
        promptNumber: 1,
        type: "discovery",
        title: "the real driver",
        toolCallCount: 99,
        createdAtEpoch: base - 24 * 60 * 60,
      }),
    );
    for (let pn = 2; pn <= 9; pn += 1) {
      rows.push(
        turn({
          promptNumber: pn,
          type: "discovery",
          title: `noise ${pn}`,
          toolCallCount: 0,
          createdAtEpoch: base + pn * 60,
        }),
      );
    }
    rows.push(
      turn({
        promptNumber: 10,
        type: "decision",
        title: "release with invalid leading cites",
        tags: ["release"],
        filesModified: ["a.ts"],
        createdAtEpoch: base + 600,
      }),
    );
    rows.push(
      turn({
        promptNumber: 11,
        type: "discovery",
        title: "a later turn",
        toolCallCount: 0,
        createdAtEpoch: base + 660,
      }),
    );
    seedTimelineSession(db, rows);
    const driverId = dbId(db, 1, 1);
    const selfId = dbId(db, 1, 10);
    const futureId = dbId(db, 1, 11);
    // Missing id + future + self lead; the valid predecessor trails. Capping
    // raw parse at the display cap (2) would lose it — parse-then-validate keeps it.
    setContent(
      db,
      1,
      10,
      `[T999999] [T${futureId}] [T${selfId}] [T${driverId}].`,
    );

    const view = buildTimelineView(db, { id: "S1", view: "milestones" });
    const release = view.pagedMilestones.find((m) => m.turn.promptNumber === 10);
    expect(release?.references?.map((r) => r.promptNumber)).toEqual([1]);

    const out = renderTimeline(view);
    expect(out).toContain("      ↳ T1 the real driver");
  });
});

describe("parseContentReferences", () => {
  const twelveRefs = Array.from({ length: 12 }, (_, i) => `[T${i + 1}]`).join(" ");

  it("keeps the milestone caps even though the shared grammar is uncapped", () => {
    // The cap lives with this consumer, not in db/citations' grammar: the
    // settle/pull-through readers must see every id a legacy turn cites.
    expect(
      parseContentReferences(twelveRefs, MILESTONE_REFERENCE_PARSE_CAP),
    ).toHaveLength(MILESTONE_REFERENCE_PARSE_CAP);
    expect(parseContentReferences(twelveRefs)).toHaveLength(
      MILESTONE_REFERENCE_CAP,
    );
  });

  it("resolves the wider shared forms too", () => {
    expect(
      parseContentReferences("[T8075, T9824]", MILESTONE_REFERENCE_PARSE_CAP),
    ).toEqual([8075, 9824]);
  });
});
