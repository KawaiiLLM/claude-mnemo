import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import { saveTurnFixture as saveTurn } from "../support/turn-fixtures";

describe("turn merge semantics", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "content-turns-merge",
      project: "claude-mnemo",
      title: "Turns",
      content: "Turn merge testing",
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("partial updates preserve unspecified extracted fields", () => {
    const turn = saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "Original prompt",
      assistantResponse: "Original answer",
      title: "Original title",
      content: "Original content",
      insight: "- original insight",
      type: "feature",
      tags: ["existing"],
      filesRead: ["src/original.ts"],
      filesModified: ["src/original.ts"],
      createdAtEpoch: 10,
      updatedAtEpoch: 11,
      observations: [],
    });

    const updated = updateTurnById(db, turn.id, {
      title: "Retitled",
      updatedAtEpoch: 12,
    });

    expect(updated).toEqual(
      expect.objectContaining({
        status: "extracted",
        title: "Retitled",
        content: "Original content",
        insight: "- original insight",
        type: "feature",
        tags: ["existing"],
        filesRead: ["src/original.ts"],
        filesModified: ["src/original.ts"],
      }),
    );
  });

  test("tag updates append rather than replace on extracted turns", () => {
    const turn = saveTurn(db, {
      sessionId,
      promptNumber: 2,
      userPrompt: "Original prompt",
      assistantResponse: "Original answer",
      title: "Original title",
      content: "Original content",
      insight: "- original insight",
      type: "decision",
      tags: ["existing", "subagent:pending"],
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 20,
      updatedAtEpoch: 21,
      observations: [],
    });

    const updated = updateTurnById(db, turn.id, {
      tags: ["existing", "invalidated"],
      updatedAtEpoch: 22,
    });

    expect(updated?.status).toBe("extracted");
    expect(updated?.tags).toEqual([
      "existing",
      "subagent:pending",
      "invalidated",
    ]);
  });

  test("replaceTags overwrites the stored tag set instead of unioning with existing tags", () => {
    const turn = saveTurn(db, {
      sessionId,
      promptNumber: 2,
      userPrompt: "Original prompt",
      assistantResponse: "Original answer",
      title: "Original title",
      content: "Original content",
      insight: "- original insight",
      type: "decision",
      tags: ["existing", "subagent:pending"],
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 20,
      updatedAtEpoch: 21,
      observations: [],
    });

    const updated = updateTurnById(db, turn.id, {
      replaceTags: ["existing", "subagent:notified"],
      updatedAtEpoch: 22,
    });

    expect(updated?.tags).toEqual(["existing", "subagent:notified"]);
    expect(updated?.status).toBe("extracted");
  });

  test("tag-only updates promote active turns to extracted", () => {
    const turnId = db
      .query<{ id: number }, [number]>(
        `
          INSERT INTO turns (
            session_id,
            prompt_number,
            status,
            user_prompt,
            title,
            content,
            insight,
            type,
            tags,
            created_at_epoch,
            updated_at_epoch
          ) VALUES (?, 3, 'active', 'Prompt', 'Title', 'Content', '- insight', 'decision', '["old"]', 30, 31)
          RETURNING id
        `,
      )
      .get(sessionId)!.id;

    const updated = updateTurnById(db, turnId, {
      tags: ["invalidated"],
      updatedAtEpoch: 32,
    });

    expect(updated?.status).toBe("extracted");
    expect(updated?.tags).toEqual(["old", "invalidated"]);
    expect(updated?.content).toBe("Content");
  });

  test("content updates promote active turns to extracted", () => {
    const turnId = db
      .query<{ id: number }, [number]>(
        `
          INSERT INTO turns (
            session_id,
            prompt_number,
            status,
            user_prompt,
            title,
            created_at_epoch,
            updated_at_epoch
          ) VALUES (?, 4, 'active', 'Prompt', 'Title', 40, 41)
          RETURNING id
        `,
      )
      .get(sessionId)!.id;

    const updated = updateTurnById(db, turnId, {
      content: "Rewritten as invalidated direction",
      updatedAtEpoch: 42,
    });

    expect(updated?.status).toBe("extracted");
    expect(updated?.content).toBe("Rewritten as invalidated direction");
  });

  test("explicit skipped updates preserve fields while changing only status", () => {
    const turn = saveTurn(db, {
      sessionId,
      promptNumber: 5,
      userPrompt: "Original prompt",
      assistantResponse: "Original answer",
      title: "Original title",
      content: "Original content",
      insight: "- original insight",
      type: "decision",
      tags: ["existing"],
      filesRead: ["src/original.ts"],
      filesModified: ["src/original.ts"],
      createdAtEpoch: 50,
      updatedAtEpoch: 51,
      observations: [],
    });

    const updated = updateTurnById(db, turn.id, {
      status: "skipped",
      updatedAtEpoch: 52,
    });

    expect(updated).toEqual(
      expect.objectContaining({
        status: "skipped",
        title: "Original title",
        content: "Original content",
        insight: "- original insight",
        type: "decision",
        tags: ["existing"],
      }),
    );
  });

  test("non-skipped updates do not promote undone turns", () => {
    const turn = saveTurn(db, {
      sessionId,
      promptNumber: 6,
      status: "undone",
      userPrompt: "Undone prompt",
      assistantResponse: "Undone answer",
      title: null,
      content: null,
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 60,
      updatedAtEpoch: 61,
      observations: [],
    });

    const updated = updateTurnById(db, turn.id, {
      tags: ["invalidated"],
      updatedAtEpoch: 62,
    });

    expect(updated?.status).toBe("undone");
    expect(getTurnById(db, turn.id)?.status).toBe("undone");
  });
});
