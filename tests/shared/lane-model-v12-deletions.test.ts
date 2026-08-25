/**
 * lane-model-v12 ticket 04 — THE GREP SENTINELS.
 *
 * Six things were deleted, not narrowed: milestone candidacy exclusion by
 * edge, the per-member `dead` flag, an open lane's most-recent-declarer seat,
 * the per-lane validity verdict, the lane-shape error class (E5), and the
 * conditional self-citation rule. Every one of them has a behavioural test
 * elsewhere pinning what happens INSTEAD. This file pins something a
 * behavioural test cannot: that none of them comes back under another name.
 *
 * WHY SOURCE TEXT AND NOT BEHAVIOUR. A deletion is only observable as an
 * absence, and an absence is exactly what a reimplementation restores without
 * touching any assertion. `electMilestones` growing a second `excluded.add`
 * fed from an edge, `LaneState` growing a fourth field, `LaneErrorClass`
 * growing an `"E5"` arm — each of those passes every behavioural test written
 * against the OLD shape (there are none left) and every one written against
 * the NEW shape (they assert what the surviving rules do, not what the
 * deleted ones no longer do). These assertions fail on the reintroduction
 * itself.
 *
 * MUTATION-VERIFICATION NOTE. A deletion is verified by reintroducing it, not
 * by breaking a surviving property: each sentinel below was checked by
 * re-adding the deleted rule to the named source file and confirming this
 * file reddens.
 *
 * The console's own deletion is NOT here: it is asserted at the payload
 * boundary instead (`tests/worker/console-api.test.ts`, "no key named
 * validity/lastDeclarer/dead survives anywhere in the response"), which is
 * strictly stronger than a source grep — it reads the shipped JSON.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const read = (relativePath: string): string =>
  readFileSync(join(REPO_ROOT, relativePath), "utf8");

/** Every source file a deleted rule could plausibly reappear in. */
const LANE_MODEL_SOURCES = [
  "src/shared/lane-interpretation.ts",
  "src/shared/milestone-election.ts",
  "src/shared/lane-checker.ts",
  "src/shared/lane-checker-render.ts",
  "src/db/lane-checker-load.ts",
  "src/worker/console-api.ts",
] as const;

