import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import type {
  RelationClassValue,
  RelationCoverageValue,
} from "../../src/shared/relation-class";
import {
  buildTurnDirectRelationLines,
  buildTurnRelationTreeLines,
} from "../../src/mcp/relations-view";
import { saveTurnFixture as saveTurn } from "../support/turn-fixtures";

/**
 * Settlement-read-once spec D8 (user rulings T2388 "render like timeline, no
 * invented notation" and T2404 "direct out/in edges only, outgoing first, no
 * downstream hops"): `recall`'s `relations` field renders THIS NODE'S OWN
 * EDGES — every outgoing row then every incoming one, both raw lane sides on
 * each, nothing elided.
 *
 * `tests/mcp/relations-view.tree.test.ts` keeps pinning the TREE, which
 * survives on exactly one surface (`timeline(id="S<n>/T<m>")`). This file
 * pins the direct set: its data source, its grammar, and the count it is
 * required to carry whole.
 */
describe("the relations field renders the node's direct edge set (spec D8)", () => {
  let db: Database;
  let sessionId: number;
  let otherSessionId: number;

  const NOW = 700_000;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: `direct-${Math.random()}`,
      project: "claude-mnemo",
      title: "direct fixture",
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    otherSessionId = upsertSession(db, {
      contentSessionId: `direct-other-${Math.random()}`,
      project: "claude-mnemo",
      title: "foreign session",
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  function turn(promptNumber: number, inSession = sessionId): number {
    saveTurn(db, {
      sessionId: inSession,
      promptNumber,
      userPrompt: `p${promptNumber}`,
      assistantResponse: `r${promptNumber}`,
      title: `turn ${promptNumber}`,
      content: `c${promptNumber}`,
      insight: null,
      type: "decision",
      tags: [],
      filesRead: [],
      filesModified: [],
      createdAtEpoch: NOW + promptNumber,
      updatedAtEpoch: NOW + promptNumber,
      observations: [],
    });
    return getTurn(db, inSession, promptNumber)!.id;
  }

  function edge(
    citingId: number,
    citedId: number,
    relation: string,
    tailTag = "",
    headTag = "",
    classification: { relationClass: RelationClassValue; relationCoverage: RelationCoverageValue } = {
      relationClass: "",
      relationCoverage: "",
    },
  ): void {
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citingId },
          cited: { kind: "turn", id: citedId },
          relation: relation as never,
          provenance: "asserted",
          tailTag,
          headTag,
          relationClass: classification.relationClass,
          relationCoverage: classification.relationCoverage,
        },
      ],
      NOW,
    );
  }

  /**
   * A PRE-CUTOVER physical row, written past the write path (main-agent-edges
   * D5). `writeMemoryEdges` cannot mint a second row on a pair any more — a
   * second class promotes the row in place and a second placement is a no-op —
   * but a database that predates the cutover holds exactly this stock (109
   * multi-row turn pairs in production), and the READERS below are untouched
   * by D5: they must keep rendering what is stored until ticket 01's rebuild
   * folds those pairs down. So the fixtures whose subject IS a multi-row pair
   * seed it in SQL, which is what such a database actually looks like.
   */
  function legacyEdgeRow(
    citingId: number,
    citedId: number,
    relation: string,
    tailTag = "",
    headTag = "",
  ): void {
    db.query(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance,
          tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
       VALUES ('turn', ?, 'turn', ?, ?, 'asserted', ?, ?, '', '', ?)`,
    ).run(citingId, citedId, relation, tailTag, headTag, NOW);
  }

  /** The same pre-cutover stock, wordless (main-agent-edges D1). */
  function legacyBareRow(citingId: number, citedId: number): void {
    db.query(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
       VALUES ('turn', ?, 'turn', ?, NULL, 'text-ref', ?)`,
    ).run(citingId, citedId, NOW);
  }

  function lines(promptNumber: number, inSession = sessionId): string[] {
    const id = getTurn(db, inSession, promptNumber)!.id;
    return buildTurnDirectRelationLines(db, { id, sessionId: inSession, promptNumber });
  }

  // ---- data source ----

  test("no edges renders empty, byte-identical to what an edgeless turn always rendered", () => {
    turn(1);
    expect(lines(1)).toEqual([]);
  });

  test("outgoing rows render first, incoming after — the ruled order, not the DB's", () => {
    const subject = turn(5);
    const cited = turn(1);
    const citer = turn(9);
    edge(subject, cited, "extends");
    edge(citer, subject, "verifies");

    expect(lines(5)).toEqual([
      "extends -> T1 [unplaced]",
      "<- T9 verifies [unplaced]",
    ]);
  });

  test("a stored bare row (relation IS NULL) is a prose reference, not an edge, and renders nothing", () => {
    const subject = turn(2);
    const cited = turn(1);
    // main-agent-edges D1 retired the wordless WRITE path — `writeMemoryEdges`
    // refuses a `relation: null` input by name — but the stored population
    // survives until ticket 01's cutover deletes it, and the reader is
    // untouched: it must go on treating such a row as no edge at all.
    legacyBareRow(subject, cited);

    expect(lines(2)).toEqual([]);
  });

  test("a stored bare row beside a relation row on the SAME pair contributes no line of its own", () => {
    const subject = turn(2);
    const cited = turn(1);
    // Both rows seeded past the write path: the relation write would DROP the
    // wordless row it displaces, so a pre-cutover database is the only place
    // the two coexist, and the reader is what has to be right about it.
    legacyBareRow(subject, cited);
    legacyEdgeRow(subject, cited, "extends", "lane-a", "lane-a");

    expect(lines(2)).toEqual(["extends -> T1 (#lane-a)"]);
  });

  test("rows render whatever their sides are — placed, half-settled and unplaced alike", () => {
    const subject = turn(4);
    const placed = turn(1);
    const halfTail = turn(2);
    const unplaced = turn(3);
    edge(subject, placed, "extends", "lane-a", "lane-a");
    edge(subject, halfTail, "consume", "lane-a", "");
    edge(subject, unplaced, "grounds");

    expect(lines(4)).toEqual([
      "extends -> T1 (#lane-a)",
      "consume -> T2 (#lane-a → ·)",
      "grounds -> T3 [unplaced]",
    ]);
  });

  test("a half-settled INCOMING row names the side that is missing on the tail, not the head", () => {
    const subject = turn(1);
    const citer = turn(2);
    edge(citer, subject, "narrows", "", "lane-b");

    expect(lines(1)).toEqual(["<- T2 narrows (· → #lane-b)"]);
  });

  // ---- grammar ----

  test("the same lane on both sides prints once", () => {
    const subject = turn(2);
    edge(subject, turn(1), "extends", "lane-a", "lane-a");

    expect(lines(2)).toEqual(["extends -> T1 (#lane-a)"]);
  });

  test("a crossing prints both lanes, tail first, on the ordinary arrow", () => {
    const subject = turn(2);
    edge(subject, turn(1), "consume", "lane-a", "lane-b");

    expect(lines(2)).toEqual(["consume -> T1 (#lane-a → #lane-b)"]);
    // T2388: no second glyph invented for a crossing — the two sides say it.
    expect(lines(2)[0]).not.toContain("=>");
  });

  test("several relations on ONE legacy pair merge only when their two sides are identical", () => {
    const subject = turn(2);
    const target = turn(1);
    // Legacy stock: main-agent-edges D5 stops the write path from producing
    // this, and the reader's fold is what still has to render it.
    legacyEdgeRow(subject, target, "extends", "lane-a", "lane-a");
    legacyEdgeRow(subject, target, "indexes", "lane-a", "lane-a");

    expect(lines(2)).toEqual(["extends,indexes -> T1 (#lane-a)"]);
  });

  test("a legacy pair with TWO placements renders two rows — one suffix cannot carry both attributions", () => {
    const subject = turn(2);
    const target = turn(1);
    legacyEdgeRow(subject, target, "extends", "lane-a", "lane-a");
    legacyEdgeRow(subject, target, "indexes", "lane-b", "lane-b");

    // Grouping is by (other endpoint, tailTag, headTag), never by the pair
    // alone: production holds 109 turn pairs carrying more than one placement.
    // main-agent-edges D5 retires the WRITE that makes them; the reader keeps
    // the grouping until ticket 01's rebuild folds the stored stock down.
    expect(lines(2)).toEqual([
      "extends -> T1 (#lane-a)",
      "indexes -> T1 (#lane-b)",
    ]);
  });

  test("a cross-session endpoint is session-qualified; a same-session one is bare", () => {
    const subject = turn(2);
    const near = turn(1);
    const far = turn(21, otherSessionId);
    edge(subject, near, "extends");
    edge(subject, far, "grounds");

    // Rows are ordered by ADDRESS, so one session's rows stay contiguous
    // instead of being scattered by the DB's relation-first row order.
    expect(lines(2)).toEqual([
      "extends -> T1 [unplaced]",
      `grounds -> S${otherSessionId}/T21 [unplaced]`,
    ]);
  });

  test("a classified row prints its CLASS word, an unclassified legacy row the word it was written under", () => {
    const subject = turn(3);
    edge(subject, turn(1), "override", "lane-a", "lane-a", {
      relationClass: "correct",
      relationCoverage: "full",
    });
    edge(subject, turn(2), "narrows", "lane-a", "lane-a");

    expect(lines(3)).toEqual([
      "correct(full) -> T1 (#lane-a)",
      "narrows -> T2 (#lane-a)",
    ]);
  });

  test("a side owned by ANOTHER task is qualified `E<n>/#lane`; the viewer's own side is not", () => {
    const subject = turn(2);
    const foreign = turn(1);
    const mine = createSegment(db, { title: "mine", nowEpoch: NOW }).id;
    const theirs = createSegment(db, { title: "theirs", nowEpoch: NOW }).id;
    addSegmentMembers(db, mine, [subject], NOW);
    addSegmentMembers(db, theirs, [foreign], NOW);
    edge(subject, foreign, "consume", "lane-a", "lane-a");

    // Same TAG on both sides, but the head sits in another task, so the two
    // sides are not the same lane and must not fold onto one.
    expect(lines(2)).toEqual([`consume -> T1 (#lane-a → E${theirs}/#lane-a)`]);
  });

  test("a homeless endpoint names no task — there is none to name", () => {
    const subject = turn(2);
    const foreign = turn(1);
    const mine = createSegment(db, { title: "mine", nowEpoch: NOW }).id;
    addSegmentMembers(db, mine, [subject], NOW);
    edge(subject, foreign, "consume", "lane-a", "lane-a");

    expect(lines(2)).toEqual(["consume -> T1 (#lane-a)"]);
  });

  // ---- size ----

  test("a 20-out / 20-in node renders all 40 atoms — no branch cap, no elision marker", () => {
    const subject = turn(100);
    for (let i = 0; i < 20; i += 1) {
      edge(subject, turn(200 + i), "extends", "lane-a", "lane-a");
      edge(turn(300 + i), subject, "verifies", "lane-a", "lane-a");
    }

    const rendered = lines(100);
    expect(rendered).toHaveLength(40);
    expect(rendered.filter((line) => line.startsWith("extends -> "))).toHaveLength(20);
    expect(rendered.filter((line) => line.startsWith("<- "))).toHaveLength(20);
    // The tree's elision vocabulary is absent, because the tree is.
    expect(rendered.some((line) => line.includes("more"))).toBe(false);
    expect(rendered.some((line) => line.includes("^"))).toBe(false);
    expect(rendered.some((line) => line.includes("└"))).toBe(false);
  });

  test("no downstream hop reaches the field — a target's OWN edges are its own business", () => {
    // 3 -> 2 -> 1: the tree would extend the chain, the direct set stops.
    const ids = [1, 2, 3].map((n) => turn(n));
    edge(ids[2]!, ids[1]!, "extends", "lane-a", "lane-a");
    edge(ids[1]!, ids[0]!, "extends", "lane-a", "lane-a");

    expect(lines(3)).toEqual(["extends -> T2 (#lane-a)"]);
    // The TREE, on the same fixture, still walks through T2 into T1 — the
    // capability moved rather than vanished.
    const treeLines = buildTurnRelationTreeLines(db, {
      id: ids[2]!,
      sessionId,
      promptNumber: 3,
    });
    expect(treeLines.join("\n")).toContain("T1");
  });
});
