import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseReplayFile } from "../../src/replay/parser";

function formatExpectedLocalTime(timestamp: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function writeTranscript(lines: unknown[]): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-replay-parse-"));
  const path = join(directory, "session.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return { directory, path };
}

describe("parseReplayFile", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("parses turns, usage, durations, message sequence, and compact boundaries", () => {
    const transcript = writeTranscript([
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
            { type: "thinking", text: "hidden thought" },
            { type: "text", text: "Checking the auth middleware." },
            { type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } },
            { type: "text", text: "The refresh path races." },
          ],
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 3,
          },
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
        type: "system",
        subtype: "turn_duration",
        uuid: "d1",
        durationMs: 42000,
        messageCount: 4,
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
          usage: {
            input_tokens: 13,
            output_tokens: 9,
            cache_read_input_tokens: 1,
            cache_creation_input_tokens: 0,
          },
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
        subtype: "turn_duration",
        uuid: "d2",
        durationMs: 17000,
        messageCount: 3,
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
        message: { role: "user", content: "Write summary" },
      },
      {
        type: "assistant",
        uuid: "a3",
        timestamp: "2026-04-12T02:00:10.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Summary is ready." }],
          usage: {
            input_tokens: 5,
            output_tokens: 4,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);
    directories.push(transcript.directory);

    const result = parseReplayFile(transcript.path);

    expect(result.turns).toHaveLength(3);
    expect(result.timeRange).toEqual({
      start: "2026-04-12T01:50:00.000Z",
      end: "2026-04-12T02:00:00.000Z",
    });
    expect(result.compacts).toEqual([
      {
        afterPromptNumber: 2,
        line: 9,
        trigger: "manual",
        preTokens: 357725,
      },
    ]);
    expect(result.turns[0]?.promptNumber).toBe(1);
    expect(result.turns[0]?.promptId).toBe("p1");
    expect(result.turns[0]?.lineStart).toBe(1);
    expect(result.turns[0]?.timestamp).toBe("2026-04-12T01:50:00.000Z");
    expect(result.turns[0]?.localTime).toBe(
      formatExpectedLocalTime("2026-04-12T01:50:00.000Z"),
    );
    expect(result.turns[0]?.durationMs).toBe(42000);
    expect(result.turns[0]?.messageCount).toBe(4);
    expect(result.turns[0]?.userPrompt).toBe("Inspect auth flow");
    expect(result.turns[0]?.assistantText).toBe(
      "Checking the auth middleware.\nThe refresh path races.",
    );
    expect(result.turns[0]?.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheCreationTokens: 3,
    });
    expect(result.turns[0]?.toolCalls).toEqual([
      {
        name: "Read",
        input: { file_path: "src/auth.ts" },
        result: "Read 42 lines.",
      },
    ]);
    expect(result.turns[0]?.messages.map((message) => message.type)).toEqual([
      "user",
      "thinking",
      "assistant",
      "tool_use",
      "assistant",
      "tool_result",
    ]);
    expect(result.turns[1]?.messages.map((message) => message.type)).toEqual([
      "user",
      "tool_use",
      "assistant",
      "tool_result",
    ]);
  });

  test("uses the original timestamp when a replay appends a later duplicate snapshot", () => {
    const transcript = writeTranscript([
      {
        type: "user",
        uuid: "u1",
        promptId: "p1",
        timestamp: "2026-04-12T01:50:00.000Z",
        message: {
          role: "user",
          content: "Inspect auth flow",
        },
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-04-12T01:50:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Working the first pass." }],
        },
      },
      {
        type: "user",
        uuid: "u1",
        promptId: "p1",
        timestamp: "2026-04-12T02:10:00.000Z",
        message: {
          role: "user",
          content: "Inspect auth flow with replay state",
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        timestamp: "2026-04-12T02:10:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Working the final pass." }],
        },
      },
    ]);
    directories.push(transcript.directory);

    const result = parseReplayFile(transcript.path);

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]).toEqual(
      expect.objectContaining({
        promptNumber: 1,
        promptId: "p1",
        lineStart: 1,
        timestamp: "2026-04-12T01:50:00.000Z",
        localTime: formatExpectedLocalTime("2026-04-12T01:50:00.000Z"),
        userPrompt: "Inspect auth flow with replay state",
      }),
    );
  });
});
