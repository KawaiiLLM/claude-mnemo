/**
 * Trimmed copies of real stored tool payloads, one per tool that occurs.
 *
 * Every entry was copied out of this project's own database (table
 * `observations`, read-only) at the observation id named in its comment, and
 * then shortened by eliding long values — never by reshaping them. Invented
 * payloads would only test the shapes we imagined, and the survey behind this
 * work exists because several of them are not what we imagined: an `Edit`
 * result repeats its input verbatim, a `Write` result's `originalFile` is
 * `null` on a create, an `Agent` result is usually a launch stub, and one
 * legacy tool stores a result that is not JSON at all.
 *
 * Stored as the strings the database holds, because that is what the
 * projection is handed — a payload that does not parse has to survive the trip
 * too.
 */

export interface StoredToolPayload {
  toolName: string;
  toolInput: string;
  toolResult: string;
}

function stored(
  toolName: string,
  toolInput: unknown,
  toolResult: unknown,
): StoredToolPayload {
  return {
    toolName,
    toolInput: JSON.stringify(toolInput),
    toolResult:
      typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
  };
}

/** O71925. stdout kept whole (140 chars); it is already short. */
export const BASH_PAYLOAD = stored(
  "Bash",
  {
    command:
      'sqlite3 -readonly ~/.claude-mnemo/claude-mnemo.db "SELECT * FROM era_state;" 2>&1; echo "--- 新纪元 turn 状态 ---"',
    description: "Check era state",
    timeout: 60000,
  },
  {
    stdout: "1|1786427403|1786427403\n--- 新纪元 turn 状态 ---\nactive|1",
    stderr: "",
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  },
);

/** O72437, the smallest era Edit. `originalFile` elided from 6,000+ chars. */
export const EDIT_PAYLOAD = stored(
  "Edit",
  {
    file_path: "/Users/zhaoqixuan/Projects/action-roleplay/scenes/v2/scene.py",
    old_string: "    Entity,\n    Locale,\n    Meter,",
    new_string: "    Entity,\n    Item,\n    Locale,\n    Meter,",
    replace_all: false,
  },
  {
    filePath: "/Users/zhaoqixuan/Projects/action-roleplay/scenes/v2/scene.py",
    oldString: "    Entity,\n    Locale,\n    Meter,",
    newString: "    Entity,\n    Item,\n    Locale,\n    Meter,",
    originalFile: "\"\"\"M10V2 …the whole pre-edit file, elided\"\"\"",
    structuredPatch: [{ oldStart: 12, oldLines: 3, newLines: 4 }],
    userModified: false,
    replaceAll: false,
  },
);

/** O72372. A create: `originalFile` really is null on 24 of 30 sampled rows. */
export const WRITE_PAYLOAD = stored(
  "Write",
  {
    file_path: "/Users/zhaoqixuan/Projects/action-roleplay/.scratch/07-audit.md",
    content: "# 07 — 收口\n\n**Status:** ready-for-agent\n\n- [x] 三视角完整渲染样张写入 .scratch 报告\n",
  },
  {
    type: "create",
    filePath: "/Users/zhaoqixuan/Projects/action-roleplay/.scratch/07-audit.md",
    content: "# 07 — 收口\n\n**Status:** ready-for-agent\n\n- [x] 三视角完整渲染样张写入 .scratch 报告\n",
    structuredPatch: [],
    originalFile: null,
    userModified: false,
  },
);

/** O71943. `file.content` elided from 1,210 chars — the counts are the real ones. */
export const READ_PAYLOAD = stored(
  "Read",
  {
    file_path:
      "/Users/zhaoqixuan/Projects/claude-mnemo/src/hooks/handlers/post-tool-use.ts",
    offset: 124,
    limit: 45,
  },
  {
    type: "text",
    file: {
      filePath:
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/hooks/handlers/post-tool-use.ts",
      content: "      if (!latestTurn) {\n        …the file slice, elided\n",
      numLines: 45,
      startLine: 124,
      totalLines: 237,
    },
  },
);

