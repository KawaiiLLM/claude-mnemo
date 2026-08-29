import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { reindexTurnFromDb } from "../../src/db/search";
import { createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { recallMemory } from "../../src/mcp/recall";

/**
 * Ticket 14 (read-write-contract spec): the selector multi-select grammar,
 * the absorbed render-seam repairs (P1-2 "record what you render" for the
 * `S<n>` detail route and the `O*` routes; P2-5 search bolding beyond
 * `content`). The pre-render sequence snapshot (P1-3) is covered at the
 * primitive level in tests/db/write-gate.test.ts; this file exercises it
 * through a real recall() render pass.
 */

let db: Database;

function seedSessionWithTurn(
  contentSessionId: string,
  overrides: {
    userPrompt?: string;
    assistantResponse?: string;
    title?: string;
    content?: string;
    insight?: string;
  } = {},
): { sessionId: number; turnId: number } {
  const sessionId = upsertSession(db, {
    contentSessionId,
    project: "/tmp/ticket14",
    title: `${contentSessionId} title`,
    content: null,
    insight: null,
    createdAtEpoch: 100,
    updatedAtEpoch: 100,
    completedAtEpoch: null,
  }).id;

  const turnId = db
    .query<{ id: number }, [number, string, string, string | null, string | null, string | null]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, content, insight, created_at_epoch
       ) VALUES (?, 1, 'extracted', ?, ?, ?, ?, ?, 110)
       RETURNING id`,
    )
    .get(
      sessionId,
      overrides.userPrompt ?? "prompt",
      overrides.assistantResponse ?? "response",
      overrides.title ?? "a turn title",
      overrides.content ?? "turn content",
      overrides.insight ?? null,
    )!.id;

  // The raw INSERT above bypasses whatever ingestion-path indexing normally
  // populates `memory_fts` — this is the same explicit re-index call
  // `db/turns.ts`'s own writers use after a field mutation.
  reindexTurnFromDb(db, turnId);

  return { sessionId, turnId };
}

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => db.close());

describe("selector multi-select — comma-separated id lists", () => {
  test('id="E<a>, E<b>" renders both segments in order, sharing the page budget, grants recorded for every item', () => {
    const first = createSegment(db, { title: "First lane", nowEpoch: 100 });
    const second = createSegment(db, { title: "Second lane", nowEpoch: 200 });

    const output = recallMemory(db, {
      id: `E${first.id}, E${second.id}`,
      readerId: "session:1",
      now: () => 500,
    });

    expect(output).toContain("First lane");
    expect(output).toContain("Second lane");
    // Order: first item's own render precedes the second's.
    expect(output.indexOf("First lane")).toBeLessThan(output.indexOf("Second lane"));

    for (const segmentId of [first.id, second.id]) {
      const grant = db
        .query<{ readAtEpoch: number }, [string, number]>(
          `SELECT read_at_epoch AS readAtEpoch FROM write_gate_reads
           WHERE writer = ? AND entity_type = 'segment' AND entity_id = ?`,
        )
        .get("session:1", segmentId);
      expect(grant).not.toBeNull();
    }
  });

  test('id="S<a>, S<b>" renders both sessions in order, grants recorded for every item', () => {
    const a = seedSessionWithTurn("multi-select-a");
    const b = seedSessionWithTurn("multi-select-b");

    const output = recallMemory(db, {
      id: `S${a.sessionId}, S${b.sessionId}`,
      readerId: "session:1",
      now: () => 500,
    });

    expect(output).toContain(`S${a.sessionId}`);
    expect(output).toContain(`S${b.sessionId}`);
    expect(output.indexOf(`S${a.sessionId}`)).toBeLessThan(output.indexOf(`S${b.sessionId}`));

    for (const sessionId of [a.sessionId, b.sessionId]) {
      const grant = db
        .query<{ readAtEpoch: number }, [string, number]>(
          `SELECT read_at_epoch AS readAtEpoch FROM write_gate_reads
           WHERE writer = ? AND entity_type = 'session' AND entity_id = ?`,
        )
        .get("session:1", sessionId);
      expect(grant).not.toBeNull();
    }
  });

  test("an invalid item in the comma list rejects the WHOLE call and echoes the grammar", () => {
    const only = createSegment(db, { title: "Only lane", nowEpoch: 100 });
    const output = recallMemory(db, { id: `E${only.id}, not-a-real-address` });

    expect(output).toContain("Parameter error:");
    expect(output).toContain("not-a-real-address");
    expect(output.toLowerCase()).toContain("address");
    // Nothing from the valid item leaks through a rejected call.
    expect(output).not.toContain("Only lane");
  });

  test("mixed address kinds in the comma list reject the WHOLE call and echo the grammar", () => {
    const segment = createSegment(db, { title: "Mixed-kind lane", nowEpoch: 100 });
    const { sessionId } = seedSessionWithTurn("mixed-kind-session");

    const output = recallMemory(db, { id: `E${segment.id}, S${sessionId}` });

    expect(output).toContain("Parameter error:");
    expect(output).toContain("mixed");
    expect(output).not.toContain("Mixed-kind lane");
  });
});

describe("P1-2 fix — record what you render: the S<n> detail route", () => {
  test("recall(id=\"S<n>\") records a grant for the session — and NOT for the turns its preview lists", () => {
    // Ticket 14's P1-2 fix granted the previewed turns too; the peer round's
    // P2-2 narrowed it back to the session alone. A session-detail render
    // delivers a bounded PREVIEW of its turns, not a read of them — a caller
    // that means to write one addresses it (`S<n>/T<m>`), which reads it as
    // itself. The session's own grant is what this route delivers.
    const { sessionId, turnId } = seedSessionWithTurn("s-detail-grants");

    recallMemory(db, { id: `S${sessionId}`, readerId: "session:1", now: () => 700 });

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
    expect(turnGrant ?? null).toBeNull();
  });
});

describe("P1-2 fix — record what you render: the O* routes (turn/session context, not the observation)", () => {
  function seedObservation(turnId: number): number {
    return db
      .query<{ id: number }, [number]>(
        `INSERT INTO observations (
           turn_id, tool_name, tool_input, tool_result, status, title, content,
           excluded_from_extraction, created_at_epoch
         ) VALUES (?, 'Edit', '{"file_path":"a.ts"}', 'ok', 'extracted',
           'Edit a.ts', 'edited', 0, 111)
         RETURNING id`,
      )
      .get(turnId)!.id;
  }

  test('S<n>/T<m>/O* records the turn + session context', () => {
    const { sessionId, turnId } = seedSessionWithTurn("obs-list-grants");
    seedObservation(turnId);

    recallMemory(db, { id: `S${sessionId}/T1/O*`, readerId: "session:1", now: () => 700 });

    expect(
      db
        .query<{ c: number }, [string, number]>(
          `SELECT COUNT(*) AS c FROM write_gate_reads WHERE writer = ? AND entity_type = 'turn' AND entity_id = ?`,
        )
        .get("session:1", turnId)!.c,
    ).toBe(1);
    expect(
      db
        .query<{ c: number }, [string, number]>(
          `SELECT COUNT(*) AS c FROM write_gate_reads WHERE writer = ? AND entity_type = 'session' AND entity_id = ?`,
        )
        .get("session:1", sessionId)!.c,
    ).toBe(1);
  });

  test('S<n>/T*/O* records the session + every turn whose observations the page actually shows', () => {
    const { sessionId, turnId } = seedSessionWithTurn("session-obs-list-grants");
    seedObservation(turnId);

    recallMemory(db, { id: `S${sessionId}/T*/O*`, readerId: "session:1", now: () => 700 });

    expect(
      db
        .query<{ c: number }, [string, number]>(
          `SELECT COUNT(*) AS c FROM write_gate_reads WHERE writer = ? AND entity_type = 'session' AND entity_id = ?`,
        )
        .get("session:1", sessionId)!.c,
    ).toBe(1);
    expect(
      db
        .query<{ c: number }, [string, number]>(
          `SELECT COUNT(*) AS c FROM write_gate_reads WHERE writer = ? AND entity_type = 'turn' AND entity_id = ?`,
        )
        .get("session:1", turnId)!.c,
    ).toBe(1);
  });

  test("bare O<n> records its owning turn + session (never the observation itself — no gated entity type exists for it)", () => {
    const { sessionId, turnId } = seedSessionWithTurn("bare-obs-grants");
    const observationId = seedObservation(turnId);

    recallMemory(db, { id: `O${observationId}`, readerId: "session:1", now: () => 700 });

    expect(
      db
        .query<{ c: number }, [string, number]>(
          `SELECT COUNT(*) AS c FROM write_gate_reads WHERE writer = ? AND entity_type = 'turn' AND entity_id = ?`,
        )
        .get("session:1", turnId)!.c,
    ).toBe(1);
    expect(
      db
        .query<{ c: number }, [string, number]>(
          `SELECT COUNT(*) AS c FROM write_gate_reads WHERE writer = ? AND entity_type = 'session' AND entity_id = ?`,
        )
        .get("session:1", sessionId)!.c,
    ).toBe(1);
  });
});

describe("P2-5 fix — search bolding covers every indexed field, not only content", () => {
  test("a needle living ONLY in insight/prompt/response still gets bold + neighborhood treatment", () => {
    seedSessionWithTurn("bolding-fixture", {
      userPrompt: "please investigate the zorkmid overflow bug",
      assistantResponse: "the zorkmid counter wraps at 2^16, patched",
      content: "unrelated content text with no needle at all",
      insight: "zorkmid overflow was the root cause",
    });

    const output = recallMemory(db, {
      query: "zorkmid",
      filter: { fields: ["prompt", "response", "insight"] },
      pageSize: 50,
    });

    // Bold marker present on every one of the non-content fields the search
    // hit's needle actually lives in — not just a single occurrence.
    const boldCount = (output.match(/\*\*zorkmid\*\*/g) ?? []).length;
    expect(boldCount).toBeGreaterThanOrEqual(3); // prompt label, response, insight
    expect(output.toLowerCase()).toContain("response:");
    expect(output).toContain("- insight:");
  });
});
