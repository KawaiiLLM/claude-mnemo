import { describe, expect, test } from "bun:test";

import {
  type FormattedObservation,
  type FormattedMemory,
  type FormattedSession,
  type FormattedTurn,
  formatMemoryCollapsed,
  formatMemoryExpanded,
  formatObservationCollapsed,
  formatObservationExpanded,
  formatSessionCollapsed,
  formatSessionExpanded,
  formatTree,
  formatTurnCollapsed,
  formatTurnExpanded,
} from "../../src/mcp/format";

const createdAtEpoch = Math.floor(Date.UTC(2026, 3, 5, 14, 30) / 1000);

describe("MCP format renderer", () => {
  test("formats collapsed lines with list structure, stats, and status", () => {
    const session: FormattedSession = {
      id: 142,
      title: "Auth refactor",
      project: "claude-mnemo",
      createdAtEpoch,
      content: "Fix race + add tests",
      turnCount: 3,
      observationCount: 8,
    };
    const turn: FormattedTurn = {
      id: 1,
      promptNumber: 1,
      title: "Diagnose auth",
      content: "Refresh overlap diagnosed",
      observationCount: 2,
      toolCallCount: 4,
      filesReadCount: 1,
      filesModifiedCount: 2,
      status: "extracted",
    };
    const observation: FormattedObservation = {
      id: 7,
      type: "bugfix",
      title: "Added mutex",
      content: "Guards refresh",
    };

    expect(formatSessionCollapsed(session)).toBe(
      [
        "- [S142] Auth refactor | 💬3 💡8 | 2026-04-05 | claude-mnemo",
        "  - desc: Fix race + add tests",
      ].join("\n"),
    );

    expect(formatTurnCollapsed(turn)).toBe(
      [
        "  - [T1] Diagnose auth | 💡2 📖1 ✏️2 🔧4 [extracted]",
        "    - desc: Refresh overlap diagnosed",
      ].join("\n"),
    );

    expect(formatTurnCollapsed(turn, { indent: "", sessionId: 142 })).toBe(
      [
        "- [S142][T1] Diagnose auth | 💡2 📖1 ✏️2 🔧4 [extracted]",
        "  - desc: Refresh overlap diagnosed",
      ].join("\n"),
    );

    expect(formatObservationCollapsed(observation)).toBe(
      [
        "- [O7] 🔴 Added mutex",
        "  - desc: Guards refresh",
      ].join("\n"),
    );

    expect(formatObservationCollapsed(observation, { indent: "    " })).toBe(
      [
        "    - [O7] 🔴 Added mutex",
        "      - desc: Guards refresh",
      ].join("\n"),
    );
  });

  test("omits zero-value stats while keeping desc visible", () => {
    const session: FormattedSession = {
      id: 9,
      title: "Empty stats",
      project: "claude-mnemo",
      createdAtEpoch,
      content: "Collapsed description stays visible",
      turnCount: 0,
      observationCount: 0,
    };
    const turn: FormattedTurn = {
      id: 2,
      promptNumber: 2,
      title: "No stats",
      content: "Collapsed description stays visible",
      observationCount: 0,
      toolCallCount: 0,
      filesReadCount: 0,
      filesModifiedCount: 0,
      status: "pending",
    };

    expect(formatSessionCollapsed(session)).toBe(
      [
        "- [S9] Empty stats | 2026-04-05 | claude-mnemo",
        "  - desc: Collapsed description stays visible",
      ].join("\n"),
    );

    expect(formatTurnCollapsed(turn)).toBe(
      [
        "  - [T2] No stats [pending]",
        "    - desc: Collapsed description stays visible",
      ].join("\n"),
    );
  });

  test("renders expanded lines with detail blocks and truncation", () => {
    const session: FormattedSession = {
      id: 142,
      title: "Auth refactor",
      project: "claude-mnemo",
      createdAtEpoch,
      content: "Fix race + add tests",
      insight: ["prompt cache preserved", "per-turn extraction is resilient"],
      nextSteps: "verify startup migration",
      turnCount: 3,
      observationCount: 8,
    };
    const turn: FormattedTurn = {
      id: 1,
      promptNumber: 1,
      title: "Diagnose auth",
      observationCount: 2,
      toolCallCount: 4,
      filesReadCount: 1,
      filesModifiedCount: 2,
      status: "extracted",
      promptPreview: "Why am I getting 401 errors?",
      responsePreview: "I found a race condition in refresh logic.",
      content: "Refresh overlap diagnosed",
      insight: ["concurrent refreshes collide"],
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts", "tests/auth.test.ts"],
    };
    const observation: FormattedObservation = {
      id: 7,
      type: "bugfix",
      title: "Added mutex",
      content: "Guards refresh",
      insight: "Serialized token refresh work with a shared promise.",
      tags: ["problem-solution", "trade-off"],
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts"],
    };
    const longTurn: FormattedTurn = {
      id: 9,
      promptNumber: 9,
      title: "Verbose turn",
      status: "extracted",
      promptPreview: "p".repeat(260),
      responsePreview: "r".repeat(260),
    };

    expect(formatSessionExpanded(session)).toBe(
      [
        "- [S142] Auth refactor | 💬3 💡8 | 2026-04-05 | claude-mnemo",
        "  - desc: Fix race + add tests",
        "  - insight:",
        "    - prompt cache preserved",
        "    - per-turn extraction is resilient",
        "  - next_steps:",
        "    - verify startup migration",
      ].join("\n"),
    );

    expect(formatTurnExpanded(turn)).toBe(
      [
        "  - [T1] Diagnose auth | 💡2 📖1 ✏️2 🔧4 [extracted]",
        "    - desc: Refresh overlap diagnosed",
        '    - prompt: "Why am I getting 401 errors?"',
        '    - response: "I found a race condition in refresh logic."',
        "    - insight:",
        "      - concurrent refreshes collide",
      ].join("\n"),
    );

    expect(formatObservationExpanded(observation)).toBe(
      [
        "- [O7] 🔴 Added mutex",
        "  - desc: Guards refresh",
        "  - insight: Serialized token refresh work with a shared promise.",
        "  - tags: problem-solution, trade-off",
        "  - files: 📖 src/auth.ts ✏️ src/auth.ts",
      ].join("\n"),
    );

    expect(formatTurnExpanded(longTurn, { sessionId: 142 })).toContain(
      "[use replay(session=142, turn=9) for full content]",
    );
    expect(formatTurnExpanded(longTurn, { sessionId: 142 })).toContain(
      "p".repeat(200),
    );
    expect(formatTurnExpanded(longTurn, { sessionId: 142 })).toContain(
      "r".repeat(200),
    );
  });

  test("formats a mixed expansion tree without extra blank lines", () => {
    const tree: FormattedSession[] = [
      {
        id: 142,
        title: "Auth refactor",
        project: "claude-mnemo",
        createdAtEpoch,
        content: "Fix race + add tests",
        nextSteps: "verify startup migration",
        turns: [
          {
            id: 1,
            promptNumber: 1,
            title: "Diagnose auth",
            observationCount: 1,
            status: "extracted",
            observations: [
              {
                id: 7,
                type: "bugfix",
                title: "Mutex added",
              },
            ],
          },
        ],
      },
    ];

    expect(formatTree(tree)).toBe(
      [
        "- [S142] Auth refactor | 💬1 💡1 | 2026-04-05 | claude-mnemo",
        "  - desc: Fix race + add tests",
        "  - next_steps:",
        "    - verify startup migration",
        "  - [S142][T1] Diagnose auth | 💡1 [extracted]",
        "    - [O7] 🔴 Mutex added",
      ].join("\n"),
    );
  });

  test("formats memory collapsed and expanded views with source counts", () => {
    const memory: FormattedMemory = {
      id: 1,
      type: "feedback",
      scope: "global",
      title: "Use real DB tests",
      content: "Integration tests should hit the real database layer.",
      reasoning: "Mocks hide locking and transaction behavior.",
      application: "When validating persistence or concurrency changes.",
      tags: ["testing", "database"],
      createdAtEpoch: createdAtEpoch,
      sourceCount: 1,
      source: {
        sessionId: 142,
        promptNumber: 3,
        title: "Add concurrency coverage",
        createdAtEpoch: createdAtEpoch,
      },
    };

    expect(formatMemoryCollapsed(memory)).toBe(
      "- [M1] feedback/global: Use real DB tests | 2026-04-05 | 1 source",
    );

    expect(formatMemoryExpanded(memory)).toBe(
      [
        "- [M1] feedback/global: Use real DB tests | 2026-04-05",
        "  - content: Integration tests should hit the real database layer.",
        "  - reasoning: Mocks hide locking and transaction behavior.",
        "  - application: When validating persistence or concurrency changes.",
        "  - tags: [testing, database]",
        "  - source: [S142/T3] Add concurrency coverage | 2026-04-05",
      ].join("\n"),
    );
  });
});
