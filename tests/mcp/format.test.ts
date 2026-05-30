import { describe, expect, test } from "bun:test";

import {
  type FormattedObservation,
  type FormattedSession,
  type FormattedTurn,
  formatObservationCollapsed,
  formatObservationExpanded,
  formatSessionCollapsed,
  formatSessionExpanded,
  renderNode,
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
      transcriptLineStart: 17,
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
        "  - [T1:L17] Diagnose auth | 💡2 📖1 ✏️2 🔧4 [extracted]",
        "    - desc: Refresh overlap diagnosed",
      ].join("\n"),
    );

    expect(formatTurnCollapsed(turn, { indent: "", sessionId: 142 })).toBe(
      [
        "- [S142][T1:L17] Diagnose auth | 💡2 📖1 ✏️2 🔧4 [extracted]",
        "  - desc: Refresh overlap diagnosed",
      ].join("\n"),
    );

    expect(formatObservationCollapsed(observation)).toBe(
      [
        "- [O7] Added mutex",
        "  - desc: Guards refresh",
      ].join("\n"),
    );

    expect(formatObservationCollapsed(observation, { indent: "    " })).toBe(
      [
        "    - [O7] Added mutex",
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
      transcriptLineStart: null,
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

  test("renders current turn statuses directly", () => {
    const activeTurn: FormattedTurn = {
      id: 3,
      promptNumber: 3,
      transcriptLineStart: null,
      title: "Active turn",
      status: "active",
    };
    const undoneTurn: FormattedTurn = {
      id: 4,
      promptNumber: 4,
      transcriptLineStart: null,
      title: "Undone turn",
      status: "undone",
    };

    expect(formatTurnCollapsed(activeTurn)).toContain("[active]");
    expect(formatTurnExpanded(activeTurn)).toContain("[active]");
    expect(formatTurnCollapsed(undoneTurn)).toContain("[undone]");
    expect(formatTurnExpanded(undoneTurn)).toContain("[undone]");
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
      transcriptLineStart: null,
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
      title: "Added mutex",
      content: "Guards refresh",
    };
    const longTurn: FormattedTurn = {
      id: 9,
      promptNumber: 9,
      transcriptLineStart: null,
      title: "Verbose turn",
      status: "extracted",
      promptPreview: "p".repeat(260),
      responsePreview: "r".repeat(260),
    };

    // Legacy session (insight set, decision NULL): falls back to insight
    // bullets, and next_steps renders under its display label "next".
    expect(formatSessionExpanded(session)).toBe(
      [
        "- [S142] Auth refactor | 💬3 💡8 | 2026-04-05 | claude-mnemo",
        "  - desc: Fix race + add tests",
        "  - insight:",
        "    - prompt cache preserved",
        "    - per-turn extraction is resilient",
        "  - next: verify startup migration",
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
        "- [O7] Added mutex",
        "  - desc: Guards refresh",
      ].join("\n"),
    );

    expect(formatTurnExpanded(longTurn, { sessionId: 142 })).not.toContain(
      "[use mnemo-replay skill",
    );
    expect(formatTurnExpanded(longTurn, { sessionId: 142 })).toContain(
      "p".repeat(200),
    );
    expect(formatTurnExpanded(longTurn, { sessionId: 142 })).toContain(
      "r".repeat(200),
    );
  });

  test("renders the redesigned session summary fields in expanded view", () => {
    const session: FormattedSession = {
      id: 200,
      title: "Session redesign",
      project: "claude-mnemo",
      createdAtEpoch,
      content: "Reworking the session summary schema",
      // decision/done/reference are markdown bullet lists; [T<n>] markers
      // arrive already resolved from the recall layer. current/next stay inline.
      decision:
        '- Whole-rewrite over field-merge [S200/T3] "Pick rewrite"\n- DB id for [T<n>] markers [S200/T4] "Pointer semantics"',
      done:
        '- Shipped migration [S200/T1] "Add columns"\n- Wired read side [S200/T5] "Render fields"',
      current: "Running the test suite",
      nextSteps: "Release 0.2.16",
      reference: "- docs/plans/redesign.md\n- github.com/anthropics/claude-code",
      turnCount: 5,
      observationCount: 12,
    };

    expect(formatSessionExpanded(session)).toBe(
      [
        "- [S200] Session redesign | 💬5 💡12 | 2026-04-05 | claude-mnemo",
        "  - desc: Reworking the session summary schema",
        "  - decision:",
        '    - Whole-rewrite over field-merge [S200/T3] "Pick rewrite"',
        '    - DB id for [T<n>] markers [S200/T4] "Pointer semantics"',
        "  - done:",
        '    - Shipped migration [S200/T1] "Add columns"',
        '    - Wired read side [S200/T5] "Render fields"',
        "  - current: Running the test suite",
        "  - next: Release 0.2.16",
        "  - reference:",
        "    - docs/plans/redesign.md",
        "    - github.com/anthropics/claude-code",
      ].join("\n"),
    );
  });

  test("a bullet field shares one truncate budget across all bullets", () => {
    const session: FormattedSession = {
      id: 202,
      title: "Big decision",
      project: "claude-mnemo",
      createdAtEpoch,
      // 3 long bullets (~100 chars each, ~306 total). Under the default 200
      // budget the whole field is capped — not 200 per bullet.
      decision: `- ${"X".repeat(100)}\n- ${"Y".repeat(100)}\n- ${"Z".repeat(100)}`,
      turnCount: 1,
      observationCount: 0,
    };

    // unified mode surfaces the truncation hint; default truncate = 200.
    const out = renderNode(
      { type: "session", value: session },
      { depth: "expanded", mode: "unified" },
    );

    expect(out).toContain("X".repeat(50)); // first bullet survives
    expect(out).not.toContain("Z".repeat(50)); // third bullet dropped by the cap
    expect(out).toContain("[use mnemo-replay skill");
  });

  test("a single-line bullet field renders as one bullet", () => {
    const session: FormattedSession = {
      id: 201,
      title: "Single",
      project: "claude-mnemo",
      createdAtEpoch,
      content: "x",
      decision: "Only one decision [S201/T2] \"the call\"",
      turnCount: 1,
      observationCount: 0,
    };

    expect(formatSessionExpanded(session)).toContain(
      ["  - decision:", '    - Only one decision [S201/T2] "the call"'].join("\n"),
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
            transcriptLineStart: null,
            title: "Diagnose auth",
            observationCount: 1,
            status: "extracted",
            observations: [
              {
                id: 7,
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
        "  - next: verify startup migration",
        "  - [S142][T1] Diagnose auth | 💡1 [extracted]",
        "    - [O7] Mutex added",
      ].join("\n"),
    );
  });

  test("uses the global truncate option at all depths", () => {
    const turn: FormattedTurn = {
      id: 10,
      promptNumber: 10,
      transcriptLineStart: null,
      title: "fix auth",
      content: "x".repeat(500),
      promptPreview: null,
      responsePreview: null,
      insight: [],
      filesRead: [],
      filesModified: [],
      observationCount: 0,
      toolCallCount: 0,
      filesReadCount: 0,
      filesModifiedCount: 0,
      status: "extracted",
    };

    const shortLimit = renderNode(
      { type: "turn", value: turn },
      { depth: "expanded", truncate: 50 },
    );
    const longLimit = renderNode(
      { type: "turn", value: turn },
      { depth: "expanded", truncate: 500 },
    );

    expect(shortLimit).toContain("x".repeat(50));
    expect(shortLimit).toContain("...");
    expect(longLimit).toContain("x".repeat(500));
    expect(longLimit).not.toContain("x".repeat(500) + "...");
  });

  test("renders expanded turn files as a tree in unified mode", () => {
    const turn: FormattedTurn = {
      id: 14,
      promptNumber: 14,
      transcriptLineStart: null,
      title: "tree render",
      status: "extracted",
      filesRead: [
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/processors.ts",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/server.ts",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/pending-queue.ts",
      ],
      filesModified: [
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/processors.ts",
      ],
    };

    expect(renderNode({ type: "turn", value: turn }, { depth: "expanded" })).toBe(
      [
        "  - [T14] tree render | 📖3 ✏️1 [extracted]",
        "    - files_read:",
        "      - /Users/zhaoqixuan/Projects/claude-mnemo/src",
        "      - db/pending-queue.ts",
        "      - worker/",
        "      -   processors.ts",
        "      -   server.ts",
        "    - files_modified:",
        "      - /Users/zhaoqixuan/Projects/claude-mnemo/src/worker/processors.ts",
      ].join("\n"),
    );
  });

  test("tree rendering respects truncate with line-aware omission", () => {
    const turn: FormattedTurn = {
      id: 15,
      promptNumber: 15,
      transcriptLineStart: null,
      title: "tree truncation",
      status: "extracted",
      filesRead: [
        "/Users/zhaoqixuan/Projects/claude-mnemo/src",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/pending-queue.ts",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/processors.ts",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/server.ts",
      ],
    };

    const rendered = renderNode(
      { type: "turn", value: turn },
      { depth: "expanded", truncate: 40 },
    );

    expect(rendered).toContain("    - files_read:");
    expect(rendered).toContain("      - /Users/zhaoqixuan/Projects/claude-mnemo/src");
    expect(rendered).toContain("... +4 lines");
  });

  test("renders expanded turn with relative-path filesRead as correct tree", () => {
    const turn: FormattedTurn = {
      id: 17,
      promptNumber: 17,
      transcriptLineStart: null,
      title: "relative tree",
      status: "extracted",
      filesRead: ["src/auth.ts", "src/server.ts"],
      filesModified: [],
    };

    expect(renderNode({ type: "turn", value: turn }, { depth: "expanded" })).toBe(
      [
        "  - [T17] relative tree | 📖2 [extracted]",
        "    - files_read:",
        "      - src",
        "      - auth.ts",
        "      - server.ts",
      ].join("\n"),
    );
  });

  test("tree truncation includes replay hints only in unified mode when hintId exists", () => {
    const turn: FormattedTurn = {
      id: 16,
      promptNumber: 16,
      transcriptLineStart: null,
      title: "tree hint",
      status: "extracted",
      filesRead: [
        "/Users/zhaoqixuan/Projects/claude-mnemo/src",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/pending-queue.ts",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/processors.ts",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/server.ts",
      ],
    };

    const unified = renderNode(
      { type: "turn", value: turn },
      { depth: "expanded", truncate: 40, sessionId: 142 },
    );
    const legacy = formatTurnExpanded(turn, { truncate: 40 });

    expect(unified).toContain("[use mnemo-replay skill");
    expect(legacy).not.toContain("[use mnemo-replay skill");
  });

  test("defaults truncate to 200 when unspecified", () => {
    const rendered = renderNode(
        {
          type: "turn",
          value: {
            id: 11,
            promptNumber: 11,
            transcriptLineStart: null,
            title: "truncate default",
            content: "x".repeat(500),
          },
      },
      { depth: "expanded" },
    );

    expect(rendered).toContain("x".repeat(200));
    expect(rendered).not.toContain("x".repeat(201));
  });

  test("shows mnemo-replay hint only for unified-mode truncation", () => {
    const turn: FormattedTurn = {
      id: 12,
      promptNumber: 12,
      transcriptLineStart: null,
      title: null,
      content: "short text",
      promptPreview: "y".repeat(500),
      responsePreview: null,
    };

    const anchoredTurn: FormattedTurn = {
      id: 13,
      promptNumber: 13,
      transcriptLineStart: 42,
      title: "Anchored turn",
      status: "extracted",
    };

    const short = renderNode(
      { type: "turn", value: { ...turn, promptPreview: "short text" } },
      { depth: "expanded", truncate: 200, sessionId: 142 },
    );
    const long = renderNode(
      { type: "turn", value: turn },
      { depth: "expanded", truncate: 200, sessionId: 142 },
    );

    expect(short).not.toContain("[use ");
    expect(long).toContain("[use mnemo-replay skill → read S142/T12 for full content]");
    expect(
      formatTurnCollapsed(anchoredTurn, { sessionId: 17 }),
    ).toContain("[S17][T13:L42] Anchored turn");
  });
});
