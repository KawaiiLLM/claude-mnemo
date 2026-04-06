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
  test("formats collapsed lines for each layer", () => {
    expect(
      formatSessionCollapsed({
        id: 142,
        title: "Auth refactor",
        project: "claude-mnemo",
        startedAtEpoch,
      }),
    ).toBe("[S142] Auth refactor | 04-05 14:30 | claude-mnemo");

    expect(
      formatTurnCollapsed({
        id: 1,
        promptNumber: 1,
        title: "Diagnose auth",
        observationCount: 2,
      }),
    ).toBe("  [T1] #1 Diagnose auth | 2 obs");

    expect(
      formatObservationCollapsed({
        id: 7,
        type: "bugfix",
        title: "Added mutex",
        description: "Guards refresh",
      }),
    ).toBe("    [O7] bugfix: Added mutex — Guards refresh");
  });

  test("formats expanded lines for each layer", () => {
    expect(
      formatSessionExpanded({
        id: 142,
        title: "Auth refactor",
        project: "claude-mnemo",
        startedAtEpoch,
        description: "Fix race + add tests",
        insight: ["prompt cache preserved", "per-turn extraction is resilient"],
      }),
    ).toBe(
      [
        "[S142] Auth refactor | 04-05 14:30 | claude-mnemo",
        "  description: Fix race + add tests",
        "  insight:",
        "  - prompt cache preserved",
        "  - per-turn extraction is resilient",
      ].join("\n"),
    );

    expect(
      formatTurnExpanded({
        id: 1,
        promptNumber: 1,
        title: "Diagnose auth",
        observationCount: 2,
        promptPreview: "Why am I getting 401 errors?",
        responsePreview: "I found a race condition in refresh logic.",
        description: "Refresh overlap diagnosed",
        insight: ["concurrent refreshes collide"],
        filesRead: ["src/auth.ts"],
        filesModified: ["src/auth.ts", "tests/auth.test.ts"],
      }),
    ).toBe(
      [
        "  [T1] #1 Diagnose auth | 2 obs",
        '    prompt: "Why am I getting 401 errors?"',
        '    response: "I found a race condition in refresh logic."',
        "    description: Refresh overlap diagnosed",
        "    insight:",
        "    - concurrent refreshes collide",
        "    files: [R] src/auth.ts [M] src/auth.ts, tests/auth.test.ts",
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
      }),
    ).toBe(
      [
        "    [O7] bugfix: Added mutex — Guards refresh",
        "      narrative: Serialized token refresh work with a shared promise.",
        "      facts: mutex added; retry path preserved",
        "      concepts: problem-solution, trade-off",
        "      files: [R] src/auth.ts [M] src/auth.ts",
      ].join("\n"),
    );
  });

  test("formats a mixed expansion tree without extra blank lines", () => {
    const output = formatTree([
      {
        id: 142,
        title: "Auth refactor",
        project: "claude-mnemo",
        startedAtEpoch,
        description: "Fix race + add tests",
        insight: ["prompt cache preserved"],
        turns: [
          {
            id: 1,
            promptNumber: 1,
            title: "Diagnose auth",
            observationCount: 1,
            promptPreview: "Why am I getting 401 errors?",
            responsePreview: "I found a race condition in refresh logic.",
            description: "Refresh overlap diagnosed",
            filesRead: ["src/auth.ts"],
            filesModified: [],
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
    ]);

    expect(output).toBe(
      [
        "[S142] Auth refactor | 04-05 14:30 | claude-mnemo",
        "  description: Fix race + add tests",
        "  insight:",
        "  - prompt cache preserved",
        "  [T1] #1 Diagnose auth | 1 obs",
        '    prompt: "Why am I getting 401 errors?"',
        '    response: "I found a race condition in refresh logic."',
        "    description: Refresh overlap diagnosed",
        "    files: [R] src/auth.ts",
        "    [O7] bugfix: Added mutex — Guards refresh",
      ].join("\n"),
    );
  });
});
