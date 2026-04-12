import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runReplayParseCommand } from "../../src/replay/cli";

function writeTranscript(lines: unknown[]): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-replay-cli-"));
  const path = join(directory, "session.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return { directory, path };
}

function createFixture() {
  return writeTranscript([
    {
      type: "user",
      uuid: "u1",
      promptId: "p1",
      timestamp: "2026-04-12T01:50:00.000Z",
      message: { role: "user", content: "Inspect auth flow" },
    },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-04-12T01:50:05.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Checking the auth middleware." },
          { type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "u1r",
      promptId: "p1",
      timestamp: "2026-04-12T01:50:07.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "Read 42 lines." }],
      },
    },
    {
      type: "user",
      uuid: "u2",
      promptId: "p2",
      timestamp: "2026-04-12T01:55:00.000Z",
      message: { role: "user", content: "Apply the fix" },
    },
    {
      type: "assistant",
      uuid: "a2",
      timestamp: "2026-04-12T01:55:10.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "src/auth.ts", old: "race", new: "mutex" },
          },
          { type: "text", text: "Patched the refresh path." },
        ],
      },
    },
    {
      type: "user",
      uuid: "u2r",
      promptId: "p2",
      timestamp: "2026-04-12T01:55:12.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "Patched auth.ts" }],
      },
    },
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "cb1",
      compactMetadata: { trigger: "manual", pre_tokens: 357725 },
    },
    {
      type: "user",
      uuid: "u3",
      promptId: "p3",
      timestamp: "2026-04-12T02:00:00.000Z",
      message: { role: "user", content: "Search logs for auth race" },
    },
    {
      type: "assistant",
      uuid: "a3",
      timestamp: "2026-04-12T02:00:10.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Need one more check." },
          { type: "thinking", text: "hidden thought" },
          { type: "text", text: "Summary is ready." },
          { type: "tool_use", name: "Grep", input: { pattern: "auth", path: "logs/app.log" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "u3r",
      promptId: "p3",
      timestamp: "2026-04-12T02:00:12.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "3 matches in logs/app.log" }],
      },
    },
  ]);
}

function createEscapedFixture() {
  return writeTranscript([
    {
      type: "user",
      uuid: "u1",
      promptId: "p1",
      timestamp: "2026-04-12T03:00:00.000Z",
      message: { role: "user", content: "abc\ndef\tghi" },
    },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-04-12T03:00:05.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    },
  ]);
}

describe("replay-parse query surface", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("schema reports registered fields and example query usage", () => {
    const transcript = createFixture();
    directories.push(transcript.directory);

    const output = runReplayParseCommand(["schema", transcript.path]);

    expect(output).toContain("3 turns | 1 compacts |");
    expect(output).toContain("promptNumber");
    expect(output).toContain("compactAfter");
    expect(output).toContain("compactInfo");
    expect(output).toContain("Inspect auth flow");
    expect(output).toContain("357k tokens, manual");
    expect(output).toContain("Usage: replay-parse query <jsonl> -f \"promptNumber,localTime,userPrompt:80\" --last 10");
  });

  test("query renders TSV rows with compact metadata fields", () => {
    const transcript = createFixture();
    directories.push(transcript.directory);

    const output = runReplayParseCommand([
      "query",
      transcript.path,
      "-f",
      "promptNumber,toolCount,compactAfter,compactInfo",
      "--all",
    ]);

    expect(output).toBe(
      [
        "promptNumber\ttoolCount\tcompactAfter\tcompactInfo",
        "1\t1\t0\t",
        "2\t1\t1\t357k tokens, manual",
        "3\t1\t0\t",
      ].join("\n"),
    );
  });

  test("query escapes string cells before truncating them", () => {
    const transcript = createEscapedFixture();
    directories.push(transcript.directory);

    const output = runReplayParseCommand([
      "query",
      transcript.path,
      "-f",
      "promptNumber,userPrompt:4",
      "--all",
    ]);

    expect(output).toBe(
      [
        "promptNumber\tuserPrompt",
        "1\tabc…",
      ].join("\n"),
    );
  });

  test("query keeps numeric fields untruncated and honors --last", () => {
    const transcript = createFixture();
    directories.push(transcript.directory);

    const output = runReplayParseCommand([
      "query",
      transcript.path,
      "-f",
      "promptNumber,usage.input,usage.output",
      "--last",
      "2",
    ]);

    expect(output).toBe(
      [
        "promptNumber\tusage.input\tusage.output",
        "2\t0\t0",
        "3\t0\t0",
      ].join("\n"),
    );
  });

  test("query respects cap=0 for untruncated strings", () => {
    const transcript = createEscapedFixture();
    directories.push(transcript.directory);

    const output = runReplayParseCommand([
      "query",
      transcript.path,
      "-f",
      "promptNumber,userPrompt:0",
      "--all",
    ]);

    expect(output).toBe(
      [
        "promptNumber\tuserPrompt",
        "1\tabc\\ndef\\tghi",
      ].join("\n"),
    );
  });

  test("query searches tool input and tool result content", () => {
    const transcript = createFixture();
    directories.push(transcript.directory);

    const toolInputHits = runReplayParseCommand([
      "query",
      transcript.path,
      "-f",
      "promptNumber",
      "--grep",
      "logs/app.log",
    ]);
    expect(toolInputHits).toBe(["promptNumber", "3"].join("\n"));

    const toolResultHits = runReplayParseCommand([
      "query",
      transcript.path,
      "-f",
      "promptNumber",
      "--grep",
      "Patched auth.ts",
    ]);
    expect(toolResultHits).toBe(["promptNumber", "2"].join("\n"));
  });

  test("show keeps the current drill-down behavior", () => {
    const transcript = createFixture();
    directories.push(transcript.directory);

    const expanded = runReplayParseCommand(["show", transcript.path, "T3"]);
    expect(expanded).toContain("T3  L8");
    expect(expanded).toContain("USER:");
    expect(expanded).toContain("ASST:");
    expect(expanded).toContain('TOOL: Grep(pattern="auth", path="logs/app.log")');
    expect(expanded).toContain("  → 3 matches in logs/app.log");
    expect(expanded).not.toContain("THINK:");
  });
});
