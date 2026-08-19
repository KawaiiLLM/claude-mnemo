import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { recallMemory } from "../../src/mcp/recall";

/**
 * A `note` call's observation is captured for the raw axis and withheld from
 * everything that reads observations as work content. recall is a reader: if it
 * renders the row — even only its id, tool name or count — the P1 trial's two
 * summary sources stop being independent, and the id it printed is one the model
 * can then fetch in full.
 */
describe("recall withholds excluded observations", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;
  let visibleObservationId: number;
  let excludedObservationId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "recall-exclusion",
      project: "claude-mnemo",
      title: "Exclusion session",
      content: "Session summary",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;

    turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           title, content, created_at_epoch
         ) VALUES (?, 1, 'extracted', 'do the work', 'done',
           'implement+exclusion: turn', 'body', 120)
         RETURNING id`,
      )
      .get(sessionId)!.id;

    visibleObservationId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO observations (
           turn_id, tool_name, tool_input, tool_result, status, title, content,
           excluded_from_extraction, created_at_epoch
         ) VALUES (?, 'Edit', '{"file_path":"src/a.ts"}', 'ok', 'extracted',
           'Edit src/a.ts', 'edited', 0, 121)
         RETURNING id`,
      )
      .get(turnId)!.id;
    excludedObservationId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO observations (
           turn_id, tool_name, tool_input, tool_result, status, title, content,
           excluded_from_extraction, created_at_epoch
         ) VALUES (?, 'mcp__mnemo__note', '{"title":"secretnotetitle"}',
           'Noted S1/T1.', 'pending', NULL, NULL, 1, 122)
         RETURNING id`,
      )
      .get(turnId)!.id;
  });

  afterEach(() => {
    db.close();
  });

  test("an expanded turn shows neither the note observation nor its count", () => {
    const output = recallMemory(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title", "content", "observations", "files"] },
    });

    expect(output).not.toContain("mcp__mnemo__note");
    expect(output).not.toContain("secretnotetitle");
    expect(output).toContain("Edit src/a.ts");
    // The count is part of the leak: "2 observations" on a turn that shows one
    // tells the reader a hidden call exists and invites a fetch by id.
    expect(output).not.toMatch(/\b2 obs/);
  });

  test("observation listings never route to an excluded row", () => {
    const turnScoped = recallMemory(db, { id: `S${sessionId}/T1/O*` });
    const sessionScoped = recallMemory(db, { id: `S${sessionId}/T*/O*` });

    for (const output of [turnScoped, sessionScoped]) {
      expect(output).not.toContain("mcp__mnemo__note");
      expect(output).not.toContain("secretnotetitle");
      expect(output).toContain("Edit src/a.ts");
    }
  });

  test("addressing an excluded observation by id reads as no such row", () => {
    // Ids are dense, so withholding a row from the listings is worth nothing if
    // the neighbouring id still fetches it in full. The direct route answers
    // exactly as it does for an id that was never written.
    const excluded = recallMemory(db, { id: `O${excludedObservationId}` });

    expect(excluded).toBe("Observation not found.");
    expect(recallMemory(db, { id: `O${excludedObservationId + 1_000}` })).toBe(
      excluded,
    );
    expect(recallMemory(db, { id: `O${visibleObservationId}` })).toContain(
      "Edit src/a.ts",
    );
  });
});
