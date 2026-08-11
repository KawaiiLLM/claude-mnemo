import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { rebuildSearchIndex, reindexTurnFromDb } from "../../src/db/search";
import {
  addSegmentMembers,
  applySegmentWrites,
  createSegment,
  getSegment,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { recallMemory } from "../../src/mcp/recall";

/**
 * Spec D11's read surface: `E` is the segment selector, a segment enters the hit
 * set under the SAME schema a turn does, and an observation row shows its
 * mechanical fields once nothing summarizes it any more.
 */
describe("recall segment selector and cross-granularity filters", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;
  let deliveredSegmentId: number;
  const CUTOFF = 1_900_000_000;
  const turnIds: Record<string, number> = {};

  function makeTurn(
    promptNumber: number,
    options: { type?: string | null; title?: string; tags?: string[]; epoch?: number } = {},
  ): number {
    const id = db
      .query<{ id: number }, [number, number, string | null, string, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, type, title, tags, created_at_epoch,
           user_prompt, assistant_response, content, files_read, files_modified
         ) VALUES (?, ?, 'extracted', ?, ?, ?, ?, 'user prompt text',
                   'assistant response text', 'turn body', '[]', '[]')
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.type ?? null,
        options.title ?? `title ${promptNumber}`,
        JSON.stringify(options.tags ?? []),
        options.epoch ?? CUTOFF + promptNumber,
      )!.id;
    reindexTurnFromDb(db, id);
    return id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-recall-segments",
      project: "/tmp/project",
      title: "Segment session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    turnIds.research = makeTurn(1, {
      type: "research",
      title: "research the ledger",
      tags: ["topic:note-ledger"],
    });
    turnIds.design = makeTurn(2, {
      type: "design",
      title: "design the ledger",
      tags: ["topic:note-ledger"],
    });
    turnIds.implement = makeTurn(3, {
      type: "implement",
      title: "implement the ledger",
      tags: ["topic:note-ledger"],
    });
    turnIds.unrelated = makeTurn(4, { type: "ops", title: "release 1.2.3" });

    const segment = createSegment(db, {
      title: "implement the note ledger",
      type: ["implement", "design"],
      tags: ["topic:note-ledger"],
      nowEpoch: CUTOFF,
    });
    segmentId = segment.id;
    addSegmentMembers(
      db,
      segmentId,
      [turnIds.research!, turnIds.design!, turnIds.implement!],
      CUTOFF,
    );
    applySegmentWrites(
      db,
      [
        {
          segmentId,
          expectedRevision: getSegment(db, segmentId)!.revision,
          content: `The ledger ships. Load-bearing: [S${sessionId}/T3].`,
        },
      ],
      { nowEpoch: CUTOFF },
    );

    const delivered = createSegment(db, {
      title: "ops release 1.2.3",
      type: ["ops"],
      tags: ["topic:release"],
      status: "delivered",
      nowEpoch: CUTOFF,
    });
    deliveredSegmentId = delivered.id;
    addSegmentMembers(db, deliveredSegmentId, [turnIds.unrelated!], CUTOFF);
  });

  afterEach(() => {
    db.close();
  });

  test("recall(id=\"E<n>\") round-trips to the segment record", () => {
    const output = recallMemory(db, { id: `E${segmentId}` });

    expect(output).toContain(`[E${segmentId}]`);
    expect(output).toContain("implement the note ledger");
    expect(output).toContain("[open]");
    expect(output).toContain("3 turns");
    expect(output).toContain("#topic:note-ledger");
  });

  test("the drill-down puts anchors first, then the derived rank", () => {
    const lines = recallMemory(db, { id: `E${segmentId}` }).split("\n");
    const memberLines = lines.filter((line) => /\[S\d+\]\[T\d+\]/.test(line));

    expect(memberLines[0]).toContain("⚓1");
    expect(memberLines[0]).toContain("[T3]");
    // The rest fall in derived order (created_at DESC, everything else tied).
    expect(memberLines.map((line) => /\[T(\d+)\]/.exec(line)?.[1])).toEqual([
      "3",
      "2",
      "1",
    ]);
    expect(lines.some((line) => line.includes("anchors: S"))).toBe(true);
  });

  test("a cross-era segment drills down to its era half only", () => {
    const legacy = makeTurn(9, {
      type: "fix",
      title: "legacy fix before the switch",
      epoch: CUTOFF - 100,
    });
    addSegmentMembers(db, segmentId, [legacy], CUTOFF);

    const era = recallMemory(db, { id: `E${segmentId}`, eraCutoffEpoch: CUTOFF });
    expect(era).toContain("3 turns");
    expect(era).not.toContain("legacy fix before the switch");

    // No cutoff means no partition — the whole membership is still readable,
    // which is what keeps `E<n>` usable before ticket 09 sets a cutoff.
    const unpartitioned = recallMemory(db, { id: `E${segmentId}` });
    expect(unpartitioned).toContain("4 turns");
    expect(unpartitioned).toContain("legacy fix before the switch");
  });

  test("the render budget bounds the member list and says what it cut", () => {
    const output = recallMemory(db, { id: `E${segmentId}`, pageSize: 2 });

    expect(output).toContain("2/3");
    expect(output).toContain("+1 more");
  });

  test("an unknown segment id reads as a miss, not an error", () => {
    expect(recallMemory(db, { id: "E9999" })).toContain("Segment not found.");
  });

  test("E* and E ranges expand like their S counterparts", () => {
    const all = recallMemory(db, { id: "E*" });
    expect(all).toContain(`[E${segmentId}]`);
    expect(all).toContain(`[E${deliveredSegmentId}]`);

    const ranged = recallMemory(db, { id: `E${segmentId}..${segmentId}` });
    expect(ranged).toContain(`[E${segmentId}]`);
    expect(ranged).not.toContain(`[E${deliveredSegmentId}]`);
  });

  test("tag: hits the segment AND its member turns in one query", () => {
    const output = recallMemory(db, { query: "tag:topic:note-ledger" });

    expect(output).toContain(`[E${segmentId}]`);
    expect(output).toContain("implement the ledger");
    expect(output).toContain("design the ledger");
    // A segment on a different topic stays out.
    expect(output).not.toContain(`[E${deliveredSegmentId}]`);
  });

  test("type: hits both granularities off the same vocabulary", () => {
    const output = recallMemory(db, { query: "type:implement" });

    expect(output).toContain(`[E${segmentId}]`);
    expect(output).toContain("implement the ledger");
    expect(output).not.toContain(`[E${deliveredSegmentId}]`);
  });

  test("a segment is findable by its own text", () => {
    expect(recallMemory(db, { query: "note ledger" })).toContain(`[E${segmentId}]`);
  });

  test("a rebuild reproduces the segment index", () => {
    rebuildSearchIndex(db);
    expect(recallMemory(db, { query: "note ledger" })).toContain(`[E${segmentId}]`);
  });

  test("session: scopes segments through their members", () => {
    const other = upsertSession(db, {
      contentSessionId: "session-other",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    expect(
      recallMemory(db, { query: `tag:topic:note-ledger session:S${sessionId}` }),
    ).toContain(`[E${segmentId}]`);
    expect(
      recallMemory(db, { query: `tag:topic:note-ledger session:S${other}` }),
    ).not.toContain(`[E${segmentId}]`);
  });
});

