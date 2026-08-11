import { describe, expect, test } from "bun:test";

import { projectToolCall } from "../../src/mcp/tool-projection";
import {
  AGENT_ASYNC_PAYLOAD,
  AGENT_COMPLETED_PAYLOAD,
  ASK_USER_QUESTION_PAYLOAD,
  BASH_PAYLOAD,
  EDIT_PAYLOAD,
  ENTER_PLAN_MODE_PAYLOAD,
  ERA_TOOL_PAYLOADS,
  NOTE_PAYLOAD,
  READ_PAYLOAD,
  RECALL_PAYLOAD,
  STRUCTURED_OUTPUT_PAYLOAD,
  TOOL_SEARCH_PAYLOAD,
  WEB_SEARCH_PAYLOAD,
  WRITE_PAYLOAD,
  type StoredToolPayload,
} from "../support/tool-payloads";

function project(payload: StoredToolPayload) {
  return projectToolCall(
    payload.toolName,
    payload.toolInput,
    payload.toolResult,
  );
}

/**
 * The projection is the seam: a pure function from the two stored payloads to a
 * header and a body, with no database, no renderer and no clock. Every fixture
 * here is a trimmed copy of a real row (see `tests/support/tool-payloads.ts`) —
 * invented payloads would only test the shapes we imagined, and the survey
 * behind this work exists because several of them are not.
 */
describe("a stored payload projects into the call it was", () => {
  test("Bash carries its command and its output", () => {
    const { header, body } = project(BASH_PAYLOAD);

    expect(header).toBe(
      'Bash(sqlite3 -readonly ~/.claude-mnemo/claude-mnemo.db "SELECT * FROM era_state;" 2>&1; echo "--- 新纪元 turn 状态 ---")',
    );
    expect(body).toEqual([
      "1|1786427403|1786427403",
      "--- 新纪元 turn 状态 ---",
      "active|1",
    ]);
  });

  test("Bash appends standard error only when it is set", () => {
    const failing = projectToolCall(
      "Bash",
      JSON.stringify({ command: "bun test" }),
      JSON.stringify({ stdout: "1 fail", stderr: "error: exited with code 1" }),
    );

    expect(failing.body).toEqual(["1 fail", "stderr: error: exited with code 1"]);
    expect(project(BASH_PAYLOAD).body.join("\n")).not.toContain("stderr");
  });

  test("Edit shows the changed lines and takes nothing from its result", () => {
    const { header, body } = project(EDIT_PAYLOAD);

    expect(header).toBe("Edit(scene.py)");
    expect(body).toEqual([
      "-     Entity,",
      "-     Locale,",
      "-     Meter,",
      "+     Entity,",
      "+     Item,",
      "+     Locale,",
      "+     Meter,",
    ]);
    // `originalFile` is the entire pre-edit file, a median 23,494 characters
    // against `old_string`'s 172, and every informative field beside it repeats
    // the input verbatim.
    expect(body.join("\n")).not.toContain("elided");
  });

  test("Write shows what was written, on the create case where there is no pre-edit file", () => {
    const { header, body } = project(WRITE_PAYLOAD);

    expect(header).toBe("Write(07-audit.md)");
    expect(body[0]).toBe("# 07 — 收口");
    expect(body).toContain("**Status:** ready-for-agent");
  });

  test("Read says how much was read, not what the file said", () => {
    const { header, body } = project(READ_PAYLOAD);

    expect(header).toBe("Read(post-tool-use.ts)");
    expect(body).toEqual(["45 lines (124–168 of 237)"]);
  });

  test("a dispatched Agent says where its report went", () => {
    const { header, body } = project(AGENT_ASYNC_PAYLOAD);

    expect(header).toBe("Agent(Tear down observation queue)");
    expect(body).toHaveLength(1);
    expect(body[0]).toContain("not stored with this call");
    // The launch stub points at an ephemeral temporary path that is not
    // queryable from anywhere a reader can reach, so it is not offered.
    expect(body.join("\n")).not.toContain("/private/tmp");
  });

  test("a completed Agent shows the report it actually returned", () => {
    const { header, body } = project(AGENT_COMPLETED_PAYLOAD);

    expect(header).toBe("Agent(Closing audit)");
    expect(body[0]).toBe("## Outcome");
    expect(body.join("\n")).not.toContain("not stored with this call");
  });

  test("a note renders the turn it addressed, its title and its receipt", () => {
    const { header, body } = project(NOTE_PAYLOAD);

    expect(header).toBe(
      "mcp__plugin_claude-mnemo_mnemo__note(S15069/T485 fix+observation-search: layer was dark after 0.9.6)",
    );
    expect(body[0]).toStartWith("Noted S15069/T485.");
    // The note body is the point of the CALL, not of this render: the turn's
    // own fields already carry it, at a median 1,170 characters.
    expect(body.join("\n")).not.toContain("Reload succeeded");
  });

  test("an MCP result is unwrapped to its text by the generic rule", () => {
    // `recall` has no table entry. It does not need one: every `mcp__*` result
    // in both eras is the protocol's content array, so unwrapping it is part of
    // the generic rule rather than a per-tool entry.
    const { header, body } = project(RECALL_PAYLOAD);

    expect(header).toContain("mcp__plugin_claude-mnemo_mnemo__recall(");
    expect(body[0]).toStartWith("- [S15069] 0.9.6 released and pushed");
    expect(body.join("\n")).not.toContain('"type"');
  });

  test("an unknown tool's object result prints as labelled fields", () => {
    const { header, body } = project(TOOL_SEARCH_PAYLOAD);

    expect(header).toStartWith("ToolSearch(");
    expect(header).toContain("select:mcp__plugin_claude-mnemo_mnemo__note");
    expect(body.some((line) => line.startsWith("matches: "))).toBe(true);
    expect(body.some((line) => line.startsWith("total_deferred_tools: 39"))).toBe(
      true,
    );
  });

  test("a single surviving value prints bare, without its key", () => {
    // `EnterPlanMode`'s result is one field. A `message:` label would restate
    // what the header already said.
    const { body } = project(ENTER_PLAN_MODE_PAYLOAD);

    expect(body).toEqual([
      "Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.",
    ]);
  });

  test("empty, false and null fields never reach the reader", () => {
    const { body } = projectToolCall(
      "SomeNewTool",
      JSON.stringify({ path: "/tmp/x" }),
      JSON.stringify({
        result: "done",
        error: null,
        interrupted: false,
        warnings: [],
        detail: "",
        meta: {},
      }),
    );

    // Everything but `result` is a payload's default state, saying nothing by
    // being there — and with them gone one value is left, so it prints bare.
    expect(body).toEqual(["done"]);
  });
});

