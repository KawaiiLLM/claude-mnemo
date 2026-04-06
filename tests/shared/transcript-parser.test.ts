import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  extractAssistantResponse,
  parseTranscript,
} from "../../src/shared/transcript-parser";

function writeTranscript(lines: unknown[]): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-transcript-"));
  const path = join(directory, "session.jsonl");
  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );

  return { directory, path };
}

describe("parseTranscript", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("extracts QA turns, ignores sidechains/errors, and captures tool calls", () => {
    const transcript = writeTranscript([
      {
        role: "system",
        content: [{ type: "text", text: "system prompt" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Investigate the auth race" }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "hidden" },
          {
            type: "text",
            text: "I inspected auth.ts.\n\n\n<system-reminder>ignore</system-reminder>",
          },
          { type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } },
          { type: "image", source: "ignored" },
          { type: "text", text: "The race is reproducible." },
        ],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [{ type: "text", text: "ignore sidechain" }],
      },
      {
        role: "assistant",
        isApiErrorMessage: true,
        content: [{ type: "text", text: "ignore api error" }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", content: "Read result" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Add a fix and tests" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "src/auth.ts" } },
          { type: "text", text: "Implemented a mutex.\n\n\nAdded tests." },
        ],
      },
    ]);
    directories.push(transcript.directory);

    const turns = parseTranscript(transcript.path);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({
      promptNumber: 1,
      userPrompt: "Investigate the auth race",
      assistantText: "I inspected auth.ts.\n\nThe race is reproducible.",
      toolCalls: [
        {
          name: "Read",
          input: { file_path: "src/auth.ts" },
        },
      ],
    });
    expect(turns[1]).toEqual({
      promptNumber: 2,
      userPrompt: "Add a fix and tests",
      assistantText: "Implemented a mutex.\n\nAdded tests.",
      toolCalls: [
        {
          name: "Edit",
          input: { file_path: "src/auth.ts" },
        },
      ],
    });
  });

  test("returns the matching assistant response by user prompt prefix", () => {
    const transcript = writeTranscript([
      {
        role: "user",
        content: [{ type: "text", text: "Diagnose the auth failure" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The token refresh path is racing." }],
      },
    ]);
    directories.push(transcript.directory);

    expect(
      extractAssistantResponse(transcript.path, "Diagnose the auth"),
    ).toBe("The token refresh path is racing.");
  });

  test("returns an empty string when no matching assistant response exists", () => {
    const transcript = writeTranscript([
      {
        role: "user",
        content: [{ type: "text", text: "Only prompt" }],
      },
    ]);
    directories.push(transcript.directory);

    expect(extractAssistantResponse(transcript.path, "Missing prefix")).toBe("");
  });

  test("can target a repeated prompt by prompt number", () => {
    const transcript = writeTranscript([
      {
        role: "user",
        content: [{ type: "text", text: "repeat" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "first response" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "repeat" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second response" }],
      },
    ]);
    directories.push(transcript.directory);

    expect(
      extractAssistantResponse(transcript.path, "repeat", 2),
    ).toBe("second response");
  });
});
