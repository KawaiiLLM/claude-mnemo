import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  parseQualifiedReferences,
  resolveContentReferences,
  validateReferences,
} from "../../src/db/references";
import { initializeSchema } from "../../src/db/schema";
import { createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

describe("qualified reference parsing and validation", () => {
  let db: Database;
  let sessionId: number;
  let otherSessionId: number;

  function addTurn(sessionDbId: number, promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, ?, 'extracted', 100)
         RETURNING id`,
      )
      .get(sessionDbId, promptNumber)!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-refs",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    otherSessionId = upsertSession(db, {
      contentSessionId: "session-refs-other",
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

  describe("parser", () => {
    test("accepts the three legal shapes", () => {
      const parsed = parseQualifiedReferences(
        "Builds on [S15069/T332], annotated [S15069/T333 approval], and segment [E47].",
      );

      expect(parsed).toEqual([
        { kind: "turn", raw: "[S15069/T332]", sessionId: 15069, promptNumber: 332 },
        {
          kind: "turn",
          raw: "[S15069/T333 approval]",
          sessionId: 15069,
          promptNumber: 333,
        },
        { kind: "segment", raw: "[E47]", segmentId: 47 },
      ]);
    });

    test("de-duplicates on the address, keeping first-seen order", () => {
      const parsed = parseQualifiedReferences("[E47] [S1/T2] [S1/T2] [E47]");
      expect(parsed).toHaveLength(2);
      expect(parsed[0]?.kind).toBe("segment");
      expect(parsed[1]?.kind).toBe("turn");
    });

    test("ignores the abolished bare form and other prose brackets", () => {
      expect(
        parseQualifiedReferences(
          "[T332] [S15069] [see S1/T2] [S1/T2, S1/T3] [dbid:T12] [S1 / T2\n]",
        ),
      ).toEqual([]);
    });

    test("a nested or padded bracket yields nothing — the malformed bracket is skipped whole", () => {
      // Each of these is a construct a reader would never take as a citation,
      // and the doc comment already promised they are skipped whole rather
      // than salvaged down to the id they happen to contain. Listed one per
      // case, not folded into an array, so a regex change names which shape
      // it broke.
      expect(parseQualifiedReferences("[[S1/T2]]")).toEqual([]);
      expect(parseQualifiedReferences("[foo [S1/T2]]")).toEqual([]);
      expect(parseQualifiedReferences("[[S1/T2] ]")).toEqual([]);
      expect(parseQualifiedReferences("[[E47]]")).toEqual([]);
      expect(parseQualifiedReferences("[see [S1/T2] and [S1/T3]]")).toEqual([]);
    });

    test("an ordinary bracket beside other punctuation still parses", () => {
      // The guard above must not swallow the legitimate neighbours: a citation
      // in parentheses, at a string boundary, or adjacent to a second one.
      expect(parseQualifiedReferences("([S1/T2])")).toHaveLength(1);
      expect(parseQualifiedReferences("[S1/T2]")).toHaveLength(1);
      expect(parseQualifiedReferences("[S1/T2] [S1/T3]")).toHaveLength(2);
      expect(parseQualifiedReferences("done [E47].")).toHaveLength(1);
    });

    test("tolerates whitespace around the slash", () => {
      expect(parseQualifiedReferences("[ S15069 / T332 ]")).toEqual([
        { kind: "turn", raw: "[ S15069 / T332 ]", sessionId: 15069, promptNumber: 332 },
      ]);
    });
  });

  // THE BARE GRAMMAR, TESTED AS ITSELF (re-review round, finding 5). Ticket 11
  // shipped the unbracketed form with no parser test of its own — the tests
  // titled "bare" elsewhere in this suite mean "unattributed" (no relation
  // word) or "the abolished `[T332]` form", and every one of them feeds
  // BRACKETED input, so deleting `BARE_REFERENCE_PATTERN` left them all green.
  // Each test below FAILS with that constant removed, which is the property
  // that makes them acceptance tests rather than decoration.
  describe("the bare (unbracketed) grammar", () => {
    test("a bare turn address in free text is a citation", () => {
      expect(parseQualifiedReferences("Builds on S15069/T332.")).toEqual([
        { kind: "turn", raw: "S15069/T332", sessionId: 15069, promptNumber: 332 },
      ]);
    });

    test("a bare segment address in free text is a citation", () => {
      expect(parseQualifiedReferences("Continues the arc E47 started.")).toEqual([
        { kind: "segment", raw: "E47", segmentId: 47 },
      ]);
    });

    test("bracket and bare interleave in document order", () => {
      expect(
        parseQualifiedReferences("first [S1/T2], then S1/T3, then [E47], then E48."),
      ).toEqual([
        { kind: "turn", raw: "[S1/T2]", sessionId: 1, promptNumber: 2 },
        { kind: "turn", raw: "S1/T3", sessionId: 1, promptNumber: 3 },
        { kind: "segment", raw: "[E47]", segmentId: 47 },
        { kind: "segment", raw: "E48", segmentId: 48 },
      ]);
    });

    test("the two grammars de-duplicate onto one address, first-seen `raw` winning", () => {
      // Bracket first, then bare: one reference, carrying the bracketed raw.
      expect(parseQualifiedReferences("[S1/T2] and again S1/T2")).toEqual([
        { kind: "turn", raw: "[S1/T2]", sessionId: 1, promptNumber: 2 },
      ]);
      // And the other way round, so the winner is document order, not a
      // grammar precedence.
      expect(parseQualifiedReferences("S1/T2 and again [S1/T2]")).toEqual([
        { kind: "turn", raw: "S1/T2", sessionId: 1, promptNumber: 2 },
      ]);
      expect(parseQualifiedReferences("E47 [E47] E47")).toHaveLength(1);
    });

    test("the ASCII word boundary holds against identifiers, and only those", () => {
      // What `\b` DOES exclude: ASCII letters, digits and `_` on either side.
      expect(parseQualifiedReferences("TYPE47")).toEqual([]);
      expect(parseQualifiedReferences("S1/T2x")).toEqual([]);
      expect(parseQualifiedReferences("xS1/T2")).toEqual([]);
      expect(parseQualifiedReferences("_E7")).toEqual([]);
      expect(parseQualifiedReferences("E7_")).toEqual([]);
      // What it does NOT, on purpose (see the pattern's own doc comment):
      // non-ASCII letters are word BOUNDARIES, so a citation flush against a
      // Chinese sentence still cites — this project's prose is mixed script.
      expect(parseQualifiedReferences("承接甲S1/T2乙的判断")).toHaveLength(1);
      // Paths, URLs and code spans are citation-bearing by the same rule, and
      // the policy is that they should be: a real address is a real address.
      expect(parseQualifiedReferences("see docs/S1/T2.md")).toHaveLength(1);
      expect(parseQualifiedReferences("see https://example.test/S1/T2")).toHaveLength(1);
      expect(parseQualifiedReferences("see `S1/T2`")).toHaveLength(1);
    });

    test("an unterminated bracket makes the whole tail opaque", () => {
      // RE-REVIEW FINDING 2, the regression this test exists for: the splitter
      // used to break out of its walk WITHOUT advancing the text cursor, so
      // the tail — the stray `[` included — was pushed as free text and the
      // bare scan minted a citation out of bracket-grammar prose. A historical
      // malformed note would have GROWN citations the moment anything
      // re-parsed it.
      expect(parseQualifiedReferences("prose [see S1/T2")).toEqual([]);
      expect(parseQualifiedReferences("prose [see E47")).toEqual([]);
      // Nested and unterminated: same answer, and the inner `]` must not be
      // mistaken for the outer group's close.
      expect(parseQualifiedReferences("prose [foo [S1/T2]")).toEqual([]);
      expect(parseQualifiedReferences("prose [[S1/T2]")).toEqual([]);
      // Everything BEFORE the stray `[` is ordinary free text and still cites.
      expect(parseQualifiedReferences("S1/T9 then [see S1/T2")).toEqual([
        { kind: "turn", raw: "S1/T9", sessionId: 1, promptNumber: 9 },
      ]);
      // A well-formed group earlier in the body is unaffected too.
      expect(parseQualifiedReferences("[E47] then [see S1/T2")).toEqual([
        { kind: "segment", raw: "[E47]", segmentId: 47 },
      ]);
    });

    test("a historical malformed body mints nothing new on re-parse", () => {
      // The fixture is the shape ticket 11's own doc comment promised was
      // byte-stable: every malformed/nested construct this suite already
      // pins, plus an unterminated tail, in one body. It parsed to nothing
      // before the bare grammar existed and must still parse to nothing.
      const historical =
        "[[S1/T2]] [foo [S1/T3]] [see [S1/T4] and [S1/T5]] [dbid:T12] [S1 / T6\n] " +
        "and finally [see S1/T7 for the rest";
      expect(parseQualifiedReferences(historical)).toEqual([]);
    });
  });

  describe("validation against the exposure ledger", () => {
    test("accepts a reference that resolves and was shown to the writer", () => {
      const rideTurn = addTurn(sessionId, 10);
      const cited = addTurn(sessionId, 3);

      const result = resolveContentReferences(db, `builds on [S${sessionId}/T3]`, {
        writerSessionId: sessionId,
        logger: { warn: () => {} },
      });

      expect(result.rejected).toHaveLength(0);
      expect(result.accepted).toHaveLength(1);
      expect(result.accepted[0]?.node).toEqual({ kind: "turn", id: cited });
    });

    test("rejects an id that names no turn, and logs it instead of writing it", () => {
      const rideTurn = addTurn(sessionId, 10);
      const logged: unknown[] = [];

      const result = resolveContentReferences(db, `[S${sessionId}/T9999]`, {
        writerSessionId: sessionId,
        logger: { warn: (...args: unknown[]) => logged.push(args) },
      });

      expect(result.accepted).toHaveLength(0);
      expect(result.rejected[0]?.reason).toBe("unresolved");
      expect(String(logged[0])).toContain("unresolved");
    });

    // Replaces "rejects an existing turn the writer was never shown". The
    // exposure gate is removed: the ledger only ever recorded the addresses
    // the note machinery handed over, never what a session read, so once
    // prose citations became the only way to create an edge it dropped any
    // citation of a turn found through recall or timeline — 55% of this
    // project's own turns. And whether an agent saw something is not
    // auditable in the first place; existence is.
    test("accepts an existing turn the writer was never handed, since existence is the only gate", () => {
      const rideTurn = addTurn(sessionId, 10);
      addTurn(otherSessionId, 4);
      const logged: unknown[] = [];

      const result = resolveContentReferences(db, `[S${otherSessionId}/T4]`, {
        writerSessionId: sessionId,
        logger: { warn: (...args: unknown[]) => logged.push(args) },
      });

      expect(result.accepted.map((entry) => entry.node.kind)).toEqual(["turn"]);
      expect(result.rejected).toHaveLength(0);
      expect(logged).toHaveLength(0);
    });

    test("a cross-session reference passes once it IS in the ledger", () => {
      const rideTurn = addTurn(sessionId, 10);
      const foreign = addTurn(otherSessionId, 4);

      const result = resolveContentReferences(db, `[S${otherSessionId}/T4]`, {
        writerSessionId: sessionId,
        logger: { warn: () => {} },
      });

      expect(result.accepted[0]?.node).toEqual({ kind: "turn", id: foreign });
    });

    test("a segment reference is accepted when it resolves and dropped when it does not", () => {
      const segment = createSegment(db, { title: "实现 段引用", nowEpoch: 100 });
      const references = parseQualifiedReferences(`[E${segment.id}] [E9999]`);

      const result = validateReferences(db, references, {
        writerSessionId: sessionId,
        logger: { warn: () => {} },
      });

      // One rule for both reference kinds now. The caller-supplied
      // `exposedSegmentIds` escape hatch is gone with the gate it fed.
      expect(result.accepted.map((entry) => entry.node)).toEqual([
        { kind: "segment", id: segment.id },
      ]);
      expect(result.rejected.map((entry) => entry.reason)).toEqual(["unresolved"]);
    });
  });
});
