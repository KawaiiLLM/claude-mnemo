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

  test("timeline handler forwards phases and milestones flags", async () => {
    const handlers = createDatabaseBackedHandlers(db, {
      defaultProject: "claude-mnemo",
    });

    const session = upsertSession(db, {
      contentSessionId: "flags-session",
      project: "claude-mnemo",
      title: "Flags fixture",
      insight: null,
      createdAtEpoch: 1_700_000_000,
      updatedAtEpoch: 1_700_000_200,
      completedAtEpoch: null,
    });

    const insertTurn = db.query(
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
    );

    // Seed turns with mixed types so a phases block renders (multiple phase
    // segments: discovery run, then a decision, then more discovery).
    const turnData = [
      { promptNumber: 1, type: "discovery", epoch: 1_700_000_010 },
      { promptNumber: 2, type: "discovery", epoch: 1_700_000_020 },
      { promptNumber: 3, type: "discovery", epoch: 1_700_000_030 },
      { promptNumber: 4, type: "decision",  epoch: 1_700_000_040 },
      { promptNumber: 5, type: "discovery", epoch: 1_700_000_050 },
      { promptNumber: 6, type: "discovery", epoch: 1_700_000_060 },
    ];

    for (const t of turnData) {
      insertTurn.run(
        session.id,
        t.promptNumber,
        null,
        t.promptNumber * 10,
        "extracted",
        `prompt ${t.promptNumber}`,
        null,
        `title ${t.promptNumber}`,
        null,
        null,
        t.type,
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify([]),
        1,
        t.epoch,
        null,
      );
    }

    const withPhases = await handlers.timeline?.({ id: `S${session.id}` });
    const noPhases = await handlers.timeline?.({ id: `S${session.id}`, phases: false });

    expect(withPhases?.content[0]?.text).toContain("phases (");
    expect(noPhases?.content[0]?.text).not.toContain("phases (");

    // milestones=true forwards through the handler and trims the turn table.
    const milestone = await handlers.timeline?.({
      id: `S${session.id}`,
      milestones: true,
    });
    const rowCount = (text: string | undefined) =>
      (text ?? "").split("\n").filter((l) => /^T\d+ \|/.test(l)).length;
    expect(rowCount(milestone?.content[0]?.text)).toBeLessThan(
      rowCount(withPhases?.content[0]?.text),
    );
  });
});
