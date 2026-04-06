import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { replayMemory } from "../../src/mcp/replay";

function writeTranscript(lines: unknown[]): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-replay-"));
  const path = join(directory, "session.jsonl");
  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );

  return { directory, path };
}

describe("replayMemory", () => {
  let db: Database;
  let sessionId: number;
  let transcriptDirectory: string;
  let transcriptPath: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    const transcript = writeTranscript([
      {
        role: "user",
        content: [{ type: "text", text: "Why am I getting 401 errors?" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I investigated the auth flow." },
          { type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } },
          { type: "tool_use", name: "Bash", input: { command: "npm test -- auth" } },
          { type: "text", text: "The refresh path races under load." },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", content: "auth.ts contents" },
          { type: "tool_result", content: "test output: ok" },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Fix it and add coverage" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "src/auth.ts" } },
          {
            type: "text",
            text: "Added a mutex and updated the test suite.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: "x".repeat(650),
          },
        ],
      },
    ]);

    transcriptDirectory = transcript.directory;
    transcriptPath = transcript.path;

    sessionId = upsertSession(db, {
      contentSessionId: "session-replay",
      project: "/tmp/project",
      title: "Replay session",
      description: "Replay coverage",
      insight: null,
      startedAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
    rmSync(transcriptDirectory, { recursive: true, force: true });
  });

  test("shows turn overview for a session", () => {
    const output = replayMemory(db, {
      session: sessionId,
      transcriptPath,
    });

    expect(output).toContain("[T1] #1 Why am I getting 401 errors?");
    expect(output).toContain("[T2] #2 Fix it and add coverage");
  });

  test("shows a full QA transcript for a specific turn", () => {
    const output = replayMemory(db, {
      session: sessionId,
      turn: 1,
      transcriptPath,
    });

    expect(output).toContain('prompt: "Why am I getting 401 errors?"');
    expect(output).toContain('response: "I investigated the auth flow.');
    expect(output).toContain("[Tool 1] Read");
    expect(output).toContain("[Tool 2] Bash");
    expect(output).toContain("result: auth.ts contents");
  });

  test("shows a single tool call by index", () => {
    const output = replayMemory(db, {
      session: sessionId,
      turn: 1,
      tool: 2,
      transcriptPath,
    });

    expect(output).toContain("[Tool 2] Bash");
    expect(output).toContain('input: {"command":"npm test -- auth"}');
    expect(output).toContain("result: test output: ok");
    expect(output).not.toContain("[Tool 1] Read");
  });

  test("truncates tool results unless full mode is enabled", () => {
    const truncated = replayMemory(db, {
      session: sessionId,
      turn: 2,
      tool: 1,
      transcriptPath,
    });
    const full = replayMemory(db, {
      session: sessionId,
      turn: 2,
      tool: 1,
      full: true,
      transcriptPath,
    });

    expect(truncated).toContain("result: ");
    expect(truncated).toContain("...");
    expect(full).not.toContain("...");
    expect(full).toContain("x".repeat(600));
  });

  test("returns a graceful error when the transcript is missing", () => {
    const output = replayMemory(db, {
      session: sessionId,
      transcriptPath: join(transcriptDirectory, "missing.jsonl"),
    });

    expect(output).toBe("Transcript not found.");
  });
});
