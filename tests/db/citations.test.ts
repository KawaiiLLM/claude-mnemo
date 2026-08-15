import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import {
  getEffectiveCitations,
  getSessionCitationInDegree,
  getSessionEffectiveCitations,
  getTurnCitations,
  parseInlineCitations,
  recomputeTurnCitedPairs,
} from "../../src/db/citations";
import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { recordNoteIdExposure } from "../../src/db/note-debt";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";

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
    relation: "evidence-for" | "supersedes" | "depends-on",
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
    // getSessionCitationInDegree/getEffectiveCitations read the structured
    // edge only once this flag is set (spec §B's from-absent-vs-recorded-empty
    // predicate) — the retired `replaceTurnCitations` used to flip it in the
    // same transaction as the edge write; a raw `writeMemoryEdges` call does
    // not, so tests that read through the effective-citations layer set it
    // by hand here, same as `writeMemoryEdges`'s other direct callers do.
    db.query("UPDATE turns SET cites_recorded = 1 WHERE id = ?").run(
      citingTurnId,
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
    citeFrom(turns[1]!, turns[0]!, "depends-on");
    citeFrom(turns[2]!, turns[0]!, "supersedes");
    citeFrom(turns[2]!, foreignTurn, "evidence-for");
    citeFrom(foreignTurn, turns[0]!, "depends-on");

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

  test("a corrected relation on the same pair does not inflate in-degree", () => {
    // Under spec C5 a pair carries at most one current relation: a SECOND
    // write to the same pair replaces the relation in place rather than
    // adding a second row (memory-edges.test.ts covers the upsert itself).
    // What must still hold here is that in-degree counts the one surviving
    // pair once, not zero and not twice.
    citeFrom(turns[1]!, turns[0]!, "evidence-for");
    citeFrom(turns[1]!, turns[0]!, "supersedes");

    expect(getTurnCitations(db, turns[1]!)).toEqual([
      {
        citingTurnId: turns[1]!,
        citedTurnId: turns[0]!,
        relation: "supersedes",
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
    citeFrom(turns[1]!, turns[0]!, "depends-on");
    citeFrom(foreignTurn, turns[0]!, "evidence-for");
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
       VALUES ('session', ?, 'turn', ?, 'depends-on', 'asserted', 500)`,
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
    citeFrom(turns[1]!, turns[0]!, "depends-on");
    citeFrom(foreignTurn, turns[0]!, "evidence-for");

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

  test("rejects a duplicate (citing, cited) pair at the composite key (spec C5: relation is not part of identity)", () => {
    const insert = db.query<unknown, [number, number, string | null]>(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
       VALUES ('turn', ?, 'turn', ?, ?, 'judged', 1)`,
    );
    insert.run(turns[1]!, turns[0]!, "evidence-for");

    // A raw second insert of the SAME pair — even under a different relation
    // — hits the primary key: the pair is the identity now, not the triple.
    expect(() => insert.run(turns[1]!, turns[0]!, "supersedes")).toThrow();
    expect(getTurnCitations(db, turns[1]!)).toHaveLength(1);
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
  function exposeAll(rideTurnId: number, exposedTurnIds: readonly number[]): void {
    recordNoteIdExposure(db, {
      sessionId,
      rideTurnId,
      exposedTurnIds,
      source: "reminder",
      nowEpoch: 100,
    });
  }

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
    exposeAll(turns[3]!, [turns[0]!]);

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
    exposeAll(turns[3]!, [turns[0]!, turns[1]!]);

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
    exposeAll(turns[3]!, [turns[0]!, turns[1]!]);

    recomputeTurnCitedPairs(
      db,
      turns[2]!,
      { title: null, content: `[S${sessionId}/T1] and [S${sessionId}/T2].`, insight: null },
      500,
      sessionId,
    );
    // A relation lands on the T1 pair from elsewhere (settlement, in
    // production) — spec C7's "attach a relation on a pair that already
    // exists" case, not this function's own job to create.
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: turns[2]! },
          cited: { kind: "turn", id: turns[0]! },
          relation: "supersedes",
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
    exposeAll(turns[3]!, [turns[0]!]);
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
          relation: "evidence-for",
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
    expect(surviving[0]?.relation).toBe("evidence-for");
  });

  test("a reference to a turn this session was never shown is dropped, not written", () => {
    // turns[0] deliberately NOT exposed.
    const result = recomputeTurnCitedPairs(
      db,
      turns[2]!,
      { title: null, content: `[S${sessionId}/T1].`, insight: null },
      500,
      sessionId,
    );

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("unexposed");
    expect(getOutgoingEdges(db, { kind: "turn", id: turns[2]! })).toEqual([]);
  });

  test("a cross-session reference is written as provenance", () => {
    const foreign = insertTurn(otherSessionId, 1);
    exposeAll(turns[3]!, [foreign]);

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
    db.query("UPDATE turns SET cites_recorded = 1 WHERE id = ?").run(citerId);

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
          relation: "supersedes",
          provenance: "judged",
        },
      ],
      500,
    );
    db.query("UPDATE turns SET cites_recorded = 1 WHERE id = ?").run(citerId);

    const effective = getEffectiveCitations(db, getTurnById(db, citerId)!);
    // The pair is named by both sources and counts once; 4242 is inline-only
    // and dangling, so it is still dropped — the union widens the sources, it
    // does not relax resolution.
    expect(effective.citedTurnIds).toEqual([citedId]);
    expect(effective.edges.map((edge) => edge.relation)).toEqual(["supersedes"]);
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
          relation: "depends-on",
          provenance: "judged",
        },
      ],
      500,
    );
    db.query("UPDATE turns SET cites_recorded = 1 WHERE id = ?").run(citerId);

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
    db.query("UPDATE turns SET cites_recorded = 1 WHERE id = ?").run(citerId);

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
          relation: "supersedes",
          provenance: "judged",
        },
        {
          citing: { kind: "turn", id: structuredCiter },
          cited: { kind: "turn", id: foreignTurn },
          relation: "evidence-for",
          provenance: "judged",
        },
      ],
      500,
    );
    db.query("UPDATE turns SET cites_recorded = 1 WHERE id = ?").run(
      structuredCiter,
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

  test("in-degree counts legacy citers, not just structured ones", () => {
    const inDegree = getSessionCitationInDegree(db, sessionA);

    // One structured citer + one `cites_recorded = 0` citer whose only signal is
    // inline prose. Reading turn_citations alone would say 1.
    expect(inDegree.get(anchor)).toBe(2);
    expect(inDegree.has(foreignTurn)).toBe(false);
    expect(inDegree.has(selfCiter)).toBe(false);
  });

  // The batched reader loses the retraction for the same reason the single
  // reader does, and it matters more here: in-degree feeds milestone selection,
  // so a flag nobody sets any more would have silently zeroed a turn's inbound
  // count. Setting it now changes nothing at all.
  test("the retired flag no longer suppresses a turn's prose citations", () => {
    const before = getSessionEffectiveCitations(db, sessionA)
      .get(legacyCiter)?.citedTurnIds;

    db.query("UPDATE turns SET cites_recorded = 1 WHERE id = ?").run(legacyCiter);

    const effective = getSessionEffectiveCitations(db, sessionA);
    expect(effective.get(legacyCiter)?.citedTurnIds).toEqual(before!);
    expect(effective.get(legacyCiter)?.citedTurnIds).toEqual([anchor]);
    // anchor is cited by legacyCiter AND by structuredCiter's edge.
    expect(getSessionCitationInDegree(db, sessionA).get(anchor)).toBe(2);
  });
});
