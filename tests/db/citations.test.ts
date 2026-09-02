import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import {
  attachTurnRelations,
  getEffectiveCitations,
  getSessionCitationInDegree,
  getSessionEffectiveCitations,
  getTurnCitations,
  parseInlineCitations,
  recomputeTurnCitedPairs,
  retractTurnRelations,
  type RecomputeTurnCitedPairsFields as RecomputeFields,
  type RelationTargetEntry,
} from "../../src/db/citations";
import { createDatabase } from "../../src/db/database";
import {
  getEdgeInDegree,
  getOutgoingEdges,
  writeMemoryEdges,
} from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, promoteTurnFromNote } from "../../src/db/turns";

describe("inline citation grammar", () => {
  // Each fixture asserts the EXACT expanded DB-id array — the grammar's whole
  // job is turning prose into ids, so "parsed something" is not an assertion.
  const positives: Array<[string, string, number[]]> = [
    ["single", "settled the axis [T8501] after review", [8501]],
    ["comma list, spaced", "[T8075, T9824]", [8075, 9824]],
    ["comma list, unspaced", "[T8075,T9824]", [8075, 9824]],
    ["comma list, ragged spacing", "[T1 ,  T2,T3]", [1, 2, 3]],
    ["comma list, three ids", "[T11, T12, T13]", [11, 12, 13]],
    ["range under the expansion cap", "[T10-T13]", [10, 11, 12, 13]],
    ["range exactly at the cap (8)", "[T10-T17]", [10, 11, 12, 13, 14, 15, 16, 17]],
    ["range one past the cap keeps endpoints", "[T10-T18]", [10, 18]],
    ["wide range keeps endpoints", "[T8942-T8964]", [8942, 8964]],
    ["range with spaces around the dash", "[T10 - T12]", [10, 11, 12]],
    ["degenerate range", "[T7-T7]", [7]],
    ["annotated takes the leading id", "[T9019 approval]", [9019]],
    ["annotated, multi-word", "[T9019 approved by user]", [9019]],
    ["annotated, CJK", "[T9019 用户拍板]", [9019]],
    [
      "cross-form dedupe keeps first-seen order",
      "[T5] then [T4, T5] and again [T4-T6]",
      [5, 4, 6],
    ],
    [
      "several brackets in one body",
      "reverses [T101], implements [T102 decision]",
      [101, 102],
    ],
    ["id padded with same-line whitespace", "[ T12 ]", [12]],
    [
      // The expansion cap governs one RANGE, never the body as a whole.
      "more than eight single citations",
      "[T1] [T2] [T3] [T4] [T5] [T6] [T7] [T8] [T9] [T10]",
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    ],
    [
      "more than eight ids across mixed forms",
      "[T1-T5] [T6-T9] [T20, T21]",
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 21],
    ],
  ];

  for (const [name, content, expected] of positives) {
    test(`parses ${name}`, () => {
      expect(parseInlineCitations(content)).toEqual(expected);
    });
  }

  // Malformed forms are ignored WHOLE — no salvaging a leading id out of a
  // broken list, no reading prose that merely mentions a turn as a citation.
  const negatives: Array<[string, string]> = [
    ["empty bracket", "[]"],
    ["no digits", "[T]"],
    ["prose only", "[approval]"],
    ["prefixed mention", "[see T12]"],
    ["dbid render form", "[dbid:T12]"],
    ["trailing garbage on the id", "[T12x]"],
    ["space between T and digits", "[T 12]"],
    ["list with a non-id element", "[T12, foo]"],
    ["list with a spaced non-id element", "[T12 , foo]"],
    ["list with a digitless element", "[T12, T]"],
    ["list with a trailing comma", "[T12, T13,]"],
    ["descending range", "[T900-T800]"],
    ["range missing the second T", "[T10-12]"],
    ["spaced range missing the second T", "[T12 - 13]"],
    ["zero id", "[T0]"],
    ["lowercase t", "[t12]"],
    ["unbracketed id", "reverted in T4243"],
    // Nesting: the inner form is part of a malformed outer body, so BOTH go.
    ["doubled brackets", "[[T12]]"],
    ["bracket nested behind prose", "[foo [T12]]"],
    ["bracket nested mid-body", "[foo [T12] bar]"],
    // Every form is a single-line token; a body that wraps a line is prose.
    ["body wrapping a line break", "[ T12\n]"],
    ["multiline annotation", "[T12\napproval]"],
    ["unterminated bracket", "[T12 and more prose"],
  ];

  for (const [name, content] of negatives) {
    test(`ignores ${name}`, () => {
      expect(parseInlineCitations(content)).toEqual([]);
    });
  }

  test("returns nothing for empty content", () => {
    expect(parseInlineCitations(null)).toEqual([]);
    expect(parseInlineCitations("")).toEqual([]);
  });

  test("honours a consumer-supplied maxRefs, expanded ranges included", () => {
    expect(parseInlineCitations("[T1, T2, T3]", 2)).toEqual([1, 2]);
    expect(parseInlineCitations("[T10-T14]", 3)).toEqual([10, 11, 12]);
    expect(parseInlineCitations("[T1] [T2]", 0)).toEqual([]);
  });

  test("is uncapped by default — only a single range is bounded", () => {
    const content = Array.from({ length: 40 }, (_, i) => `[T${i + 1}]`).join(" ");
    expect(parseInlineCitations(content)).toHaveLength(40);
  });
});

