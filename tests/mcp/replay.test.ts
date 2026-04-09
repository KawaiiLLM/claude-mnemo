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
      content: "Replay coverage",
      insight: null,
      createdAtEpoch: 100,
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
      id: `S${sessionId}`,
      transcriptPath,
    });

    expect(output).toContain("- [S1] Replay session");
    expect(output).toContain('- [S1][T1] "Why am I getting 401 errors?" | 🔧2');
    expect(output).toContain('- [S1][T2] "Fix it and add coverage" | 🔧1');
  });

  test("shows a full QA transcript for a specific turn", () => {
    const output = replayMemory(db, {
      id: `S${sessionId}/T1`,
      depth: "expanded",
      transcriptPath,
    });

    expect(output).toContain('prompt: "Why am I getting 401 errors?"');
    expect(output).toContain('response: "I investigated the auth flow.');
    expect(output).toContain("- [S1] Replay session");
    expect(output).toContain("- 🔧 Read src/auth.ts");
    expect(output).toContain("- 🔧 Bash npm test -- auth");
    expect(output).toContain('- out: auth.ts contents');
  });

  test("shows a single tool call by index", () => {
    const output = replayMemory(db, {
      id: `S${sessionId}/T1/Tool2`,
      depth: "expanded",
      transcriptPath,
    });

    expect(output).toContain("- [S1] Replay session");
    expect(output).toContain("- [S1][T1] \"Why am I getting 401 errors?\" | 🔧2");
    expect(output).toContain("- 🔧 Bash npm test -- auth");
    expect(output).toContain('- in: {"command":"npm test -- auth"}');
    expect(output).toContain("- out: test output: ok");
    expect(output).not.toContain("- 🔧 Read src/auth.ts");
  });

  test("uses content_prompt_id to replay the correct turn when prompt numbering drifts", () => {
    const driftedTranscript = writeTranscript([
      {
        type: "user",
        promptId: "real-1",
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
        promptId: "real-2",
        permissionMode: "default",
        message: {
          role: "user",
          content: "Second real prompt",
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "src/app.ts" } },
            { type: "text", text: "Second answer" },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "app.ts contents" }],
        },
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        assistant_response,
        created_at_epoch,
        content_prompt_id
      ) VALUES (?, ?, 'extracted', ?, ?, ?, ?)`,
    ).run(
      sessionId,
      2,
      "Second real prompt",
      "Second answer",
      200,
      "real-2",
    );

    const output = replayMemory(db, {
      id: `S${sessionId}/T2`,
      depth: "expanded",
      transcriptPath: driftedTranscript.path,
    });

    expect(output).toContain('prompt: "Second real prompt"');
    expect(output).toContain('response: "Second answer"');
    expect(output).toContain("- 🔧 Read src/app.ts");
    expect(output).not.toContain("First real prompt");

    rmSync(driftedTranscript.directory, { recursive: true, force: true });
  });

  test("truncates tool results unless full mode is enabled", () => {
    const truncated = replayMemory(db, {
      id: `S${sessionId}/T2/Tool1`,
      depth: "expanded",
      transcriptPath,
    });
    const full = replayMemory(db, {
      id: `S${sessionId}/T2/Tool1`,
      depth: "full",
      transcriptPath,
    });

    expect(truncated).toContain("- out: ");
    expect(truncated).toContain("...");
    expect(full).not.toContain("...");
    expect(full).toContain("x".repeat(600));
  });

  test("returns a graceful error when the transcript is missing", () => {
    const output = replayMemory(db, {
      id: `S${sessionId}`,
      transcriptPath: join(transcriptDirectory, "missing.jsonl"),
    });

    expect(output).toBe("Transcript not found.");
  });

  test("shows undone turns in replay overview using DB status while preserving sidechain numbering", () => {
    const transcript = writeTranscript([
      {
        role: "user",
        isSidechain: true,
        content: [{ type: "text", text: "Draft approach" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [{ type: "text", text: "Old draft response" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Ship the final fix" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Final response after undo." }],
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        assistant_response,
        created_at_epoch
      ) VALUES (?, ?, 'undone', ?, ?, ?)`,
    ).run(
      sessionId,
      1,
      "Draft approach",
      "Old draft response",
      110,
    );
    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        assistant_response,
        created_at_epoch
      ) VALUES (?, ?, 'pending', ?, ?, ?)`,
    ).run(
      sessionId,
      2,
      "Ship the final fix",
      "Final response after undo.",
      120,
    );

    const output = replayMemory(db, {
      id: `S${sessionId}`,
      transcriptPath: transcript.path,
    });

    expect(output).toContain('- [S1][T1] "Draft approach" [undone]');
    expect(output).toContain('- [S1][T2] "Ship the final fix" [pending]');
    expect(output).not.toContain("#1");

    rmSync(transcript.directory, { recursive: true, force: true });
  });

  test("shows undone turn transcript instead of reporting it unavailable", () => {
    const transcript = writeTranscript([
      {
        role: "user",
        isSidechain: true,
        content: [{ type: "text", text: "Draft approach" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [{ type: "text", text: "Old draft response" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Ship the final fix" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Final response after undo." }],
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        assistant_response,
        created_at_epoch
      ) VALUES (?, ?, 'undone', ?, ?, ?)`,
    ).run(
      sessionId,
      1,
      "Draft approach",
      "Old draft response",
      110,
    );
    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        assistant_response,
        created_at_epoch
      ) VALUES (?, ?, 'pending', ?, ?, ?)`,
    ).run(
      sessionId,
      2,
      "Ship the final fix",
      "Final response after undo.",
      120,
    );

    const output = replayMemory(db, {
      id: `S${sessionId}/T1`,
      depth: "expanded",
      transcriptPath: transcript.path,
    });

    expect(output).toContain('- [S1][T1] "Draft approach" [undone]');
    expect(output).toContain('prompt: "Draft approach"');
    expect(output).toContain('response: "Old draft response"');

    rmSync(transcript.directory, { recursive: true, force: true });
  });

  test("disambiguates repeated prompts by preserving sidechain turns in replay numbering", () => {
    const transcript = writeTranscript([
      {
        role: "user",
        isSidechain: true,
        content: [{ type: "text", text: "repeat" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [{ type: "text", text: "discarded response" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "repeat" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "kept response" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "repeat" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "latest response" }],
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        assistant_response,
        created_at_epoch
      ) VALUES (?, ?, 'undone', ?, ?, ?)`,
    ).run(sessionId, 1, "repeat", "discarded response", 110);
    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        assistant_response,
        created_at_epoch
      ) VALUES (?, ?, 'extracted', ?, ?, ?)`,
    ).run(sessionId, 2, "repeat", "kept response", 120);
    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        assistant_response,
        created_at_epoch
      ) VALUES (?, ?, 'pending', ?, ?, ?)`,
    ).run(sessionId, 3, "repeat", "latest response", 130);

    const output = replayMemory(db, {
      id: `S${sessionId}/T3`,
      depth: "expanded",
      transcriptPath: transcript.path,
    });

    expect(output).toContain('- [S1][T3] "repeat" [pending]');
    expect(output).toContain('response: "latest response"');
    expect(output).not.toContain('response: "kept response"');

    rmSync(transcript.directory, { recursive: true, force: true });
  });

  test("renders all turns in a selected turn range", () => {
    const output = replayMemory(db, {
      id: `S${sessionId}/T1..2`,
      depth: "expanded",
      transcriptPath,
    });

    expect(output).toContain("- [S1] Replay session");
    expect(output).toContain('- [S1][T1] "Why am I getting 401 errors?" | 🔧2');
    expect(output).toContain('- [S1][T2] "Fix it and add coverage" | 🔧1');
    expect(output).toContain('prompt: "Why am I getting 401 errors?"');
    expect(output).toContain('prompt: "Fix it and add coverage"');
  });

  test("renders all tool calls for a turn when using Tool*", () => {
    const output = replayMemory(db, {
      id: `S${sessionId}/T1/Tool*`,
      depth: "expanded",
      transcriptPath,
    });

    expect(output).toContain("- [S1] Replay session");
    expect(output).toContain('- [S1][T1] "Why am I getting 401 errors?" | 🔧2');
    expect(output).toContain("- 🔧 Read src/auth.ts");
    expect(output).toContain("- 🔧 Bash npm test -- auth");
    expect(output).toContain('- out: auth.ts contents');
    expect(output).toContain("- out: test output: ok");
  });

  test("rejects legacy replay parameters", () => {
    expect(
      replayMemory(db, {
        // @ts-expect-error exercising removed public API
        session: sessionId,
        transcriptPath,
      }),
    ).toBe('Parameter error: replay() requires id like "S1", "S1/T2", or "S1/T2/Tool3".');
  });

  test("rejects invalid replay ids", () => {
    expect(
      replayMemory(db, {
        id: "S1/Tool2",
        transcriptPath,
      }),
    ).toBe('Parameter error: invalid replay id "S1/Tool2"');
  });
});
