import { describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import type { TurnRecord } from "../../src/db/turns";
import { resolveTranscriptPath } from "../../src/shared/paths";
import {
  buildTimelineView,
  cleanPromptForLabel,
  computeTypesDistribution,
  detectBrokenPromptPairs,
  detectShapeSignals,
  formatDuration,
  formatGap,
  formatLocalDate,
  formatLocalTime,
  getSystemTimezone,
  extractSourceTags,
  parseTimelineId,
  renderTimeline,
  resolveWindow,
  segmentPhases,
  timelineQuery,
  truncateText,
} from "../../src/mcp/timeline";

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: 1,
    sessionId: 1,
    promptNumber: 1,
    contentPromptId: null,
    transcriptLineStart: null,
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
      null,
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
  it("defaults to first 30 turns when range is none", () => {
    const window = resolveWindow({ kind: "none" }, 120);

    expect(window.startPromptNumber).toBe(1);
    expect(window.endPromptNumber).toBe(30);
    expect(window.requestedEnd).toBeNull();
    expect(window.hadExplicitEnd).toBe(false);
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

  it("respects a closed range within cap", () => {
    const window = resolveWindow({ kind: "closed", start: 10, end: 30 }, 120);

    expect(window.startPromptNumber).toBe(10);
    expect(window.endPromptNumber).toBe(30);
    expect(window.hadExplicitEnd).toBe(true);
    expect(window.requestedEnd).toBeNull();
  });

  it("truncates a closed range that exceeds the cap", () => {
    const window = resolveWindow({ kind: "closed", start: 10, end: 50 }, 120);

    expect(window.startPromptNumber).toBe(10);
    expect(window.endPromptNumber).toBe(39);
    expect(window.hadExplicitEnd).toBe(true);
    expect(window.requestedEnd).toBe(50);
  });

  it("truncates a closed range that exceeds the session end", () => {
    const window = resolveWindow({ kind: "closed", start: 100, end: 150 }, 120);

    expect(window.startPromptNumber).toBe(100);
    expect(window.endPromptNumber).toBe(120);
    expect(window.requestedEnd).toBe(150);
  });

  it("caps open-end ranges at 30 rows", () => {
    const window = resolveWindow({ kind: "openEnd", start: 30 }, 120);

    expect(window.startPromptNumber).toBe(30);
    expect(window.endPromptNumber).toBe(59);
    expect(window.requestedEnd).toBeNull();
    expect(window.hadExplicitEnd).toBe(false);
  });

  it("ends open-start ranges at the requested turn", () => {
    const window = resolveWindow({ kind: "openStart", end: 20 }, 120);

    expect(window.startPromptNumber).toBe(1);
    expect(window.endPromptNumber).toBe(20);
    expect(window.hadExplicitEnd).toBe(true);
    expect(window.requestedEnd).toBeNull();
  });

  it("truncates open-start ranges that exceed the cap", () => {
    const window = resolveWindow({ kind: "openStart", end: 50 }, 120);

    expect(window.startPromptNumber).toBe(1);
    expect(window.endPromptNumber).toBe(30);
    expect(window.requestedEnd).toBe(50);
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
    expect(view.phases.length).toBeGreaterThan(1);
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

  it("phases always use the full session regardless of window", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T10..15" });
    const firstPhase = view.phases[0];
    const lastPhase = view.phases[view.phases.length - 1];

    expect(firstPhase.startPromptNumber).toBe(1);
    expect(lastPhase.endPromptNumber).toBeGreaterThanOrEqual(19);
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

  it("rejects ranges that start beyond the session end", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    expect(() => buildTimelineView(db, { id: "S1/T30..40" })).toThrow(
      /starts beyond session end/i,
    );
  });
});

describe("renderTimeline", () => {
  it("includes all 6 metadata lines in the header", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1" });
    const output = renderTimeline(view);

    expect(output).toMatch(/- \[S1\]/);
    expect(output).toMatch(/\| \d+ turns \| \d+ tool_calls/);
    expect(output).toMatch(/types: .+\(session-wide\)/);
    expect(output).toMatch(/showing: T\d+-T\d+/);
    expect(output).toMatch(/tz: .+/);
    expect(output).toMatch(/raw: .+\.jsonl/);
  });

  it("renders two-column turn table header matching T# time gap stats prompt title", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T1..5" });
    const output = renderTimeline(view);

    expect(output).toMatch(/T#\s+time\s+gap\s+stats\s+prompt\s+title/);
  });

  it("showing line reports truncation when request exceeds cap", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T5..60" });
    const output = renderTimeline(view);

    expect(output).toMatch(/requested T5\.\.60, truncated/);
  });

  it("showing line emits (end) on last page for S1", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1" });
    const output = renderTimeline(view);

    expect(output).toMatch(/showing: T1-T21 of 21 \(end\)/);
  });

  it("pending turns render ⏳ in the title column for S1/T19..21", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T19..21" });
    const output = renderTimeline(view);
    const turn21Line = output
      .split("\n")
      .find((line) => line.startsWith("  T21"));

    expect(turn21Line).toBeDefined();
    expect(turn21Line).toContain("⏳");
  });

  it("extracted turns render emoji plus title in the title column", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T1..1" });
    const output = renderTimeline(view);
    const turn1Line = output
      .split("\n")
      .find((line) => line.startsWith("  T1 "));

    expect(turn1Line).toBeDefined();
    expect(turn1Line).toContain("🔵 title for T1");
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
      .find((line) => line.startsWith("  ⨯ T19"));

    expect(turn19Line).toBeDefined();
    expect(turn19Line).toContain("~~⚖️ title for T19~~");
  });

  it("renders a phases block labeled session-wide", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const view = buildTimelineView(db, { id: "S1/T10..15" });
    const output = renderTimeline(view);

    expect(output).toMatch(/phases \(session-wide\)/);
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
});

describe("timelineQuery", () => {
  it("builds and renders the timeline for a valid session id", () => {
    const db = createDatabase(":memory:");

    seedSession(db);

    const output = timelineQuery(db, { id: "S1" });

    expect(output).toContain("- [S1]");
    expect(output).toContain("showing: T1-T21 of 21 (end)");
  });

  it("returns a timeline error string when the view builder throws", () => {
    const db = createDatabase(":memory:");

    initializeSchema(db);

    expect(timelineQuery(db, { id: "S999" })).toBe(
      "timeline error: timeline: session S999 not found",
    );
  });
});