// The generic body-free structured edge write (`replaceTurnCitations`, spec
// C6) is retired outright — a `{turn, relation}` list with no prose backing
// it made every rule in the `recomputeTurnCitedPairs` describe block below
// bypassable in one call. These fixtures now seed edges through
// `writeMemoryEdges` directly — the primitive both the old function and
// `recomputeTurnCitedPairs` are built on — so the schema/delete-trigger
// coverage (spec C15) they exist for survives the retirement unchanged.
describe("memory_edges schema and delete triggers (spec C15)", () => {
  let db: Database;
  let sessionA: number;
  let sessionB: number;
  let turns: number[];
  let foreignTurn: number;

  const insertTurn = (sessionId: number, promptNumber: number): number =>
    db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch)
         VALUES (?, ?, 'extracted', 'fixture', 100) RETURNING id`,
      )
      .get(sessionId, promptNumber)!.id;

  function citeFrom(
    citingTurnId: number,
    citedTurnId: number,
    relation: "verifies" | "narrows" | "consume",
    nowEpoch = 500,
  ): void {
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citingTurnId },
          cited: { kind: "turn", id: citedTurnId },
          relation,
          provenance: "judged",
        },
      ],
      nowEpoch,
    );
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionA = upsertSession(db, {
      contentSessionId: "citations-a",
      project: "claude-mnemo",
      title: "A",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    sessionB = upsertSession(db, {
      contentSessionId: "citations-b",
      project: "claude-mnemo",
      title: "B",
      insight: null,
      createdAtEpoch: 200,
      updatedAtEpoch: 200,
      completedAtEpoch: null,
    }).id;

    turns = [1, 2, 3, 4].map((promptNumber) =>
      insertTurn(sessionA, promptNumber),
    );
    foreignTurn = insertTurn(sessionB, 1);
  });

  afterEach(() => {
    db.close();
  });

  test("writes cross-session edges but excludes them from session-local in-degree", () => {
    // Two same-session citers of turns[0], one cross-session citer, and one
    // outbound cross-session edge.
    citeFrom(turns[1]!, turns[0]!, "consume");
    citeFrom(turns[2]!, turns[0]!, "narrows");
    citeFrom(turns[2]!, foreignTurn, "verifies");
    citeFrom(foreignTurn, turns[0]!, "consume");

    // The cross-session edges are persisted as provenance …
    expect(
      getTurnCitations(db, turns[2]!).map((edge) => edge.citedTurnId),
    ).toContain(foreignTurn);
    expect(getTurnCitations(db, foreignTurn)).toHaveLength(1);

    // … but the same exclusion the victim-demotion and ↳ rendering consumers
    // apply keeps them out of session-local in-degree.
    const inDegree = getSessionCitationInDegree(db, sessionA);
    expect(inDegree.get(turns[0]!)).toBe(2);
    expect(inDegree.has(foreignTurn)).toBe(false);
    expect(getSessionCitationInDegree(db, sessionB).size).toBe(0);
  });

  test("a second relation on the same pair is a second row, and still one citer of the target", () => {
    // Edge-mechanism-revision D2: identity is (pair, relation), so the second
    // write ADDS a row rather than relabelling the first (memory-edges.test.ts
    // covers the write path itself). What must still hold here is that
    // in-degree counts the citing turn ONCE — it is one piece of work
    // consuming the target, however many claims it filed about it.
    citeFrom(turns[1]!, turns[0]!, "verifies");
    citeFrom(turns[1]!, turns[0]!, "narrows");

    // Alphabetical by relation, not insertion order: 'narrows' < 'verifies'.
    // (The pair used to be written 'supersedes'/'verifies'; lane-model-v12
    // ticket 03 retired that word, and the ordering point is the same.)
    expect(getTurnCitations(db, turns[1]!)).toEqual([
      {
        citingTurnId: turns[1]!,
        citedTurnId: turns[0]!,
        relation: "narrows",
        createdAtEpoch: 500,
      },
      {
        citingTurnId: turns[1]!,
        citedTurnId: turns[0]!,
        relation: "verifies",
        createdAtEpoch: 500,
      },
    ]);
    expect(getSessionCitationInDegree(db, sessionA).get(turns[0]!)).toBe(1);
  });

  // `memory_edges.citing_id`/`cited_id` carry no FOREIGN KEY at all (they
  // cannot: one INTEGER column is shared across turn, segment and session id
  // spaces, so a single REFERENCES clause can never be correct). Retiring
  // `turn_citations` (which DID cascade via `ON DELETE CASCADE`) made this
  // load-bearing rather than merely untidy (spec C15): the segment ranking
  // key's cited-by count reads memory_edges directly, so an orphaned edge
  // inflates a surviving target's in-degree with a citer that no longer
  // exists. The fix is schema.ts's kind-aware `AFTER DELETE` triggers on
  // turns/segments/sessions; these two tests prove the endpoint's edges are
  // actually gone afterward, not merely dangling.
  test("deleting the cited endpoint's session removes its edges via the kind-aware delete trigger (spec C15)", () => {
    citeFrom(turns[1]!, turns[0]!, "consume");
    citeFrom(foreignTurn, turns[0]!, "verifies");
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM memory_edges WHERE citing_kind = 'turn' AND cited_kind = 'turn'",
      ).get()!.count,
    ).toBe(2);

    db.query("DELETE FROM sessions WHERE id = ?").run(sessionA);

    // The turns are gone (CASCADE on turns.session_id is intact) …
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM turns").get()!
        .count,
    ).toBe(1); // only foreignTurn (session B) remains
    // … and the AFTER DELETE trigger fired for every cascaded turn row,
    // removing both the edge that CITED turns[0] and the one turns[1] (also
    // deleted) had CITING. Nothing dangles.
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM memory_edges WHERE citing_kind = 'turn' AND cited_kind = 'turn'",
      ).get()!.count,
    ).toBe(0);
  });

  // The two tests above reach the TURN trigger, and only that one — a session
  // deletion gets there by cascading into `turns`. The segment and session
  // triggers are separate SQL programs, and kind qualification exists in all
  // three precisely because a turn id and a segment id are numbers drawn from
  // independent sequences and will collide. An untested collision is the one
  // failure this design was built to prevent.
  test("a segment sharing a turn's id takes only its own edges when deleted (spec C15)", () => {
    // Force the collision rather than hoping for it: the segment is given the
    // id of a live turn, so every edge below is ambiguous on id alone and can
    // only be resolved by kind.
    const collidingId = turns[0]!;
    db.query(
      `INSERT INTO segments (id, title, content, created_at_epoch, updated_at_epoch)
       VALUES (?, 'colliding segment', NULL, 500, 500)`,
    ).run(collidingId);

    const edge = db.query<unknown, [string, number, string, number]>(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
       VALUES (?, ?, ?, ?, NULL, 'text-ref', 500)`,
    );
    edge.run("segment", collidingId, "turn", turns[1]!); // segment's outgoing
    edge.run("turn", foreignTurn, "segment", collidingId); // segment's incoming
    edge.run("turn", collidingId, "turn", foreignTurn); // the TURN of the same id

    db.query("DELETE FROM segments WHERE id = ?").run(collidingId);

    const survivors = db
      .query<{ citingKind: string; citedKind: string }, []>(
        "SELECT citing_kind AS citingKind, cited_kind AS citedKind FROM memory_edges",
      )
      .all();
    // Both segment-touching edges are gone in BOTH directions, and the
    // same-numbered turn's edge is untouched.
    expect(survivors).toEqual([{ citingKind: "turn", citedKind: "turn" }]);
  });

  test("a session-sourced edge goes when its session does (spec C15)", () => {
    // The only trigger with a single direction: nothing cites a session, so it
    // prunes outgoing edges only.
    //
    // The cited endpoint MUST be a turn of the OTHER session. An earlier
    // version of this test cited a turn of sessionB itself, and deleting
    // sessionB cascaded into that turn, so the TURN trigger removed the edge
    // through its cited endpoint — the row disappeared and the session
    // trigger was never the cause. That test stayed green with the session
    // trigger deleted outright, which is the same false-positive shape the
    // id-collision test above exists to rule out: it asserted disappearance
    // without pinning what caused it.
    db.query<unknown, [number, number]>(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
       VALUES ('session', ?, 'turn', ?, NULL, 'text-ref', 500)`,
    ).run(sessionB, turns[0]!);
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM memory_edges WHERE citing_kind = 'session'",
      ).get()!.count,
    ).toBe(1);

    db.query("DELETE FROM sessions WHERE id = ?").run(sessionB);

    // The cited endpoint outlived the deletion, so no turn trigger can have
    // fired for it — the only thing that could remove this row is the session
    // trigger. Without this assertion the test proves nothing.
    expect(
      db.query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM turns WHERE id = ?",
      ).get(turns[0]!)!.count,
    ).toBe(1);
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM memory_edges WHERE citing_kind = 'session'",
      ).get()!.count,
    ).toBe(0);
  });

  test("deleting the citing endpoint's session removes only that endpoint's edges (spec C15)", () => {
    citeFrom(turns[1]!, turns[0]!, "consume");
    citeFrom(foreignTurn, turns[0]!, "verifies");

    db.query("DELETE FROM sessions WHERE id = ?").run(sessionB);

    // foreignTurn is gone, so its outgoing edge is gone with it; turns[1]'s
    // edge to turns[0] — neither endpoint deleted — survives untouched.
    expect(
      db
        .query<{ citingTurnId: number }, []>(
          `SELECT citing_id AS citingTurnId FROM memory_edges
           WHERE citing_kind = 'turn' AND cited_kind = 'turn'
           ORDER BY citing_id`,
        )
        .all(),
    ).toEqual([{ citingTurnId: turns[1]! }]);
  });

  test("rejects a duplicate (citing, cited, relation) row, and a second BARE row for one pair (D2)", () => {
    const insert = db.query<unknown, [number, number, string | null]>(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
       VALUES ('turn', ?, 'turn', ?, ?, 'judged', 1)`,
    );
    insert.run(turns[1]!, turns[0]!, "verifies");

    // Identity is the triple now: a DIFFERENT relation on the same pair is a
    // legal second row, the same relation twice is not.
    expect(() => insert.run(turns[1]!, turns[0]!, "narrows")).not.toThrow();
    expect(() => insert.run(turns[1]!, turns[0]!, "verifies")).toThrow();
    expect(getTurnCitations(db, turns[1]!)).toHaveLength(2);

    // The bare row is the one shape SQLite's UNIQUE cannot police on its own
    // (it treats NULLs as distinct), so the partial unique index does.
    insert.run(turns[2]!, turns[0]!, null);
    expect(() => insert.run(turns[2]!, turns[0]!, null)).toThrow();
    expect(getTurnCitations(db, turns[2]!)).toHaveLength(1);
  });

  test("rejects an unknown relation at the schema level", () => {
    expect(() =>
      db
        .query(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, 'mentions', 'judged', 1)`,
        )
        .run(turns[1]!, turns[0]!),
    ).toThrow();
  });

  test("accepts a NULL relation at the schema level (spec C5: an unattributed citation is storable)", () => {
    expect(() =>
      db
        .query(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, NULL, 'text-ref', 1)`,
        )
        .run(turns[1]!, turns[0]!),
    ).not.toThrow();
  });
});

