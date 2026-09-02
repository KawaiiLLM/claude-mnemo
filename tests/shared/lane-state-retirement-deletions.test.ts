/**
 * lane-state-retirement ticket 01 — THE GREP SENTINELS.
 *
 * Lane state is DELETED, not reinterpreted: `closed`/`open`, the single
 * per-lane terminus they were computed from, the predicate that produced it,
 * and every downstream field that existed only to carry their answer. Each has
 * a behavioural test elsewhere pinning what happens INSTEAD. This file pins
 * something a behavioural test cannot: that none of them comes back under
 * another name.
 *
 * WHY SOURCE TEXT AND NOT BEHAVIOUR (the reasoning `lane-model-v12-deletions
 * .test.ts` states for the same technique, applied to this ticket's own set).
 * A deletion is observable only as an absence, and an absence is exactly what
 * a reimplementation restores without touching any assertion. `Lane` growing a
 * `terminus` field again, `checkLanes` calling a re-added `deriveLaneStates`,
 * the election's tier ② quietly seating "whoever wrote the newest index" —
 * each of those passes every behavioural test written against the NEW shape,
 * because those assert what the surviving rules do, not what the deleted ones
 * no longer do.
 *
 * MUTATION-VERIFICATION NOTE. Each sentinel below was checked by
 * reintroducing the deleted rule into the named source file and confirming
 * this file reddens — the observable named per block.
 *
 * The console's own deletion is asserted at the PAYLOAD boundary instead
 * (`tests/worker/console-api.test.ts`), which is strictly stronger than a
 * source grep because it reads the shipped JSON.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { electMilestones } from "../../src/shared/milestone-election";
import { deriveLaneInterpretation } from "../../src/shared/lane-interpretation";
import { laneEdge } from "../support/lane-edge-fixtures";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const read = (relativePath: string): string =>
  readFileSync(join(REPO_ROOT, relativePath), "utf8");

/**
 * `read`, with comments stripped. Every file below documents what it deleted
 * and why — a deletion whose reason is not written down is re-added by the
 * next reader — so a raw grep for `terminus` fires on the sentence explaining
 * that the terminus is gone. A reintroduction is CODE, and this is where it
 * has to show.
 */
const readCode = (relativePath: string): string =>
  read(relativePath).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** Every source file a retired lane-state rule could plausibly reappear in. */
const LANE_STATE_SOURCES = [
  "src/shared/lane-interpretation.ts",
  "src/shared/lane-checker.ts",
  "src/shared/lane-checker-render.ts",
  "src/shared/milestone-election.ts",
  "src/db/lane-checker-load.ts",
  "src/worker/console-api.ts",
  "src/cli/lane-controls-cli.ts",
  "src/mcp/timeline.ts",
] as const;

