import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
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
  RELATIONS_FIELD_LEGEND,
} from "../../src/mcp/relations-view";
import { saveTurnFixture as saveTurn } from "../support/turn-fixtures";
import { wordEdgeClass } from "../support/edge-row-fixtures";
import { downgradeToPreCutoverShape, seedPreCutoverEdge } from "../support/pre-cutover-edge-shape";

/**
 * Settlement-read-once spec D8 (user rulings T2388 "render like timeline, no
 * invented notation" and T2404 "direct out/in edges only, outgoing first, no
 * downstream hops"), with MAIN-AGENT-EDGES ticket 07's marks on top:
 * `recall`'s `relations` field renders THIS NODE'S OWN EDGES — every outgoing
 * row then every incoming one — and each side shows the lane attribution it
 * RESOLVES to (spec D2's five outcomes), not the raw tag the row stores.
 *
 * `tests/mcp/relations-view.tree.test.ts` keeps pinning the TREE, which
 * survives on exactly one surface (`timeline(id="S<n>/T<m>")`). This file
 * pins the direct set: its data source, its grammar, its five marks, and the
 * count it is required to carry whole.
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

  /** A task with its lanes DECLARED — an attribution resolves through the registry, never off a turn's raw tag alone. */
  function task(title: string, laneTags: readonly string[]): number {
    const segmentId = createSegment(db, { title, nowEpoch: NOW }).id;
    for (const tag of laneTags) {
      insertLane(db, segmentId, tag, NOW);
    }
    return segmentId;
  }

  /** Put a turn in a task and give it lane memberships — what `loadEndpointLaneFacts` reads to resolve either side. */
  function place(turnId: number, segmentId: number, laneTags: readonly string[]): void {
    addSegmentMembers(db, segmentId, [turnId], NOW);
    db.query("UPDATE turns SET tags = ? WHERE id = ?").run(JSON.stringify([...laneTags]), turnId);
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
          provenance: "asserted",
          tailTag,
          headTag,
          // A caller that states a class wins; otherwise the fixture's legacy
          // WORD is translated the one way the migration translated it.
          ...(classification.relationClass === ""
            ? wordEdgeClass(relation)
            : {
                relationClass: classification.relationClass,
                relationCoverage: classification.relationCoverage,
              }),
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
    // The pair-UNIQUE rebuilt table cannot hold a second row on a pair, so the
    // fixture first puts `memory_edges` back into the PRE-CUTOVER shape
    // (idempotent). That is not a fiction: D9's claim fence defers the
    // migration while a settlement claim is live, and every READ in that
    // window runs the new readers over exactly this table.
    downgradeToPreCutoverShape(db);
    seedPreCutoverEdge(db, {
      citingId,
      citedId,
      relation,
      ...wordEdgeClass(relation),
      tailTag,
      headTag,
      createdAtEpoch: NOW,
    });
  }

  /** The same pre-cutover stock, wordless (main-agent-edges D1). */
  function legacyBareRow(citingId: number, citedId: number): void {
    downgradeToPreCutoverShape(db);
    seedPreCutoverEdge(db, {
      citingId,
      citedId,
      relation: null,
      provenance: "text-ref",
      createdAtEpoch: NOW,
    });
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
      "use -> T1 (none)",
      "<- T9 verify (none)",
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
    const alpha = task("alpha task", ["lane-a"]);
    place(subject, alpha, ["lane-a"]);
    place(cited, alpha, ["lane-a"]);
    // Both rows seeded past the write path: the relation write would DROP the
    // wordless row it displaces, so a pre-cutover database is the only place
    // the two coexist, and the reader is what has to be right about it.
    legacyBareRow(subject, cited);
    legacyEdgeRow(subject, cited, "extends", "lane-a", "lane-a");

    expect(lines(2)).toEqual(["use -> T1 (#lane-a declared)"]);
  });

  // ---- the five outcomes (spec D2) ----

  test("DERIVED: an endpoint in exactly one lane needs no declaration, and the blank side still names the lane", () => {
    const subject = turn(2);
    const cited = turn(1);
    const alpha = task("alpha task", ["lane-a"]);
    place(subject, alpha, ["lane-a"]);
    place(cited, alpha, ["lane-a"]);
    edge(subject, cited, "extends");

    // The retired renderer printed `[unplaced]` here — over the majority of
    // production's corpus, whose attribution is in fact fully determined.
    expect(lines(2)).toEqual(["use -> T1 (#lane-a derived)"]);
  });

  test("DECLARED: an endpoint in several lanes, and the stored tag is one of them", () => {
    const subject = turn(2);
    const cited = turn(1);
    const alpha = task("alpha task", ["lane-a", "lane-b"]);
    place(subject, alpha, ["lane-a", "lane-b"]);
    place(cited, alpha, ["lane-a", "lane-b"]);
    edge(subject, cited, "extends", "lane-a", "lane-b");

    expect(lines(2)).toEqual(["use -> T1 (#lane-a declared → #lane-b declared)"]);
  });

  test("AMBIGUOUS: several lanes and nothing declared — the finding settlement's edge pass owes a declaration for", () => {
    const subject = turn(2);
    const cited = turn(1);
    const alpha = task("alpha task", ["lane-a", "lane-b"]);
    place(subject, alpha, ["lane-a", "lane-b"]);
    place(cited, alpha, ["lane-a"]);
    edge(subject, cited, "extends");

    expect(lines(2)).toEqual(["use -> T1 (ambiguous → #lane-a derived)"]);
  });

  test("NONE: an endpoint in no lane at all is legal, and says so", () => {
    const subject = turn(2);
    const cited = turn(1);
    const alpha = task("alpha task", ["lane-a"]);
    place(subject, alpha, ["lane-a"]);
    // The cited turn is homeless: no task, therefore no qualified lane.
    edge(subject, cited, "extends");

    expect(lines(2)).toEqual(["use -> T1 (#lane-a derived → none)"]);
  });

  test("INVALID names the stored tag, and never falls back to the derivation however unambiguous the endpoint looks", () => {
    const subject = turn(2);
    const cited = turn(1);
    const alpha = task("alpha task", ["lane-a", "lane-b"]);
    place(subject, alpha, ["lane-a"]);
    place(cited, alpha, ["lane-a"]);
    // The writer said `lane-b`; the turn is only in `lane-a`. E4.
    edge(subject, cited, "extends", "lane-b", "");

    expect(lines(2)).toEqual(["use -> T1 (invalid (stored #lane-b) → #lane-a derived)"]);
  });

  test("a lane the registry never declared is not a lane: the membership tag resolves to nothing", () => {
    const subject = turn(2);
    const cited = turn(1);
    const alpha = task("alpha task", []);
    place(subject, alpha, ["lane-a"]);
    place(cited, alpha, ["lane-a"]);
    edge(subject, cited, "extends", "lane-a", "lane-a");

    // The stored tag is not among the endpoint's RESOLVED lanes (the turn
    // carries a word no lane of its task declares), so it is invalid, not
    // declared — the same answer `resolveEdgeSide` gives every other reader.
    expect(lines(2)).toEqual([
      "use -> T1 (invalid (stored #lane-a))",
    ]);
  });

  // ---- grammar ----

  test("both sides reading alike print once; a crossing prints both, tail first, on the ordinary arrow", () => {
    const subject = turn(3);
    const same = turn(1);
    const crossing = turn(2);
    const alpha = task("alpha task", ["lane-a", "lane-b"]);
    place(subject, alpha, ["lane-a"]);
    place(same, alpha, ["lane-a"]);
    place(crossing, alpha, ["lane-b"]);
    edge(subject, same, "extends");
    edge(subject, crossing, "consume");

    expect(lines(3)).toEqual([
      "use -> T1 (#lane-a derived)",
      "use -> T2 (#lane-a derived → #lane-b derived)",
    ]);
    // T2388: no second glyph invented for a crossing — the two sides say it.
    expect(lines(3)[1]).not.toContain("=>");
  });

  test("the retired vocabulary is gone: no `[unplaced]`, no `·` half-settled stand-in", () => {
    const subject = turn(3);
    const nowhere = turn(1);
    const half = turn(2);
    const alpha = task("alpha task", ["lane-a"]);
    // The subject is IN the task but in none of its lanes; `nowhere` is
    // homeless. Both are the `none` outcome, reached from the two different
    // directions it can arise.
    place(subject, alpha, []);
    place(half, alpha, ["lane-a"]);
    edge(subject, nowhere, "extends");
    edge(subject, half, "consume");

    const rendered = lines(3).join("\n");
    expect(rendered).not.toContain("[unplaced]");
    expect(rendered).not.toContain("·");
    expect(lines(3)).toEqual([
      "use -> T1 (none)",
      "use -> T2 (none → #lane-a derived)",
    ]);
  });

  test("several relations on ONE legacy pair merge when their sides RESOLVE alike", () => {
    const subject = turn(2);
    const target = turn(1);
    const alpha = task("alpha task", ["lane-a"]);
    place(subject, alpha, ["lane-a"]);
    place(target, alpha, ["lane-a"]);
    // Legacy stock: main-agent-edges D5 stops the write path from producing
    // this, and the reader's fold is what still has to render it. Two classes,
    // both sides blank on each row, so both rows resolve to the SAME
    // attribution — one line carrying both classes, which is the only case a
    // single suffix describes truthfully.
    legacyEdgeRow(subject, target, "extends", "", "");
    legacyEdgeRow(subject, target, "verifies", "", "");

    expect(lines(2)).toEqual(["use,verify -> T1 (#lane-a derived)"]);
  });

  test("a legacy pair whose rows RESOLVE differently renders one line per physical row", () => {
    const subject = turn(2);
    const target = turn(1);
    const alpha = task("alpha task", ["lane-a", "lane-b"]);
    place(subject, alpha, ["lane-a", "lane-b"]);
    place(target, alpha, ["lane-a", "lane-b"]);
    legacyEdgeRow(subject, target, "extends", "lane-a", "lane-a");
    legacyEdgeRow(subject, target, "verifies", "lane-b", "lane-b");

    // Grouping is by (other endpoint, RESOLVED tail, RESOLVED head), never by
    // the pair alone: production holds 109 turn pairs carrying more than one
    // physical row. Until ticket 01's rebuild folds them, such a pair renders
    // one line per row with its own raw declaration — and no machinery beyond
    // the grouping key does it.
    expect(lines(2)).toEqual([
      "use -> T1 (#lane-a declared)",
      "verify -> T1 (#lane-b declared)",
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
      "use -> T1 (none)",
      `use -> S${otherSessionId}/T21 (none)`,
    ]);
  });

  test("the CLASS is the only relation word rendered — an unclassified legacy row prints its class, never its stored word", () => {
    const subject = turn(4);
    edge(subject, turn(1), "override", "", "", {
      relationClass: "correct",
      relationCoverage: "full",
    });
    edge(subject, turn(2), "narrows");
    edge(subject, turn(3), "indexes");

    expect(lines(4)).toEqual([
      "correct(full) -> T1 (none)",
      "correct(partial) -> T2 (none)",
      "use -> T3 (none)",
    ]);
    for (const word of ["override", "narrows", "extends", "consume", "grounds", "indexes", "verifies"]) {
      expect(lines(4).join("\n")).not.toContain(word);
    }
  });

  test("a side owned by ANOTHER task is qualified `E<n>/#lane`; the viewer's own side is not", () => {
    const subject = turn(2);
    const foreign = turn(1);
    const mine = task("mine", ["lane-a"]);
    const theirs = task("theirs", ["lane-a"]);
    place(subject, mine, ["lane-a"]);
    place(foreign, theirs, ["lane-a"]);
    edge(subject, foreign, "consume");

    // Same TAG on both sides, but the head sits in another task, so the two
    // sides are not the same lane and must not fold onto one.
    expect(lines(2)).toEqual([`use -> T1 (#lane-a derived → E${theirs}/#lane-a derived)`]);
  });

  test("a homeless endpoint names no task — there is none to name", () => {
    const subject = turn(2);
    const foreign = turn(1);
    const mine = task("mine", ["lane-a"]);
    place(subject, mine, ["lane-a"]);
    edge(subject, foreign, "consume");

    expect(lines(2)).toEqual(["use -> T1 (#lane-a derived → none)"]);
  });

  // ---- the legend ----

  test("the legend names all five outcomes and calls the attribution advisory", () => {
    for (const clause of [
      "derived",
      "declared",
      "ambiguous",
      "none",
      "invalid (stored #tag)",
      "CURRENT task",
      "ADVISORY",
    ]) {
      expect(RELATIONS_FIELD_LEGEND).toContain(clause);
    }
    expect(RELATIONS_FIELD_LEGEND).not.toContain("[unplaced]");
  });

  // ---- size ----

  test("a 20-out / 20-in node renders all 40 atoms — no branch cap, no elision marker", () => {
    const subject = turn(100);
    const alpha = task("alpha task", ["lane-a"]);
    place(subject, alpha, ["lane-a"]);
    for (let i = 0; i < 20; i += 1) {
      const cited = turn(200 + i);
      const citer = turn(300 + i);
      place(cited, alpha, ["lane-a"]);
      place(citer, alpha, ["lane-a"]);
      edge(subject, cited, "extends");
      edge(citer, subject, "verifies");
    }

    const rendered = lines(100);
    expect(rendered).toHaveLength(40);
    expect(rendered.filter((line) => line.startsWith("use -> "))).toHaveLength(20);
    expect(rendered.filter((line) => line.startsWith("<- "))).toHaveLength(20);
    // Every atom carries its resolved attribution, not a raw tag.
    expect(rendered.filter((line) => line.endsWith("(#lane-a derived)"))).toHaveLength(40);
    // The tree's elision vocabulary is absent, because the tree is.
    expect(rendered.some((line) => line.includes("more"))).toBe(false);
    expect(rendered.some((line) => line.includes("^"))).toBe(false);
    expect(rendered.some((line) => line.includes("└"))).toBe(false);
  });

  test("no downstream hop reaches the field — a target's OWN edges are its own business", () => {
    // 3 -> 2 -> 1: the tree would extend the chain, the direct set stops.
    const ids = [1, 2, 3].map((n) => turn(n));
    edge(ids[2]!, ids[1]!, "extends");
    edge(ids[1]!, ids[0]!, "extends");

    expect(lines(3)).toEqual(["use -> T2 (none)"]);
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