describe("recomputeTurnCitedPairs (spec C6)", () => {
  let db: Database;
  let sessionId: number;
  let otherSessionId: number;
  let turns: number[];

  const insertTurn = (sessionDbId: number, promptNumber: number): number =>
    db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch)
         VALUES (?, ?, 'extracted', 'fixture', 100) RETURNING id`,
      )
      .get(sessionDbId, promptNumber)!.id;

  /** Exposes every turn id to `sessionId`'s ledger — recomputeTurnCitedPairs' own gate. */
  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "recompute-a",
      project: "claude-mnemo",
      title: "A",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    otherSessionId = upsertSession(db, {
      contentSessionId: "recompute-b",
      project: "claude-mnemo",
      title: "B",
      insight: null,
      createdAtEpoch: 200,
      updatedAtEpoch: 200,
      completedAtEpoch: null,
    }).id;
    turns = [1, 2, 3, 4].map((promptNumber) => insertTurn(sessionId, promptNumber));
  });

  afterEach(() => {
    db.close();
  });

  // Acceptance criterion 1: a bare `[S/T]` in a citation-bearing field creates
  // an unattributed (relation: null) pair — no relation field, no separate
  // structured input, the body alone.
  test("a bare qualified reference in content creates an unattributed pair", () => {

    const result = recomputeTurnCitedPairs(
      db,
      turns[2]!,
      { title: null, content: `Builds on [S${sessionId}/T1].`, insight: null },
      500,
      sessionId,
    );

    expect(result.rejected).toEqual([]);
    expect(
      getOutgoingEdges(db, { kind: "turn", id: turns[2]! }).map((edge) => [
        edge.cited,
        edge.relation,
      ]),
    ).toEqual([[{ kind: "turn", id: turns[0]! }, null]]);
  });

  test("title and insight are citation-bearing fields too", () => {

    recomputeTurnCitedPairs(
      db,
      turns[2]!,
      {
        title: `design: reverses [S${sessionId}/T1]`,
        content: null,
        insight: `Same lesson as [S${sessionId}/T2].`,
      },
      500,
      sessionId,
    );

    expect(
      getOutgoingEdges(db, { kind: "turn", id: turns[2]! })
        .map((edge) => edge.cited.id)
        .sort((a, b) => a - b),
    ).toEqual([turns[0]!, turns[1]!]);
  });

  // Acceptance criterion 3: reproduce the SEQUENCE — write a body citing two
  // turns (one carrying a relation another writer already attached), rewrite
  // it citing only one, and prove the dropped pair is gone along with its
  // relation. Not merely "a delete helper exists".
  test("a rewrite that drops a reference drops its pair and any relation it carried", () => {

    recomputeTurnCitedPairs(
      db,
      turns[2]!,
      { title: null, content: `[S${sessionId}/T1] and [S${sessionId}/T2].`, insight: null },
      500,
      sessionId,
    );
    // A relation lands on the T1 pair from elsewhere (settlement, in
    // production, through its own pre-state fence) — never this function's
    // own job to create.
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: turns[2]! },
          cited: { kind: "turn", id: turns[0]! },
          relation: "narrows",
          provenance: "judged",
        },
      ],
      500,
    );
    expect(
      getOutgoingEdges(db, { kind: "turn", id: turns[2]! }),
    ).toHaveLength(2);

    const result = recomputeTurnCitedPairs(
      db,
      turns[2]!,
      { title: null, content: `Only [S${sessionId}/T1] now.`, insight: null },
      600,
      sessionId,
    );

    // T2's bare pair is gone …
    const surviving = getOutgoingEdges(db, { kind: "turn", id: turns[2]! });
    expect(surviving.map((edge) => edge.cited.id)).toEqual([turns[0]!]);
    // … and the deleted pair's relation is reported, not silently dropped.
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]?.cited).toEqual({ kind: "turn", id: turns[1]! });
  });

  // Acceptance criterion 4: a relation on a pair the rewrite STILL cites
  // survives untouched — the bare re-scan must not clear or relabel it.
  test("a relation on a surviving pair is not disturbed by a rewrite that still cites it", () => {
    recomputeTurnCitedPairs(
      db,
      turns[2]!,
      { title: null, content: `[S${sessionId}/T1].`, insight: null },
      500,
      sessionId,
    );
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: turns[2]! },
          cited: { kind: "turn", id: turns[0]! },
          relation: "verifies",
          provenance: "judged",
        },
      ],
      500,
    );

    recomputeTurnCitedPairs(
      db,
      turns[2]!,
      { title: null, content: `Restating [S${sessionId}/T1] once more.`, insight: null },
      600,
      sessionId,
    );

    const surviving = getOutgoingEdges(db, { kind: "turn", id: turns[2]! });
    expect(surviving).toHaveLength(1);
    expect(surviving[0]?.relation).toBe("verifies");
  });

  // The exposure gate is gone: a citation is legal iff its address resolves.
  // The ledger only recorded the addresses the note machinery handed over,
  // so gating on it dropped anything a writer found through recall or
  // timeline — and "did this agent see it" is not an auditable fact anyway.
  test("a reference to a turn this session was never handed is written, because it resolves", () => {
    // turns[0] deliberately NOT exposed.
    const result = recomputeTurnCitedPairs(
      db,
      turns[2]!,
      { title: null, content: `[S${sessionId}/T1].`, insight: null },
      500,
      sessionId,
    );

    expect(result.rejected).toHaveLength(0);
    expect(
      getOutgoingEdges(db, { kind: "turn", id: turns[2]! }).map((e) => e.cited),
    ).toEqual([{ kind: "turn", id: turns[0]! }]);
  });

  test("an address that resolves to nothing is still dropped", () => {
    const result = recomputeTurnCitedPairs(
      db,
      turns[2]!,
      { title: null, content: `[S${sessionId}/T4242].`, insight: null },
      500,
      sessionId,
    );

    expect(result.rejected.map((entry) => entry.reason)).toEqual(["unresolved"]);
    expect(getOutgoingEdges(db, { kind: "turn", id: turns[2]! })).toEqual([]);
  });

  test("a cross-session reference is written as provenance", () => {
    const foreign = insertTurn(otherSessionId, 1);

    recomputeTurnCitedPairs(
      db,
      turns[2]!,
      { title: null, content: `[S${otherSessionId}/T1].`, insight: null },
      500,
      sessionId,
    );

    expect(
      getOutgoingEdges(db, { kind: "turn", id: turns[2]! }).map((edge) => edge.cited.id),
    ).toEqual([foreign]);
  });

  test("no citation-bearing field leaves the turn's outgoing set untouched at empty", () => {
    const result = recomputeTurnCitedPairs(
      db,
      turns[2]!,
      { title: null, content: null, insight: null },
      500,
      sessionId,
    );

    expect(result.written).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(getOutgoingEdges(db, { kind: "turn", id: turns[2]! })).toEqual([]);
  });
});

/**
 * relation-vocabulary-v13 ticket 02: a `correct` entry MUST carry its
 * FULL/PARTIAL coverage bit, so a bare address string is not a legal `correct`
 * target — only `verify` and `use` take the bare draft form. The two sides stay
 * `''` (unsettled), which is exactly what a bare address used to mean, so these
 * fixtures test the same DRAFT shape they always did.
 */
function correctEntries(
  addresses: readonly string[],
  coverage: "full" | "partial",
): RelationTargetEntry[] {
  return addresses.map((turn) => ({ turn, tailTag: "", headTag: "", coverage }));
}

describe("attachTurnRelations / retractTurnRelations (spec C1; prose decoupled by edge-mechanism-revision D1/D3, ticket 02)", () => {
  let db: Database;
  let sessionId: number;
  let turns: number[];

  const insertTurn = (sessionDbId: number, promptNumber: number): number =>
    db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch)
         VALUES (?, ?, 'extracted', 'fixture', 100) RETURNING id`,
      )
      .get(sessionDbId, promptNumber)!.id;

  const relationsOn = (turnId: number): Array<string | null> =>
    getOutgoingEdges(db, { kind: "turn", id: turnId })
      .map((edge) => edge.relation)
      .sort();

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "attach-relations",
      project: "claude-mnemo",
      title: "A",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    turns = [1, 2, 3].map((promptNumber) => insertTurn(sessionId, promptNumber));
  });

  afterEach(() => {
    db.close();
  });

  test("attaches a relation with provenance asserted, on a turn with no prose at all", () => {
    const result = attachTurnRelations(
      db,
      turns[2]!,
      [{ relationClass: "correct", targets: correctEntries([`S${sessionId}/T1`], "partial") }],
      500,
    );

    expect(result.rejected).toEqual([]);
    expect(result.restated).toEqual([]);
    expect(result.written).toHaveLength(1);
    expect(result.written[0]?.relation).toBe("narrows");
    expect(result.written[0]?.provenance).toBe("asserted");
    const stored = getOutgoingEdges(db, { kind: "turn", id: turns[2]! });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.relation).toBe("narrows");
    expect(stored[0]?.provenance).toBe("asserted");
  });

  // Ticket 02 (D1): the retired C7 premise, tested from the other side. The
  // body here names T1 and nothing else; the relation targets T2, which the
  // old contract rejected as `not-cited`.
  test("attaches to a target the body does not name — the bare pair is no longer a prerequisite", () => {
    recomputeTurnCitedPairs(
      db,
      turns[2]!,
      { title: null, content: `Mentions [S${sessionId}/T1].`, insight: null },
      500,
      sessionId,
    );

    const result = attachTurnRelations(
      db,
      turns[2]!,
      [{ relationClass: "use", targets: [`S${sessionId}/T2`] }],
      500,
    );

    expect(result.rejected).toEqual([]);
    expect(result.written).toHaveLength(1);
    expect(result.written[0]?.cited).toEqual({ kind: "turn", id: turns[1]! });
    // The body's own bare pair to T1 is untouched alongside it (the sort is
    // lexical, so the bare `null` row lands last).
    // relation-vocabulary-v13 ticket 02: a `use` write lands in the `relation`
    // column as `extends` — the INTERIM equivalence
    // (`shared/relation-class.ts`'s `INTERIM_LEGACY_RELATION`), which ticket 05a
    // replaces. The stored word, not the class, is what `relationsOn` reads.
    expect(relationsOn(turns[2]!)).toEqual(["extends", null]);
  });

  // Ticket 02 (D2): the tool-surface "one relation per pair" refusal is gone,
  // and a restatement is reported rather than counted as new work.
  test("two relations on one pair coexist, and a restated one lands in `restated`", () => {
    attachTurnRelations(
      db,
      turns[2]!,
      [{ relationClass: "verify", targets: [`S${sessionId}/T1`] }],
      500,
    );

    const second = attachTurnRelations(
      db,
      turns[2]!,
      [
        { relationClass: "verify", targets: [`S${sessionId}/T1`] },
        { relationClass: "correct", targets: correctEntries([`S${sessionId}/T1`], "partial") },
      ],
      600,
    );

    expect(second.rejected).toEqual([]);
    expect(second.written.map((edge) => edge.relation)).toEqual(["narrows"]);
    expect(second.restated.map((edge) => edge.relation)).toEqual(["verifies"]);
    // Alphabetical by relation, not insertion order: 'narrows' < 'verifies'.
    expect(relationsOn(turns[2]!)).toEqual(["narrows", "verifies"]);
    // The restated row keeps its FIRST sighting, not this call's clock.
    expect(second.restated[0]?.createdAtEpoch).toBe(500);
  });

  test("rejects a relation naming the citing turn itself, before anything is written", () => {
    const result = attachTurnRelations(
      db,
      turns[2]!,
      [{ relationClass: "use", targets: [`S${sessionId}/T3`] }],
      500,
    );

    expect(result.written).toEqual([]);
    expect(result.rejected).toEqual([
      { relation: "use", raw: `S${sessionId}/T3`, reason: "self-edge" },
    ]);
    expect(getOutgoingEdges(db, { kind: "turn", id: turns[2]! })).toEqual([]);
  });

  // lane-model-v12 D2 (ticket 04): this primitive used to carve `grounds`
  // OUT of the refusal above and write the row, trusting the caller's own
  // post-write gate for the terminus condition that made a self-`grounds`
  // legal. The carve-out, the gate and the condition are all deleted — the
  // storage layer now refuses a self target word-blind.
  test("rejects a grounds relation naming the citing turn itself too — the last carve-out is gone", () => {
    const result = attachTurnRelations(
      db,
      turns[2]!,
      [{ relationClass: "use", targets: [`S${sessionId}/T3`] }],
      500,
    );

    expect(result.written).toEqual([]);
    expect(result.rejected).toEqual([
      { relation: "use", raw: `S${sessionId}/T3`, reason: "self-edge" },
    ]);
    expect(getOutgoingEdges(db, { kind: "turn", id: turns[2]! })).toEqual([]);
  });

  test("rejects a malformed address and an unresolved one, distinctly", () => {
    const result = attachTurnRelations(
      db,
      turns[2]!,
      [
        { relationClass: "correct", targets: correctEntries(["not an address"], "partial") },
        { relationClass: "use", targets: [`S${sessionId}/T4242`] },
      ],
      500,
    );

    expect(result.written).toEqual([]);
    expect(result.rejected).toEqual([
      { relation: "correct", raw: "not an address", reason: "malformed" },
      { relation: "use", raw: `S${sessionId}/T4242`, reason: "unresolved" },
    ]);
  });

  // depends-on's storage direction (spec C1): "cited -> citing" describes
  // trust FLOW ("its result underwrites my conclusion"), not a reversal of
  // which id lands in which column — pair identity stays citing=the turn
  // being written, cited=the target, exactly like the other three relations.
  test("depends-on stores citing=the writing turn, cited=the target — no direction reversal", () => {
    attachTurnRelations(
      db,
      turns[2]!,
      [{ relationClass: "use", targets: [`S${sessionId}/T1`] }],
      500,
    );

    const stored = getOutgoingEdges(db, { kind: "turn", id: turns[2]! });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.citing).toEqual({ kind: "turn", id: turns[2]! });
    expect(stored[0]?.cited).toEqual({ kind: "turn", id: turns[0]! });
    // INTERIM (ticket 05a): `use` stores as `extends`, and the CLASS is what a
    // reader asks for.
    expect(stored[0]?.relation).toBe("extends");
    expect(stored[0]?.relationClass).toBe("use");
    expect(stored[0]?.relationCoverage).toBe("");
  });

  // [S15069/T1728] REVERSED, by ruling. This test used to assert the opposite,
  // under a deliberate layering: the storage layer accepted a segment target
  // and the TOOL layer did the narrowing. D10 moves the refusal down, because
  // the model's own glossary says segments never enter the graph as relation
  // nodes, and an invariant kept by discipline at one layer is exactly what the
  // four stray judged rows in production disproved.
  //
  // A segment can still be CITED — a bare `text-ref` row records that prose
  // named it. What it can no longer do is carry a relation word.
  test("a segment target is refused at this layer: a segment is not a relation node", () => {
    const segment = createSegment(db, { title: "Prior chapter", nowEpoch: 200 });

    const result = attachTurnRelations(
      db,
      turns[2]!,
      [{ relationClass: "correct", targets: correctEntries([`E${segment.id}`], "partial") }],
      500,
    );

    expect(result.written).toEqual([]);
    // `raw` is the caller's OWN token, which is what makes this a
    // reference-level refusal rather than the storage layer's backstop: that
    // one only knows the resolved node ("segment 3"), so it cannot tell the
    // caller which address they wrote. Assert the token, or the two layers are
    // indistinguishable and a mutation removing this one survives.
    expect(result.rejected).toEqual([
      {
        relation: "correct",
        raw: `E${segment.id}`,
        reason: "segment-not-a-relation-node",
      },
    ]);
    expect(
      getOutgoingEdges(db, { kind: "turn", id: turns[2]! }).filter(
        (edge) => edge.cited.kind === "segment" && edge.relation !== null,
      ),
    ).toEqual([]);
  });

  // ------------------------------------------------------------------
  // Retraction (D3)
  // ------------------------------------------------------------------

  test("retracts exactly the addressed (pair, relation) row, leaving the pair's others", () => {
    attachTurnRelations(
      db,
      turns[2]!,
      [
        { relationClass: "verify", targets: [`S${sessionId}/T1`] },
        { relationClass: "correct", targets: correctEntries([`S${sessionId}/T1`], "partial") },
      ],
      500,
    );

    const result = retractTurnRelations(db, turns[2]!, [
      { relationClass: "correct", targets: correctEntries([`S${sessionId}/T1`], "partial") },
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.deleted.map((edge) => edge.relation)).toEqual(["narrows"]);
    expect(relationsOn(turns[2]!)).toEqual(["verifies"]);
  });

  test("an address carrying no such relation rejects the whole call and deletes nothing", () => {
    attachTurnRelations(
      db,
      turns[2]!,
      [{ relationClass: "verify", targets: [`S${sessionId}/T1`] }],
      500,
    );

    const result = retractTurnRelations(db, turns[2]!, [
      { relationClass: "verify", targets: [`S${sessionId}/T1`] },
      { relationClass: "correct", targets: correctEntries([`S${sessionId}/T1`], "partial") },
    ]);

    expect(result.deleted).toEqual([]);
    expect(result.rejected).toEqual([
      { relation: "correct", raw: `S${sessionId}/T1`, reason: "no-such-edge" },
    ]);
    // The one that WAS there survives — all-or-nothing, same as the attach path.
    expect(relationsOn(turns[2]!)).toEqual(["verifies"]);
  });

  // Ticket 10, acceptance criterion 2: the fixture turns carry `title:
  // 'fixture'` and no body, so nothing re-asserts the citation and the pair
  // stays gone. This is the CURRENT behaviour pinned, not the old one: the
  // bare row comes back only for a body that still names the target.
  test("retracting a pair's last relation leaves the pair with no row at all when no prose names the target", () => {
    attachTurnRelations(
      db,
      turns[2]!,
      [{ relationClass: "verify", targets: [`S${sessionId}/T1`] }],
      500,
    );

    const result = retractTurnRelations(db, turns[2]!, [
      { relationClass: "verify", targets: [`S${sessionId}/T1`] },
    ]);

    expect(result.restored).toEqual([]);
    expect(getOutgoingEdges(db, { kind: "turn", id: turns[2]! })).toEqual([]);
  });

  // ------------------------------------------------------------------
  // Bare restore on retraction (ticket 10, peer 终审必改 3)
  // ------------------------------------------------------------------

  describe("bare restore when a retraction empties a pair the body still names", () => {
    const setBody = (turnId: number, fields: Partial<RecomputeFields>): void => {
      db.query<unknown, [string | null, string | null, string | null, number]>(
        "UPDATE turns SET title = ?, content = ?, insight = ? WHERE id = ?",
      ).run(
        fields.title ?? null,
        fields.content ?? null,
        fields.insight ?? null,
        turnId,
      );
    };

    // The whole reproduction chain in one test, because the bug is the
    // COMPOSITION of three individually-correct rules, not any one of them:
    // prose creates a bare row, a relation write REPLACES it (D2 one-fact-
    // one-row), and a retraction hard-deletes without downgrading (D3). Only
    // the sequence shows the citation evaporating.
    test("prose → bare; relation replaces it; retraction puts it back", () => {
      const body = `Builds on [S${sessionId}/T1].`;
      setBody(turns[2]!, { content: body });

      recomputeTurnCitedPairs(
        db,
        turns[2]!,
        { title: null, content: body, insight: null },
        500,
        sessionId,
      );
      expect(relationsOn(turns[2]!)).toEqual([null]);

      attachTurnRelations(
        db,
        turns[2]!,
        [{ relationClass: "use", targets: [`S${sessionId}/T1`] }],
        600,
      );
      // Replaced, not accompanied — the pair holds exactly one row.
      expect(relationsOn(turns[2]!)).toEqual(["extends"]);

      const result = retractTurnRelations(
        db,
        turns[2]!,
        [{ relationClass: "use", targets: [`S${sessionId}/T1`] }],
        700,
      );

      expect(result.rejected).toEqual([]);
      expect(result.deleted.map((edge) => edge.relation)).toEqual(["extends"]);
      expect(result.restored).toHaveLength(1);
      expect(result.restored[0]?.cited).toEqual({ kind: "turn", id: turns[0]! });
      expect(result.restored[0]?.relation).toBeNull();
      // Provenance is the BODY's fact, not the withdrawn writer's assertion.
      expect(result.restored[0]?.provenance).toBe("text-ref");
      expect(result.restored[0]?.createdAtEpoch).toBe(700);

      // Back to the post-prose state exactly: one bare row, and every
      // downstream count (`↳` pull-through, cited counts) reads the same as
      // it did before any relation was ever written.
      expect(relationsOn(turns[2]!)).toEqual([null]);
      expect(
        getEffectiveCitations(db, { id: turns[2]!, content: body }).citedTurnIds,
      ).toEqual([turns[0]!]);
      expect(getEdgeInDegree(db, { kind: "turn", id: turns[0]! })).toBe(1);
    });

    test("title and insight re-assert the citation too, same three fields the recompute scans", () => {
      setBody(turns[2]!, {
        title: `reverses [S${sessionId}/T1]`,
        insight: `same lesson as [S${sessionId}/T2]`,
      });
      attachTurnRelations(
        db,
        turns[2]!,
        [
          { relationClass: "correct", targets: correctEntries([`S${sessionId}/T1`], "full") },
          { relationClass: "use", targets: [`S${sessionId}/T2`] },
        ],
        600,
      );

      const result = retractTurnRelations(
        db,
        turns[2]!,
        [
          { relationClass: "correct", targets: correctEntries([`S${sessionId}/T1`], "full") },
          { relationClass: "use", targets: [`S${sessionId}/T2`] },
        ],
        700,
      );

      expect(
        result.restored.map((edge) => edge.cited.id).sort((a, b) => a - b),
      ).toEqual([turns[0]!, turns[1]!]);
      expect(relationsOn(turns[2]!)).toEqual([null, null]);
    });

    // The bare row stays the existence record OF LAST RESORT: a pair that
    // still carries a relation records itself, so restoring one there would
    // reverse ticket 01's one-fact-one-row de-dup and double the reader's
    // row count.
    test("a pair keeping another relation gets no bare row", () => {
      setBody(turns[2]!, { content: `Builds on [S${sessionId}/T1].` });
      attachTurnRelations(
        db,
        turns[2]!,
        [
          { relationClass: "verify", targets: [`S${sessionId}/T1`] },
          { relationClass: "use", targets: [`S${sessionId}/T1`] },
        ],
        600,
      );

      const result = retractTurnRelations(
        db,
        turns[2]!,
        [{ relationClass: "use", targets: [`S${sessionId}/T1`] }],
        700,
      );

      expect(result.restored).toEqual([]);
      expect(relationsOn(turns[2]!)).toEqual(["verifies"]);
    });

    // A retraction is not a reconcile: it repairs only what it just emptied.
    // A target the body names but that carries no row at all is
    // `recomputeTurnCitedPairs`' business, on the next prose write.
    test("only the emptied pair is restored, never every address the body names", () => {
      setBody(turns[2]!, {
        content: `[S${sessionId}/T1] and [S${sessionId}/T2].`,
      });
      attachTurnRelations(
        db,
        turns[2]!,
        [{ relationClass: "use", targets: [`S${sessionId}/T1`] }],
        600,
      );

      const result = retractTurnRelations(
        db,
        turns[2]!,
        [{ relationClass: "use", targets: [`S${sessionId}/T1`] }],
        700,
      );

      expect(result.restored.map((edge) => edge.cited.id)).toEqual([turns[0]!]);
      expect(
        getOutgoingEdges(db, { kind: "turn", id: turns[2]! }).map(
          (edge) => edge.cited.id,
        ),
      ).toEqual([turns[0]!]);
    });

    // The cited side may be a segment (`[E<n>]`), so the restore has to match
    // on the whole node address, not on a turn id.
    // [S15069/T1728] The scenario this test used to run is now UNREACHABLE, and
    // that is the point rather than a loss of coverage. Restoration exists
    // because a relation row REPLACES the pair's bare row, so retracting the
    // last relation would otherwise leave prose asserting a citation no row
    // records. After D10 a segment antecedent can never carry a relation, so
    // its bare row is never replaced and never needs putting back.
    //
    // The property that mattered — prose naming a segment keeps its graph
    // record — is asserted directly instead: the bare row is simply never
    // suppressed, because nothing is able to suppress it.
    test("a segment antecedent's bare row is never suppressed, so it never needs restoring", () => {
      const segment = createSegment(db, { title: "Prior chapter", nowEpoch: 200 });
      const body = { title: null, content: `Continues [E${segment.id}].`, insight: null };
      setBody(turns[2]!, { content: body.content });
      // Prose is what mints a bare row, so derive it explicitly — the sibling
      // tests above get theirs from the relation write they are about to
      // retract, and that write is exactly what is no longer possible here.
      recomputeTurnCitedPairs(db, turns[2]!, body, 500, sessionId);
      const before = getOutgoingEdges(db, { kind: "turn", id: turns[2]! }).filter(
        (edge) => edge.cited.kind === "segment" && edge.cited.id === segment.id,
      );
      expect(before).toHaveLength(1);
      expect(before[0]?.relation).toBeNull();

      // The only write that could have replaced it is refused outright, by
      // name — so the bare row simply stays, and no restoration is owed.
      const attach = attachTurnRelations(
        db,
        turns[2]!,
        [{ relationClass: "use", targets: [`E${segment.id}`] }],
        600,
      );
      expect(attach.written).toEqual([]);
      expect(attach.rejected).toEqual([
        {
          relation: "use",
          raw: `E${segment.id}`,
          reason: "segment-not-a-relation-node",
        },
      ]);

      const after = getOutgoingEdges(db, { kind: "turn", id: turns[2]! }).filter(
        (edge) => edge.cited.kind === "segment" && edge.cited.id === segment.id,
      );
      expect(after).toEqual(before);
    });

    // All-or-nothing survives the addition: a rejected address means nothing
    // was deleted, so there is nothing to restore either.
    test("a rejected retraction restores nothing", () => {
      setBody(turns[2]!, { content: `Builds on [S${sessionId}/T1].` });
      attachTurnRelations(
        db,
        turns[2]!,
        [{ relationClass: "use", targets: [`S${sessionId}/T1`] }],
        600,
      );

      const result = retractTurnRelations(
        db,
        turns[2]!,
        [
          { relationClass: "use", targets: [`S${sessionId}/T1`] },
          { relationClass: "correct", targets: correctEntries([`S${sessionId}/T1`], "full") },
        ],
        700,
      );

      expect(result.restored).toEqual([]);
      expect(result.deleted).toEqual([]);
      expect(relationsOn(turns[2]!)).toEqual(["extends"]);
    });
  });
});

