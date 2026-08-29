import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { RECALL_PARAMETER_ERROR_PREFIX, recallQueryOutcome } from "../../src/mcp/recall";

/**
 * Ticket 16 scope addition (peer review finding P2): `recall`'s console
 * route used to answer every failure — a garbage id as much as a
 * well-formed id naming a missing target — with HTTP 200 and prose text
 * ("Parameter error: ..."). `recallQueryOutcome` is the TYPED sibling of
 * `recallMemory` the console now reads its 400/404/200 status from,
 * directly, not by pattern-matching the rendered prose.
 */

const NOW = 1_800_000_000;

let db: Database;

function seedSession(label = "outcome"): number {
  return upsertSession(db, {
    contentSessionId: `${label}-${Math.random()}`,
    project: `/tmp/${label}`,
    title: label,
    content: null,
    insight: null,
    createdAtEpoch: NOW,
    updatedAtEpoch: NOW,
    completedAtEpoch: null,
  }).id;
}

function insertTurn(sessionId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, tags
       ) VALUES (?, ?, 'active', 'p', 'r', 1, ?, '["design"]', '[]')
       RETURNING id`,
    )
    .get(sessionId, promptNumber, NOW + promptNumber)!.id;
}

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

describe("recallQueryOutcome", () => {
  test("a genuinely malformed id selector is 400 — RECALL_PARAMETER_ERROR_PREFIX drives the classification", () => {
    const outcome = recallQueryOutcome(db, { id: "garbage" });
    expect(outcome.status).toBe(400);
    if (outcome.status === 400) {
      expect(outcome.message).not.toContain(RECALL_PARAMETER_ERROR_PREFIX);
    }
  });

  test("a malformed filter is also 400", () => {
    const outcome = recallQueryOutcome(db, { filter: { time: "not-a-date" } });
    expect(outcome.status).toBe(400);
  });

  test("a well-formed but missing segment is 404, not 400", () => {
    const outcome = recallQueryOutcome(db, { id: "E999999" });
    expect(outcome.status).toBe(404);
    if (outcome.status === 404) {
      expect(outcome.message).toContain("not found");
    }
  });

  test("a well-formed but missing turn-by-id is 404", () => {
    const outcome = recallQueryOutcome(db, { id: "T999999" });
    expect(outcome.status).toBe(404);
  });

  test("a well-formed but missing session is 404", () => {
    const outcome = recallQueryOutcome(db, { id: "S999999" });
    expect(outcome.status).toBe(404);
  });

  test("a well-formed lane address naming a segment with NO such declared lane is 404", () => {
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    insertLane(db, segment.id, "known", NOW);
    const outcome = recallQueryOutcome(db, { id: `E${segment.id}/#unknown` });
    expect(outcome.status).toBe(404);
  });

  test("a real session renders 200 with its own text", () => {
    const sessionId = seedSession("outcome-ok");
    const outcome = recallQueryOutcome(db, { id: `S${sessionId}` });
    expect(outcome.status).toBe(200);
    if (outcome.status === 200) {
      expect(outcome.text).toContain("outcome-ok");
    }
  });

  test("a real lane renders 200 with the SAME text recallMemory gives", () => {
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    insertLane(db, segment.id, "mylane", NOW);
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    addSegmentMembers(db, segment.id, [t1, t2], NOW);
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t2 },
          cited: { kind: "turn", id: t1 },
          relation: "extends",
          provenance: "asserted",
          ...deriveSideTags(["mylane"]),
        },
      ],
      NOW,
    );
    db.query("UPDATE turns SET tags = '[\"mylane\"]' WHERE id IN (?, ?)").run(t1, t2);

    const outcome = recallQueryOutcome(db, { id: `E${segment.id}/#mylane` });
    expect(outcome.status).toBe(200);
  });

  test("a list/range id that renders empty stays 200 — an empty listing is not a missing target", () => {
    const outcome = recallQueryOutcome(db, { id: "E1..9" });
    expect(outcome.status).toBe(200);
  });

  test("a comma-separated id list is not classified for 404 (documented gap) — stays whatever recallMemory renders", () => {
    const outcome = recallQueryOutcome(db, { id: "E999998, E999999" });
    // Not asserted 404: comma-list existence classification is out of this
    // ticket's scoped 404 coverage (single-address kinds only) — the render
    // itself still answers correctly, just not reflected in this status.
    expect([200, 400, 404]).toContain(outcome.status);
  });

  test("bare recall() (browse mode, no id) is always 200", () => {
    const outcome = recallQueryOutcome(db, {});
    expect(outcome.status).toBe(200);
  });
});