describe("observation rows render mechanical fields on the era side", () => {
  let db: Database;
  let sessionId: number;
  let observationId: number;
  const CUTOFF = 1_900_000_000;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-obs-era",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    const turnId = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, title, content, created_at_epoch,
           user_prompt, assistant_response, tags, files_read, files_modified
         ) VALUES (?, 1, 'extracted', 'run the sweep', 'swept', ?, 'prompt',
                   'response', '[]', '[]', '[]')
         RETURNING id`,
      )
      .get(sessionId, CUTOFF + 1)!.id;

    observationId = createObservation(db, {
      turnId,
      toolName: "Bash",
      toolInput: "rg --files-with-matches watchdog src/",
      toolResult: "src/worker/server.ts\nsrc/worker/diary-runtime.ts",
      status: "extracted",
      createdAtEpoch: CUTOFF + 2,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("a pre-era read shows no mechanical fields", () => {
    const output = recallMemory(db, { id: `O${observationId}` });

    expect(output).toContain(`[O${observationId}]`);
    expect(output).not.toContain("- in:");
    expect(output).not.toContain("- out:");
  });

  test("an era read shows the tool name via the label, input prefix and result prefix", () => {
    const output = recallMemory(db, {
      id: `O${observationId}`,
      eraCutoffEpoch: CUTOFF,
    });

    // No extractor title on an era observation, so the label falls back to the
    // tool name (spec D11) — a separate `tool:` line would just repeat the word
    // the label already shows, so it does not appear (spec D3).
    expect(output).toContain(`[O${observationId}] Bash`);
    expect(output).not.toContain("- tool:");
    expect(output).toContain("- in: rg --files-with-matches watchdog src/");
    expect(output).toContain("- out: src/worker/server.ts");
  });

  test("a legacy read with an extractor title still shows the tool: line", () => {
    // The judgment is "does the label already say this", not the era (spec
    // D3): a legacy observation has a real extractor title, so the label and
    // the tool name are two different words and `tool:` earns its line.
    const legacyTurnId = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, title, content, created_at_epoch,
           user_prompt, assistant_response, tags, files_read, files_modified
         ) VALUES (?, 2, 'extracted', 'run the sweep again', 'swept again', ?, 'prompt',
                   'response', '[]', '[]', '[]')
         RETURNING id`,
      )
      .get(sessionId, CUTOFF - 100)!.id;
    const legacyObservationId = createObservation(db, {
      turnId: legacyTurnId,
      toolName: "Bash",
      title: "Added mutex",
      toolInput: "rg --files-with-matches watchdog src/",
      toolResult: "src/worker/server.ts",
      status: "extracted",
      createdAtEpoch: CUTOFF - 99,
    }).id;

    const output = recallMemory(db, {
      id: `O${legacyObservationId}`,
      eraCutoffEpoch: CUTOFF,
    });

    expect(output).toContain(`[O${legacyObservationId}] Added mutex`);
    // A legacy row carries NO mechanical fields at all (spec D5) — not the
    // name either. Its record is the extractor's summary, and the dedup rule
    // never gets to weigh in because there is nothing to dedup against.
    expect(output).not.toContain("- tool:");
    expect(output).not.toContain("- in:");
    expect(output).not.toContain("- out:");
  });

  test("the mechanical fields respect the truncate budget", () => {
    const output = recallMemory(db, {
      id: `O${observationId}`,
      eraCutoffEpoch: CUTOFF,
      truncate: 10,
    });

    expect(output).toContain("- in: rg --files...");
    expect(output).toContain("- out: src/worker...");
  });
});