describe("effective citations predicate", () => {
  let db: Database;
  let sessionId: number;
  let citedId: number;
  let citerId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "effective-citations",
      project: "claude-mnemo",
      title: "E",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    citedId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch)
         VALUES (?, 1, 'extracted', 'cited', 100) RETURNING id`,
      )
      .get(sessionId)!.id;
    citerId = db
      .query<{ id: number }, [number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, title, content, created_at_epoch)
         VALUES (?, 2, 'extracted', 'citer', ?, 100) RETURNING id`,
      )
      .get(sessionId, `reverses [T${citedId}] and [T4242]`)!.id;
  });

  afterEach(() => {
    db.close();
  });

  test("reads prose when there are no edges, and resolves what the parser cannot", () => {
    const turn = getTurnById(db, citerId)!;
    // T4242 names no turn: the parser is DB-blind and returns it, this layer
    // resolves and drops it.
    expect(getEffectiveCitations(db, turn)).toEqual({
      citedTurnIds: [citedId],
      edges: [],
    });
  });

  test("drops a legacy self-citation the same way the write path does", () => {
    db.query("UPDATE turns SET content = ? WHERE id = ?").run(
      `revisits [T${citerId}] and [T${citedId}]`,
      citerId,
    );

    expect(
      getEffectiveCitations(db, getTurnById(db, citerId)!).citedTurnIds,
    ).toEqual([citedId]);
  });

  // Replaces "a recorded empty set means genuinely none, not legacy absence",
  // which pinned the retired gate. `cites_recorded` used to let a writer
  // retract prose by recording an authoritative empty set; that retraction is
  // deliberately no longer expressible. After ticket 06 a body owns its pairs,
  // so a turn that stops citing something loses it from BOTH sources at once —
  // the retraction had nothing left to do, and the flag it depended on could be
  // forgotten or lie. Measured on the live database before the change: 135 of
  // 838 flagged turns gain citations, 185 ids in all, and sampling showed them
  // to be real prose links the structured writer had failed to record.
  test("an empty edge set no longer retracts what the prose still says", () => {
    const effective = getEffectiveCitations(db, getTurnById(db, citerId)!);
    expect(effective.edges).toEqual([]);
    expect(effective.citedTurnIds).toEqual([citedId]);
  });

  test("unions the two sources rather than letting either win", () => {
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citerId },
          cited: { kind: "turn", id: citedId },
          relation: "narrows",
          provenance: "judged",
        },
      ],
      500,
    );

    const effective = getEffectiveCitations(db, getTurnById(db, citerId)!);
    // The pair is named by both sources and counts once; 4242 is inline-only
    // and dangling, so it is still dropped — the union widens the sources, it
    // does not relax resolution.
    expect(effective.citedTurnIds).toEqual([citedId]);
    expect(effective.edges.map((edge) => edge.relation)).toEqual(["narrows"]);
  });

  test("a prose citation the edge set never recorded is still effective", () => {
    const extra = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch)
         VALUES (?, 9, 'extracted', 'fixture', 100) RETURNING id`,
      )
      .get(sessionId)!.id;
    db.query("UPDATE turns SET content = ? WHERE id = ?").run(
      `builds on [T${citedId}] and also [T${extra}]`,
      citerId,
    );
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citerId },
          cited: { kind: "turn", id: citedId },
          relation: "consume",
          provenance: "judged",
        },
      ],
      500,
    );

    // Structured first, then prose the edges did not cover.
    expect(
      getEffectiveCitations(db, getTurnById(db, citerId)!).citedTurnIds,
    ).toEqual([citedId, extra]);
  });

  // Second review round: both generic pair readers used to filter
  // `relation IS NOT NULL`, so a pair with no stated relation returned
  // nothing at all — and since this turn's `cites_recorded = 1`, there was no
  // inline fallback either. That emptied spec C5 of its content: the whole
  // point of pair identity is that an unattributed citation is a real,
  // storable, READABLE state. A bare write reaches `memory_edges` the way
  // settlement's text-ref/bare writes do (writeMemoryEdges, spec C14);
  // inserted directly here since `replaceTurnCitations` requires every entry
  // in its replace-set to carry a relation.
  test("a NULL-relation edge is still an effective citation, not a missing one (spec C5)", () => {
    db.query(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
       VALUES ('turn', ?, 'turn', ?, NULL, 'text-ref', 500)`,
    ).run(citerId, citedId);

    const effective = getEffectiveCitations(db, getTurnById(db, citerId)!);
    expect(effective.citedTurnIds).toEqual([citedId]);
    expect(effective.edges).toEqual([
      {
        citingTurnId: citerId,
        citedTurnId: citedId,
        relation: null,
        createdAtEpoch: 500,
      },
    ]);

    const sessionEffective = getSessionEffectiveCitations(db, sessionId);
    expect(sessionEffective.get(citerId)?.citedTurnIds).toEqual([citedId]);

    expect(getSessionCitationInDegree(db, sessionId).get(citedId)).toBe(1);
  });
});

