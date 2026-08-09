import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation, updateObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import {
  OBSERVATION_ORIGINAL_INDEX_CHARS,
  rebuildSearchIndex,
  reindexTurnFromDb,
  searchMemory,
} from "../../src/db/search";
import { upsertSession } from "../../src/db/sessions";
import { updateTurnById } from "../../src/db/turns";

/**
 * Spec D11 (R1#5, R2#4): the FTS index tracks what was captured, the rendering
 * side decides what is shown. These tests pin the consequence that motivated the
 * change — a skipped turn's own prompt stays findable.
 */
describe("FTS ingest is decoupled from status", () => {
  let db: Database;
  let sessionId: number;

  function captureTurn(promptNumber: number, prompt: string, response: string): number {
    const turnId = db
      .query<{ id: number }, [number, number, string, string]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           created_at_epoch
         ) VALUES (?, ?, 'active', ?, ?, 100)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, prompt, response)!.id;
    reindexTurnFromDb(db, turnId);
    return turnId;
  }

  function ftsRow(
    layer: string,
    sourceId: number,
  ): { prompt: string; response: string } | null {
    return (
      db
        .query<{ prompt: string; response: string }, [string, number]>(
          "SELECT prompt, response FROM memory_fts WHERE layer = ? AND source_id = ?",
        )
        .get(layer, sourceId) ?? null
    );
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-fts",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  // The index keeps a skipped turn's originals; the RENDER side is what decides
  // it is not a hit (ticket 08's addendum). The two halves are asserted
  // separately on purpose — that separation IS the decoupling.
  test("a skipped turn's original prompt and response stay indexed", () => {
    const turnId = captureTurn(
      1,
      "why does the retry watchdog keep respinning",
      "because the connection retry never consumes an attempt",
    );

    updateTurnById(db, turnId, { status: "skipped", updatedAtEpoch: 200 });

    const indexed = ftsRow("turn", turnId);
    expect(indexed?.prompt).toBe("why does the retry watchdog keep respinning");
    expect(indexed?.response).toBe(
      "because the connection retry never consumes an attempt",
    );
    // ... and stays out of the reader's hit set until something extracts it.
    expect(
      searchMemory(db, { scope: "turns", query: "retry watchdog respinning" }),
    ).toEqual([]);

    updateTurnById(db, turnId, { status: "extracted", updatedAtEpoch: 300 });
    expect(
      searchMemory(db, { scope: "turns", query: "retry watchdog respinning" }).map(
        (hit) => hit.turnId,
      ),
    ).toContain(turnId);
  });

  test("a turn is indexed at capture, before any extraction exists", () => {
    const turnId = captureTurn(1, "index me at capture time", "acknowledged");

    expect(ftsRow("turn", turnId)?.prompt).toBe("index me at capture time");
    // In flight (`active`), so not yet a hit — the same rule skipped turns get.
    expect(
      searchMemory(db, { scope: "turns", query: "index me at capture" }),
    ).toEqual([]);
  });

  test("no status transition ever removes a turn from the index", () => {
    const turnId = captureTurn(1, "a prompt worth remembering", "a response");

    for (const status of ["extracted", "skipped", "undone", "failed"] as const) {
      updateTurnById(db, turnId, { status, updatedAtEpoch: 200 });
      expect(ftsRow("turn", turnId)?.prompt).toBe("a prompt worth remembering");
    }
  });

  test("observation originals enter the index truncated to the head of each payload", () => {
    const turnId = captureTurn(1, "run the thing", "ran it");
    const head = "alpha-marker ".padEnd(OBSERVATION_ORIGINAL_INDEX_CHARS - 1, "x");
    const tail = " omega-marker";
    const observation = createObservation(db, {
      turnId,
      toolName: "Bash",
      toolInput: `input-marker ${head}${tail}`,
      toolResult: `result-marker ${head}${tail}`,
      status: "pending",
      createdAtEpoch: 150,
    });

    const indexed = ftsRow("observation", observation.id);
    expect(indexed?.prompt).toHaveLength(OBSERVATION_ORIGINAL_INDEX_CHARS);
    expect(indexed?.response).toHaveLength(OBSERVATION_ORIGINAL_INDEX_CHARS);
    expect(indexed?.prompt).toContain("input-marker");
    expect(indexed?.response).toContain("result-marker");
    // Past the cap the payload is deliberately unindexed: the full corpus is
    // ~1.3 GB and the head is where the identifying material lives.
    expect(indexed?.prompt).not.toContain("omega-marker");

    const hits = db
      .query<{ sourceId: number }, [string]>(
        `SELECT CAST(source_id AS INTEGER) AS sourceId FROM memory_fts
         WHERE memory_fts MATCH ? AND layer = 'observation'`,
      )
      .all('"input-marker"');
    expect(hits.map((hit) => hit.sourceId)).toEqual([observation.id]);
  });

  test("a skipped observation keeps its index row", () => {
    const turnId = captureTurn(1, "run the thing", "ran it");
    const observation = createObservation(db, {
      turnId,
      toolName: "Bash",
      toolInput: "keepme-input",
      toolResult: "keepme-result",
      status: "pending",
      createdAtEpoch: 150,
    });

    updateObservation(db, observation.id, { status: "skipped" });

    expect(ftsRow("observation", observation.id)?.prompt).toBe("keepme-input");
  });

  test("a rebuild reproduces the same status-blind index", () => {
    const skipped = captureTurn(1, "rebuild me even though skipped", "response one");
    updateTurnById(db, skipped, { status: "skipped", updatedAtEpoch: 200 });
    const observation = createObservation(db, {
      turnId: skipped,
      toolName: "Bash",
      toolInput: "rebuild-input",
      toolResult: "rebuild-result",
      status: "pending",
      createdAtEpoch: 150,
    });

    rebuildSearchIndex(db);

    expect(ftsRow("turn", skipped)?.prompt).toBe("rebuild me even though skipped");
    expect(ftsRow("observation", observation.id)?.prompt).toBe("rebuild-input");
  });
});
