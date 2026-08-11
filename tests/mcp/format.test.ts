import { describe, expect, test } from "bun:test";

import {
  type FormattedObservation,
  type FormattedSession,
  type FormattedTurn,
  type TruncationSignal,
  createTruncationSignal,
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

    // default truncate = 200; the signal records that this field got cut.
    const signal = createTruncationSignal();
    const out = renderNode(
      { type: "session", value: session },
      { depth: "expanded", mode: "unified", signal },
    );

    expect(out).toContain("X".repeat(50)); // first bullet survives
    expect(out).not.toContain("Z".repeat(50)); // third bullet dropped by the cap
    // The per-field navigation sentence is gone (spec D1/D2): truncation only
    // sets the render-scoped signal here; the response-level legend is
    // assembled by the caller (recallMemory/timelineQuery), not this layer.
    expect(out).not.toContain("mnemo-replay skill");
    expect(signal.truncated).toBe(true);
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
    expect(shortLimit).toContain("…");
    expect(longLimit).toContain("x".repeat(500));
    expect(longLimit).not.toContain("x".repeat(500) + "…");
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
    expect(rendered).toContain("… +4 lines");
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

  test("tree truncation sets the signal without a per-line hint, in either mode", () => {
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

    const signal = createTruncationSignal();
    const unified = renderNode(
      { type: "turn", value: turn },
      { depth: "expanded", truncate: 40, sessionId: 142, signal },
    );
    // Legacy mode never renders files_read at all (unified-only field), so it
    // has nothing to truncate here — unrelated to the hint removal itself.
    const legacy = formatTurnExpanded(turn, { truncate: 40 });

    expect(unified).toContain("… +4 lines");
    expect(unified).not.toContain("mnemo-replay skill");
    expect(legacy).not.toContain("mnemo-replay skill");
    expect(signal.truncated).toBe(true);
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

  test("sets the truncation signal only when a field actually got cut", () => {
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

    const shortSignal = createTruncationSignal();
    const short = renderNode(
      { type: "turn", value: { ...turn, promptPreview: "short text" } },
      { depth: "expanded", truncate: 200, sessionId: 142, signal: shortSignal },
    );
    const longSignal = createTruncationSignal();
    const long = renderNode(
      { type: "turn", value: turn },
      { depth: "expanded", truncate: 200, sessionId: 142, signal: longSignal },
    );

    expect(short).not.toContain("…");
    expect(shortSignal.truncated).toBe(false);
    expect(long).toContain(`${"y".repeat(200)}…`);
    expect(long).not.toContain("mnemo-replay skill");
    expect(longSignal.truncated).toBe(true);
    expect(
      formatTurnCollapsed(anchoredTurn, { sessionId: 17 }),
    ).toContain("[S17][T13:L42] Anchored turn");
  });
});

describe("truncation lands on a boundary a reader can see", () => {
  const baseTurn: FormattedTurn = {
    id: 21,
    promptNumber: 21,
    transcriptLineStart: null,
    title: null,
    content: null,
  };

  test("a cut inside a word retreats to the word boundary", () => {
    // The production shape: a note's content is prose, and a raw slice ended
    // mid-identifier ("identity sup…", "messaging-s…"), which reads as
    // corruption rather than as truncation.
    const content = `${"alpha beta gamma ".repeat(20)}supplementary`;
    const rendered = renderNode(
      { type: "turn", value: { ...baseTurn, title: "boundary", content } },
      { depth: "expanded" },
    );

    const shown = rendered.split("- desc: ")[1]?.split("\n")[0] ?? "";
    // One character, not three: the mark a cut field ends with is the same on
    // every read surface now, and it is the one the timeline already used.
    expect(shown).toEndWith("…");
    expect(shown.slice(0, -1)).not.toEndWith(" ");
    // Whatever survived is whole words: the visible text is a prefix of the
    // source that ends where the source has a space.
    expect(content.startsWith(shown.slice(0, -1))).toBe(true);
    expect(content[shown.length - 1]).toBe(" ");
  });

  test("a window that already ends on whitespace keeps its last word", () => {
    // "…too" where the source reads "…too long " is a word thrown away for
    // nothing: the slice stopped before a space, so its last word was whole.
    const content = `${"ab ".repeat(66)}tail`;
    const rendered = renderNode(
      { type: "turn", value: { ...baseTurn, title: "aligned", content } },
      { depth: "expanded" },
    );

    expect(rendered).toContain(`${"ab ".repeat(66).trimEnd()}…`);
  });

  test("a sentence end is never honoured — the window keeps its evidence", () => {
    // A note written conclusion-first ends its first sentence well before the
    // window does. Retreating there would show the claim and drop every piece
    // of support the rest of the window exists to carry, so the cut is decided
    // by word boundaries alone.
    const content = `Short conclusion. ${"evidence ".repeat(40)}`;
    const rendered = renderNode(
      { type: "turn", value: { ...baseTurn, title: "early", content } },
      { depth: "expanded" },
    );

    expect(rendered).not.toContain("Short conclusion.…");
    expect(rendered).toContain("evidence evidence");
  });

  test("an unbroken run still hard-cuts", () => {
    const rendered = renderNode(
      {
        type: "turn",
        value: { ...baseTurn, title: "unbroken", content: "x".repeat(500) },
      },
      { depth: "expanded" },
    );

    expect(rendered).toContain(`${"x".repeat(200)}…`);
  });

  test("a multi-line prompt standing in for a missing note is collapsed to one line", () => {
    // A turn with no note falls back to its user prompt for the title slot,
    // and a machine-generated prompt carries newlines. They reached the layout
    // intact and spilled one turn's label across four lines.
    const promptPreview =
      "<task-notification>\n<task-id>a1758e6c</task-id>\n<output-file>/tmp/x.txt</output-file>\n</task-notification>";
    const rendered = formatTurnCollapsed(
      { ...baseTurn, promptPreview },
      { sessionId: 15069 },
    );

    expect(rendered.split("\n")).toHaveLength(1);
    expect(rendered).toContain("<task-notification> <task-id>a1758e6c</task-id>");
  });

  test("the expanded prompt and response lines are one line each", () => {
    // The collapsed title slot was collapsed and the expanded detail was not,
    // so one multi-line prompt read as one line under depth="collapsed" and as
    // four under depth="expanded" — the same turn, two shapes.
    const promptPreview =
      "<task-notification>\n<task-id>a1758e6c</task-id>\n</task-notification>";
    const responsePreview = "the answer\n\nwith a blank line in it";
    const rendered = renderNode(
      {
        type: "turn",
        value: { ...baseTurn, title: "expanded", promptPreview, responsePreview },
      },
      { depth: "expanded" },
    );

    expect(rendered).toContain(
      '- prompt: "<task-notification> <task-id>a1758e6c</task-id> </task-notification>"',
    );
    expect(rendered).toContain('- response: "the answer with a blank line in it"');
    // Every line of this view is a `- label:` bullet or a bullet under one. A
    // raw newline inside a value does not just look wrong, it produces a line
    // no reader (and no downstream parser) can attribute to a field.
    for (const line of rendered.split("\n")) {
      expect(line.trimStart()).toStartWith("-");
    }
  });
});

/**
 * An observation renders as the call it was, not as the JSON it was stored in.
 * The `- in:` / `- out:` labels named where a value was kept rather than what
 * it is, and the two sides do not correspond to what a reader wants: an
 * `Edit`'s meaning is entirely in its input, a `Read`'s entirely in its result,
 * and a `Bash` draws its header from one side and its body from the other.
 */
describe("an observation renders as the call it was", () => {
  function observation(
    toolName: string,
    toolInput: unknown,
    toolResult: unknown,
  ): FormattedObservation {
    return {
      id: 7,
      // What an era row's label really holds: no pipeline summarizes an
      // observation any more, so the title has already fallen back to the tool
      // name by the time the renderer sees it.
      title: toolName,
      toolName,
      toolInput: JSON.stringify(toolInput),
      toolResult:
        typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
    };
  }

  function render(
    value: FormattedObservation,
    options: { truncate?: number; signal?: TruncationSignal } = {},
  ): string {
    return renderNode({ type: "observation", value }, {
      depth: "expanded",
      ...options,
    });
  }

  test("a Bash call renders as its command with its output beneath", () => {
    const rendered = render(
      observation(
        "Bash",
        { command: "git diff --stat", description: "Show the diff" },
        {
          stdout: "src/mcp/format.ts | 42 ++++---\nsrc/mcp/recall.ts |  8 +--",
          stderr: "",
          interrupted: false,
          isImage: false,
        },
      ),
    );

    expect(rendered).toBe(
      [
        "- [O7] Bash(git diff --stat)",
        "    src/mcp/format.ts | 42 ++++---",
        "    src/mcp/recall.ts |  8 +--",
      ].join("\n"),
    );
  });

  test("standard error is shown when it is non-empty", () => {
    const rendered = render(
      observation("Bash", { command: "bun test" }, {
        stdout: "3 pass",
        stderr: "error: 1 test failed",
      }),
    );

    expect(rendered).toContain("    3 pass");
    expect(rendered).toContain("    stderr: error: 1 test failed");
  });

  test("neither observation form carries the in/out labels any more", () => {
    const value = observation("Bash", { command: "ls" }, { stdout: "a.ts" });

    for (const depth of ["collapsed", "expanded"] as const) {
      const rendered = renderNode({ type: "observation", value }, { depth });
      expect(rendered).not.toContain("- in:");
      expect(rendered).not.toContain("- out:");
      expect(rendered).toContain("Bash(ls)");
    }
  });

  test("a body is cut by whole lines and says how many it dropped", () => {
    const stdout = Array.from({ length: 30 }, (_, index) => `line ${index}`)
      // Blank lines cost vertical space and carry nothing, so they are dropped
      // before anything is counted — otherwise the "+N lines" a reader is asked
      // to judge by counts emptiness.
      .join("\n\n");
    const rendered = render(
      observation("Bash", { command: "ls" }, { stdout }),
      { truncate: 40 },
    );

    const bodyLines = rendered.split("\n").slice(1);
    const marker = bodyLines[bodyLines.length - 1] ?? "";
    const droppedMatch = /^ {4}… \+(\d+) lines$/.exec(marker);
    expect(droppedMatch).not.toBeNull();
    // Every surviving line is a whole line of the source — the cut lands
    // between lines, never inside one.
    for (const line of bodyLines.slice(0, -1)) {
      expect(line).toMatch(/^ {4}line \d+$/);
    }
    expect(bodyLines.length - 1 + Number(droppedMatch?.[1])).toBe(30);
  });

  test("the budget does not charge a separator after the final line", () => {
    // A limit of 3 buys `a\nb`, which is three characters. Charging a separator
    // after the last line as well made the budget one character short of what
    // it was asked for, so a body that fitted was cut and reported `+1 lines`.
    const rendered = render(
      observation("Bash", { command: "ls" }, { stdout: "a\nb" }),
      { truncate: 3 },
    );

    expect(rendered.split("\n").slice(1)).toEqual(["    a", "    b"]);
    expect(rendered).not.toContain("lines");
  });

  test("the truncation signal is set only when something was dropped", () => {
    // Three seven-character lines and the two separators between them are
    // exactly twenty-three characters, and the header fits too — so nothing in
    // this render was cut, and the response must not offer to show more.
    const stdout = "aaaaaaa\nbbbbbbb\nccccccc";
    const intact = createTruncationSignal();
    render(observation("Bash", { command: "ls" }, { stdout }), {
      truncate: 23,
      signal: intact,
    });
    expect(intact.truncated).toBe(false);

    const cut = createTruncationSignal();
    const rendered = render(observation("Bash", { command: "ls" }, { stdout }), {
      truncate: 22,
      signal: cut,
    });
    expect(rendered).toContain("… +1 lines");
    expect(cut.truncated).toBe(true);
  });

  test("a header cut down to the tool name still identifies the call", () => {
    // At a budget this small the cut reached into the name and `Bash(ls)`
    // became `B…)`, which identifies neither a tool nor an argument. The
    // argument is what a header spends its budget on; the name is what is left
    // when there is nothing to spend.
    const rendered = render(
      observation("Bash", { command: "ls" }, { stdout: "" }),
      { truncate: 1 },
    );

    expect(rendered).toBe("- [O7] Bash");
  });

  test("a body's lines are indented under their header", () => {
    // A multi-line value that reaches column zero produces lines no reader and
    // no downstream parser can attribute to the observation they came from.
    const rendered = render(
      observation("Bash", { command: "cat notes" }, {
        stdout: "first\nsecond\nthird",
      }),
    );

    for (const line of rendered.split("\n").slice(1)) {
      expect(line).toStartWith("    ");
    }
  });

  test("an Edit shows what changed and nothing from its result", () => {
    const rendered = render(
      observation(
        "Edit",
        {
          file_path: "/Users/me/project/src/mcp/recall.ts",
          old_string: "  const limit = 10;",
          new_string: "  const limit = 20;",
          replace_all: false,
        },
        {
          filePath: "/Users/me/project/src/mcp/recall.ts",
          oldString: "  const limit = 10;",
          newString: "  const limit = 20;",
          originalFile: `${"the whole pre-edit file ".repeat(40)}`,
          structuredPatch: [{ oldStart: 1 }],
        },
      ),
    );

    expect(rendered).toBe(
      [
        "- [O7] Edit(recall.ts)",
        "    -   const limit = 10;",
        "    +   const limit = 20;",
      ].join("\n"),
    );
    expect(rendered).not.toContain("pre-edit file");
  });

  test("a Write shows the beginning of what was written, on a create", () => {
    const rendered = render(
      observation(
        "Write",
        {
          file_path: "/Users/me/project/docs/plan.md",
          content: "# Plan\n\n- step one\n- step two\n",
        },
        {
          type: "create",
          filePath: "/Users/me/project/docs/plan.md",
          content: "# Plan\n\n- step one\n- step two\n",
          // The majority case: there is no pre-edit file to diff against, so a
          // projection that reached for one would render empty here.
          originalFile: null,
          structuredPatch: [],
        },
      ),
    );

    expect(rendered).toBe(
      [
        "- [O7] Write(plan.md)",
        "    # Plan",
        "    - step one",
        "    - step two",
      ].join("\n"),
    );
  });

  test("a Read says how much was read, not what was in the file", () => {
    const rendered = render(
      observation(
        "Read",
        { file_path: "/Users/me/project/src/mcp/format.ts", offset: 124, limit: 45 },
        {
          type: "text",
          file: {
            filePath: "/Users/me/project/src/mcp/format.ts",
            content: "export function truncateText() {\n  return 1;\n}",
            numLines: 45,
            startLine: 124,
            totalLines: 237,
          },
        },
      ),
    );

    expect(rendered).toBe(
      ["- [O7] Read(format.ts)", "    45 lines (124–168 of 237)"].join("\n"),
    );
  });

  test("a note renders as the turn it addressed and its title, with the receipt", () => {
    const rendered = render(
      observation(
        "mcp__plugin_claude-mnemo_mnemo__note",
        {
          turn: "S15069/T485",
          title: "fix+render: the observation body is the call's output",
          content: "A long note body that is the point of the call, not of the render.",
        },
        [{ type: "text", text: "Noted S15069/T485. ride_turn: S15069/T485." }],
      ),
    );

    expect(rendered).toBe(
      [
        "- [O7] mcp__plugin_claude-mnemo_mnemo__note(S15069/T485 fix+render: the observation body is the call's output)",
        "    Noted S15069/T485. ride_turn: S15069/T485.",
      ].join("\n"),
    );
  });

  test("a dispatched agent says its report is not stored with the call", () => {
    // Rendering an empty body would assert that it returned nothing, which is
    // false: the completion report arrives later as a turn-level notification
    // and never becomes a second observation.
    const rendered = render(
      observation(
        "Agent",
        {
          description: "Tear down observation queue",
          prompt: "实现一张票 …",
          subagent_type: "offload-worker",
        },
        {
          isAsync: true,
          status: "async_launched",
          agentId: "a6d8456146913f590",
          description: "Tear down observation queue",
          prompt: "实现一张票 …",
          outputFile: "/private/tmp/claude-501/a6d8456146913f590.output",
        },
      ),
    );

    expect(rendered).toStartWith("- [O7] Agent(Tear down observation queue)");
    expect(rendered.split("\n")[1]).toContain("not stored with this call");
    expect(rendered).not.toContain("outputFile");
  });

  test("an unknown tool renders through the generic rule", () => {
    const rendered = render(
      observation(
        "ToolSearch",
        { query: "select:Read,Edit", max_results: 3 },
        { matches: ["Read", "Edit"], query: "select:Read,Edit", total_deferred_tools: 39 },
      ),
    );

    expect(rendered).toStartWith("- [O7] ToolSearch(");
    expect(rendered).toContain("select:Read,Edit");
    expect(rendered).toContain("matches:");
  });

  test("a header cut inside its argument still closes its parenthesis", () => {
    const rendered = render(
      observation("Bash", { command: `echo ${"long ".repeat(80)}` }, { stdout: "" }),
      { truncate: 60 },
    );

    expect(rendered).toMatch(/^- \[O7\] Bash\(echo (long ?)+…\)$/);
  });

  test("a legacy observation renders exactly as it did before", () => {
    // A row recorded before the era cutoff carries no raw tool fields at all —
    // its record is its extractor's summary — so this change is about what a
    // NEW row looks like, not about what the archive says.
    const legacy: FormattedObservation = {
      id: 7,
      title: "Added mutex",
      content: "Guards refresh",
    };

    expect(formatObservationCollapsed(legacy)).toBe(
      ["- [O7] Added mutex", "  - desc: Guards refresh"].join("\n"),
    );
    expect(formatObservationExpanded(legacy)).toBe(
      ["- [O7] Added mutex", "  - desc: Guards refresh"].join("\n"),
    );
  });
});

describe("a projected call keeps the row's own record", () => {
  test("a row that has both a title and a call shows both", () => {
    // Not reachable from recall today — an era row has no extractor title — but
    // the two are independent fields, and a title that exists is the row's own
    // record, not something the header may overwrite.
    const rendered = renderNode(
      {
        type: "observation",
        value: {
          id: 7,
          title: "Added mutex",
          toolName: "Bash",
          toolInput: JSON.stringify({ command: "bun test" }),
          toolResult: JSON.stringify({ stdout: "3 pass" }),
        },
      },
      { depth: "expanded" },
    );

    expect(rendered).toBe(
      [
        "- [O7] Added mutex",
        "  - tool: 🔧 Bash(bun test)",
        "    3 pass",
      ].join("\n"),
    );
  });

  test("a line longer than the whole budget is cut inside itself, not dropped", () => {
    // The rule, stated rather than implied: the budget is spent by whole lines,
    // and a line that alone exceeds it is cut inside itself and ends in the
    // truncation mark. Dropping it instead would render a call that produced
    // thousands of characters as `… +1 lines` and nothing else — the same
    // untruth an empty body tells, and not a rare one: 22 of the 304 era Bash
    // rows carrying output have a line longer than the default budget.
    const rendered = renderNode(
      {
        type: "observation",
        value: {
          id: 7,
          title: "Bash",
          toolName: "Bash",
          toolInput: JSON.stringify({ command: "cat blob" }),
          toolResult: JSON.stringify({ stdout: "x".repeat(20_000) }),
        },
      },
      { depth: "expanded", truncate: 200 },
    );

    expect(rendered).toBe(
      ["- [O7] Bash(cat blob)", `    ${"x".repeat(200)}…`].join("\n"),
    );
    // Cut, not dropped: the line is shown, so it is not also counted as one the
    // reader never saw.
    expect(rendered).not.toContain("+1 lines");
  });

  test("a cut inside a line still lands on a word boundary", () => {
    // The two cuts stay apart in the output — a line cut inside ends in the
    // mark, dropped lines are counted by `… +N lines` — and neither ends the
    // reader's last line in the middle of a word.
    const rendered = renderNode(
      {
        type: "observation",
        value: {
          id: 7,
          title: "Bash",
          toolName: "Bash",
          toolInput: JSON.stringify({ command: "cat prose" }),
          toolResult: JSON.stringify({ stdout: "word ".repeat(100).trim() }),
        },
      },
      { depth: "expanded", truncate: 200 },
    );

    const body = rendered.split("\n")[1] ?? "";
    expect(body).toEndWith("word…");
    expect(rendered).not.toContain("lines");
  });
});