describe("session-wide effective citations", () => {
  let db: Database;
  let sessionA: number;
  let sessionB: number;
  let anchor: number;
  let legacyCiter: number;
  let structuredCiter: number;
  let selfCiter: number;
  let foreignTurn: number;

  const insertTurn = (
    sessionId: number,
    promptNumber: number,
    content: string | null,
  ): number =>
    db
      .query<{ id: number }, [number, number, string | null]>(
        `INSERT INTO turns (session_id, prompt_number, status, title, content, created_at_epoch)
         VALUES (?, ?, 'extracted', 'fixture', ?, 100) RETURNING id`,
      )
      .get(sessionId, promptNumber, content)!.id;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionA = upsertSession(db, {
      contentSessionId: "session-effective-a",
      project: "claude-mnemo",
      title: "A",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    sessionB = upsertSession(db, {
      contentSessionId: "session-effective-b",
      project: "claude-mnemo",
      title: "B",
      insight: null,
      createdAtEpoch: 200,
      updatedAtEpoch: 200,
      completedAtEpoch: null,
    }).id;

    anchor = insertTurn(sessionA, 1, null);
    foreignTurn = insertTurn(sessionB, 1, null);
    // Pre-deployment turn: its ONLY causal signal is inline prose, and it names
    // a live id, a dangling id and a cross-session id.
    legacyCiter = insertTurn(
      sessionA,
      2,
      `builds on [T${anchor}], [T4242] and [T${foreignTurn}]`,
    );
    // Prose names something the edges do not: the union carries both.
    structuredCiter = insertTurn(sessionA, 3, `mentions [T${legacyCiter}]`);
    selfCiter = insertTurn(sessionA, 4, `revisits [T4243]`);
    db.query("UPDATE turns SET content = ? WHERE id = ?").run(
      `revisits [T${selfCiter}]`,
      selfCiter,
    );

    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: structuredCiter },
          cited: { kind: "turn", id: anchor },
          relation: "narrows",
          provenance: "judged",
        },
        {
          citing: { kind: "turn", id: structuredCiter },
          cited: { kind: "turn", id: foreignTurn },
          relation: "verifies",
          provenance: "judged",
        },
      ],
      500,
    );
  });

  afterEach(() => {
    db.close();
  });

  test("carries one entry per turn, including turns that cite nothing", () => {
    const effective = getSessionEffectiveCitations(db, sessionA);

    expect([...effective.keys()]).toEqual([
      anchor,
      legacyCiter,
      structuredCiter,
      selfCiter,
    ]);
    // No per-turn "which source decided this" any more: both are always read,
    // so the only question left is what the union resolved to.
    expect(effective.get(anchor)?.citedTurnIds).toEqual([]);
    expect(effective.get(legacyCiter)?.edges).toEqual([]);
    expect(effective.get(structuredCiter)?.edges).not.toEqual([]);
  });

  test("resolves ids and drops dangling, cross-session and self citations", () => {
    const effective = getSessionEffectiveCitations(db, sessionA);

    // Prose side: T4242 is dangling and the foreign turn is another session's.
    expect(effective.get(legacyCiter)?.citedTurnIds).toEqual([anchor]);
    // Structured side contributes `anchor` (the cross-session edge stays out of
    // the session view even though it is persisted as provenance), and this
    // turn's prose independently names `legacyCiter` — the union carries both.
    expect(effective.get(structuredCiter)?.citedTurnIds).toEqual([
      anchor,
      legacyCiter,
    ]);
    expect(effective.get(structuredCiter)?.edges.map((e) => e.citedTurnId)).toEqual([
      anchor,
    ]);
    expect(getTurnCitations(db, structuredCiter)).toHaveLength(2);
    // A turn citing itself confirms nothing.
    expect(effective.get(selfCiter)?.citedTurnIds).toEqual([]);
  });

  // The exact population the union exists to recover: settlement wrote a
  // structured edge (the live rows were `supersedes`, a word lane-model-v12
  // ticket 03 retired; the fixture writes `narrows`), and the prose says
  // nothing. Under the
  // retired `cites_recorded` gate this turn read as citing NOTHING unless a
  // writer had separately flagged it — 353 turns were in that state on the
  // live database, and the reversal they recorded was invisible to the
  // correction graph the timeline builds from this very map.
  test("a settlement edge on a turn with no inline citation reaches the graph", () => {
    db.query("UPDATE turns SET content = NULL WHERE id = ?").run(
      structuredCiter,
    );

    const entry = getSessionEffectiveCitations(db, sessionA).get(structuredCiter)!;
    expect(entry.citedTurnIds).toEqual([anchor]);
    expect(entry.edges.map((edge) => edge.relation)).toEqual(["narrows"]);
    expect(getSessionCitationInDegree(db, sessionA).get(anchor)).toBe(2);
  });

  // The batched reader dedupes per target, and the existing fixture cannot see
  // it: its structured and prose targets differ, so swapping `appendUnseen` for
  // a raw append would stay green while double-counting in-degree. This pins
  // the same target named by BOTH sources.
  test("a target named by both an edge and the prose counts once, not twice", () => {
    db.query("UPDATE turns SET content = ? WHERE id = ?").run(
      `narrows [T${anchor}]`,
      structuredCiter,
    );

    const effective = getSessionEffectiveCitations(db, sessionA);
    const entry = effective.get(structuredCiter)!;
    expect(entry.citedTurnIds).toEqual([anchor]);
    expect(entry.citedTurnIds.filter((id) => id === anchor)).toHaveLength(1);

    // legacyCiter also cites anchor, so the honest count is 2 — never 3.
    expect(getSessionCitationInDegree(db, sessionA).get(anchor)).toBe(2);
  });

  test("in-degree counts legacy citers, not just structured ones", () => {
    const inDegree = getSessionCitationInDegree(db, sessionA);

    // One structured citer + one legacy citer whose only signal is inline
    // prose. Reading turn_citations alone would say 1.
    expect(inDegree.get(anchor)).toBe(2);
    expect(inDegree.has(foreignTurn)).toBe(false);
    expect(inDegree.has(selfCiter)).toBe(false);
  });

});

