import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { applyInvalidation, getReminderItems } from "../../src/worker/invalidation";

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

describe("worker invalidation", () => {
  let db: Database;
  let sessionId: number;
  const directories: string[] = [];

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "content-session-invalidation",
      project: "claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("applyInvalidation demotes extracted/skipped turns back to active and sets was_* flags", () => {
    const interruptedTurnId = db
      .query<{ id: number }, [number]>(
        `
          INSERT INTO turns (
            session_id, prompt_number, content_prompt_id, status, user_prompt, title, created_at_epoch, updated_at_epoch
          ) VALUES (?, 1, 'p1', 'extracted', 'Interrupted prompt', 'Interrupted title', 10, 11)
          RETURNING id
        `,
      )
      .get(sessionId)!.id;
    const rolledBackTurnId = db
      .query<{ id: number }, [number]>(
        `
          INSERT INTO turns (
            session_id, prompt_number, content_prompt_id, status, user_prompt, title, created_at_epoch, updated_at_epoch
          ) VALUES (?, 2, 'p2', 'skipped', 'Rolled-back prompt', 'Rolled-back title', 20, 21)
          RETURNING id
        `,
      )
      .get(sessionId)!.id;

    const transcript = writeTranscript([
      {
        uuid: "root",
        type: "system",
        timestamp: "2026-04-18T10:00:00.000Z",
      },
      {
        uuid: "u1",
        type: "user",
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:01.000Z",
        message: { role: "user", content: "Interrupted prompt" },
      },
      {
        uuid: "a1",
        type: "assistant",
        role: "assistant",
        parentUuid: "u1",
        timestamp: "2026-04-18T10:00:01.500Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Interrupted answer" }],
        },
      },
      {
        uuid: "i1",
        type: "user",
        role: "user",
        promptId: "p1",
        parentUuid: "a1",
        timestamp: "2026-04-18T10:00:02.000Z",
        message: { role: "user", content: "[Request interrupted by user]" },
      },
      {
        uuid: "u2",
        type: "user",
        role: "user",
        promptId: "p2",
        permissionMode: "default",
        parentUuid: "a1",
        timestamp: "2026-04-18T10:00:03.000Z",
        message: { role: "user", content: "Rolled-back prompt" },
      },
      {
        uuid: "a2",
        type: "assistant",
        role: "assistant",
        parentUuid: "u2",
        timestamp: "2026-04-18T10:00:03.500Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Rolled-back answer" }],
        },
      },
      {
        uuid: "u3",
        type: "user",
        role: "user",
        promptId: "p3",
        permissionMode: "default",
        parentUuid: "a1",
        timestamp: "2026-04-18T10:00:04.000Z",
        message: { role: "user", content: "Replacement prompt" },
      },
      {
        uuid: "a3",
        type: "assistant",
        role: "assistant",
        parentUuid: "u3",
        timestamp: "2026-04-18T10:00:04.500Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Replacement answer" }],
        },
      },
    ]);
    directories.push(transcript.directory);

    applyInvalidation(db, sessionId, transcript.path, 100);

    expect(getTurnById(db, interruptedTurnId)).toEqual(
      expect.objectContaining({
        status: "active",
        wasInterrupted: true,
        wasRolledBack: true,
      }),
    );
    expect(getTurnById(db, rolledBackTurnId)).toEqual(
      expect.objectContaining({
        status: "active",
        wasInterrupted: false,
        wasRolledBack: true,
      }),
    );
  });

  test("getReminderItems includes active turns and allows an extracted clean replacement turn", () => {
    db.query(
      `
        INSERT INTO turns (
          session_id, prompt_number, content_prompt_id, status, user_prompt, title,
          was_interrupted, was_rolled_back, created_at_epoch, updated_at_epoch
        ) VALUES
          (?, 1, 'p1', 'active', 'Invalidated prompt', 'Old title', 1, 0, 10, 11),
          (?, 2, 'p2', 'extracted', 'Replacement prompt', 'Replacement title', 0, 0, 20, 21),
          (?, 3, 'p3', 'undone', 'Subagent prompt', 'Subagent title', 0, 0, 30, 31)
      `,
    ).run(sessionId, sessionId, sessionId);

    expect(getReminderItems(db, sessionId)).toEqual([
      expect.objectContaining({
        promptNumber: 1,
        wasInterrupted: true,
        wasRolledBack: false,
        priorTitle: "Old title",
        replacementPromptNumber: 2,
      }),
    ]);
  });
});
