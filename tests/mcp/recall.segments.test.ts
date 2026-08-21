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

  // ticket 03 reforms the id-addressed segment view (spec "Tools"): the card
  // no longer inlines a ranked member listing (anchors-first/derived-rank was
  // a SELECTION concern for that old listing) — expanded now carries a
  // MEMBER INDEX in EVENT order instead (spec D9 user story 21), and members
  // are read individually through `E<n>/T<m>` ordinal addressing.
  test("the expanded card's member index lists members in event order, not anchor/rank order", () => {
    const lines = recallMemory(db, { id: `E${segmentId}`, page: 2 }).split("\n");
    const indexLines = lines.filter((line) => /^\s*-\s+\d+\.\s+S\d+\/T\d+/.test(line));

    // research(T1) design(T2) implement(T3) were created in that prompt-number
    // order, so event order — despite T3 being the body's cited anchor and
    // therefore the OLD ranking's first slot — is 1,2,3.
    expect(indexLines.map((line) => /T(\d+)/.exec(line)?.[1])).toEqual(["1", "2", "3"]);
  });

  test("E<n>/T<m> addresses a member by its 1-based EVENT-ORDER ordinal, exposing its S/T home address", () => {
    const first = recallMemory(db, { id: `E${segmentId}/T1` });
    const third = recallMemory(db, { id: `E${segmentId}/T3` });

    // Spec 金样例: the member listing splits the `S<n>/T<m>` citation across
    // two rungs — a `[S<n>]` transition line, then bare `[T<m>]` rows.
    expect(first).toContain("research the ledger");
    expect(first).toContain(`[S${sessionId}]`);
    expect(first).toContain("[T1]");
    expect(third).toContain("implement the ledger");
    expect(third).toContain(`[S${sessionId}]`);
    expect(third).toContain("[T3]");
  });

  test("a cross-era segment's member count and member index drill down to its era half only", () => {
    const legacy = makeTurn(9, {
      type: "fix",
      title: "legacy fix before the switch",
      epoch: CUTOFF - 100,
    });
    addSegmentMembers(db, segmentId, [legacy], CUTOFF);

    const era = recallMemory(db, { id: `E${segmentId}`, eraCutoffEpoch: CUTOFF, page: 2 });
    expect(era).toContain("3 turns");
    expect(era).not.toContain("legacy fix before the switch");

    // No cutoff means no partition — the whole membership is still readable,
    // which is what keeps `E<n>` usable before ticket 09 sets a cutoff.
    const unpartitioned = recallMemory(db, { id: `E${segmentId}`, page: 2 });
    expect(unpartitioned).toContain("4 turns");
    expect(unpartitioned).toContain("legacy fix before the switch");
  });

  test("E<n>/T<selector> pagination bounds a large ordinal range with pageSize", () => {
    const output = recallMemory(db, { id: `E${segmentId}/T1..3`, pageSize: 2 });

    expect(output).toContain("page 1 / 2 (total 3)");
    expect(output).toContain("research the ledger");
    expect(output).toContain("design the ledger");
    expect(output).not.toContain("implement the ledger");
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

  // Ticket 04: `tag:`/`type:`/`session:` move from in-query prefixes to the
  // structured `filter` object; `query` becomes pure FTS text.
  test("filter.tag hits the segment AND its member turns in one call", () => {
    const output = recallMemory(db, { filter: { tag: "note-ledger" } });

    expect(output).toContain(`[E${segmentId}]`);
    expect(output).toContain("implement the ledger");
    expect(output).toContain("design the ledger");
    // A segment on a different topic stays out.
    expect(output).not.toContain(`[E${deliveredSegmentId}]`);
  });

  test("filter.type hits both granularities off the same vocabulary", () => {
    const output = recallMemory(db, { filter: { type: "implement" } });

    expect(output).toContain(`[E${segmentId}]`);
    expect(output).toContain("implement the ledger");
    expect(output).not.toContain(`[E${deliveredSegmentId}]`);
  });

  test("a segment is findable by its own text", () => {
    expect(recallMemory(db, { query: "note ledger" })).toContain(`[E${segmentId}]`);
  });

  // Ticket 04, acceptance criterion 4: segment field ROWS (not just the
  // title) remain first-class FTS hits under the purified query — a plain
  // text query with NO filter at all must still surface a segment matched on
  // its `content` field body.
  test("a segment's content field row is a first-class FTS hit under a purified query", () => {
    const output = recallMemory(db, { query: "Load-bearing" });

    expect(output).toContain(`[E${segmentId}]`);
    expect(output).not.toContain(`[E${deliveredSegmentId}]`);
  });

  test("a rebuild reproduces the segment index", () => {
    rebuildSearchIndex(db);
    expect(recallMemory(db, { query: "note ledger" })).toContain(`[E${segmentId}]`);
  });

  test("filter.session scopes segments through their members", () => {
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
      recallMemory(db, {
        filter: { tag: "note-ledger", session: `S${sessionId}` },
      }),
    ).toContain(`[E${segmentId}]`);
    expect(
      recallMemory(db, { filter: { tag: "note-ledger", session: `S${other}` } }),
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
    const output = recallMemory(db, { id: `E${cardSegmentId}`, page: 2 });

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
    const output = recallMemory(db, { id: `E${harnessSegmentId}`, page: 2 });

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
    const cardHits = recallMemory(db, { filter: { tag: "card-extraction" } });
    expect(cardHits).toContain(`[E${cardSegmentId}]`);
    expect(cardHits).toContain("CARD_MARKER_9f2a");
    expect(cardHits).not.toContain(`[E${harnessSegmentId}]`);
    expect(cardHits).not.toContain("HARNESS_MARKER_7c31");
    expect(cardHits).not.toContain("harness retry queue");

    const harnessHits = recallMemory(db, { filter: { tag: "harness-retry" } });
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

  // Ticket 11: the char `truncate` budget (and the header/line char caps it
  // fed) retired outright — an observation is now capped ONLY by the `turn`
  // token budget (spec: "obs 恒截断，由 turn 预算驱动"), applied to the
  // WHOLE rendered block (label + tool line + body), word-boundary, exactly
  // like every other node kind.
  test("the projected call respects the turn token budget", () => {
    const fullOutput = recallMemory(db, {
      id: `O${observationId}`,
      eraCutoffEpoch: CUTOFF,
      turn: 1000,
    });
    const tightOutput = recallMemory(db, {
      id: `O${observationId}`,
      eraCutoffEpoch: CUTOFF,
      turn: 12,
    });

    // The label — the only thing identifying which observation this is —
    // survives even a budget too small for it, WHOLE (never itself cut).
    expect(tightOutput).toContain(
      `[O${observationId}] Bash(rg --files-with-matches watchdog src/)`,
    );
    // A bigger budget shows strictly more of the same content — the second
    // stdout line only survives when there is room for it.
    expect(fullOutput).toContain("src/worker/server.ts");
    expect(fullOutput).toContain("src/worker/diary-runtime.ts");
    expect(tightOutput).not.toContain("diary-runtime.ts");
    // Ticket 01 (render-boilerplate-trim spec): the marker shrank to a bare
    // `…` line — check it as its OWN line, not a substring, since the cut
    // line just above it can independently end in the same character via
    // `truncateTextToTokenBudget`'s inline word-boundary cut.
    expect(tightOutput.split("\n").some((line) => line.trim() === "…")).toBe(true);
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
        filter: { fields: ["title", "content", "observations"] },
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
        filter: { fields: ["title", "content", "observations"] },
        eraCutoffEpoch: CUTOFF,
      }),
    ).toContain("Bash(rg --files-with-matches watchdog src/)");
  });
});
