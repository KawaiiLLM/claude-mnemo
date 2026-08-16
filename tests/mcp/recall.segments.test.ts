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
      .query<{ id: number }, [number, number, string, string, string, number]>(
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
        options.type ? JSON.stringify([options.type]) : "[]",
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
      tags: ["note-ledger"],
    });
    turnIds.design = makeTurn(2, {
      type: "design",
      title: "design the ledger",
      tags: ["note-ledger"],
    });
    turnIds.implement = makeTurn(3, {
      type: "implement",
      title: "implement the ledger",
      tags: ["note-ledger"],
    });
    turnIds.unrelated = makeTurn(4, {
      type: "ops",
      title: "release 1.2.3",
      tags: ["release"],
    });

    const segment = createSegment(db, {
      title: "implement the note ledger",
      type: ["implement", "design"],
      tags: ["note-ledger"],
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
      tags: ["release"],
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
    expect(output).toContain("#note-ledger");
  });

  test("a segment's insight reaches the reader — the field exists for the agent checking \"did we already rule this out\" (ticket 14, spec K5)", () => {
    applySegmentWrites(
      db,
      [
        {
          segmentId,
          expectedRevision: getSegment(db, segmentId)!.revision,
          insight: "the per-turn ledger route was ruled out: it re-reads on every write",
        },
      ],
      { nowEpoch: CUTOFF },
    );

    expect(recallMemory(db, { id: `E${segmentId}` })).toContain(
      "insight: the per-turn ledger route was ruled out",
    );
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
    const output = recallMemory(db, { query: "tag:note-ledger" });

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
      recallMemory(db, { query: `tag:note-ledger session:S${sessionId}` }),
    ).toContain(`[E${segmentId}]`);
    expect(
      recallMemory(db, { query: `tag:note-ledger session:S${other}` }),
    ).not.toContain(`[E${segmentId}]`);
  });
});

/**
 * Ticket 14's acceptance test (spec K8a), stated in the ticket itself:
 * "recalling one task must not drag another task's memory along with it."
 * K8a names `action-roleplay`'s card-extraction and harness lines — two
 * threads of work interleaved turn-by-turn in one session — as the real
 * shape this has to survive, and notes it has zero segments today so the
 * check has to be built rather than found. This constructs that shape: two
 * segments over ONE session whose member turns alternate 1-2-1-2-1-2, one
 * `delivered`, one `open` (K4).
 *
 * Every assertion below is an ABSENCE check against a marker string unique
 * to the other task, not just a presence check on the right one — a
 * implementation that (for instance) forgot to scope member lookup by
 * `segment_id` and rendered the whole session's turns would still pass every
 * "contains" assertion the collapsed test above makes; it would only fail
 * here.
 */