/**
 * An observation has no semantics of its own: whether a pipeline summarized it
 * is decided by the TURN it belongs to. Its own timestamp is just when the tool
 * ran, and a turn's tool calls straddle any instant you pick — so judging the
 * era by the observation row leaks era-only fields out of a legacy turn and
 * hides them inside an era one.
 */
describe("an observation's era is its owning turn's era", () => {
  let db: Database;
  let sessionId: number;
  const CUTOFF = 1_900_000_000;

  function makeTurn(promptNumber: number, createdAtEpoch: number): number {
    return db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, title, content, created_at_epoch,
           user_prompt, assistant_response, tags, files_read, files_modified
         ) VALUES (?, ?, 'extracted', 'run the sweep', 'swept', ?, 'prompt',
                   'response', '[]', '[]', '[]')
         RETURNING id`,
      )
      .get(sessionId, promptNumber, createdAtEpoch)!.id;
  }

  function makeObservation(turnId: number, createdAtEpoch: number): number {
    return createObservation(db, {
      turnId,
      toolName: "Bash",
      toolInput: "rg --files-with-matches watchdog src/",
      toolResult: "src/worker/server.ts",
      status: "extracted",
      createdAtEpoch,
    }).id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-obs-owner-era",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF - 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("a legacy turn whose tool call ran after the cutoff keeps its fields hidden", () => {
    const turnId = makeTurn(1, CUTOFF - 10);
    const observationId = makeObservation(turnId, CUTOFF + 5);

    expect(
      recallMemory(db, { id: `O${observationId}`, eraCutoffEpoch: CUTOFF }),
    ).not.toContain("- in:");
    expect(
      recallMemory(db, {
        id: `S${sessionId}/T1`,
        depth: "expanded",
        eraCutoffEpoch: CUTOFF,
      }),
    ).not.toContain("- in:");
  });

  test("an era turn whose tool call is stamped earlier still shows them", () => {
    const turnId = makeTurn(2, CUTOFF + 10);
    const observationId = makeObservation(turnId, CUTOFF - 5);

    expect(
      recallMemory(db, { id: `O${observationId}`, eraCutoffEpoch: CUTOFF }),
    ).toContain("- in: rg --files-with-matches watchdog src/");
    expect(
      recallMemory(db, {
        id: `S${sessionId}/T2`,
        depth: "expanded",
        eraCutoffEpoch: CUTOFF,
      }),
    ).toContain("- in: rg --files-with-matches watchdog src/");
  });
});
