import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeDatabase } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { recallInputSchema } from "../../src/mcp/definitions";
import { createDatabaseBackedHandlers } from "../../src/mcp/handlers";

describe("database-backed MCP handlers", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  test("recall schema accepts the new surface and rejects removed fields", () => {
    expect(
      recallInputSchema.parse({
        id: "S1/T2",
        depth: "expanded",
        page: 2,
        pageSize: 10,
        truncate: 500,
      }),
    ).toEqual({
      id: "S1/T2",
      depth: "expanded",
      page: 2,
      pageSize: 10,
      truncate: 500,
    });

    expect(() =>
      recallInputSchema.parse({
        id: "S1",
        limit: 10,
      }),
    ).toThrow();
    expect(() =>
      recallInputSchema.parse({
        id: "S1",
        depth: "full",
      }),
    ).toThrow();
  });

  test("routes timeline requests through the database-backed handler set", async () => {
    const handlers = createDatabaseBackedHandlers(db, {
      defaultProject: "claude-mnemo",
    });

    const session = upsertSession(db, {
      contentSessionId: "timeline-session",
      project: "claude-mnemo",
      title: "Timeline fixture",
      insight: null,
      createdAtEpoch: 1_700_000_000,
      updatedAtEpoch: 1_700_000_100,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        content_prompt_id,
        transcript_line_start,
        status,
        user_prompt,
        assistant_response,
        title,
        content,
        insight,
        type,
        tags,
        files_read,
        files_modified,
        tool_call_count,
        created_at_epoch,
        updated_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      1,
      null,
      null,
      "extracted",
      "Investigate timeline registration",
      null,
      "Wire timeline tool",
      null,
      null,
      "change",
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      1,
      1_700_000_100,
      null,
    );
    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        content_prompt_id,
        transcript_line_start,
        status,
        user_prompt,
        assistant_response,
        title,
        content,
        insight,
        type,
        tags,
        files_read,
        files_modified,
        tool_call_count,
        created_at_epoch,
        updated_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      2,
      null,
      null,
      "extracted",
      "Investigate timeline pagination",
      null,
      "Page two turn",
      null,
      null,
      "change",
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      1,
      1_700_000_110,
      null,
    );

    const result = await handlers.timeline?.({
      id: `S${session.id}`,
      page: 2,
      pageSize: 1,
    });

    expect(result?.content[0]?.text).toContain("claude-mnemo | 2 turns | 2 tool_calls");
    expect(result?.content[0]?.text).toContain("showing: page 2 / 2 (total 2)");
    expect(result?.content[0]?.text).toContain("T2");
    expect(result?.content[0]?.text).not.toContain("T1  ");
  });
});