describe("acceptance: recalling one task does not drag another task's memory along (spec K8a)", () => {
  let db: Database;
  let sessionId: number;
  let cardSegmentId: number;
  let harnessSegmentId: number;
  const CUTOFF = 1_900_200_000;

  function makeTurn(promptNumber: number, title: string, tags: string[]): number {
    const id = db
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, title, tags, created_at_epoch,
           user_prompt, assistant_response, content, files_read, files_modified
         ) VALUES (?, ?, 'extracted', ?, ?, ?, 'user prompt text',
                   'assistant response text', 'turn body', '[]', '[]')
         RETURNING id`,
      )
      .get(sessionId, promptNumber, title, JSON.stringify(tags), CUTOFF + promptNumber)!
      .id;
    reindexTurnFromDb(db, id);
    return id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-interleaved-tasks",
      project: "/tmp/project",
      title: "Two interleaved workstreams",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    // T1/T3/T5 = card-extraction line, T2/T4/T6 = harness-retry line,
    // interleaved in the SAME session the way action-roleplay's threads do.
    const card1 = makeTurn(1, "extract card ruleset from bundle", ["card-extraction"]);
    const harness1 = makeTurn(2, "retry queue backoff timer", ["harness-retry"]);
    const card2 = makeTurn(3, "card schema validated against golden set", ["card-extraction"]);
    const harness2 = makeTurn(4, "harness retry queue drains under load", ["harness-retry"]);
    const card3 = makeTurn(5, "card extraction ships in 0.9.1", ["card-extraction"]);
    const harness3 = makeTurn(6, "harness retry queue ships in 0.9.2", ["harness-retry"]);

    const cardSegment = createSegment(db, {
      title: "card extraction ruleset",
      content: "CARD_MARKER_9f2a ships the ruleset end to end.",
      type: ["implement"],
      tags: ["card-extraction"],
      status: "delivered",
      nowEpoch: CUTOFF,
    });
    cardSegmentId = cardSegment.id;
    addSegmentMembers(db, cardSegmentId, [card1, card2, card3], CUTOFF);

    const harnessSegment = createSegment(db, {
      title: "harness retry queue",
      content: "HARNESS_MARKER_7c31 still draining under load.",
      type: ["implement"],
      tags: ["harness-retry"],
      status: "open",
      nowEpoch: CUTOFF,
    });
    harnessSegmentId = harnessSegment.id;
    addSegmentMembers(db, harnessSegmentId, [harness1, harness2, harness3], CUTOFF);
  });

  afterEach(() => {
    db.close();
  });

  test("drilling into the card segment never surfaces the harness line", () => {
    const output = recallMemory(db, { id: `E${cardSegmentId}`, depth: "expanded" });

    expect(output).toContain("CARD_MARKER_9f2a");
    expect(output).toContain("extract card ruleset from bundle");
    expect(output).toContain("card schema validated against golden set");
    expect(output).toContain("card extraction ships in 0.9.1");

    expect(output).not.toContain("HARNESS_MARKER_7c31");
    expect(output).not.toContain("harness retry queue");
    expect(output).not.toContain("retry queue backoff timer");
    expect(output).not.toContain("harness retry queue drains under load");
    expect(output).not.toContain("harness retry queue ships in 0.9.2");
  });

  test("drilling into the harness segment never surfaces the card line", () => {
    const output = recallMemory(db, { id: `E${harnessSegmentId}`, depth: "expanded" });

    expect(output).toContain("HARNESS_MARKER_7c31");
    expect(output).toContain("retry queue backoff timer");
    expect(output).toContain("harness retry queue drains under load");
    expect(output).toContain("harness retry queue ships in 0.9.2");

    expect(output).not.toContain("CARD_MARKER_9f2a");
    expect(output).not.toContain("card extraction ruleset");
    expect(output).not.toContain("extract card ruleset from bundle");
    expect(output).not.toContain("card schema validated against golden set");
    expect(output).not.toContain("card extraction ships in 0.9.1");
  });

  test("searching one task's tag returns only its own segment, never the other's", () => {
    const cardHits = recallMemory(db, { query: "tag:card-extraction" });
    expect(cardHits).toContain(`[E${cardSegmentId}]`);
    expect(cardHits).toContain("CARD_MARKER_9f2a");
    expect(cardHits).not.toContain(`[E${harnessSegmentId}]`);
    expect(cardHits).not.toContain("HARNESS_MARKER_7c31");
    expect(cardHits).not.toContain("harness retry queue");

    const harnessHits = recallMemory(db, { query: "tag:harness-retry" });
    expect(harnessHits).toContain(`[E${harnessSegmentId}]`);
    expect(harnessHits).toContain("HARNESS_MARKER_7c31");
    expect(harnessHits).not.toContain(`[E${cardSegmentId}]`);
    expect(harnessHits).not.toContain("CARD_MARKER_9f2a");
    expect(harnessHits).not.toContain("card extraction ruleset");
  });

  // Requirement 2: an open segment (live working state) and a delivered one
  // (settled impression, spec K4) must read as distinguishable on sight, not
  // just by chance content. Both share the exact same field shape, so the
  // only structural signal is the status tag itself.
  test("an open segment and a delivered one carry distinguishable status tags", () => {
    const delivered = recallMemory(db, { id: `E${cardSegmentId}` });
    const open = recallMemory(db, { id: `E${harnessSegmentId}` });

    expect(delivered).toContain("[delivered]");
    expect(delivered).not.toContain("[open]");
    expect(open).toContain("[open]");
    expect(open).not.toContain("[delivered]");
  });
});

const SWEEP_INPUT = JSON.stringify({
  command: "rg --files-with-matches watchdog src/",
});
const SWEEP_RESULT = JSON.stringify({
  stdout: "src/worker/server.ts\nsrc/worker/diary-runtime.ts",
  stderr: "",
  interrupted: false,
});

describe("observation rows render the call they were, on the era side", () => {
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
      toolInput: SWEEP_INPUT,
      toolResult: SWEEP_RESULT,
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
    expect(output).not.toContain("rg --files-with-matches");
    expect(output).not.toContain("src/worker/server.ts");
  });

  test("an era read shows the command and its output, never the stored JSON", () => {
    const output = recallMemory(db, {
      id: `O${observationId}`,
      eraCutoffEpoch: CUTOFF,
    });

    // No extractor title on an era observation, so the label is the tool name
    // (spec D11) and the projected header takes its place — a separate `tool:`
    // line would just repeat the word the label already shows (spec D3).
    expect(output).toContain(
      `[O${observationId}] Bash(rg --files-with-matches watchdog src/)`,
    );
    expect(output).not.toContain("- tool:");
    expect(output).toContain("    src/worker/server.ts");
    expect(output).toContain("    src/worker/diary-runtime.ts");
    // The stored payload's structure never reaches the reader.
    expect(output).not.toContain('"stdout"');
    expect(output).not.toContain("interrupted");
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
    // name either. Its record is the extractor's summary, and neither the
    // dedup rule nor the projection ever gets to weigh in, because there is
    // nothing for either to work from.
    expect(output).not.toContain("- tool:");
    expect(output).not.toContain("Bash(");
    expect(output).not.toContain("rg --files-with-matches");
  });

  test("the projected call respects the truncate budget", () => {
    const output = recallMemory(db, {
      id: `O${observationId}`,
      eraCutoffEpoch: CUTOFF,
      truncate: 10,
    });

    // The header spends its budget on the argument and keeps the tool name
    // whole, so the whole call line fits the ten characters it was given; the
    // body is cut by whole lines, and the one line it keeps by its own cap.
    expect(output).toContain(`[O${observationId}] Bash(rg …)`);
    expect(output).toContain("    src/worker…");
    expect(output).toContain("    … +1 lines");
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
      toolInput: SWEEP_INPUT,
      toolResult: SWEEP_RESULT,
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
    ).not.toContain("Bash(");
    expect(
      recallMemory(db, {
        id: `S${sessionId}/T1`,
        depth: "expanded",
        eraCutoffEpoch: CUTOFF,
      }),
    ).not.toContain("Bash(");
  });

  test("an era turn whose tool call is stamped earlier still shows them", () => {
    const turnId = makeTurn(2, CUTOFF + 10);
    const observationId = makeObservation(turnId, CUTOFF - 5);

    expect(
      recallMemory(db, { id: `O${observationId}`, eraCutoffEpoch: CUTOFF }),
    ).toContain("Bash(rg --files-with-matches watchdog src/)");
    expect(
      recallMemory(db, {
        id: `S${sessionId}/T2`,
        depth: "expanded",
        eraCutoffEpoch: CUTOFF,
      }),
    ).toContain("Bash(rg --files-with-matches watchdog src/)");
  });
});
