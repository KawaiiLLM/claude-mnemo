import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { reindexTurnFromDb, searchMemory } from "../../src/db/search";
import { upsertSession } from "../../src/db/sessions";
import { updateTurnById, type TurnStatus } from "../../src/db/turns";

/**
 * Ticket 08's addendum. Ticket 06 decoupled FTS ingest from status, which left
 * `queryTurnsByScope` with no status predicate at all — so a skipped or
 * in-flight turn started surfacing as a recall hit, which is NOT what the index
 * change was for (spec D11: status governs rendering, not indexing). The read
 * side now carries the filter the index used to enforce by deleting rows.
 */
describe("recall turn hits are filtered by render status", () => {
  let db: Database;
  let sessionId: number;

  function captureTurn(promptNumber: number, status: TurnStatus): number {
    const turnId = db
      .query<{ id: number }, [number, number, string]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           title, content, tags, type, created_at_epoch
         ) VALUES (?, ?, ?, 'zebrafish prompt', 'zebrafish response',
                   'zebrafish title', 'zebrafish content', '["topic:zebrafish"]',
                   'bugfix', 100)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, status)!.id;
    reindexTurnFromDb(db, turnId);
    return turnId;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-status-filter",
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

  test("only an extracted turn is a text hit", () => {
    const extracted = captureTurn(1, "extracted");
    for (const [index, status] of (
      ["active", "provisional", "skipped", "failed", "undone"] as const
    ).entries()) {
      captureTurn(index + 2, status);
    }

    expect(
      searchMemory(db, { scope: "turns", query: "zebrafish" }).map((hit) => hit.turnId),
    ).toEqual([extracted]);
  });

  test("the filter also governs the filter-only path (tag:, no text)", () => {
    const extracted = captureTurn(1, "extracted");
    const skipped = captureTurn(2, "skipped");

    const hits = searchMemory(db, { scope: "turns", tag: "topic:zebrafish" });
    expect(hits.map((hit) => hit.turnId)).toEqual([extracted]);
    expect(hits.map((hit) => hit.turnId)).not.toContain(skipped);
  });

  test("a turn re-enters the hit set the moment it is extracted", () => {
    const turnId = captureTurn(1, "active");
    expect(searchMemory(db, { scope: "turns", query: "zebrafish" })).toEqual([]);

    updateTurnById(db, turnId, { status: "extracted", updatedAtEpoch: 200 });

    expect(
      searchMemory(db, { scope: "turns", query: "zebrafish" }).map((hit) => hit.turnId),
    ).toEqual([turnId]);
  });

  test("the session facets answer off rendered turns too", () => {
    // A session-scoped `tag:`/`type:` asks "does this session hold such a
    // turn". It has to mean the same turns the turn-scoped query would return,
    // or a skipped turn re-enters the hit set one level up, as a session.
    upsertSession(db, {
      contentSessionId: "session-status-filter",
      project: "/tmp/project",
      title: "zebrafish session",
      content: "zebrafish content",
      insight: null,
      nextSteps: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    captureTurn(1, "skipped");

    expect(searchMemory(db, { scope: "sessions", tag: "topic:zebrafish" })).toEqual([]);
    expect(searchMemory(db, { scope: "sessions", type: "bugfix" })).toEqual([]);
    expect(
      searchMemory(db, { scope: "sessions", query: "zebrafish", tag: "topic:zebrafish" }),
    ).toEqual([]);

    captureTurn(2, "extracted");

    expect(
      searchMemory(db, { scope: "sessions", tag: "topic:zebrafish" }).map(
        (hit) => hit.sessionId,
      ),
    ).toEqual([sessionId]);
    expect(
      searchMemory(db, { scope: "sessions", query: "zebrafish", tag: "topic:zebrafish" }).map(
        (hit) => hit.sessionId,
      ),
    ).toEqual([sessionId]);
  });

  test("direct addressing is unaffected — only the hit set is filtered", () => {
    const turnId = captureTurn(1, "skipped");

    // The index still holds the originals; the render filter is a search-side
    // rule, not a deletion.
    const indexed = db
      .query<{ prompt: string }, [number]>(
        "SELECT prompt FROM memory_fts WHERE layer = 'turn' AND source_id = ?",
      )
      .get(turnId);
    expect(indexed?.prompt).toBe("zebrafish prompt");
  });
});

/**
 * The observation layer's half of the same rule, and why it needed an era.
 *
 * `skipped` changed meaning at the cutover. Before it, the extraction agent read
 * each observation and skipping it was a JUDGEMENT — those rows are noise a
 * reader should not be shown. After it nothing summarizes an observation at all,
 * so every one of them ends `skipped` on completion and the status says nothing
 * about worth; keeping the old filter would have hidden the entire layer.
 */
describe("recall observation hits read status per era", () => {
  const CUTOFF = 1_000;
  let db: Database;
  let sessionId: number;

  function captureObservation(
    promptNumber: number,
    createdAtEpoch: number,
    filePath: string,
  ): number {
    const turnId = db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, created_at_epoch
         ) VALUES (?, ?, 'extracted', 'prompt', ?)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, createdAtEpoch)!.id;
    return createObservation(db, {
      turnId,
      toolName: "Read",
      toolInput: JSON.stringify({ file_path: filePath }),
      status: "skipped",
      createdAtEpoch,
    }).id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-observation-era",
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

  test("an era observation is a hit on its own captured text; a legacy one is not", () => {
    const legacy = captureObservation(1, CUTOFF - 1, "src/pufferfish-legacy.ts");
    const era = captureObservation(2, CUTOFF, "src/pufferfish-era.ts");

    const hits = searchMemory(db, {
      scope: "observations",
      query: "pufferfish",
      eraCutoffEpoch: CUTOFF,
    }).map((hit) => hit.observationId);

    expect(hits).toEqual([era]);
    expect(hits).not.toContain(legacy);
  });

  test("with no era, the legacy rule stands and skipped stays out", () => {
    captureObservation(1, CUTOFF - 1, "src/pufferfish-legacy.ts");
    captureObservation(2, CUTOFF, "src/pufferfish-era.ts");

    expect(
      searchMemory(db, { scope: "observations", query: "pufferfish" }),
    ).toEqual([]);
  });
});