describe("lane-model-v12 ticket 04 — deleted rules stay deleted", () => {
  // ---- 1. milestone candidacy exclusion by edge -------------------------
  //
  // The rule read an edge (`override`/`refutes` with no tag) and removed its
  // CITED node from candidacy. Only one arm survives — the turn-level invalid
  // node (rolled back / skipped), rubric-v12's 无效节点 — so `excluded` may
  // still be written, but never from an edge.
  test("no edge can put a node into `excluded` — the repudiation arm has no successor", () => {
    const source = read("src/shared/milestone-election.ts");
    // The exact shape the deleted rule had, and the only shape a successor
    // could take: an id derived from an edge reaching `excluded`.
    expect(source).not.toMatch(/excluded\.add\(edge/);
    expect(source).not.toMatch(/excluded\.add\([^)]*\bedge\b/);
    // Exactly one write to `excluded` survives, and it is inside the loop
    // over `turns`.
    expect(source.match(/excluded\.add\(/g)).toHaveLength(1);
    expect(source).toContain("if (turn.wasRolledBack === true || turn.skipped === true) {");
  });

  // ---- 2. the per-member `dead` flag ------------------------------------
  //
  // `LaneMember.dead` was set by an in-lane override or an untagged "global
  // kill". Both are gone. A member is `{ id }`.
  test("no lane member, in any reader, carries a status flag", () => {
    for (const path of LANE_MODEL_SOURCES) {
      const source = read(path);
      expect(source, path).not.toMatch(/member\.dead\b/);
      expect(source, path).not.toMatch(/\bdead:\s*(true|false|boolean)/);
      expect(source, path).not.toMatch(/deadInLane|globallyDead|isDead\b/);
    }
    // And the type itself has exactly one field.
    const core = read("src/shared/lane-interpretation.ts");
    expect(core).toContain("export interface LaneMember {\n  id: number;\n}");
  });

  // ---- 3. the open lane's most-recent-declarer seat ---------------------
  //
  // `LaneState.lastDeclarer` fed tier ②'s second seat (`open-last-declarer`).
  // Both the field and the seat are deleted; an open lane seats nobody.
  test("no lane state computes a most-recent declarer, and no tier reason names that seat", () => {
    for (const path of LANE_MODEL_SOURCES) {
      expect(read(path), path).not.toContain("lastDeclarer");
    }
    const election = read("src/shared/milestone-election.ts");
    expect(election).not.toContain("open-last-declarer");
    // The tier-② loop has ONE branch. An `else` here is the seat returning.
    expect(election).toContain('tier2.set(state.terminus, "closed-terminus");');
    expect(election).not.toMatch(/state\.closure === "open"/);
  });

  // ---- 4. the per-lane validity verdict ---------------------------------
  //
  // `LaneState.validity` asked whether a closed lane's declared core still
  // held a living node — a question about node death, which is deleted.
  test("no lane state carries a validity verdict, and no surface renders one", () => {
    for (const path of LANE_MODEL_SOURCES) {
      const source = read(path);
      expect(source, path).not.toContain("validity");
      expect(source, path).not.toContain("LaneValidity");
      expect(source, path).not.toContain("closed-valid");
      expect(source, path).not.toContain("closed-invalid");
    }
    // The renderer's own state line is a two-way branch and nothing more.
    const renderer = read("src/shared/lane-checker-render.ts");
    expect(renderer).toContain(
      'return state.closure === "closed" ? "closed" : "open";',
    );
  });

  // ---- 5. E5, the lane-shape error class --------------------------------
  //
  // A COMMIT-BLOCKING error enforcing "exactly one start and one end", a
  // clause rubric v11 had already removed. Deleted from the checker, the
  // renderer, and both settlement teaching surfaces — a class the tool
  // descriptions still enumerated but the checker could never produce would
  // be worse than either alone.
  test("no error class named E5 exists in the checker, its renderers or the settlement surfaces", () => {
    const surfaces = [
      ...LANE_MODEL_SOURCES,
      "src/worker/note-settlement-sdk-query.ts",
      "src/worker/note-settlement-prompt.ts",
      "src/cli/lane-check-cli.ts",
    ];
    for (const path of surfaces) {
      // The quoted class literal: a class must be spelled this way somewhere
      // to be constructed, switched on, or filtered for.
      expect(read(path), path).not.toContain('"E5"');
    }
    const checker = read("src/shared/lane-checker.ts");
    expect(checker).toContain('export type LaneErrorClass = "E2" | "E3" | "E4";');
    expect(checker).not.toContain("LaneShapeError");
    expect(checker).not.toContain("computeLaneShapeErrors");
    // The teaching surfaces enumerate the classes as a CLOSED list, so a
    // deleted class must leave the enumeration too.
    expect(read("src/worker/note-settlement-sdk-query.ts")).not.toContain("(E5)");
    expect(read("src/worker/note-settlement-prompt.ts")).not.toContain("(E5)");
  });

  // ---- 6. the self-citation rule ----------------------------------------
  //
  // `grounds` — and only `grounds` — could cite its own turn, under two
  // conditions: a delivery-phase type (checked pre-write) and being the
  // CURRENT terminus of a lane it had declared (checked post-transaction, in
  // a separate "Gate C" function fed a graph fact the caller computed). The
  // permission, both conditions, the post-write gate and its four rejection
  // reasons are deleted. An edge's two ends must be different nodes.
  test("no writer, at any layer, admits a self edge under any condition", () => {
    const writePaths = [
      "src/shared/turn-phase.ts",
      "src/mcp/note.ts",
      "src/db/citations.ts",
      "src/worker/note-settlement-turn-facade.ts",
    ];
    for (const path of writePaths) {
      const source = read(path);
      // The four deleted rejection reasons. Each named a CONDITION under
      // which a self edge was or was not legal; one flat `self-edge` reason
      // replaces all of them.
      expect(source, path).not.toContain("self-not-grounds");
      expect(source, path).not.toContain("self-not-delivery");
      expect(source, path).not.toContain("self-not-terminus");
      expect(source, path).not.toContain("tag-on-self-edge");
      // The post-transaction gate and its evidence type.
      expect(source, path).not.toContain("checkSelfGroundsTerminus");
      expect(source, path).not.toContain("hasTaggedTerminusDeclaration");
      expect(source, path).not.toContain("RelationEdgeFact");
      expect(source, path).not.toContain("isCurrentTerminus");
    }
    // The refusal is unconditional at the shared validator: no relation, tag
    // or phase test sits between the self check and its rejection.
    const validator = read("src/shared/turn-phase.ts");
    expect(validator).toContain(
      '  if (input.isSelfReference) {\n' +
        "    // lane-model-v12 D2 (ticket 04): flat refusal. No relation, phase or tag\n" +
        "    // state makes a self edge legal, so nothing below this line runs for one.\n" +
        '    return { ok: false, reason: "self-edge", detail: SELF_EDGE_DETAIL };\n' +
        "  }",
    );
    // And the storage-layer backstop refuses word-blind — no `grounds`
    // carve-out survives beside the self test.
    const storage = read("src/db/citations.ts");
    expect(storage).toContain(
      'if (node.kind === "turn" && node.id === citingTurnId) {',
    );
    expect(storage).not.toMatch(/node\.id === citingTurnId && field\.relation/);
  });

  // ---- the untagged override's own lane event ---------------------------
  //
  // Not one of the six named deletions, but the mechanism behind two of them:
  // an untagged `override` was the GLOBAL REPUDIATION, killing the cited turn
  // in every lane and unseating every terminus it held. rubric-v12 says an
  // unsettled edge (both sides tagless) takes no part in any connectivity,
  // convergence or coupling computation — closure IS convergence — so an
  // untagged override must push no lane event at all.
  test("an untagged edge produces no lane event, for either graph-state word", () => {
    const core = read("src/shared/lane-interpretation.ts");
    // The reduction's event token is non-nullable: an untagged edge cannot
    // reach the reducer, because there is no token for it to carry.
    expect(core).toContain("  /** The lane token this event belongs to.");
    expect(core).toMatch(/relation: "indexes" \| "override";\n\s+\/\*\*[\s\S]*?\*\/\n\s+token: string;/);
    expect(core).not.toMatch(/token: string \| null/);
    expect(core).not.toMatch(/pushEvent\([^)]*null\)/);
  });
});
