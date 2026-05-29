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

  test("applyInvalidation preserves status and marks newly invalidated turns pending for reminder delivery", () => {
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
        status: "extracted",
        wasInterrupted: true,
        wasRolledBack: true,
        tags: [
          "invalidated:notify-pending:interrupt",
          "invalidated:notify-pending:rollback",
        ],
      }),
    );
    expect(getTurnById(db, rolledBackTurnId)).toEqual(
      expect.objectContaining({
        status: "skipped",
        wasInterrupted: false,
        wasRolledBack: true,
        tags: ["invalidated:notify-pending:rollback"],
      }),
    );
  });

  test("getReminderItems returns only the 10 most recent pending invalidation reminders with title/content context", () => {
    for (let promptNumber = 1; promptNumber <= 12; promptNumber += 1) {
      db.query(
        `
          INSERT INTO turns (
            session_id, prompt_number, content_prompt_id, status, user_prompt, title, content,
            was_interrupted, was_rolled_back, tags, created_at_epoch, updated_at_epoch
          ) VALUES (?, ?, ?, 'extracted', ?, ?, ?, 0, 1, '["invalidated:notify-pending:rollback"]', ?, ?)
        `,
      ).run(
        sessionId,
        promptNumber,
        `p${promptNumber}`,
        `Prompt ${promptNumber}`,
        `Title ${promptNumber}`,
        `Content ${promptNumber}`,
        promptNumber,
        promptNumber,
      );
    }

    db.query(
      `
        INSERT INTO turns (
          session_id, prompt_number, content_prompt_id, status, user_prompt, title, content,
          was_interrupted, was_rolled_back, tags, created_at_epoch, updated_at_epoch
        ) VALUES (?, 13, 'p13', 'extracted', 'Replacement prompt', 'Replacement title', 'Replacement content', 0, 0, '[]', 13, 13)
      `,
    ).run(sessionId);

    expect(getReminderItems(db, sessionId)).toEqual([
      expect.objectContaining({
        promptNumber: 3,
        priorTitle: "Title 3",
        priorContent: "Content 3",
        reasons: [
          expect.objectContaining({
            key: "rollback",
            flagToken: "was_rolled_back",
            parenExtra: null,
          }),
        ],
      }),
      expect.objectContaining({ promptNumber: 4 }),
      expect.objectContaining({ promptNumber: 5 }),
      expect.objectContaining({ promptNumber: 6 }),
      expect.objectContaining({ promptNumber: 7 }),
      expect.objectContaining({ promptNumber: 8 }),
      expect.objectContaining({ promptNumber: 9 }),
      expect.objectContaining({ promptNumber: 10 }),
      expect.objectContaining({ promptNumber: 11 }),
      expect.objectContaining({
        promptNumber: 12,
        priorTitle: "Title 12",
        priorContent: "Content 12",
        reasons: [
          expect.objectContaining({
            key: "rollback",
            parenExtra: null,
          }),
        ],
      }),
    ]);
  });

  test("getReminderItems does not invent replacement for interrupt-only turns", () => {
    db.query(
      `
        INSERT INTO turns (
          session_id, prompt_number, content_prompt_id, status, user_prompt, title, content,
          was_interrupted, was_rolled_back, tags, created_at_epoch, updated_at_epoch
        ) VALUES
          (?, 1, 'p1', 'extracted', 'Interrupted prompt', 'Interrupted title', 'Interrupted content', 1, 0, '["invalidated:notify-pending:interrupt"]', 10, 11),
          (?, 2, 'p2', 'extracted', 'Later clean prompt', 'Later clean title', 'Later clean content', 0, 0, '[]', 20, 21)
      `,
    ).run(sessionId, sessionId);

    expect(getReminderItems(db, sessionId)).toEqual([
      expect.objectContaining({
        promptNumber: 1,
        reasons: [
          expect.objectContaining({
            key: "interrupt",
            flagToken: "was_interrupted",
            parenExtra: null,
          }),
        ],
      }),
    ]);
  });

  test("getReminderItems derives rollback replacement from transcript branch topology", () => {
    db.query(
      `
        INSERT INTO turns (
          session_id, prompt_number, content_prompt_id, status, user_prompt, title, content,
          was_interrupted, was_rolled_back, tags, created_at_epoch, updated_at_epoch
        ) VALUES
          (?, 1, 'p1', 'extracted', 'Rolled-back prompt', 'Rolled-back title', 'Rolled-back content', 0, 1, '["invalidated:notify-pending:rollback"]', 10, 11),
          (?, 2, 'p2', 'extracted', 'Replacement prompt', 'Replacement title', 'Replacement content', 1, 0, '[]', 20, 21),
          (?, 3, 'p3', 'extracted', 'Unrelated clean prompt', 'Unrelated clean title', 'Unrelated clean content', 0, 0, '[]', 30, 31)
      `,
    ).run(sessionId, sessionId, sessionId);

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
        message: { role: "user", content: "Rolled-back prompt" },
      },
      {
        uuid: "u2",
        type: "user",
        role: "user",
        promptId: "p2",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:02.000Z",
        message: { role: "user", content: "Replacement prompt" },
      },
      {
        uuid: "a2",
        type: "assistant",
        role: "assistant",
        parentUuid: "u2",
        timestamp: "2026-04-18T10:00:02.500Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Replacement answer" }],
        },
      },
      {
        uuid: "u3",
        type: "user",
        role: "user",
        promptId: "p3",
        permissionMode: "default",
        parentUuid: "a2",
        timestamp: "2026-04-18T10:00:03.000Z",
        message: { role: "user", content: "Unrelated clean prompt" },
      },
    ]);
    directories.push(transcript.directory);

    expect(getReminderItems(db, sessionId, transcript.path)).toEqual([
      expect.objectContaining({
        promptNumber: 1,
        reasons: [
          expect.objectContaining({
            key: "rollback",
            flagToken: "was_rolled_back",
            parenExtra: "replaced by T2",
          }),
        ],
      }),
    ]);
  });

  test("getReminderItems excludes invalidated turns that are still active", () => {
    db.query(
      `
        INSERT INTO turns (
          session_id, prompt_number, content_prompt_id, status, user_prompt, title, content,
          was_interrupted, was_rolled_back, tags, created_at_epoch, updated_at_epoch
        ) VALUES
          (?, 1, 'p1', 'active', 'Pending invalidated prompt', 'Pending title', 'Pending content', 1, 0, '["invalidated:notify-pending:interrupt"]', 10, 11),
          (?, 2, 'p2', 'extracted', 'Completed invalidated prompt', 'Completed title', 'Completed content', 0, 1, '["invalidated:notify-pending:rollback"]', 20, 21)
      `,
    ).run(sessionId, sessionId);

    expect(getReminderItems(db, sessionId)).toEqual([
      expect.objectContaining({
        promptNumber: 2,
        priorTitle: "Completed title",
        priorContent: "Completed content",
        reasons: [
          expect.objectContaining({
            key: "rollback",
            flagToken: "was_rolled_back",
          }),
        ],
      }),
    ]);
  });
});
