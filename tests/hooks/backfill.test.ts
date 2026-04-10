import { afterEach, describe, expect, test } from "bun:test";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { backfillFromTranscript } from "../../src/hooks/backfill";

describe("backfillFromTranscript", () => {
  const databases: Array<ReturnType<typeof createDatabase>> = [];

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close();
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

    backfillFromTranscript(
      db,
      [pendingTurn!],
      undefined,
      undefined,
      [
        {
          promptNumber: 1,
          promptId: "pid-A",
          userPrompt: "Run the tool-heavy turn",
          assistantText: "done",
          isSidechain: false,
          toolCalls: [
            { name: "Read", input: { file_path: "a.ts" }, result: "a" },
            { name: "Edit", input: { file_path: "a.ts" }, result: "b" },
            { name: "Bash", input: { command: "npm test" }, result: "c" },
          ],
        },
        {
          promptNumber: 1,
          promptId: "pid-A",
          userPrompt: "Run the tool-heavy turn",
          assistantText: "done",
          isSidechain: false,
          toolCalls: [
            { name: "Read", input: { file_path: "a.ts" }, result: "a" },
            { name: "Edit", input: { file_path: "a.ts" }, result: "b" },
            { name: "Bash", input: { command: "npm test" }, result: "c" },
          ],
        },
      ],
    );

    const updatedTurn = getTurn(db, session.id, 1);
    expect(updatedTurn?.toolCallCount).toBe(3);
    expect(updatedTurn?.contentPromptId).toBe("pid-A");
  });
});
