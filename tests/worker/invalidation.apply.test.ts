import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { readAllTranscriptEntries } from "../../src/shared/transcript-parser";
import {
  applyInvalidation,
  applyInvalidationSets,
  computeInvalidationSets,
} from "../../src/worker/invalidation";

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

function insertInvalidationTargetTurns(db: Database, sessionId: number) {
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

  return { interruptedTurnId, rolledBackTurnId };
}

function writeInvalidationTranscript(): { directory: string; path: string } {
  return writeTranscript([
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

  test("applyInvalidationSets matches the path wrapper with precomputed entries", () => {
    const pathTurns = insertInvalidationTargetTurns(db, sessionId);
    const parsedSessionId = upsertSession(db, {
      contentSessionId: "content-session-invalidation-parsed",
      project: "claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 2,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const parsedTurns = insertInvalidationTargetTurns(db, parsedSessionId);
    const transcript = writeInvalidationTranscript();
    directories.push(transcript.directory);

    applyInvalidation(db, sessionId, transcript.path, 100);
    const invalidationSets = computeInvalidationSets(
      readAllTranscriptEntries(transcript.path),
    );
    applyInvalidationSets(db, parsedSessionId, invalidationSets, 100);

    expect(invalidationSets.interruptedPromptIds).toEqual(new Set(["p1"]));
    expect(invalidationSets.rolledBackPromptIds).toEqual(new Set(["p1", "p2"]));
    expect(invalidationSets.replacementByPromptId.get("p1")).toBe("p3");
    expect(invalidationSets.replacementByPromptId.get("p2")).toBe("p3");
    const pathInterruptedTurn = getTurnById(db, pathTurns.interruptedTurnId);
    const pathRolledBackTurn = getTurnById(db, pathTurns.rolledBackTurnId);

    expect(getTurnById(db, parsedTurns.interruptedTurnId)).toEqual(
      expect.objectContaining({
        status: pathInterruptedTurn?.status,
        wasInterrupted: pathInterruptedTurn?.wasInterrupted,
        wasRolledBack: pathInterruptedTurn?.wasRolledBack,
        tags: pathInterruptedTurn?.tags,
      }),
    );
    expect(getTurnById(db, parsedTurns.rolledBackTurnId)).toEqual(
      expect.objectContaining({
        status: pathRolledBackTurn?.status,
        wasInterrupted: pathRolledBackTurn?.wasInterrupted,
        wasRolledBack: pathRolledBackTurn?.wasRolledBack,
        tags: pathRolledBackTurn?.tags,
      }),
    );
  });

});