/**
 * The projection encodes knowledge of Claude Code's tool payloads, which is an
 * external contract that will move. The generic fallback is not a convenience;
 * it is what makes that acceptable, and these are what keep it honest.
 */
describe("a payload the projection does not recognise degrades", () => {
  test("every tool name present in the era produces a non-empty header", () => {
    for (const payload of ERA_TOOL_PAYLOADS) {
      const { header } = project(payload);
      expect(header).not.toBe("");
      expect(header).toContain(payload.toolName);
    }
    expect(ERA_TOOL_PAYLOADS).toHaveLength(10);
  });

  test("a tool whose whole input is empty still names itself", () => {
    // `EnterPlanMode` stores `{}`. There is no argument to carry, and
    // `EnterPlanMode()` would claim there was one.
    expect(project(ENTER_PLAN_MODE_PAYLOAD).header).toBe("EnterPlanMode");
  });

  test("a projected key that is missing falls through instead of rendering empty", () => {
    // The failure this prevents: an upstream rename leaves the rule reaching
    // for a key that is not there, and an empty body silently claims the call
    // did nothing.
    const renamed = projectToolCall(
      "Edit",
      JSON.stringify({ filePath: "/tmp/x.ts", oldText: "a", newText: "b" }),
      JSON.stringify({ ok: true }),
    );

    expect(renamed.header).toContain("Edit(");
    expect(renamed.header).toContain("/tmp/x.ts");
    expect(renamed.body.length).toBeGreaterThan(0);

    const noLineCount = projectToolCall(
      "Read",
      JSON.stringify({ file_path: "/tmp/x.png" }),
      JSON.stringify({ type: "image", file: { filePath: "/tmp/x.png" } }),
    );
    expect(noLineCount.body.length).toBeGreaterThan(0);
    expect(noLineCount.body.join("\n")).not.toContain("lines");
  });

  test("a result that is not JSON at all renders as its own text", () => {
    // The one outright parse failure in ~1,000 sampled rows.
    const { header, body } = project(STRUCTURED_OUTPUT_PAYLOAD);

    expect(header).toStartWith("StructuredOutput(");
    expect(body).toEqual(["Structured output provided successfully"]);
  });

  test("an array of mixed item shapes does not throw", () => {
    // `WebSearch`'s `results` mixes objects with bare narration strings, so
    // anything mapping over it assuming one shape breaks here.
    expect(() => project(WEB_SEARCH_PAYLOAD)).not.toThrow();
    expect(project(WEB_SEARCH_PAYLOAD).header).toStartWith("WebSearch(");

    const bareArray = projectToolCall(
      "Unknown",
      JSON.stringify({ query: "x" }),
      JSON.stringify(["just a string", { text: "and a block" }, 7]),
    );
    expect(bareArray.body).toEqual(["and a block"]);
  });

  test("a missing or empty payload never throws", () => {
    expect(() => projectToolCall("Bash", null, null)).not.toThrow();
    expect(projectToolCall("Bash", null, null)).toEqual({
      header: "Bash",
      body: [],
    });
    expect(projectToolCall("Bash", "", "   ")).toEqual({
      header: "Bash",
      body: [],
    });
    expect(projectToolCall("Bash", "{}", "null")).toEqual({
      header: "Bash",
      body: [],
    });
  });

  test("an input the projection has never seen still identifies the call", () => {
    const { header, body } = project(ASK_USER_QUESTION_PAYLOAD);

    expect(header).toStartWith("AskUserQuestion(");
    expect(header).toContain("observation 的队列通道拆到哪一层？");
    expect(body.length).toBeGreaterThan(0);
  });
});