// Indexes-rescope spec law 8 / ticket 03: before this ticket NONE of
// citations.ts's four read functions filtered `was_rolled_back` or `status`
// at all — a rolled-back or skipped turn's edges and prose citations counted
// toward in-degree and citation listings exactly like a live turn's. This
// describe block pins the shared predicate at every one of those four
// functions.
describe("deleted/dormant node predicate (indexes-rescope spec law 8, ticket 03)", () => {
  let db: Database;
  let sessionId: number;

  const insertTurn = (
    promptNumber: number,
    options: { status?: string; wasRolledBack?: boolean; content?: string | null } = {},
  ): number =>
    db
      .query<{ id: number }, [number, number, string, number, string | null]>(
        `INSERT INTO turns (session_id, prompt_number, status, was_rolled_back, content, title, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, 'fixture', 100) RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.status ?? "extracted",
        options.wasRolledBack ? 1 : 0,
        options.content ?? null,
      )!.id;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "citations-liveness",
      project: "claude-mnemo",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("getTurnCitations excludes an edge whose CITED turn is rolled back, and returns nothing for a rolled-back CITING turn", () => {
    const live = insertTurn(1);
    const rolledBackTarget = insertTurn(2, { wasRolledBack: true });
    const rolledBackCiter = insertTurn(3, { wasRolledBack: true });
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: live },
          cited: { kind: "turn", id: rolledBackTarget },
          relation: "consume",
          provenance: "asserted",
        },
        {
          citing: { kind: "turn", id: rolledBackCiter },
          cited: { kind: "turn", id: live },
          relation: "consume",
          provenance: "asserted",
        },
      ],
      500,
    );

    expect(getTurnCitations(db, live)).toEqual([]);
    expect(getTurnCitations(db, rolledBackCiter)).toEqual([]);
  });

  test("getEffectiveCitations drops a prose reference to a rolled-back turn the same way it drops a dangling one", () => {
    const rolledBackTarget = insertTurn(1, { wasRolledBack: true });
    const citer = insertTurn(2, { content: `reverses [T${rolledBackTarget}]` });

    expect(getEffectiveCitations(db, getTurnById(db, citer)!)).toEqual({
      citedTurnIds: [],
      edges: [],
    });
  });

  // The full round trip through the REAL promotion path, not a hand-set
  // status: an edge is written while the target is still live, session-end
  // abandonment (simulated the way schema.ts's own sweep would leave it)
  // marks the target `skipped`, and only `db/turns.ts`'s `promoteTurnFromNote`
  // — the actual "a late note lands on a backlog turn" transition — brings it
  // back. Covers `getSessionEffectiveCitations` and its `getSessionCitationInDegree`
  // derivative in one pass.
  test("a skipped turn's citations vanish while skipped and return, edges included and unrewritten, after the real promotion path", () => {
    const anchor = insertTurn(1);
    const dormant = insertTurn(2, { status: "active" });
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: dormant },
          cited: { kind: "turn", id: anchor },
          relation: "consume",
          provenance: "asserted",
        },
      ],
      500,
    );
    db.query("UPDATE turns SET status = 'skipped' WHERE id = ?").run(dormant);

    const whileSkipped = getSessionEffectiveCitations(db, sessionId);
    // Absent as a KEY — not "present with an empty list" — because a dormant
    // turn is not a node at all.
    expect(whileSkipped.has(dormant)).toBe(false);
    expect(getSessionCitationInDegree(db, sessionId).get(anchor)).toBeUndefined();

    promoteTurnFromNote(db, dormant, {
      title: "late note",
      content: "closes the backlog",
      insight: null,
      updatedAtEpoch: 600,
    });

    const restored = getSessionEffectiveCitations(db, sessionId);
    expect(restored.get(dormant)?.citedTurnIds).toEqual([anchor]);
    // The edge itself: same relation, same original timestamp — never
    // rewritten by the promotion, only re-exposed.
    expect(restored.get(dormant)?.edges).toEqual([
      { citingTurnId: dormant, citedTurnId: anchor, relation: "consume", createdAtEpoch: 500 },
    ]);
    expect(getSessionCitationInDegree(db, sessionId).get(anchor)).toBe(1);
  });

  // Behavior parity: a fixture with nothing skipped or rolled back must read
  // exactly as it did before this ticket (the predicate is a no-op absent
  // dead/dormant rows). Reproduces the shape of the pre-existing "session-wide
  // effective citations" fixture above in miniature.
  test("behavior parity: an ordinary two-turn citation with nothing skipped or rolled back is unaffected", () => {
    const anchor = insertTurn(1);
    const citer = insertTurn(2, { content: `builds on [T${anchor}]` });

    const effective = getSessionEffectiveCitations(db, sessionId);
    expect([...effective.keys()]).toEqual([anchor, citer]);
    expect(effective.get(citer)?.citedTurnIds).toEqual([anchor]);
    expect(getSessionCitationInDegree(db, sessionId).get(anchor)).toBe(1);
  });
});
