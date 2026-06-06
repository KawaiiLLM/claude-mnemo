import { describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession, type UpsertSessionInput } from "../../src/db/sessions";
import type { TurnRecord } from "../../src/db/turns";
import { resolveTranscriptPath } from "../../src/shared/paths";
import {
  buildContextTimelineView,
  buildTimelineView,
  cleanPromptForLabel,
  computeTypesDistribution,
  detectBrokenPromptPairs,
  detectShapeSignals,
  extractReversalFlag,
  formatDuration,
  formatGap,
  formatLocalDate,
  formatLocalTime,
  getSystemTimezone,
  extractSourceTags,
  milestoneCandidateTurn,
  parseTimelineId,
  renderTimeline,
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
    tags: [],
    filesRead: [],
    filesModified: [],
    toolCallCount: 0,
    parentTurnId: null,
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

function selectionFor(turns: TurnRecord[]): MilestoneSelection {
  const selectionView = {
    windowTurns: turns,
    windowSignals: detectShapeSignals(turns),
    compactBoundaries: turns
      .filter((row) => row.type === "compact")
      .map((row) => row.promptNumber),
  } as unknown as TimelineView;

  return selectMilestoneTurns(selectionView) as unknown as MilestoneSelection;
}

function keptPromptNumbers(selection: MilestoneSelection): number[] {
  return selection.kept.map((item) => item.turn.promptNumber);
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

describe("milestoneCandidateTurn", () => {
  it("keeps live rows and invalidated decisions, but rejects skipped and invalidated non-decisions", () => {
    expect(milestoneCandidateTurn(turn({ type: "discovery" }))).toBe(true);
    expect(
      milestoneCandidateTurn(
        turn({ type: "decision", status: "skipped" }),
      ),
    ).toBe(false);
    expect(
      milestoneCandidateTurn(
        turn({ type: "decision", status: "undone" }),
      ),
    ).toBe(true);
    expect(
      milestoneCandidateTurn(
        turn({ type: "decision", wasRolledBack: true }),
      ),
    ).toBe(true);
    expect(
      milestoneCandidateTurn(
        turn({ type: "feature", status: "undone" }),
      ),
    ).toBe(false);
    expect(
      milestoneCandidateTurn(
        turn({ type: "discovery", tags: ["invalidated:notify-pending:rollback"] }),
      ),
    ).toBe(false);
  });
});

describe("extractReversalFlag", () => {
  it("marks seeded reversal tags only on decision turns", () => {
    expect(
      extractReversalFlag(turn({ type: "decision", tags: ["reversal"] })),
    ).toBe(true);
    expect(
      extractReversalFlag(turn({ type: "decision", tags: ["design-pivot"] })),
    ).toBe(true);
    expect(
      extractReversalFlag(turn({ type: "feature", tags: ["reversal"] })),
    ).toBe(false);
    expect(
      extractReversalFlag(turn({ type: "decision", tags: ["rollback"] })),
    ).toBe(false);
    expect(
      extractReversalFlag(turn({ type: "discovery", tags: ["reverse-kl"] })),
    ).toBe(false);
  });
});

describe("selectMilestoneTurns", () => {
  it("keeps all Tier 1 decisions from a dense day without applying the Tier 2 cap", () => {
    const rows = Array.from({ length: 8 }, (_, index) =>
      turn({
        promptNumber: index + 1,
        type: "decision",
        title: `decision ${index + 1}`,
        createdAtEpoch: 1_779_782_400 + index * 60,
      }),
    );

    const selection = selectionFor(rows);

    expect(keptPromptNumbers(selection)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(selection.kept.every((item) => item.tier === 1)).toBe(true);
    expect(selection.overflowByDay).toEqual([]);
  });

  it("caps same-day Tier 2 fixes by score and preserves overflow metadata", () => {
    const rows = [
      turn({
        promptNumber: 1,
        type: "decision",
        title: "open the day",
        createdAtEpoch: 1_779_782_400,
      }),
      ...Array.from({ length: 10 }, (_, index) => {
        const promptNumber = 2 + index * 2;
        return [
          turn({
            promptNumber,
            type: "bugfix",
            title: `fix ${promptNumber}`,
            toolCallCount: promptNumber,
            createdAtEpoch: 1_779_782_400 + promptNumber * 60,
          }),
          turn({
            promptNumber: promptNumber + 1,
            type: null,
            title: `note ${promptNumber + 1}`,
            toolCallCount: 1,
            createdAtEpoch: 1_779_782_400 + (promptNumber + 1) * 60,
          }),
        ];
      }).flat(),
      turn({
        promptNumber: 23,
        type: "decision",
        title: "close the day",
        createdAtEpoch: 1_779_782_400 + 23 * 60,
      }),
    ];

    const selection = selectionFor(rows);
    const keptFixes = selection.kept
      .filter((item) => item.turn.type === "bugfix")
      .map((item) => item.turn.promptNumber);

    expect(keptFixes).toEqual([14, 16, 18, 20]);
    expect(selection.overflowByDay).toEqual([
      {
        date: "2026-05-26",
        count: 6,
        firstPrompt: 2,
        lastPrompt: 12,
        lastKeptPrompt: 23,
        kind: "fixes",
      },
    ]);
  });

  it("selects capped Tier 2 milestones by score but renders kept rows in prompt order", () => {
    const rows = [
      turn({
        promptNumber: 1,
        type: "decision",
        title: "start",
        createdAtEpoch: 1_779_782_400,
      }),
      ...[2, 4, 6, 8, 10, 12].flatMap((promptNumber) => [
        turn({
          promptNumber,
          type: "bugfix",
          title: `fix ${promptNumber}`,
          toolCallCount:
            promptNumber === 10
              ? 100
              : promptNumber === 12
                ? 90
                : promptNumber === 4
                  ? 80
                  : promptNumber === 2
                    ? 70
                    : 1,
          createdAtEpoch: 1_779_782_400 + promptNumber * 60,
        }),
        turn({
          promptNumber: promptNumber + 1,
          type: null,
          title: `separator ${promptNumber + 1}`,
          toolCallCount: 1,
          createdAtEpoch: 1_779_782_400 + (promptNumber + 1) * 60,
        }),
      ]),
      turn({
        promptNumber: 15,
        type: "decision",
        title: "end",
        createdAtEpoch: 1_779_782_400 + 15 * 60,
      }),
    ];
    const db = createDatabase(":memory:");
    seedTimelineSession(db, rows);

    const selection = selectionFor(rows);
    expect(keptPromptNumbers(selection)).toContain(10);
    expect(keptPromptNumbers(selection)).not.toContain(6);

    const output = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "milestones" }),
    );
    const rowOrder = output
      .split("\n")
      .filter((line) => /^T\d+ \|/.test(line))
      .map((line) => Number(line.match(/^T(\d+)/)?.[1]));

    expect(rowOrder).toEqual([1, 2, 4, 10, 12, 15]);
  });

  it("excludes a phase-lead discovery feeding an invalidated decision unless it bursts on its own", () => {
    const base = 1_779_782_400;
    const rowsFor = (discoveryTools: number): TurnRecord[] => [
      turn({
        promptNumber: 1,
        type: "decision",
        title: "start",
        toolCallCount: 2,
        createdAtEpoch: base,
      }),
      turn({
        promptNumber: 2,
        type: "discovery",
        title: "analysis feeding a dead branch",
        toolCallCount: discoveryTools,
        createdAtEpoch: base + 60,
      }),
      turn({
        promptNumber: 3,
        type: "decision",
        title: "rolled-back decision",
        wasRolledBack: true,
        toolCallCount: 2,
        createdAtEpoch: base + 120,
      }),
      turn({
        promptNumber: 4,
        type: "decision",
        title: "end",
        toolCallCount: 2,
        createdAtEpoch: base + 180,
      }),
    ];

    // Low-tool phase-lead discovery: adjacency to an *invalidated* decision must
    // not pull it in (the dead branch does not resurrect its upstream analysis).
    const lowTool = selectionFor(rowsFor(2));
    expect(keptPromptNumbers(lowTool)).toEqual([1, 3, 4]);
    expect(
      lowTool.kept.find((item) => item.turn.promptNumber === 3)?.invalidated,
    ).toBe(true);

    // The same discovery, now exceeding the burst threshold, is kept on its own
    // merit (Tier 2) — independent of the adjacency path.
    const burst = selectionFor(rowsFor(100));
    expect(keptPromptNumbers(burst)).toContain(2);
    expect(
      burst.kept.find((item) => item.turn.promptNumber === 2)?.tier,
    ).toBe(2);
  });

  it("renders same-day overflow hint only on the page with that day's last kept milestone", () => {
    const rows = [
      turn({
        promptNumber: 1,
        type: "decision",
        title: "open",
        createdAtEpoch: 1_779_782_400,
      }),
      ...[2, 4, 6, 8, 10, 12].flatMap((promptNumber) => [
        turn({
          promptNumber,
          type: "bugfix",
          title: `fix ${promptNumber}`,
          toolCallCount: 120 - promptNumber,
          createdAtEpoch: 1_779_782_400 + promptNumber * 60,
        }),
        turn({
          promptNumber: promptNumber + 1,
          type: null,
          title: `separator ${promptNumber + 1}`,
          toolCallCount: 1,
          createdAtEpoch: 1_779_782_400 + (promptNumber + 1) * 60,
        }),
      ]),
      ...[14, 15, 16, 17, 18].map((promptNumber) =>
        turn({
          promptNumber,
          type: "decision",
          title: `decision ${promptNumber}`,
          createdAtEpoch: 1_779_782_400 + promptNumber * 60,
        }),
      ),
    ];
    const db = createDatabase(":memory:");
    seedTimelineSession(db, rows);

    const page1 = renderTimeline(
      buildTimelineView(db, {
        id: "S1",
        view: "milestones",
        page: 1,
        pageSize: 5,
      }),
    );
    const page2 = renderTimeline(
      buildTimelineView(db, {
        id: "S1",
        view: "milestones",
        page: 2,
        pageSize: 5,
      }),
    );

    expect(page1).not.toContain("… +2 more fixes this day");
    expect(page2.match(/… \+2 more fixes this day/g)).toHaveLength(1);
  });

  it("renders invalidated decisions with 🚫 taking precedence over reversal ↩️", () => {
    const db = createDatabase(":memory:");
    seedTimelineSession(db, [
      turn({
        promptNumber: 1,
        type: "decision",
        title: "live decision",
        createdAtEpoch: 1_779_782_400,
      }),
      turn({
        promptNumber: 2,
        type: "decision",
        title: "rolled back reversal",
        wasRolledBack: true,
        tags: ["reversal"],
        createdAtEpoch: 1_779_782_460,
      }),
    ]);

    const output = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "milestones" }),
    );
    const invalidatedLine = output
      .split("\n")
      .find((line) => line.includes("T2"));

    expect(invalidatedLine).toBeDefined();
    expect(invalidatedLine).toContain("🚫");
    expect(invalidatedLine).not.toContain("↩️");
  });

  it("does not promote session compact-boundary fallback rows into milestones", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);

    db.query("UPDATE sessions SET last_compact_turn = 15 WHERE id = ?").run(
      session.id,
    );

    const view = buildTimelineView(db, { id: "S1", view: "milestones" });

    expect(view.compactBoundaries).toEqual([15]);
    expect(view.pagedMilestones.map((item) => item.turn.promptNumber)).not.toContain(
      15,
    );
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
    seedTimelineSession(
      db,
      Array.from({ length: 10 }, (_, index) =>
        turn({
          promptNumber: index + 1,
          type: "decision",
          title: `decision ${index + 1}`,
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
    expect(view.viewItemTotal).toBe(10);
    expect(view.pageCount).toBe(4);
    expect(view.pageAnchorEpoch).toBe(1_779_782_400 + 3 * 60);
    expect(view.pagedMilestones.map((item) => item.turn.promptNumber)).toEqual([
      4,
      5,
      6,
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

    const promptNumbers = (output: string) =>
      output
        .split("\n")
        .filter((line) => /^T\d+ \|/.test(line))
        .map((line) => Number(line.match(/^T(\d+)/)?.[1]));

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
    expect(promptNumbers(milestoneOutput)).toEqual([1, 3, 5]);
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

    const rowCount = (s: string) =>
      s.split("\n").filter((l) => /^T\d+ \|/.test(l)).length;

    const full = renderTimeline(buildTimelineView(db, { id: "S1", view: "turns" }));
    const milestone = renderTimeline(
      buildTimelineView(db, { id: "S1", view: "milestones" }),
    );

    expect(rowCount(milestone)).toBeLessThan(rowCount(full));
    expect(milestone).toContain("T6 |");
    expect(milestone).not.toContain("T11 |");
    expect(milestone).not.toContain("T2 |");
    expect(milestone).not.toMatch(/\n\s+phases[:(]/);
  });

  it("view=milestones keeps gaps spanning suppressed turns", () => {
    const db = createDatabase(":memory:");
    seedSession(db);

    const gapField = (line: string | undefined) => line?.split("|")[3]?.trim();
    const find = (s: string, n: string) =>
      s.split("\n").find((l) => l.startsWith(n));

    const fullT6 = find(
      renderTimeline(buildTimelineView(db, { id: "S1", view: "turns" })),
      "T6 |",
    );
    const msT6 = find(
      renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" })),
      "T6 |",
    );

    expect(gapField(msT6)).toBeDefined();
    // T6 is a decision milestone; T2-T5 are suppressed. Its gap must equal the
    // full-mode gap (T5->T6), proving suppressed turns still advance it.
    expect(gapField(msT6)).toBe(gapField(fullT6));
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

    const rowCount = (s: string) =>
      s.split("\n").filter((l) => /^T\d+ \|/.test(l)).length;
    expect(
      rowCount(timelineQuery(db, { id: "S1", view: "milestones" })),
    ).toBeLessThan(rowCount(timelineQuery(db, { id: "S1" })));
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
