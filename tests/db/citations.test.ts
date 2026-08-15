import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

import {
  getEffectiveCitations,
  getSessionCitationInDegree,
  getSessionEffectiveCitations,
  getTurnCitations,
  parseInlineCitations,
  replaceTurnCitations,
} from "../../src/db/citations";
import { createDatabase } from "../../src/db/database";
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

describe("turn_citations edge table", () => {
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

  test("writes edges and records the flag", () => {
    const result = replaceTurnCitations(
      db,
      turns[2]!,
      [
        { id: turns[0]!, relation: "supersedes" },
        { id: turns[1]!, relation: "evidence-for" },
      ],
      500,
    );

    expect(result.droppedIds).toEqual([]);
    expect(getTurnCitations(db, turns[2]!)).toEqual([
      {
        citingTurnId: turns[2]!,
        citedTurnId: turns[0]!,
        relation: "supersedes",
        createdAtEpoch: 500,
      },
      {
        citingTurnId: turns[2]!,
        citedTurnId: turns[1]!,
        relation: "evidence-for",
        createdAtEpoch: 500,
      },
    ]);
    expect(getTurnById(db, turns[2]!)?.citesRecorded).toBe(true);
  });

  test("replaces the whole edge set on resend instead of accumulating", () => {
    replaceTurnCitations(
      db,
      turns[2]!,
      [{ id: turns[0]!, relation: "evidence-for" }],
      500,
    );
    replaceTurnCitations(
      db,
      turns[2]!,
      [{ id: turns[1]!, relation: "depends-on" }],
      600,
    );

    expect(getTurnCitations(db, turns[2]!)).toEqual([
      {
        citingTurnId: turns[2]!,
        citedTurnId: turns[1]!,
        relation: "depends-on",
        createdAtEpoch: 600,
      },
    ]);
  });

  test("an explicit empty set clears the edges and keeps the flag recorded", () => {
    replaceTurnCitations(
      db,
      turns[2]!,
      [{ id: turns[0]!, relation: "evidence-for" }],
      500,
    );
    replaceTurnCitations(db, turns[2]!, [], 600);

    expect(getTurnCitations(db, turns[2]!)).toEqual([]);
    expect(getTurnById(db, turns[2]!)?.citesRecorded).toBe(true);
  });

  test("de-duplicates a repeated identical edge but rejects a conflicting relation on the same target (spec C5)", () => {
    const result = replaceTurnCitations(
      db,
      turns[2]!,
      [
        { id: turns[0]!, relation: "evidence-for" },
        { id: turns[0]!, relation: "evidence-for" },
        { id: turns[0]!, relation: "supersedes" },
      ],
      500,
    );

    // The identical repeat collapses silently; the same target under a
    // SECOND, different relation is dropped — a pair carries at most one
    // current relation, and a single batch cannot say which of two claims
    // about the same pair is the correction.
    expect(result.written).toHaveLength(1);
    expect(result.droppedIds).toEqual([turns[0]!]);
    expect(
      getTurnCitations(db, turns[2]!).map((edge) => edge.relation),
    ).toEqual(["evidence-for"]);
  });

  test("drops unresolvable and self ids with a log line and writes the rest", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = replaceTurnCitations(
        db,
        turns[2]!,
        [
          { id: turns[0]!, relation: "evidence-for" },
          { id: 999_999, relation: "evidence-for" },
          { id: turns[2]!, relation: "supersedes" },
        ],
        500,
      );

      expect(result.droppedIds).toEqual([999_999, turns[2]!]);
      expect(
        getTurnCitations(db, turns[2]!).map((edge) => edge.citedTurnId),
      ).toEqual([turns[0]!]);
      expect(warn.mock.calls.at(0)?.[0]).toContain("999999");
    } finally {
      warn.mockRestore();
    }
  });

  test("drops semantically invalid integer ids per edge instead of per call", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = replaceTurnCitations(
        db,
        turns[2]!,
        [
          { id: 0, relation: "evidence-for" },
          { id: -3, relation: "evidence-for" },
          { id: 999_999, relation: "evidence-for" },
          { id: turns[2]!, relation: "supersedes" },
          { id: turns[0]!, relation: "depends-on" },
        ],
        500,
      );

      expect(result.droppedIds).toEqual([0, -3, 999_999, turns[2]!]);
      expect(result.written).toHaveLength(1);
      expect(getTurnCitations(db, turns[2]!)).toEqual([
        {
          citingTurnId: turns[2]!,
          citedTurnId: turns[0]!,
          relation: "depends-on",
          createdAtEpoch: 500,
        },
      ]);
      expect(getTurnById(db, turns[2]!)?.citesRecorded).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("rolls the whole replace-set back when one insert fails", () => {
    replaceTurnCitations(
      db,
      turns[2]!,
      [{ id: turns[0]!, relation: "evidence-for" }],
      500,
    );
    db.exec(`
      CREATE TRIGGER block_citation BEFORE INSERT ON memory_edges
      WHEN NEW.cited_kind = 'turn' AND NEW.cited_id = ${turns[1]!}
      BEGIN SELECT RAISE(ABORT, 'citation write blocked'); END;
    `);

    // No enclosing transaction: the operation must be atomic on its own, or a
    // direct caller publishes a cleared/half-written set.
    expect(() =>
      replaceTurnCitations(
        db,
        turns[2]!,
        [
          { id: turns[0]!, relation: "supersedes" },
          { id: turns[1]!, relation: "evidence-for" },
        ],
        600,
      ),
    ).toThrow();

    expect(getTurnCitations(db, turns[2]!)).toEqual([
      {
        citingTurnId: turns[2]!,
        citedTurnId: turns[0]!,
        relation: "evidence-for",
        createdAtEpoch: 500,
      },
    ]);

    // …and a first-ever write that fails leaves the flag unrecorded.
    expect(() =>
      replaceTurnCitations(
        db,
        turns[3]!,
        [{ id: turns[1]!, relation: "evidence-for" }],
        600,
      ),
    ).toThrow();
    expect(getTurnCitations(db, turns[3]!)).toEqual([]);
    expect(getTurnById(db, turns[3]!)?.citesRecorded).toBe(false);
  });

  test("writes cross-session edges but excludes them from session-local in-degree", () => {
    // Two same-session citers of turns[0], one cross-session citer, and one
    // outbound cross-session edge.
    replaceTurnCitations(
      db,
      turns[1]!,
      [{ id: turns[0]!, relation: "depends-on" }],
      500,
    );
    replaceTurnCitations(
      db,
      turns[2]!,
      [
        { id: turns[0]!, relation: "supersedes" },
        { id: foreignTurn, relation: "evidence-for" },
      ],
      500,
    );
    replaceTurnCitations(
      db,
      foreignTurn,
      [{ id: turns[0]!, relation: "depends-on" }],
      500,
    );

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

  test("a rejected second relation on the same pair does not inflate in-degree", () => {
    // Under spec C5 a pair carries at most one relation, so "files several
    // relations" for the SAME target can no longer happen — the second is
    // dropped (covered above). What must still hold is that in-degree counts
    // the one surviving relation once, not zero and not twice.
    replaceTurnCitations(
      db,
      turns[1]!,
      [
        { id: turns[0]!, relation: "evidence-for" },
        { id: turns[0]!, relation: "supersedes" },
      ],
      500,
    );

    expect(getTurnCitations(db, turns[1]!)).toHaveLength(1);
    expect(getSessionCitationInDegree(db, sessionA).get(turns[0]!)).toBe(1);
  });

  // `memory_edges.citing_id`/`cited_id` carry no FOREIGN KEY at all (they
  // cannot: one INTEGER column is shared across turn, segment and session id
  // spaces, so a single REFERENCES clause can never be correct). This is not
  // new to ticket 05 — the table has always lacked it — but retiring
  // `turn_citations` (which DID cascade via `ON DELETE CASCADE`) means this
  // gap now applies to turn↔turn citations too. Deleting a turn or session
  // ORPHANS its edges rather than removing them. This is deliberately left
  // for the ticket that owns memory_edges's delete semantics (recompute-and-
  // delete on a rewritten body) to account for — these two tests PIN the
  // current gap so it is not silently reintroduced as "already handled".
  test("deleting the cited endpoint's session orphans the edge rather than cascading (known gap, not this ticket's to close)", () => {
    replaceTurnCitations(
      db,
      turns[1]!,
      [{ id: turns[0]!, relation: "depends-on" }],
      500,
    );
    replaceTurnCitations(
      db,
      foreignTurn,
      [{ id: turns[0]!, relation: "evidence-for" }],
      500,
    );
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM memory_edges WHERE citing_kind = 'turn' AND cited_kind = 'turn'",
      ).get()!.count,
    ).toBe(2);

    db.query("DELETE FROM sessions WHERE id = ?").run(sessionA);

    // The turns are gone (CASCADE on turns.session_id is intact), but the
    // edges that named them survive, dangling.
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM turns").get()!
        .count,
    ).toBe(1); // only foreignTurn (session B) remains
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM memory_edges WHERE citing_kind = 'turn' AND cited_kind = 'turn'",
      ).get()!.count,
    ).toBe(2);
  });

  test("deleting the citing endpoint's session orphans the edge rather than cascading (known gap, not this ticket's to close)", () => {
    replaceTurnCitations(
      db,
      turns[1]!,
      [{ id: turns[0]!, relation: "depends-on" }],
      500,
    );
    replaceTurnCitations(
      db,
      foreignTurn,
      [{ id: turns[0]!, relation: "evidence-for" }],
      500,
    );

    db.query("DELETE FROM sessions WHERE id = ?").run(sessionB);

    // Both edges are still there; the foreign one now names a citing_id that
    // resolves to no live turn.
    expect(
      db
        .query<{ citingTurnId: number }, []>(
          `SELECT citing_id AS citingTurnId FROM memory_edges
           WHERE citing_kind = 'turn' AND cited_kind = 'turn'
           ORDER BY citing_id`,
        )
        .all(),
    ).toEqual([{ citingTurnId: turns[1]! }, { citingTurnId: foreignTurn }]);
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

  test("falls back to inline parsing while the flag is unset", () => {
    const turn = getTurnById(db, citerId)!;
    expect(turn.citesRecorded).toBe(false);
    // T4242 names no turn: the parser is DB-blind and returns it, this layer
    // resolves and drops it.
    expect(getEffectiveCitations(db, turn)).toEqual({
      source: "inline",
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

  test("a recorded empty set means genuinely none, not legacy absence", () => {
    replaceTurnCitations(db, citerId, [], 500);

    const effective = getEffectiveCitations(db, getTurnById(db, citerId)!);
    expect(effective.source).toBe("structured");
    expect(effective.citedTurnIds).toEqual([]);
    // The inline `[T…]` text is still in the content and is deliberately ignored.
    expect(getTurnById(db, citerId)?.content).toContain(`[T${citedId}]`);
  });

  test("structured edges win over disagreeing inline text", () => {
    replaceTurnCitations(
      db,
      citerId,
      [{ id: citedId, relation: "supersedes" }],
      500,
    );

    const effective = getEffectiveCitations(db, getTurnById(db, citerId)!);
    expect(effective.source).toBe("structured");
    // 4242 is inline-only and dangling; the edge table does not carry it.
    expect(effective.citedTurnIds).toEqual([citedId]);
    expect(effective.edges.map((edge) => edge.relation)).toEqual(["supersedes"]);
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
    // Post-deployment turn: prose disagrees with the edges, edges win.
    structuredCiter = insertTurn(sessionA, 3, `mentions [T${legacyCiter}]`);
    selfCiter = insertTurn(sessionA, 4, `revisits [T4243]`);
    db.query("UPDATE turns SET content = ? WHERE id = ?").run(
      `revisits [T${selfCiter}]`,
      selfCiter,
    );

    replaceTurnCitations(
      db,
      structuredCiter,
      [
        { id: anchor, relation: "supersedes" },
        { id: foreignTurn, relation: "evidence-for" },
      ],
      500,
    );
  });

  afterEach(() => {
    db.close();
  });

  test("carries one entry per turn, with the source that decided it", () => {
    const effective = getSessionEffectiveCitations(db, sessionA);

    expect([...effective.keys()]).toEqual([
      anchor,
      legacyCiter,
      structuredCiter,
      selfCiter,
    ]);
    expect(effective.get(legacyCiter)?.source).toBe("inline");
    expect(effective.get(structuredCiter)?.source).toBe("structured");
    expect(effective.get(anchor)?.citedTurnIds).toEqual([]);
  });

  test("resolves ids and drops dangling, cross-session and self citations", () => {
    const effective = getSessionEffectiveCitations(db, sessionA);

    // Legacy path: T4242 is dangling and the foreign turn is another session's.
    expect(effective.get(legacyCiter)?.citedTurnIds).toEqual([anchor]);
    // Structured path: the cross-session edge stays out of the session view even
    // though it is persisted as provenance.
    expect(effective.get(structuredCiter)?.citedTurnIds).toEqual([anchor]);
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

  test("a recorded empty set retracts what the prose still says", () => {
    replaceTurnCitations(db, legacyCiter, [], 600);

    const effective = getSessionEffectiveCitations(db, sessionA);
    expect(effective.get(legacyCiter)?.source).toBe("structured");
    expect(effective.get(legacyCiter)?.citedTurnIds).toEqual([]);
    expect(getSessionCitationInDegree(db, sessionA).get(anchor)).toBe(1);
  });
});