/** O72086. The common Agent shape: a launch stub, no report. Prompt elided. */
export const AGENT_ASYNC_PAYLOAD = stored(
  "Agent",
  {
    description: "Tear down observation queue",
    prompt: "实现一张票。仓库 `/Users/zhaoqixuan/Projects/claude-mnemo` …elided",
    subagent_type: "offload-worker",
    model: "opus",
    run_in_background: true,
  },
  {
    isAsync: true,
    status: "async_launched",
    agentId: "a6d8456146913f590",
    description: "Tear down observation queue",
    resolvedModel: "claude-sonnet-5",
    prompt: "实现一张票。仓库 `/Users/zhaoqixuan/Projects/claude-mnemo` …elided",
    outputFile: "/private/tmp/claude-501/a6d8456146913f590.output",
    canReadOutputFile: true,
  },
);

/** O72390. The rare synchronous shape: the report really is in the result. */
export const AGENT_COMPLETED_PAYLOAD = stored(
  "Agent",
  {
    description: "Closing audit",
    prompt: "数据侧封板验收 …elided",
    subagent_type: "offload-worker",
  },
  {
    status: "completed",
    prompt: "数据侧封板验收 …elided",
    agentId: "a1a4a03d1f0e5c2b7",
    agentType: "offload-worker",
    content: [
      {
        type: "text",
        text: "## Outcome\n\nWrote `.scratch/scene-data-v2/closing-report.md`\n\nAcceptance criteria: all met.",
      },
    ],
    resolvedModel: "claude-opus-5",
    totalDurationMs: 512_000,
    totalTokens: 98_000,
    totalToolUseCount: 41,
    usage: { input_tokens: 12, output_tokens: 34 },
    toolStats: { Read: 9 },
  },
);

/** O71974. `content`/`insight` elided; the receipt is the real 160-char one. */
export const NOTE_PAYLOAD = stored(
  "mcp__plugin_claude-mnemo_mnemo__note",
  {
    turn: "S15069/T485",
    title: "fix+observation-search: layer was dark after 0.9.6",
    content: "Reload succeeded (worker 0.9.6-mso8aqc4) …elided",
    insight: "…elided",
  },
  [
    {
      type: "text",
      text: "Noted S15069/T485. ride_turn: S15069/T485. writer_model: not recorded — this environment does not expose the model to the MCP server.",
    },
  ],
);

/** O72165. The MCP envelope again, but here the text is the substance. */
export const RECALL_PAYLOAD = stored(
  "mcp__plugin_claude-mnemo_mnemo__recall",
  { id: "S15069/T508/O*", pageSize: 6 },
  [
    {
      type: "text",
      text: "- [S15069] 0.9.6 released and pushed | 💬509 💡2892 | 2026-07-20\n  - desc: All era-cutover work is released.",
    },
  ],
);

/** O72164. No table entry: this is what the generic rule has to carry. */
export const TOOL_SEARCH_PAYLOAD = stored(
  "ToolSearch",
  {
    query:
      "select:mcp__plugin_claude-mnemo_mnemo__note,mcp__plugin_claude-mnemo_mnemo__recall",
    max_results: 3,
  },
  {
    matches: [
      "mcp__plugin_claude-mnemo_mnemo__note",
      "mcp__plugin_claude-mnemo_mnemo__recall",
    ],
    query:
      "select:mcp__plugin_claude-mnemo_mnemo__note,mcp__plugin_claude-mnemo_mnemo__recall",
    total_deferred_tools: 39,
  },
);

/** O71983. Questions elided; the result mirrors the input plus the answers. */
export const ASK_USER_QUESTION_PAYLOAD = stored(
  "AskUserQuestion",
  { questions: [{ question: "observation 的队列通道拆到哪一层？", header: "拆除范围" }] },
  { questions: [{ question: "observation 的队列通道拆到哪一层？", header: "拆除范围" }] },
);

