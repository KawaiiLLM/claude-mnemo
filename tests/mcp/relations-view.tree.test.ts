import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { buildTurnRelationTreeLines, RELATION_TREE_BRANCH_CAP } from "../../src/mcp/relations-view";
import { saveTurnFixture as saveTurn } from "../support/turn-fixtures";

/**
 * Fork-tree spec (ticket 12): `buildTurnRelationTreeLines` renders the viewed
 * turn's position in the graph as a tree — root address + main out-chain
 * inline, every other out-edge and every in-edge as its own `└` branch.
 *
 * Every arrow label below is a CLASS (main-agent-edges ticket 07): the tree is
 * one of the three surfaces on which the class word is the only relation word
 * rendered, so a fixture written under a seven-word storage value reads back
 * as `use`/`verify`/`correct(full)`/`correct(partial)`, never as the word it
 * was stored under.
 * `tests/mcp/recall.test.ts`'s own "relations field" describe block still
 * exercises the field end-to-end through `recallMemory`; this file targets
 * the tree shape's own rules directly against `buildTurnRelationTreeLines`.
 */
describe("recall relations tree (fork-tree spec, ticket 12)", () => {
  let db: Database;
  let sessionId: number;

  const NOW = 600_000;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: `tree-${Math.random()}`,
      project: "claude-mnemo",
      title: "tree fixture",
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  function turn(promptNumber: number, label = `turn ${promptNumber}`): number {
    saveTurn(db, {
      sessionId,
      promptNumber,
      userPrompt: `p${promptNumber}`,
      assistantResponse: `r${promptNumber}`,
      title: label,
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
    return getTurn(db, sessionId, promptNumber)!.id;
  }

  function edge(
    citingId: number,
    citedId: number,
    relation: string,
    tags: readonly [string, string] | readonly [string] | [] = [],
  ): void {
    const sides =
      tags.length === 2
        ? { tailTag: tags[0], headTag: tags[1] }
        : tags.length === 1
          ? deriveSideTags([tags[0]])
          : {};
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citingId },
          cited: { kind: "turn", id: citedId },
          relation: relation as never,
          provenance: "asserted",
          ...sides,
        },
      ],
      NOW,
    );
  }

  function lines(promptNumber: number): string[] {
    const id = getTurn(db, sessionId, promptNumber)!.id;
    return buildTurnRelationTreeLines(db, { id, sessionId, promptNumber });
  }

  test("no edges renders exactly what it renders today: empty", () => {
    turn(1);
    expect(lines(1)).toEqual([]);
  });

  test("out-branches extend at most 3 hops, then '-> ..'", () => {
    // 6 -> 5 -> 4 -> 3 -> 2 -> 1 (citing is always the later turn).
    const ids = [1, 2, 3, 4, 5, 6].map((n) => turn(n));
    for (let i = ids.length - 1; i > 0; i -= 1) {
      edge(ids[i]!, ids[i - 1]!, "extends");
    }
    const out = lines(6);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(
      `S${sessionId}/T6 -use-> T5 -use-> T4 -use-> T3 -> ..`,
    );
  });

  test("in-branches never extend — only the root's own citer renders, its citer's citer does not", () => {
    const root = turn(1);
    const citer = turn(2);
    const citerOfCiter = turn(3);
    edge(citer, root, "narrows");
    edge(citerOfCiter, citer, "narrows");

    const out = lines(1);
    expect(out).toEqual([`S${sessionId}/T1`, `     └<-correct(partial)- T2`]);
    // T3 only cites T2, never T1 — it must not appear anywhere in T1's tree.
    expect(out.join("\n")).not.toContain("T3");
  });

  test("^ dedupe: a branch reconverging on a main-chain node renders the edge and stops, without re-expanding", () => {
    const root = turn(1);
    const a = turn(2);
    const b = turn(3);
    // Main chain: root -extends-> a -extends-> b.
    edge(root, a, "extends");
    edge(a, b, "extends");
    // Second out-edge from root straight to b — b is already on the main
    // chain by the time this branch is walked.
    edge(root, b, "indexes");

    const out = lines(1);
    expect(out[0]).toBe(`S${sessionId}/T1 -use-> T2 -use-> T3`);
    expect(out[1]).toBe(`     └-use-> T3 ^`);
    // Not re-expanded: b has no children of its own here to expand into
    // anyway, but the point is the branch line stops right at `^`, one hop.
    expect(out).toHaveLength(2);
  });

  test("lane suffixes: {lane} same-lane, {tail→head} cross-lane with a double stroke, nothing when unplaced", () => {
    const root = turn(1);
    const sameLane = turn(2);
    const crossLane = turn(3);
    const unplaced = turn(4);
    edge(root, sameLane, "override", ["alpha"]);
    edge(root, crossLane, "consume", ["alpha", "beta"]);
    edge(root, unplaced, "grounds");

    const out = lines(1).join("\n");
    expect(out).toContain("-correct(full)-> T2 {alpha}");
    expect(out).toContain("=use=> T3 {alpha→beta}");
    expect(out).toContain("-use-> T4");
    expect(out).not.toContain("-use-> T4 {");
  });

  test(`branch count caps at ${RELATION_TREE_BRANCH_CAP}, trailing '… +N more' when cut`, () => {
    const root = turn(1);
    const citerCount = RELATION_TREE_BRANCH_CAP + 2;
    for (let n = 2; n <= 1 + citerCount; n += 1) {
      const citer = turn(n);
      edge(citer, root, "verifies");
    }
    const out = lines(1);
    // Root line (no out-edges) + capped branches + the "+N more" line.
    expect(out).toHaveLength(1 + RELATION_TREE_BRANCH_CAP + 1);
    expect(out[out.length - 1]).toContain(`… +${citerCount - RELATION_TREE_BRANCH_CAP} more`);
  });

  test("ticket 16 decision 2: a deep 6-hop thread wins the main spine over five shallower, better-ranked 3-hop threads — unbounded coverage, not depth-bounded", () => {
    const root = turn(1);
    // Five shallow, 3-node dead-end threads, top relation rank ("extends").
    // Under the retired DEPTH-BOUNDED coverage (capped to the tree's own
    // 3-hop render horizon) these would look tied with the deep thread below
    // (both truncate to "coverage 3"), and the better relation rank would
    // have made one of THESE win the main spine outright.
    const a1 = turn(2), a2 = turn(3), a3 = turn(4);
    const b1 = turn(5), b2 = turn(6), b3 = turn(7);
    const c1 = turn(8), c2 = turn(9), c3 = turn(10);
    const d1 = turn(11), d2 = turn(12), d3 = turn(13);
    const e1 = turn(14), e2 = turn(15), e3 = turn(16);
    for (const [s1, s2, s3] of [
      [a1, a2, a3],
      [b1, b2, b3],
      [c1, c2, c3],
      [d1, d2, d3],
      [e1, e2, e3],
    ]) {
      edge(root, s1, "verifies");
      edge(s1, s2, "extends");
      edge(s2, s3, "extends");
    }
    // One deep, 6-node thread whose first hop has the WORSE class rank (`use`
    // against the shallow threads' `verify`) — only a genuinely unbounded
    // coverage (the full 6-node reach) can tell it apart from them.
    const y1 = turn(17), y2 = turn(18), y3 = turn(19), y4 = turn(20), y5 = turn(21), y6 = turn(22);
    edge(root, y1, "extends");
    edge(y1, y2, "extends");
    edge(y2, y3, "extends");
    edge(y3, y4, "extends");
    edge(y4, y5, "extends");
    edge(y5, y6, "extends");

    const out = lines(1);
    // The deep thread wins the main spine and shows the truncation ellipsis
    // — the bounded-coverage counter-case (acceptance criterion 3).
    expect(out[0]).toBe(`S${sessionId}/T1 -use-> T17 -use-> T18 -use-> T19 -> ..`);
    // Every shallow thread lost the race and renders as its own full,
    // un-truncated branch — none of them ever leaked into the main spine.
    expect(out).toHaveLength(1 + RELATION_TREE_BRANCH_CAP + 1);
    expect(out[1]).toBe(`     └-verify-> T14 -use-> T15 -use-> T16`);
    expect(out[2]).toBe(`     └-verify-> T11 -use-> T12 -use-> T13`);
    expect(out[3]).toBe(`     └-verify-> T8 -use-> T9 -use-> T10`);
    expect(out[4]).toBe(`     └-verify-> T5 -use-> T6 -use-> T7`);
    expect(out[5]).toContain("… +1 more");
    expect(out.slice(1).join("\n")).not.toContain("-> ..");
  });

  test("real-shape regression: main chain plus two in-branches, one narrows one indexes (settled example shape)", () => {
    const root = turn(1);
    const c1 = turn(2);
    const c2 = turn(3);
    const citer1 = turn(4);
    const citer2 = turn(5);
    edge(root, c1, "extends");
    edge(c1, c2, "extends");
    edge(citer1, root, "narrows");
    edge(citer2, root, "indexes");

    const out = lines(1);
    expect(out[0]).toBe(`S${sessionId}/T1 -use-> T2 -use-> T3`);
    expect(out).toContain(`     └<-correct(partial)- T4`);
    expect(out).toContain(`     └<-use- T5`);
  });
});
