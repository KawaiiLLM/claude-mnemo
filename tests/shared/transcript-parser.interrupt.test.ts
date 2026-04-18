import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  detectInterruptedPromptIds,
  isChainParticipant,
  parseReplayTranscript,
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

describe("transcript parser interrupt helpers", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("detectInterruptedPromptIds finds both regular and tool-use interrupt markers", () => {
    const transcript = writeTranscript([
      {
        uuid: "u1",
        type: "user",
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        message: { role: "user", content: "Original prompt" },
      },
      {
        uuid: "i1",
        type: "user",
        role: "user",
        promptId: "p1",
        message: { role: "user", content: "[Request interrupted by user]" },
      },
      {
        uuid: "u2",
        type: "user",
        role: "user",
        promptId: "p2",
        permissionMode: "default",
        message: { role: "user", content: "Other prompt" },
      },
      {
        uuid: "i2",
        type: "user",
        role: "user",
        promptId: "p2",
        message: {
          role: "user",
          content: "[Request interrupted by user for tool use]",
        },
      },
    ]);
    directories.push(transcript.directory);

    expect([...detectInterruptedPromptIds(transcript.path)].sort()).toEqual([
      "p1",
      "p2",
    ]);
  });

  test("parseReplayTranscript marks turns whose promptId later received an interrupt marker", () => {
    const transcript = writeTranscript([
      {
        uuid: "u1",
        type: "user",
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        message: { role: "user", content: "Interrupted prompt" },
      },
      {
        uuid: "a1",
        type: "assistant",
        role: "assistant",
        parentUuid: "u1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Partial response" }],
        },
      },
      {
        uuid: "i1",
        type: "user",
        role: "user",
        parentUuid: "a1",
        promptId: "p1",
        message: { role: "user", content: "[Request interrupted by user]" },
      },
    ]);
    directories.push(transcript.directory);

    expect(parseReplayTranscript(transcript.path)[0]?.wasInterrupted).toBe(true);
  });

  test("isChainParticipant excludes only progress entries", () => {
    expect(isChainParticipant({ type: "progress" })).toBe(false);
    expect(isChainParticipant({ type: "assistant" })).toBe(true);
    expect(isChainParticipant({ type: "system" })).toBe(true);
    expect(isChainParticipant({ type: "attachment" })).toBe(true);
  });
});
