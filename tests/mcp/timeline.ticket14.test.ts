import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { timelineQuery } from "../../src/mcp/timeline";

/**
 * Ticket 14 (P1-2 fix, spec "timeline 的 session 路由...记录其实际渲染实体
 * 的授权"): `timeline(id="S<n>")` used to record grants for the turns it
 * showed but never the SESSION entity the render also displays.
 */

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => db.close());

describe("P1-2 fix — timeline's session route records the session entity too", () => {
  test('timeline(id="S<n>") records a grant for the session AND its rendered turns', () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "timeline-session-grant",
      project: "/tmp/ticket14",
      title: "timeline session grant fixture",
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;

    const turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           title, content, created_at_epoch
         ) VALUES (?, 1, 'extracted', 'p', 'r', 'a turn', 'body', 110)
         RETURNING id`,
      )
      .get(sessionId)!.id;

    timelineQuery(db, {
      id: `S${sessionId}`,
      view: "turns",
      readerId: "session:1",
      now: () => 900,
    });

    const sessionGrant = db
      .query<{ readAtEpoch: number }, [string, number]>(
        `SELECT read_at_epoch AS readAtEpoch FROM write_gate_reads
         WHERE writer = ? AND entity_type = 'session' AND entity_id = ?`,
      )
      .get("session:1", sessionId);
    const turnGrant = db
      .query<{ readAtEpoch: number }, [string, number]>(
        `SELECT read_at_epoch AS readAtEpoch FROM write_gate_reads
         WHERE writer = ? AND entity_type = 'turn' AND entity_id = ?`,
      )
      .get("session:1", turnId);

    expect(sessionGrant).not.toBeNull();
    expect(sessionGrant?.readAtEpoch).toBe(900);
    expect(turnGrant).not.toBeNull();
  });
});
