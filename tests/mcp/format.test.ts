import { describe, expect, test } from "bun:test";

import {
  formatObservationCollapsed,
  formatObservationExpanded,
  formatSessionCollapsed,
  formatSessionExpanded,
  formatTree,
  formatTurnCollapsed,
  formatTurnExpanded,
} from "../../src/mcp/format";

const startedAtEpoch = Math.floor(Date.UTC(2026, 3, 5, 14, 30) / 1000);

describe("MCP format renderer", () => {
  test("formats collapsed lines with list structure and stats", () => {
    expect(
      formatSessionCollapsed({
        id: 142,
        title: "Auth refactor",
        project: "claude-mnemo",
        startedAtEpoch,
        description: "Fix race + add tests",
        turnCount: 3,
        observationCount: 8,
      } as any),
    ).toBe(
      [
        "- [S142] Auth refactor | 💬3 💡8 | 2026-04-05 | claude-mnemo",
        "  - desc: Fix race + add tests",
      ].join("\n"),
    );

    expect(
      formatTurnCollapsed({
        id: 1,
        promptNumber: 1,
        title: "Diagnose auth",
        description: "Refresh overlap diagnosed",
        observationCount: 2,
        toolCallCount: 4,
        filesReadCount: 1,
        filesModifiedCount: 2,
      } as any),
    ).toBe(
      [
        "  - [T1] Diagnose auth | 💡2 📖1 ✏️2 🔧4",
        "    - desc: Refresh overlap diagnosed",
      ].join("\n"),
    );

    expect(
      formatTurnCollapsed(
        {
          id: 1,
          promptNumber: 1,
          title: "Diagnose auth",
          description: "Refresh overlap diagnosed",
          observationCount: 2,
          toolCallCount: 4,
          filesReadCount: 1,
          filesModifiedCount: 2,
        } as any,
        { indent: "", sessionId: 142 },
      ),
    ).toBe(
      [
        "- [S142][T1] Diagnose auth | 💡2 📖1 ✏️2 🔧4",
        "  - desc: Refresh overlap diagnosed",
      ].join("\n"),
    );

    expect(
      formatObservationCollapsed({
        id: 7,
        type: "bugfix",
        title: "Added mutex",
        description: "Guards refresh",
      } as any),
    ).toBe(
      [
        "- [O7] 🔴 Added mutex",
        "  - desc: Guards refresh",
      ].join("\n"),
    );

    expect(
      formatObservationCollapsed(
        {
          id: 7,
          type: "bugfix",
          title: "Added mutex",
          description: "Guards refresh",
        } as any,
        { indent: "    " },
      ),
    ).toBe(
      [
        "    - [O7] 🔴 Added mutex",
        "      - desc: Guards refresh",
      ].join("\n"),
    );
  });

  test("omits zero-value stats while keeping desc visible", () => {
    expect(
      formatSessionCollapsed({
        id: 9,
        title: "Empty stats",
        project: "claude-mnemo",
        startedAtEpoch,
        description: "Collapsed description stays visible",
        turnCount: 0,
        observationCount: 0,
      } as any),
    ).toBe(
      [
        "- [S9] Empty stats | 2026-04-05 | claude-mnemo",
        "  - desc: Collapsed description stays visible",
      ].join("\n"),
    );

    expect(
      formatTurnCollapsed({
        id: 2,
        promptNumber: 2,
        title: "No stats",
        description: "Collapsed description stays visible",
        observationCount: 0,
        toolCallCount: 0,
        filesReadCount: 0,
        filesModifiedCount: 0,
      } as any),
    ).toBe(
      [
        "  - [T2] No stats",
        "    - desc: Collapsed description stays visible",
      ].join("\n"),
    );
  });

  test("renders expanded lines with detail blocks", () => {
    expect(
      formatSessionExpanded({
        id: 142,
        title: "Auth refactor",
        project: "claude-mnemo",
        startedAtEpoch,
        description: "Fix race + add tests",
        insight: ["prompt cache preserved", "per-turn extraction is resilient"],
        nextSteps: "verify startup migration",
        turnCount: 3,
        observationCount: 8,
      } as any),
    ).toBe(
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

    expect(
      formatTurnExpanded({
        id: 1,
        promptNumber: 1,
        title: "Diagnose auth",
        observationCount: 2,
        toolCallCount: 4,
        filesReadCount: 1,
        filesModifiedCount: 2,
        promptPreview: "Why am I getting 401 errors?",
        responsePreview: "I found a race condition in refresh logic.",
        description: "Refresh overlap diagnosed",
        insight: ["concurrent refreshes collide"],
        filesRead: ["src/auth.ts"],
        filesModified: ["src/auth.ts", "tests/auth.test.ts"],
      } as any),
      ).toBe(
      [
        "  - [T1] Diagnose auth | 💡2 📖1 ✏️2 🔧4",
        "    - desc: Refresh overlap diagnosed",
        '    - prompt: "Why am I getting 401 errors?"',
        '    - response: "I found a race condition in refresh logic."',
        "    - insight:",
        "      - concurrent refreshes collide",
      ].join("\n"),
    );

    expect(
      formatObservationExpanded({
        id: 7,
        type: "bugfix",
        title: "Added mutex",
        description: "Guards refresh",
        narrative: "Serialized token refresh work with a shared promise.",
        facts: ["mutex added", "retry path preserved"],
        concepts: ["problem-solution", "trade-off"],
        filesRead: ["src/auth.ts"],
        filesModified: ["src/auth.ts"],
      } as any),
    ).toBe(
      [
        "- [O7] 🔴 Added mutex",
        "  - desc: Guards refresh",
        "  - narrative: Serialized token refresh work with a shared promise.",
        "  - facts:",
        "    - mutex added",
        "    - retry path preserved",
        "  - concepts: problem-solution, trade-off",
        "  - files: 📖 src/auth.ts ✏️ src/auth.ts",
      ].join("\n"),
    );

    expect(
      formatObservationExpanded(
        {
          id: 7,
          type: "mystery",
          title: "Unknown type",
        } as any,
        { indent: "    " },
      ),
    ).toBe("    - [O7] mystery Unknown type");
  });

  test("formats a mixed expansion tree without extra blank lines", () => {
    const output = formatTree([
      {
        id: 142,
        title: "Auth refactor",
        project: "claude-mnemo",
        startedAtEpoch,
        description: "Fix race + add tests",
        nextSteps: "verify startup migration",
        turnCount: 1,
        observationCount: 1,
        turns: [
          {
            id: 1,
            promptNumber: 1,
            title: "Diagnose auth",
            description: "Refresh overlap diagnosed",
            observationCount: 1,
            toolCallCount: 4,
            filesReadCount: 1,
            filesModifiedCount: 0,
            promptPreview: "Why am I getting 401 errors?",
            responsePreview: "I found a race condition in refresh logic.",
            insight: ["concurrent refreshes collide"],
        observations: [
              {
                id: 7,
                type: "bugfix",
                title: "Added mutex",
                description: "Guards refresh",
              },
            ],
          },
        ],
      },
    ] as any);

    expect(output).toBe(
      [
        "- [S142] Auth refactor | 💬1 💡1 | 2026-04-05 | claude-mnemo",
        "  - desc: Fix race + add tests",
        "  - next_steps:",
        "    - verify startup migration",
        "  - [T1] Diagnose auth | 💡1 📖1 🔧4",
        "    - desc: Refresh overlap diagnosed",
        '    - prompt: "Why am I getting 401 errors?"',
        '    - response: "I found a race condition in refresh logic."',
        "    - insight:",
        "      - concurrent refreshes collide",
        "    - [O7] 🔴 Added mutex",
        "      - desc: Guards refresh",
      ].join("\n"),
    );
  });
});
