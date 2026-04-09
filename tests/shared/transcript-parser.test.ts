import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  countUserPromptsInTranscript,
  extractAssistantResponse,
  parseReplayTranscript,
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

  test("parseReplayTranscript retains sidechain turns for raw replay", () => {
    const transcript = writeTranscript([
      {
        role: "user",
        isSidechain: true,
        content: [{ type: "text", text: "Draft approach" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [{ type: "text", text: "Discarded branch" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Final approach" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Kept branch" }],
      },
    ]);
    directories.push(transcript.directory);

    const turns = parseReplayTranscript(transcript.path);

    expect(turns.map((turn) => [turn.promptNumber, turn.userPrompt])).toEqual([
      [1, "Draft approach"],
      [2, "Final approach"],
    ]);
  });

  test("countUserPromptsInTranscript matches parseReplayTranscript length", () => {
    const transcript = writeTranscript([
      {
        role: "user",
        content: [{ type: "text", text: "First prompt" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "First answer" }],
      },
      {
        role: "user",
        isSidechain: true,
        content: [{ type: "text", text: "Sidechain prompt" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [{ type: "text", text: "Sidechain answer" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Final prompt" }],
      },
    ]);
    directories.push(transcript.directory);

    expect(countUserPromptsInTranscript(transcript.path)).toBe(
      parseReplayTranscript(transcript.path).length,
    );
  });

  test("countUserPromptsInTranscript includes sidechain user entries", () => {
    const transcript = writeTranscript([
      {
        role: "user",
        isSidechain: true,
        content: [{ type: "text", text: "Draft approach" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [{ type: "text", text: "Discarded branch" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Final approach" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Kept branch" }],
      },
    ]);
    directories.push(transcript.directory);

    const turns = parseReplayTranscript(transcript.path);

    expect(countUserPromptsInTranscript(transcript.path)).toBe(2);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.isSidechain).toBe(true);
  });

  test("countUserPromptsInTranscript returns 0 for missing or empty files", () => {
    const missingPath = join(tmpdir(), `claude-mnemo-missing-${Date.now()}.jsonl`);

    const emptyDirectory = mkdtempSync(join(tmpdir(), "claude-mnemo-empty-"));
    const emptyPath = join(emptyDirectory, "session.jsonl");
    writeFileSync(emptyPath, "", "utf8");
    directories.push(emptyDirectory);

    expect(countUserPromptsInTranscript(missingPath)).toBe(0);
    expect(countUserPromptsInTranscript(emptyPath)).toBe(0);
  });

  test("parses nested Claude JSONL entries and ignores task notifications", () => {
    const transcript = writeTranscript([
      {
        type: "user",
        promptId: "p1",
        permissionMode: "default",
        message: {
          role: "user",
          content: "First real prompt",
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "First answer" }],
        },
      },
      {
        type: "user",
        promptId: "task-1",
        message: {
          role: "user",
          content: "<task-notification>subagent finished</task-notification>",
        },
      },
      {
        type: "user",
        promptId: "p2",
        permissionMode: "default",
        message: {
          role: "user",
          content: [{ type: "text", text: "Second real prompt" }],
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Second answer" }],
        },
      },
    ]);
    directories.push(transcript.directory);

    expect(countUserPromptsInTranscript(transcript.path)).toBe(2);
    expect(parseReplayTranscript(transcript.path)).toEqual([
      expect.objectContaining({
        promptNumber: 1,
        promptId: "p1",
        userPrompt: "First real prompt",
      }),
      expect.objectContaining({
        promptNumber: 2,
        promptId: "p2",
        userPrompt: "Second real prompt",
      }),
    ]);
  });

  test("ignores local-command and command-name injected entries when counting promptId turns", () => {
    const transcript = writeTranscript([
      {
        type: "user",
        promptId: "p1",
        permissionMode: "default",
        message: {
          role: "user",
          content: "First real prompt",
        },
      },
      {
        type: "user",
        promptId: "cmd-1",
        message: {
          role: "user",
          content: "<local-command-run>npm test</local-command-run>",
        },
      },
      {
        type: "user",
        promptId: "cmd-2",
        message: {
          role: "user",
          content: "<command-name>/help</command-name>",
        },
      },
      {
        type: "user",
        promptId: "p2",
        permissionMode: "default",
        message: {
          role: "user",
          content: "Second real prompt",
        },
      },
    ]);
    directories.push(transcript.directory);

    expect(countUserPromptsInTranscript(transcript.path)).toBe(2);
    expect(parseReplayTranscript(transcript.path).map((turn) => turn.promptId)).toEqual([
      "p1",
      "p2",
    ]);
  });
});
