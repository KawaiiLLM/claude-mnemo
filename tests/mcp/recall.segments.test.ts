import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
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
import { recallMemory, recallMemoryDelivery } from "../../src/mcp/recall";
import { renderSegmentMembersByOrdinal } from "../../src/mcp/segment-card";
import { WORKER_TOOL_RESULT_CONTENT_LIMIT } from "../../src/mcp/tool-envelope";

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
  // are read individually through their ordinary `S<session>/T<prompt>`
  // address, scoped by `E<n>/` in front (ticket 10, one-address-grammar spec
  // — retires this route's earlier `E<n>/T<m>` event-order ordinal).
  test("the expanded card's member index lists members in event order, not anchor/rank order", () => {
    const lines = recallMemory(db, { id: `E${segmentId}`, page: 2 }).split("\n");
    const indexLines = lines.filter((line) => /^\s*-\s+\d+\.\s+S\d+\/T\d+/.test(line));

    // research(T1) design(T2) implement(T3) were created in that prompt-number
    // order, so event order — despite T3 being the body's cited anchor and
    // therefore the OLD ranking's first slot — is 1,2,3.
    expect(indexLines.map((line) => /T(\d+)/.exec(line)?.[1])).toEqual(["1", "2", "3"]);
  });

  // Ticket 10 (one-address-grammar spec): `E<n>/S<a>/T<b>` addresses one
  // segment member by its ordinary, ordinary-anywhere-else S/T address.
  test("E<n>/S<a>/T<b> addresses one segment member by its ordinary S/T address", () => {
    const first = recallMemory(db, { id: `E${segmentId}/S${sessionId}/T1` });
    const third = recallMemory(db, { id: `E${segmentId}/S${sessionId}/T3` });

    // Spec 金样例: the member listing splits the `S<n>/T<m>` citation across
    // two rungs — an `S<n>` transition line, then bare `T<m>` rows
    // (ticket 11, USER RULING S15069/T2016: unbracketed).
    expect(first).toContain("research the ledger");
    expect(first).toContain(`S${sessionId}`);
    expect(first).toContain("T1 ");
    expect(third).toContain("implement the ledger");
    expect(third).toContain(`S${sessionId}`);
    expect(third).toContain("T3 ");
  });

  test("the retired E<n>/T<m> ordinal form refuses, naming the new grammar — never a silent reinterpretation", () => {
    const single = recallMemory(db, { id: `E${segmentId}/T1` });
    expect(single).not.toContain("research the ledger");
    expect(single).toContain("retired");
    expect(single).toContain(`E${segmentId}/S<session>/T<prompt>`);

    const range = recallMemory(db, { id: `E${segmentId}/T1..3` });
    expect(range).not.toContain("research the ledger");
    expect(range).toContain("retired");
    // `E<n>/T*` (every member) is unaffected — no ordinal is named.
    const wildcard = recallMemory(db, { id: `E${segmentId}/T*` });
    expect(wildcard).toContain("research the ledger");
    expect(wildcard).not.toContain("retired");
  });

  test("an E<n>/S<a>/T<b> endpoint that is not a member of the segment refuses, naming it", () => {
    // Exists in the DB, and in the same session, but never joined via
    // `addSegmentMembers` — a real turn, just not this segment's own.
    makeTurn(50, { title: "never joined the segment" });

    const output = recallMemory(db, { id: `E${segmentId}/S${sessionId}/T50` });
    expect(output).toContain(`S${sessionId}/T50`);
    expect(output).toContain("not a member");
    // A range whose SECOND endpoint is the non-member also refuses, naming
    // that endpoint specifically (not the valid first one).
    const rangeOutput = recallMemory(db, {
      id: `E${segmentId}/S${sessionId}/T1..S${sessionId}/T50`,
    });
    expect(rangeOutput).toContain(`S${sessionId}/T50`);
    expect(rangeOutput).toContain("not a member");
  });

  // Ticket 10: the range endpoints need not share a session — the range
  // runs over the SEGMENT's own event order between them, so a session
  // whose only member sits strictly between the two endpoints' event-order
  // positions is pulled in too, and the render's leading-prefix rule prints
  // a full address again the moment the run crosses into a new session.
  test("a cross-session E<n>/S<a>/T<b>..S<c>/T<d> range spans event order regardless of session, and the render re-addresses on the session switch", () => {
    const otherSessionId = upsertSession(db, {
      contentSessionId: "session-recall-segments-other",
      project: "/tmp/project",
      title: "Other session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF + 1, // between design(T2) and implement(T3) in event order
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const bridgeTurnId = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, type, title, tags, created_at_epoch,
           user_prompt, assistant_response, content, files_read, files_modified
         ) VALUES (?, 1, 'extracted', '["implement"]', 'bridge turn in the other session', '[]', ?,
                   'user prompt text', 'assistant response text', 'turn body', '[]', '[]')
         RETURNING id`,
      )
      .get(otherSessionId, CUTOFF + 2)!.id;
    reindexTurnFromDb(db, bridgeTurnId);
    addSegmentMembers(db, segmentId, [bridgeTurnId], CUTOFF);

    // Event order is now: research(S<sessionId>/T1), design(S<sessionId>/T2),
    // bridge(S<otherSessionId>/T1), implement(S<sessionId>/T3).
    const output = recallMemory(db, {
      id: `E${segmentId}/S${sessionId}/T1..S${sessionId}/T3`,
    });
    expect(output).toContain("research the ledger");
    expect(output).toContain("design the ledger");
    expect(output).toContain("bridge turn in the other session");
    expect(output).toContain("implement the ledger");
    // The leading-prefix rule: the run opens in sessionId (full address on
    // its first row), then switches to otherSessionId for the bridge turn
    // (full address again), then switches BACK to sessionId for implement
    // (full address a third time) — every session entry/re-entry gets one.
    expect(output).toContain(`S${sessionId}`);
    expect(output).toContain(`S${otherSessionId}`);
  });

  // Judgment call (not pinned by the ticket text, flagged in the report): a
  // range whose two endpoints are given in the OPPOSITE of event order still
  // resolves to the same span — min/max of the two ordinals, symmetric —
  // mirroring `expandNumericSelector`'s own existing range convention rather
  // than rejecting a "backwards" pasting order.
  test("a range named end-before-start still resolves to the same span (symmetric, not directional)", () => {
    const forward = recallMemory(db, { id: `E${segmentId}/S${sessionId}/T1..S${sessionId}/T3` });
    const backward = recallMemory(db, { id: `E${segmentId}/S${sessionId}/T3..S${sessionId}/T1` });
    expect(backward).toBe(forward);
    expect(backward).toContain("research the ledger");
    expect(backward).toContain("implement the ledger");
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

  test("an E<n>/S<a>/T<b>..S<c>/T<d> range within one session paginates with pageSize", () => {
    const output = recallMemory(db, {
      id: `E${segmentId}/S${sessionId}/T1..S${sessionId}/T3`,
      pageSize: 2,
    });

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

/**
 * Container-unification ticket 03 (spec D2): `E<n>/#<tag>` — a lane
 * addressed by NAME, the CANONICAL, pasteable lane address. Own fixture
 * (rather than folding into the first describe above) because declaring a
 * lane requires a tag word that is not ALREADY claimed as a segment's own
 * name — `insertLane` throws on that collision (db/lanes.ts's namespace
 * invariant) — and the first fixture's turns already carry their segment's
 * own tag ("note-ledger"/"release").
 */
describe("lane addressing E<n>/#<tag> (container-unification ticket 03, spec D2)", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;
  const CUTOFF = 1_950_000_000;
  const turnIds: Record<string, number> = {};

  function makeTurn(promptNumber: number, options: { title?: string; tags?: string[] } = {}): number {
    const id = db
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, title, tags, created_at_epoch,
           user_prompt, assistant_response, content, files_read, files_modified
         ) VALUES (?, ?, 'extracted', ?, ?, ?, 'user prompt text',
                   'assistant response text', 'turn body', '[]', '[]')
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.title ?? `title ${promptNumber}`,
        JSON.stringify(options.tags ?? []),
        CUTOFF + promptNumber,
      )!.id;
    reindexTurnFromDb(db, id);
    return id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-recall-lane-address",
      project: "/tmp/project-lane-address",
      title: "Lane address session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    turnIds.inLane = makeTurn(1, { title: "declares the write gate", tags: ["write-gate"] });
    turnIds.alsoInLane = makeTurn(2, { title: "closes the write gate", tags: ["write-gate"] });
    turnIds.notInLane = makeTurn(3, { title: "an unrelated turn", tags: [] });

    segmentId = createSegment(db, { title: "write gate work", nowEpoch: CUTOFF }).id;
    addSegmentMembers(
      db,
      segmentId,
      [turnIds.inLane!, turnIds.alsoInLane!, turnIds.notInLane!],
      CUTOFF,
    );
    insertLane(db, segmentId, "write-gate", CUTOFF);
  });

  afterEach(() => {
    db.close();
  });

  test('recall(id="E<n>/#<tag>") renders exactly this lane\'s member turns, never a non-member', () => {
    const body = recallMemory(db, { id: `E${segmentId}/#write-gate` });
    expect(body).toContain("declares the write gate");
    expect(body).toContain("closes the write gate");
    expect(body).not.toContain("an unrelated turn");
  });

  test("does not conflict with the bare E<n> segment route", () => {
    const body = recallMemory(db, { id: `E${segmentId}` });
    expect(body).toContain(`E${segmentId}`);
    expect(body).not.toContain("Lane not found");
  });

  test("an undeclared but canonical tag reads as a named miss, not a silent empty page", () => {
    const body = recallMemory(db, { id: `E${segmentId}/#no-such-lane` });
    expect(body).toContain("Lane not found");
    expect(body).toContain(`E${segmentId}/#no-such-lane`);
  });

  // The empty-tag checkbox (spec D2, ticket 03): `E<n>/#` refuses and NAMES
  // the problem, reusing `checkCanonicalLaneTag` rather than a second
  // predicate — this is the SAME "empty" message `declare`/`retag` refuse a
  // bare "" tag with (tests/db/lanes.test.ts pins the predicate itself).
  test('an empty tag ("E<n>/#") refuses and names the problem', () => {
    const body = recallMemory(db, { id: `E${segmentId}/#` });
    expect(body).toContain("Parameter error");
    expect(body).toContain("must not be empty");
  });

  test("a non-canonical tag (mixed case) refuses and names the exact problem", () => {
    const body = recallMemory(db, { id: `E${segmentId}/#Write-Gate` });
    expect(body).toContain("Parameter error");
    expect(body).toContain("is not lowercase");
  });

  // A selector separator inside a tag can never reach the lane-address check
  // as ONE string — `recall`'s own comma split (ticket 14) breaks it apart
  // first, exactly the failure ticket 01 closed the charset for. This pins
  // that the split half still names a problem rather than silently routing
  // to an unrelated kind.
  test("a tag containing a comma splits before it reaches the lane check, and the split half still refuses", () => {
    const body = recallMemory(db, { id: `E${segmentId}/#write,gate` });
    expect(body).toContain("Parameter error");
    expect(body).toContain('invalid id selector "gate"');
  });

  test("a comma list of two lane addresses in the same segment renders both — same kind", () => {
    const other = makeTurn(4, { title: "a second lane's own turn", tags: ["also-write-gate"] });
    addSegmentMembers(db, segmentId, [other], CUTOFF);
    insertLane(db, segmentId, "also-write-gate", CUTOFF);

    const body = recallMemory(db, {
      id: `E${segmentId}/#write-gate, E${segmentId}/#also-write-gate`,
    });
    expect(body).toContain("declares the write gate");
    expect(body).toContain("a second lane's own turn");
  });

  test("mixing a lane address with a different kind in a comma list rejects, naming mixed kinds", () => {
    const body = recallMemory(db, { id: `E${segmentId}/#write-gate, E${segmentId}` });
    expect(body).toContain("mixed id kinds");
  });

  /**
   * PHASE-CONNECTIVITY TICKET 07 — the lane read receipt records what the
   * RENDERER emitted, per lane, and nothing at all when the delivery would be
   * cut. Ticket 05 wrote the receipt BEFORE the render ran, out of its own
   * copy of the page arithmetic; the ninth peer round found three defects in
   * that arrangement and these are the ones observable from this surface.
   */
  describe("lane read receipts (phase-connectivity ticket 07)", () => {
    const READER = "claim:707:1";

    interface ReceiptRow {
      laneTag: string;
      rendered: string;
    }

    function receipts(): ReceiptRow[] {
      return db
        .query<ReceiptRow, [string]>(
          `SELECT lane_tag AS laneTag, rendered_member_ids AS rendered
             FROM lane_read_receipts WHERE reader_id = ? ORDER BY lane_tag`,
        )
        .all(READER);
    }

    /**
     * Decision 2, at the seam the collector lives on: the renderer is handed
     * THREE ordinals and emits TWO blocks (ordinal 99 resolves to no member),
     * and only the two emitted ids land in the collector the receipt is
     * written from. A receipt derived from the caller's own selection — what
     * ticket 05 shipped — would have credited all three.
     */
    test("the render collector records the members it EMITTED, not the ordinals it was asked for", () => {
      const emitted: number[] = [];
      const body = renderSegmentMembersByOrdinal(db, segmentId, [1, 2, 99], {
        emittedTurnIds: emitted,
      });
      expect(body).toContain("declares the write gate");
      expect(body).toContain("closes the write gate");
      expect(emitted).toEqual([turnIds.inLane!, turnIds.alsoInLane!]);
    });

    /** Decision 5: the comma-list branch used to render both lanes and credit neither. */
    test('recall(id="E<n>/#a,E<n>/#b") records a receipt for EACH lane, naming that lane\'s own rendered members', () => {
      const other = makeTurn(4, { title: "a second lane's own turn", tags: ["also-write-gate"] });
      addSegmentMembers(db, segmentId, [other], CUTOFF);
      insertLane(db, segmentId, "also-write-gate", CUTOFF);

      recallMemory(db, {
        id: `E${segmentId}/#write-gate, E${segmentId}/#also-write-gate`,
        readerId: READER,
        now: () => CUTOFF,
      });

      const rows = receipts();
      expect(rows.map((row) => row.laneTag)).toEqual(["also-write-gate", "write-gate"]);
      expect(JSON.parse(rows[1]!.rendered)).toEqual([turnIds.inLane!, turnIds.alsoInLane!]);
      expect(JSON.parse(rows[0]!.rendered)).toEqual([other]);
    });

    /**
     * Decision 3, re-seated by TICKET 08 decision 6. A page the envelope would
     * cut still credits NOTHING — not a partial receipt, not a receipt for the
     * members that happened to fit — but the decision is no longer made inside
     * the lane route against a constant. The receipt is a PENDING delivery
     * fact now, committed by the same `endOffset > deliveredChars` comparison
     * the ledger already applies to read grants, so it is the CALLER's own
     * envelope that decides. That is why this is driven through
     * `recallMemoryDelivery` rather than `recallMemory`: the latter is the
     * main agent's uncut audience, which delivers every character and
     * therefore credits everything — the old in-route guard refused it a
     * receipt it had never truncated. The worker's real envelope is pinned
     * end-to-end at the settlement seam
     * (`tests/worker/note-settlement-sdk-query.test.ts`).
     */
    test("a lane page the caller's envelope cut writes NO receipt at all", () => {
      // Six members at the public per-item ceiling (`MAX_TURN_BUDGET` = 5000
      // tokens, ~20K characters each) overflow the 100K envelope on one page.
      for (let promptNumber = 10; promptNumber < 16; promptNumber += 1) {
        const bulky = makeTurn(promptNumber, { tags: ["write-gate"] });
        db.query<unknown, [string, number]>("UPDATE turns SET content = ? WHERE id = ?").run(
          "sentence ".repeat(6_000),
          bulky,
        );
        addSegmentMembers(db, segmentId, [bulky], CUTOFF);
      }

      const cut = recallMemoryDelivery(db, {
        id: `E${segmentId}/#write-gate`,
        turn: 5_000,
        readerId: READER,
        now: () => CUTOFF,
      });
      expect(cut.text.length).toBeGreaterThan(WORKER_TOOL_RESULT_CONTENT_LIMIT);
      // Exactly what `mcp/handlers.ts` tells the ledger when it slices.
      cut.commitDelivered(WORKER_TOOL_RESULT_CONTENT_LIMIT);
      expect(receipts()).toEqual([]);

      // …and the SAME lane, paged small enough to be delivered whole, does
      // credit the members it showed — so the emptiness above is the cut
      // speaking, not the receipt path having gone silent.
      const small = recallMemoryDelivery(db, {
        id: `E${segmentId}/#write-gate`,
        page: 1,
        pageSize: 2,
        turn: 5_000,
        readerId: READER,
        now: () => CUTOFF,
      });
      expect(small.text.length).toBeLessThan(WORKER_TOOL_RESULT_CONTENT_LIMIT);
      small.commitDelivered(small.text.length);
      expect(JSON.parse(receipts()[0]!.rendered)).toEqual([
        turnIds.inLane!,
        turnIds.alsoInLane!,
      ]);
    });
  });

  /**
   * PHASE-CONNECTIVITY TICKET 08 — the three receipt defects the tenth peer
   * round found, all reachable from this surface.
   */
  describe("lane read receipts (phase-connectivity ticket 08)", () => {
    const READER = "claim:808:1";

    function receipts(): Array<{ laneTag: string; rendered: string }> {
      return db
        .query<{ laneTag: string; rendered: string }, [string]>(
          `SELECT lane_tag AS laneTag, rendered_member_ids AS rendered
             FROM lane_read_receipts WHERE reader_id = ? ORDER BY lane_tag`,
        )
        .all(READER);
    }

    /**
     * DECISION 5, the sentinel half. The lane route paginates its ordinals
     * with plain `paginateItems`, which does not clamp, so an out-of-range
     * page hands the member renderer an EMPTY ordinal list — and an empty
     * list used to mean "every member". A page past the end of a two-member
     * lane therefore rendered the whole TASK, the unrelated turn included.
     */
    test("an out-of-range lane page renders nothing, never the task's other members", () => {
      const body = recallMemory(db, {
        id: `E${segmentId}/#write-gate`,
        page: 99,
        pageSize: 2,
        readerId: READER,
        now: () => CUTOFF,
      });
      expect(body).not.toContain("an unrelated turn");
      expect(body).not.toContain("declares the write gate");
    });

    /**
     * DECISION 5, the receipt half. `hasAnyLaneReadReceipt` asks only whether
     * a row exists, so a page that showed the reader nothing at all used to
     * buy the "this run has recalled the lane" floor outright.
     */
    test("a lane page that emitted no member of the lane records NO receipt", () => {
      recallMemory(db, {
        id: `E${segmentId}/#write-gate`,
        page: 99,
        pageSize: 2,
        readerId: READER,
        now: () => CUTOFF,
      });
      expect(receipts()).toEqual([]);

      // The same lane, on a page that does emit members, still credits them —
      // the emptiness above is the empty page speaking.
      recallMemory(db, {
        id: `E${segmentId}/#write-gate`,
        readerId: READER,
        now: () => CUTOFF,
      });
      expect(receipts()).toHaveLength(1);
    });

    /**
     * DECISION 6. Receipts used to be written EAGERLY inside
     * `recallMemoryBody`, while every other authorization fact waited on the
     * delivery ledger — so in a comma list the first item's receipt survived a
     * later item's throw, crediting a lane whose response never reached the
     * reader at all. Nothing is written before `commitDelivered` now, and a
     * throw never reaches it.
     */
    test("a comma-list recall whose later item throws leaves NO receipt from its earlier items", () => {
      const other = makeTurn(4, { title: "a second lane's own turn", tags: ["also-write-gate"] });
      addSegmentMembers(db, segmentId, [other], CUTOFF);
      insertLane(db, segmentId, "also-write-gate", CUTOFF);
      // `files_read` carries no CHECK, and `db/turns.ts`'s row mapper
      // JSON.parses it — so the SECOND lane's own member is the one that
      // explodes, after the first lane has already rendered.
      db.query<unknown, [number]>("UPDATE turns SET files_read = 'not json' WHERE id = ?").run(
        other,
      );

      expect(() =>
        recallMemory(db, {
          id: `E${segmentId}/#write-gate, E${segmentId}/#also-write-gate`,
          readerId: READER,
          now: () => CUTOFF,
        }),
      ).toThrow();
      expect(receipts()).toEqual([]);
    });
  });
});
