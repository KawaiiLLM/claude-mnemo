import { describe, expect, test } from "bun:test";

import {
  type FormattedObservation,
  type FormattedSession,
  type FormattedTurn,
  type TruncationSignal,
  createTruncationSignal,
  DEFAULT_TURN_RENDER_FIELDS,
  renderNode,
  truncateText,
} from "../../src/mcp/format";
import { RECALL_TURN_FIELD_NAMES, type RecallTurnField } from "../../src/mcp/memory-filter";

const createdAtEpoch = Math.floor(Date.UTC(2026, 3, 5, 14, 30) / 1000);

// Every `filter.fields` value at once — the ticket 11 replacement for the
// retired "expanded" depth, used wherever a test wants to see everything a
// turn can show.
const ALL_FIELDS: ReadonlySet<RecallTurnField> = new Set(RECALL_TURN_FIELD_NAMES);

describe("MCP format renderer", () => {
  test("formats default-field lines with list structure, stats, and status", () => {
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

    expect(renderNode({ type: "session", value: session })).toBe(
      [
        "- [S142] Auth refactor | 💬3 💡8 | 2026-04-05 | claude-mnemo",
        "  - desc: Fix race + add tests",
      ].join("\n"),
    );

    expect(renderNode({ type: "turn", value: turn })).toBe(
      [
        "  - [T1:L17] Diagnose auth | 💡2 📖1 ✏️2 🔧4 [extracted]",
        "    - desc: Refresh overlap diagnosed",
      ].join("\n"),
    );

    expect(
      renderNode({ type: "turn", value: turn }, { indent: "", sessionId: 142 }),
    ).toBe(
      [
        "- [S142][T1:L17] Diagnose auth | 💡2 📖1 ✏️2 🔧4 [extracted]",
        "  - desc: Refresh overlap diagnosed",
      ].join("\n"),
    );

    expect(renderNode({ type: "observation", value: observation })).toBe(
      ["- [O7] Added mutex", "  - desc: Guards refresh"].join("\n"),
    );

    expect(
      renderNode({ type: "observation", value: observation }, { indent: "    " }),
    ).toBe(
      ["    - [O7] Added mutex", "      - desc: Guards refresh"].join("\n"),
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

    expect(renderNode({ type: "session", value: session })).toBe(
      [
        "- [S9] Empty stats | 2026-04-05 | claude-mnemo",
        "  - desc: Collapsed description stays visible",
      ].join("\n"),
    );

    expect(renderNode({ type: "turn", value: turn })).toBe(
      [
        "  - [T2] No stats [pending]",
        "    - desc: Collapsed description stays visible",
      ].join("\n"),
    );
  });

  test("renders current turn statuses directly, at either field selection", () => {
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

    expect(renderNode({ type: "turn", value: activeTurn })).toContain("[active]");
    expect(
      renderNode({ type: "turn", value: activeTurn }, { fields: ALL_FIELDS }),
    ).toContain("[active]");
    expect(renderNode({ type: "turn", value: undoneTurn })).toContain("[undone]");
    expect(
      renderNode({ type: "turn", value: undoneTurn }, { fields: ALL_FIELDS }),
    ).toContain("[undone]");
  });

  test("filter.fields adds detail blocks on top of the default field set", () => {
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

    // ownership-and-note-cadence spec ([S15069/T910]-[T913]): the session's
    // own render is the collapsed line plus (when present) the raw
    // transcript pointer — insight/decision/done/next/reference retired
    // unconditionally, legacy row or not. `includeRawPointer` is recall.ts's
    // own concern (the S<n> DETAIL route sets it); this module's default is
    // off, matching every session HEADER embed.
    expect(renderNode({ type: "session", value: session })).toBe(
      [
        "- [S142] Auth refactor | 💬3 💡8 | 2026-04-05 | claude-mnemo",
        "  - desc: Fix race + add tests",
      ].join("\n"),
    );

    expect(renderNode({ type: "turn", value: turn }, { fields: ALL_FIELDS })).toBe(
      [
        "  - [T1] Diagnose auth | 💡2 📖1 ✏️2 🔧4 [extracted]",
        "    - desc: Refresh overlap diagnosed",
        '    - prompt: "Why am I getting 401 errors?"',
        '    - response: "I found a race condition in refresh logic."',
        "    - insight:",
        "      - concurrent refreshes collide",
        "    - files_read:",
        "      - src/auth.ts",
        "    - files_modified:",
        "      - .",
        "      - src/auth.ts",
        "      - tests/auth.test.ts",
      ].join("\n"),
    );

    expect(renderNode({ type: "observation", value: observation })).toBe(
      ["- [O7] Added mutex", "  - desc: Guards refresh"].join("\n"),
    );
  });

  test("a session detail render includes the raw pointer only when includeRawPointer is set", () => {
    const session: FormattedSession = {
      id: 200,
      title: "Session redesign",
      project: "claude-mnemo",
      createdAtEpoch,
      content: "Reworking the session summary schema",
      jsonlPath: "/tmp/session-200.jsonl",
      turnCount: 5,
      observationCount: 12,
    };

    expect(renderNode({ type: "session", value: session })).not.toContain("raw:");
    expect(
      renderNode({ type: "session", value: session }, { includeRawPointer: true }),
    ).toBe(
      [
        "- [S200] Session redesign | 💬5 💡12 | 2026-04-05 | claude-mnemo",
        "  - desc: Reworking the session summary schema",
        "  raw: /tmp/session-200.jsonl",
      ].join("\n"),
    );
  });

  // Ticket 11 (read-write-contract spec, "视图(读面)"): the char `truncate`/
  // `truncateCap` knobs retired outright — every field renders IN FULL now;
  // the ONLY thing that ever cuts a rendered block is the `turn` TOKEN
  // budget, applied once to the whole block (see the "per-item token
  // budget" describe block below and `capRenderToTokenBudget`'s own tests
  // in recall-segment-card.test.ts).
  test("fields render in full — no per-field character cap survives", () => {
    const turn: FormattedTurn = {
      id: 10,
      promptNumber: 10,
      transcriptLineStart: null,
      title: "fix auth",
      content: "x".repeat(500),
      status: "extracted",
    };

    const rendered = renderNode(
      { type: "turn", value: turn },
      { fields: DEFAULT_TURN_RENDER_FIELDS, turnBudget: 100_000 },
    );

    expect(rendered).toContain("x".repeat(500));
    expect(rendered).not.toContain("…");
  });

  test("renders turn files as a full tree, no per-field line cap", () => {
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

    expect(
      renderNode(
        { type: "turn", value: turn },
        { fields: new Set<RecallTurnField>(["title", "files"]), turnBudget: 100_000 },
      ),
    ).toBe(
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

  test("renders turn with relative-path filesRead as correct tree", () => {
    const turn: FormattedTurn = {
      id: 17,
      promptNumber: 17,
      transcriptLineStart: null,
      title: "relative tree",
      status: "extracted",
      filesRead: ["src/auth.ts", "src/server.ts"],
      filesModified: [],
    };

    expect(
      renderNode(
        { type: "turn", value: turn },
        { fields: new Set<RecallTurnField>(["title", "files"]), turnBudget: 100_000 },
      ),
    ).toBe(
      [
        "  - [T17] relative tree | 📖2 [extracted]",
        "    - files_read:",
        "      - src",
        "      - auth.ts",
        "      - server.ts",
      ].join("\n"),
    );
  });

  test("a multi-line prompt standing in for a missing note is collapsed to one line", () => {
    // A turn with no note falls back to its user prompt for the title slot,
    // and a machine-generated prompt carries newlines. They reached the
    // layout intact and spilled one turn's label across four lines.
    const promptPreview =
      "<task-notification>\n<task-id>a1758e6c</task-id>\n<output-file>/tmp/x.txt</output-file>\n</task-notification>";
    const rendered = renderNode(
      {
        type: "turn",
        value: {
          id: 21,
          promptNumber: 21,
          transcriptLineStart: null,
          title: null,
          promptPreview,
        },
      },
      { sessionId: 15069 },
    );

    expect(rendered.split("\n")).toHaveLength(1);
    expect(rendered).toContain("<task-notification> <task-id>a1758e6c</task-id>");
  });

  test("the prompt and response detail lines are one line each, newlines collapsed", () => {
    const promptPreview =
      "<task-notification>\n<task-id>a1758e6c</task-id>\n</task-notification>";
    const responsePreview = "the answer\n\nwith a blank line in it";
    const rendered = renderNode(
      {
        type: "turn",
        value: {
          id: 21,
          promptNumber: 21,
          transcriptLineStart: null,
          title: "expanded",
          promptPreview,
          responsePreview,
        },
      },
      { fields: ALL_FIELDS },
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

// ---------------------------------------------------------------------------
// `truncateText` — the one word-boundary primitive left (ticket 11: the
// fixed 200-char DEFAULT_TRUNCATE default it used to be invoked with by
// every field is gone; the function's own boundary rule is unchanged and is
// what `capRenderToTokenBudget` reuses for the token-budget cut).
// ---------------------------------------------------------------------------

describe("truncateText lands its cut on a boundary a reader can see", () => {
  test("a cut inside a word retreats to the word boundary", () => {
    // A raw slice ends mid-identifier ("identity sup…", "messaging-s…"),
    // which reads as corruption rather than as truncation.
    const content = `${"alpha beta gamma ".repeat(20)}supplementary`;
    const shown = truncateText(content, { limit: 200 });

    expect(shown).toEndWith("…");
    expect(shown.slice(0, -1)).not.toEndWith(" ");
    expect(content.startsWith(shown.slice(0, -1))).toBe(true);
    expect(content[shown.length - 1]).toBe(" ");
  });

  test("a window that already ends on whitespace keeps its last word", () => {
    // "…too" where the source reads "…too long " is a word thrown away for
    // nothing: the slice stopped before a space, so its last word was whole.
    const content = `${"ab ".repeat(66)}tail`;
    const shown = truncateText(content, { limit: 200 });

    expect(shown).toBe(`${"ab ".repeat(66).trimEnd()}…`);
  });

  test("a sentence end is never honoured — the window keeps its evidence", () => {
    // A note written conclusion-first ends its first sentence well before
    // the window does. Retreating there would show the claim and drop every
    // piece of support the rest of the window exists to carry.
    const content = `Short conclusion. ${"evidence ".repeat(40)}`;
    const shown = truncateText(content, { limit: 200 });

    expect(shown).not.toContain("Short conclusion.…");
    expect(shown).toContain("evidence evidence");
  });

  test("an unbroken run still hard-cuts", () => {
    const shown = truncateText("x".repeat(500), { limit: 200 });
    expect(shown).toBe(`${"x".repeat(200)}…`);
  });

  test("marks the signal only when a cut actually happened", () => {
    const untouched = createTruncationSignal();
    expect(truncateText("short text", { limit: 200, signal: untouched })).toBe(
      "short text",
    );
    expect(untouched.truncated).toBe(false);

    const touched = createTruncationSignal();
    truncateText("y".repeat(500), { limit: 200, signal: touched });
    expect(touched.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-item token budget (ticket 11): the SOLE size mechanism left, applied
// to the whole rendered block (session, turn, or observation) — never a
// per-field character cap. `capRenderToTokenBudget`'s own unit tests live in
// recall-segment-card.test.ts; these exercise it through `renderNode`.
// ---------------------------------------------------------------------------

describe("per-item token budget (`turnBudget` — the `turn` param at the MCP seam)", () => {
  test("defaults to DEFAULT_TURN_TOKEN_BUDGET when unspecified", () => {
    const rendered = renderNode({
      type: "turn",
      value: {
        id: 11,
        promptNumber: 11,
        transcriptLineStart: null,
        title: "turn budget default",
        content: "x".repeat(2000),
      },
    });

    expect(rendered).toContain("truncated to fit");
  });

  test("a bigger budget shows strictly more of the same content — no char-count knob involved", () => {
    const turn: FormattedTurn = {
      id: 12,
      promptNumber: 12,
      transcriptLineStart: null,
      title: null,
      content: "short text",
      promptPreview: "y".repeat(500),
      responsePreview: null,
    };

    const shortSignal = createTruncationSignal();
    const short = renderNode(
      { type: "turn", value: { ...turn, promptPreview: "short text" } },
      { fields: ALL_FIELDS, sessionId: 142, signal: shortSignal, turnBudget: 30 },
    );
    const longSignal = createTruncationSignal();
    const long = renderNode(
      { type: "turn", value: turn },
      { fields: ALL_FIELDS, sessionId: 142, signal: longSignal, turnBudget: 30 },
    );

    expect(short).not.toContain("…");
    expect(shortSignal.truncated).toBe(false);
    expect(long).toContain("…");
    expect(long).not.toContain("mnemo-replay skill");
    expect(longSignal.truncated).toBe(true);
  });

  test("the label survives even a budget too small for anything else, and the anchor address stays intact", () => {
    const anchoredTurn: FormattedTurn = {
      id: 13,
      promptNumber: 13,
      transcriptLineStart: 42,
      title: "Anchored turn",
      status: "extracted",
    };

    expect(
      renderNode(
        { type: "turn", value: anchoredTurn },
        { sessionId: 17, turnBudget: 1 },
      ),
    ).toContain("[S17][T13:L42] Anchored turn");
  });
});

/**
 * An observation renders as the call it was, not as the JSON it was stored
 * in. The `- in:` / `- out:` labels named where a value was kept rather than
 * what it is, and the two sides do not correspond to what a reader wants: an
 * `Edit`'s meaning is entirely in its input, a `Read`'s entirely in its
 * result, and a `Bash` draws its header from one side and its body from the
 * other.
 *
 * Ticket 11: an observation always renders every field it has — there is no
 * more collapsed/expanded split (there never was a real one: both depths
 * produced identical output before this ticket too). What DID retire is the
 * per-field character `truncate` budget (header-argument cutting, whole-line
 * "+N lines" dropping) — an observation's own size is bounded ONLY by the
 * outer per-item `turn` token budget now, tested in the section above and in
 * recall-segment-card.test.ts / recall.segments.test.ts.
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
      // observation any more, so the title has already fallen back to the
      // tool name by the time the renderer sees it.
      title: toolName,
      toolName,
      toolInput: JSON.stringify(toolInput),
      toolResult:
        typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
    };
  }

  function render(
    value: FormattedObservation,
    options: { turnBudget?: number; signal?: TruncationSignal } = {},
  ): string {
    return renderNode({ type: "observation", value }, { turnBudget: 100_000, ...options });
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
    const rendered = render(value);

    expect(rendered).not.toContain("- in:");
    expect(rendered).not.toContain("- out:");
    expect(rendered).toContain("Bash(ls)");
  });

  test("a body's lines are indented under their header", () => {
    // A multi-line value that reaches column zero produces lines no reader
    // and no downstream parser can attribute to the observation they came
    // from.
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
          // The majority case: there is no pre-edit file to diff against, so
          // a projection that reached for one would render empty here.
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
    // Rendering an empty body would assert that it returned nothing, which
    // is false: the completion report arrives later as a turn-level
    // notification and never becomes a second observation.
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

  test("a legacy observation renders exactly as it did before", () => {
    // A row recorded before the era cutoff carries no raw tool fields at
    // all — its record is its extractor's summary — so this change is about
    // what a NEW row looks like, not about what the archive says.
    const legacy: FormattedObservation = {
      id: 7,
      title: "Added mutex",
      content: "Guards refresh",
    };

    expect(render(legacy)).toBe(
      ["- [O7] Added mutex", "  - desc: Guards refresh"].join("\n"),
    );
  });

  test("a row that has both a title and a call shows both", () => {
    // Not reachable from recall today — an era row has no extractor title —
    // but the two are independent fields, and a title that exists is the
    // row's own record, not something the header may overwrite.
    const rendered = render({
      id: 7,
      title: "Added mutex",
      toolName: "Bash",
      toolInput: JSON.stringify({ command: "bun test" }),
      toolResult: JSON.stringify({ stdout: "3 pass" }),
    });

    expect(rendered).toBe(
      ["- [O7] Added mutex", "  - tool: 🔧 Bash(bun test)", "    3 pass"].join("\n"),
    );
  });

  // Ticket 11: the per-item `turn` budget replaces the retired per-field
  // `truncate` cap even for a single giant observation body — a huge line
  // is now cut WORD-BOUNDARY at the point the budget runs out, never
  // dropped outright (same "the cut is visible, not silent" guarantee the
  // old line-aware truncator gave, driven by the one surviving budget).
  test("a body far larger than the budget is cut at a word boundary, not silently dropped", () => {
    const big = render(
      observation("Bash", { command: "cat blob" }, { stdout: "x".repeat(20_000) }),
      { turnBudget: 30 },
    );

    expect(big).toContain("[O7] Bash(cat blob)"); // the label survives whole
    expect(big).toContain("…");
    expect(big).toContain("truncated to fit");
  });
});
