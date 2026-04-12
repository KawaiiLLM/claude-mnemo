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
          { type: "tool_use", name: "Edit", input: { file_path: "src/auth.ts", old: "race", new: "mutex" } },
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

describe("replay-parse CLI", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("ls renders summary, turns, and compact separators", () => {
    const transcript = createFixture();
    directories.push(transcript.directory);

    const output = runReplayParseCommand(["ls", transcript.path, "--all"]);

    expect(output).toContain("3 turns | 1 compacts |");
    expect(output).toContain("T  1  L1");
    expect(output).toContain("Inspect auth flow");
    expect(output).toContain("T  2  L4");
    expect(output).toContain("Apply the fix");
    expect(output).toContain("── compact (357k tokens, manual) ──");
    expect(output).toContain("T  3  L8");
  });

  test("ls supports range and grep filters", () => {
    const transcript = createFixture();
    directories.push(transcript.directory);

    const ranged = runReplayParseCommand(["ls", transcript.path, "--range", "T2..T3"]);
    expect(ranged).not.toContain("T  1");
    expect(ranged).toContain("T  2");
    expect(ranged).toContain("T  3");

    const filtered = runReplayParseCommand(["ls", transcript.path, "--all", "--grep", "Search logs"]);
    expect(filtered).not.toContain("Inspect auth flow");
    expect(filtered).toContain("Search logs for auth race");
  });

  test("show renders ordered message sequence and can omit tool results", () => {
    const transcript = createFixture();
    directories.push(transcript.directory);

    const expanded = runReplayParseCommand(["show", transcript.path, "T3"]);
    expect(expanded).toContain("T3  L8");
    expect(expanded).toContain("USER:");
    expect(expanded).toContain("ASST:");
    expect(expanded).toContain('TOOL: Grep(pattern="auth", path="logs/app.log")');
    expect(expanded).toContain("  → 3 matches in logs/app.log");
    expect(expanded).not.toContain("THINK:");

    const omitted = runReplayParseCommand(["show", transcript.path, "T3", "--no-tool-result"]);
    expect(omitted).toContain("  → (omitted)");
  });

  test("grep searches assistant and tool content with type filters", () => {
    const transcript = createFixture();
    directories.push(transcript.directory);

    const assistantHits = runReplayParseCommand(["grep", transcript.path, "Summary"]);
    expect(assistantHits).toContain("1 matches in 1 turns");
    expect(assistantHits).toContain("ASST: Summary is ready.");

    const toolHits = runReplayParseCommand(["grep", transcript.path, "logs/app.log", "--type", "tool"]);
    expect(toolHits).toContain("TOOL: Grep");
    expect(toolHits).toContain("3 matches in logs/app.log");
    expect(toolHits).not.toContain("Inspect auth flow");
  });
});
