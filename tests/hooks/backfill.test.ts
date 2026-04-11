import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { backfillFromTranscript } from "../../src/hooks/backfill";

describe("backfillFromTranscript", () => {
  const databases: Array<ReturnType<typeof createDatabase>> = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close();
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not double-count tool calls when a transcript segment is replay-appended", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "session-backfill",
      project: "/tmp/project",
      title: "Backfill session",
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, ?, 'active', ?, ?)`,
    ).run(session.id, 1, "Run the tool-heavy turn", 101);

    const pendingTurn = getTurn(db, session.id, 1);
    expect(pendingTurn).not.toBeNull();

    const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-backfill-"));
    const transcriptPath = join(directory, "session.jsonl");
    directories.push(directory);
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          uuid: "u1",
          type: "user",
          promptId: "pid-A",
          permissionMode: "default",
          message: {
            role: "user",
            content: "Run the tool-heavy turn",
          },
        }),
        JSON.stringify({
          uuid: "u2",
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
              { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } },
              { type: "tool_use", name: "Bash", input: { command: "npm test" } },
              { type: "text", text: "done" },
            ],
          },
        }),
        JSON.stringify({
          uuid: "u1",
          type: "user",
          promptId: "pid-A",
          permissionMode: "default",
          message: {
            role: "user",
            content: "Run the tool-heavy turn",
          },
        }),
        JSON.stringify({
          uuid: "u2",
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
              { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } },
              { type: "tool_use", name: "Bash", input: { command: "npm test" } },
              { type: "text", text: "done" },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    backfillFromTranscript(db, [pendingTurn!], transcriptPath);

    const updatedTurn = getTurn(db, session.id, 1);
    expect(updatedTurn?.toolCallCount).toBe(3);
    expect(updatedTurn?.contentPromptId).toBe("pid-A");
  });

  test("backfillFromTranscript writes transcriptLineStart from the matched prompt line", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "session-backfill-line-start",
      project: "/tmp/project",
      title: "Backfill line start session",
      content: null,
      insight: null,
      createdAtEpoch: 200,
      updatedAtEpoch: 200,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, ?, 'active', ?, ?)`,
    ).run(session.id, 1, "Match me", 201);

    const pendingTurn = getTurn(db, session.id, 1);
    expect(pendingTurn).not.toBeNull();

    const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-backfill-line-"));
    const transcriptPath = join(directory, "session.jsonl");
    directories.push(directory);
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          uuid: "u0",
          type: "system",
          subtype: "turn_start",
          content: "preface",
        }),
        JSON.stringify({
          uuid: "u1",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "setup" }],
          },
        }),
        JSON.stringify({
          uuid: "u2",
          type: "user",
          promptId: "pid-match",
          permissionMode: "default",
          message: {
            role: "user",
            content: "Match me",
          },
        }),
        JSON.stringify({
          uuid: "u3",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Matched response" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    backfillFromTranscript(db, [pendingTurn!], transcriptPath);

    const updatedTurn = getTurn(db, session.id, 1);
    expect(updatedTurn?.contentPromptId).toBe("pid-match");
    expect(updatedTurn?.transcriptLineStart).toBe(3);
  });
});