/** O72360. The whole input is `{}` — the header cannot come from an argument. */
export const ENTER_PLAN_MODE_PAYLOAD = stored(
  "EnterPlanMode",
  {},
  {
    message:
      "Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.",
  },
);

/**
 * O15004 (legacy). The only outright JSON-parse failure in ~1,000 sampled rows:
 * the result is a bare sentence, not JSON and not even a quoted JSON string.
 */
export const STRUCTURED_OUTPUT_PAYLOAD = stored(
  "StructuredOutput",
  { question: "角色扮演类 LLM 在 SFT 阶段的 target 格式？", angles: [] },
  "Structured output provided successfully",
);

/**
 * O3250 (legacy). `results` mixes `{tool_use_id, content}` objects with bare
 * narration strings, so anything that maps over an array assuming one item
 * shape throws here.
 */
export const WEB_SEARCH_PAYLOAD = stored(
  "WebSearch",
  { query: "Claude Code CLI subscription cache read tokens pricing" },
  {
    query: "Claude Code CLI subscription cache read tokens pricing",
    results: [
      { tool_use_id: "srvtoolu_01BDiFogdXwzuUyPrWYr22R9", content: [] },
      "I'll search for that query now.",
      { tool_use_id: "srvtoolu_018xZ7juZijd2x6bn2ricjtU", content: [] },
    ],
    searchCount: 2,
    durationSeconds: 7.4,
  },
);

/**
 * O72482. A tool name the survey never saw: two arrived in the era between the
 * survey and this file's second pass, which is the case the generic rule and
 * this list exist for. `message`/`content` elided.
 */
export const SEND_MESSAGE_PAYLOAD = stored(
  "SendMessage",
  {
    to: "a5000183d81f3f0b0",
    summary: "追问无闪烁渲染的具体机制和效果",
    message: "追问上一个问题：你提到 Claude Code 有个可选的「全屏无闪烁渲染」模式 …elided",
    type: "message",
    recipient: "a5000183d81f3f0b0",
    content: "追问上一个问题：…elided",
  },
  {
    success: true,
    message:
      'Agent "a5000183d81f3f0b0" had no active task; resumed from transcript in the background with your message.',
    resumedAgentId: "a5000183d81f3f0b0",
    pin: { id: "a5000183d81f3f0b0", name: "a5000183d81f3f0b0", ref: "f2bb4d" },
  },
);

/** O72484. The era's other newcomer; `result` elided from 23,635 chars. */
export const WEB_FETCH_PAYLOAD = stored(
  "WebFetch",
  {
    url: "https://code.claude.com/docs/en/fullscreen.md",
    prompt: "这篇文档讲的是 Claude Code 的全屏无闪烁渲染模式。请提取：…elided",
  },
  {
    bytes: 23669,
    code: 200,
    codeText: "OK",
    result:
      "# Fullscreen rendering\n\n> Enable a smoother, flicker-free rendering mode …elided",
    durationMs: 0,
    url: "https://code.claude.com/docs/en/fullscreen.md",
  },
);

/**
 * Every tool name present in the era, measured 2026-08-11 over the 591 rows at
 * or after cutoff 1786427403, ordered by frequency. The coverage test walks
 * this list, which is what turns "we covered the common ones" into a checked
 * property rather than an impression. It is a moving list by construction —
 * `SendMessage` and `WebFetch` entered the era after the survey was written,
 * and both reach the reader through the generic rule alone.
 */
export const ERA_TOOL_PAYLOADS: StoredToolPayload[] = [
  BASH_PAYLOAD,
  EDIT_PAYLOAD,
  NOTE_PAYLOAD,
  WRITE_PAYLOAD,
  READ_PAYLOAD,
  AGENT_ASYNC_PAYLOAD,
  RECALL_PAYLOAD,
  TOOL_SEARCH_PAYLOAD,
  ASK_USER_QUESTION_PAYLOAD,
  ENTER_PLAN_MODE_PAYLOAD,
  SEND_MESSAGE_PAYLOAD,
  WEB_FETCH_PAYLOAD,
];