describe("lane-state-retirement ticket 01 — the retired symbols stay retired", () => {
  // ---- 1. the four named symbols ----------------------------------------
  //
  // MUTATION: re-export any one of them from `lane-interpretation.ts`.
  test("LaneClosure, LaneState, deriveLaneStates and laneClosureClaim exist nowhere in the tree", () => {
    for (const path of LANE_STATE_SOURCES) {
      const source = readCode(path);
      expect(source, path).not.toContain("LaneClosure");
      expect(source, path).not.toContain("LaneState");
      expect(source, path).not.toContain("deriveLaneStates");
      expect(source, path).not.toContain("laneClosureClaim");
    }
  });

  // ---- 2. the declaration object and its terminus -----------------------
  //
  // `LaneDeclaration` was `{ state, terminus }` and `Lane` carried it beside
  // `latestMember`, closure's second input. All three go: the terminus was a
  // LATEST-WINS seat, one per lane, and a lane converging once per phase never
  // had one.
  //
  // MUTATION: add `terminus: number | null` back to `Lane`.
  test("no lane type carries a declaration, a terminus or a newest-member seat", () => {
    for (const path of LANE_STATE_SOURCES) {
      const source = readCode(path);
      expect(source, path).not.toContain("LaneDeclaration");
      expect(source, path).not.toContain("latestMember");
      expect(source, path).not.toContain("terminusCitedness");
      expect(source, path).not.toContain("LaneTerminusCitedness");
    }
  });

  // The runtime shape, which no grep can state: a lane object has exactly the
  // three keys and no fourth arrives quietly beside them.
  test("a derived Lane has exactly key/members/taggedEdges", () => {
    const derivation = deriveLaneInterpretation(
      [
        { id: 1, type: ["design"], laneTags: ["a"] },
        { id: 2, type: ["design"], laneTags: ["a"] },
      ],
      [laneEdge({ citingId: 2, relation: "indexes", citedId: 1, tags: ["a"] })],
    );
    for (const lane of derivation.lanes) {
      expect(Object.keys(lane).sort()).toEqual(["key", "members", "taggedEdges"]);
    }
  });

  // ---- 3. the checker's own two carriers --------------------------------
  //
  // Report 1's `declaration`/`state` pair and report 2's closed-terminus line.
  //
  // MUTATION: put `state` back on `LaneStatsReport` and render it.
  test("report 1 declares no state and report 2 asks no terminus question", () => {
    const checker = readCode("src/shared/lane-checker.ts");
    expect(checker).not.toMatch(/^\s*state:/m);
    expect(checker).not.toMatch(/^\s*declaration:/m);
    const renderer = readCode("src/shared/lane-checker-render.ts");
    expect(renderer).not.toContain("formatLaneState");
    expect(renderer).not.toContain("declaration: ");
  });

  // ---- 4. the ◎ terminus marker, at both surfaces -----------------------
  //
  // `timeline`'s lane-chain rendered `◎` for the lane's terminus; the console
  // drew a ring on the node and a mark on the panel chip. Neither marker was
  // re-pointed at another fact — an `index` declaration is already visible as
  // the chain's `=>` arrow and as the console's thin convergence fan.
  //
  // MUTATION: restore `isTerminus` on either surface.
  test("no surface renders a terminus marker, and no payload carries the flag it read", () => {
    expect(readCode("src/mcp/timeline.ts")).not.toContain("isTerminus");
    expect(readCode("src/worker/console-api.ts")).not.toContain("isTerminus");
    // The generated console shell is the byte-identical twin of the HTML; the
    // stale-shell guard pins that, so checking one checks both.
    expect(readCode("src/worker/console-shell.html")).not.toContain("isTerminus");
    expect(readCode("src/worker/console-shell.html")).not.toContain("state.closure");
    expect(readCode("src/worker/console-shell.html")).not.toContain("terminusAddress");
  });

  // ---- 5. tier ② and the whole tier ladder ------------------------------
  //
  // This section pinned ticket 01's deliberately empty tier ②, then ticket
  // 02's real predicate for it. main-agent-edges ticket 02 deletes the LADDER:
  // `indexes` — tier ②'s only feeder — has no successor under three classes,
  // so there is no convergence declaration left to seat anyone on, and the
  // election is one heuristic score per node.
  //
  // What survives permanently is the RETIRED REASON WORD, `closed-terminus`:
  // it names lane-terminus voting, which is gone for good and never comes back
  // under any rule. The positive pin for what the election DOES now lives at
  // `tests/shared/milestone-election.test.ts`.
  test("the `closed-terminus` reason is gone from the union for good — and so is every other tier reason", () => {
    const election = readCode("src/shared/milestone-election.ts");
    expect(election).not.toContain("closed-terminus");
    expect(election).not.toContain("declares-index");
    expect(election).not.toContain("MilestoneTier");
  });

  // The runtime half: the shape that seated at tier ② under every earlier rule
  // — an `indexes` writer who is the lane's newest member — is still ranked
  // FIRST here, but on the score's own terms (two out-edges plus the recency
  // term) rather than on a declaration nobody can make any more.
  test("the shape that always seated at tier 2 still leads, now on its own out-degree", () => {
    const result = electMilestones(
      [
        { id: 1, type: ["design"], laneTags: ["v"] },
        { id: 2, type: ["design"], laneTags: ["v"] },
      ],
      [
        laneEdge({ citingId: 2, relation: "extends", citedId: 1, tags: ["v"] }),
        laneEdge({ citingId: 2, relation: "indexes", citedId: 1, tags: ["v"] }),
      ],
    );
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([2, 1]);
    expect(result.candidates[0]!.outDegree).toBe(2);
  });

  // ---- 6. the rubric's own two halves -----------------------------------
  //
  // The `open`/`closed` bullets and the sentence "七个词里只有 index 参与 open /
  // closed 的判定" go. The clause ADJACENT to that sentence —
  // "被 override 的节点依然有效" — STAYS: it is a separate law, and ticket 02
  // depends on it.
  //
  // MUTATION: delete the survivor, or restore either retired half.
  test("the injected rubric drops open/closed and KEEPS the override-validity law", () => {
    for (const path of [
      "src/shared/memory-rubric.ts",
      ".scratch/lane-model-v12/rubric-v12-concepts.md",
    ]) {
      const text = read(path);
      // relation-vocabulary-v13 ticket 02 renamed the word, not the law: the
      // class that overturns a node still does not invalidate it.
      expect(text, path).toContain("被 correct 的节点依然有效");
      expect(text, path).not.toContain("七个词里只有 index 参与 open / closed 的判定");
      expect(text, path).not.toContain("**closed**:泳道的最新成员是它的终点");
      expect(text, path).not.toContain("**open**:最新成员不是终点");
    }
  });

  // ---- 7. the settlement prompt's step 4 --------------------------------
  //
  // MUTATION: restore the OPEN clause, or any lane-state word in step 4.
  test("settlement's prompt names no lane state in its convergence step", () => {
    // The English clause is gone from the WHOLE file, comments included — it
    // was never quoted in a comment, so the raw read is the stronger check.
    expect(read("src/worker/note-settlement-prompt.ts")).not.toContain(
      "leaving a lane honestly OPEN is normal life",
    );
    // The Chinese coupling clause IS quoted in the comment that records its
    // replacement, so this half reads the code alone.
    expect(readCode("src/worker/note-settlement-prompt.ts")).not.toContain(
      "一条 closed 泳道的终点",
    );
  });
});
