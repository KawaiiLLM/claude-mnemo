import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import {
  attachTurnRelations,
  formatRelationRejections,
  MAX_TURN_RELATION_DEGREE,
  retractTurnRelations,
} from "../../src/db/citations";
import { createDatabase } from "../../src/db/database";
import { getIncomingEdges, getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { wordEdgeClass } from "../support/edge-row-fixtures";
import { downgradeToPreCutoverShape, seedPreCutoverEdge } from "../support/pre-cutover-edge-shape";

/**
 * Settlement-read-once ticket 00, spec D0 — the degree caps (USER RULING
 * T2404): at most 20 outgoing relation atoms per citing turn and 20 incoming
 * per cited turn, enforced ONCE in the shared `attachTurnRelations`.
 *
 * They exist so the `relations` field can be SIZED rather than hoped at: with
 * both caps a node's direct edge set is at most 40 atoms, which is what lets
 * D1 pick a default budget from a measured widest atom instead of from a
 * distribution with no ceiling. Production carries no violator (read-only,
 * 2026-09-02: max outgoing 18, max incoming 7), so this bounds new work and
 * invalidates no stored row.
 *
 * "Enforced once, in the shared primitive" is the design claim, and it is what
 * makes the four pinned cases below sufficient: both write faces — `note` and
 * the settlement turn facade — reach the graph through this function, and both
 * retract before they attach, so the counts it reads are already the
 * post-retraction state. A second copy at either tool surface would be a
 * second thing to keep in step, which is exactly what this ticket refuses.
 *
 * What counts is an ATOM: a relation-carrying row. A bare existence row (the
 * `[S<n>/T<m>]` a body happens to name, `relation IS NULL`) carries no claim
 * and is not counted — otherwise prose could exhaust a turn's edge budget
 * without anybody asserting anything.
 */
describe("relation degree caps, enforced in attachTurnRelations (spec D0)", () => {
  const NOW = 1_800_000_000;

  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "degree-caps",
      project: "/tmp/degree-caps",
      title: null,
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => db.close());

  function seedTurn(promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', 'fixture', ${NOW}, '[]', '[]') RETURNING id`,
      )
      .get(sessionId, promptNumber)!.id;
  }

  function address(turnId: number): string {
    const row = db
      .query<{ promptNumber: number }, [number]>(
        "SELECT prompt_number AS promptNumber FROM turns WHERE id = ?",
      )
      .get(turnId)!;
    return `S${sessionId}/T${row.promptNumber}`;
  }

  /** Stored rows, written straight to the table so the cap check meets an EXISTING degree. */
  function storeEdge(citing: number, cited: number, relation = "extends"): void {
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          ...wordEdgeClass(relation),
          provenance: "asserted",
          tailTag: "",
          headTag: "",
          relationClass: "use",
          relationCoverage: null,
        },
      ],
      NOW,
    );
  }

  function attach(citing: number, targets: string[]) {
    return attachTurnRelations(
      db,
      citing,
      [{ relationClass: "use", targets }],
      NOW + 1,
    );
  }

  // An ATOM is a row that carries a CLASS. `MemoryEdge.relation` left with the
  // word column at the main-agent-edges cutover, so the wordless row a cap
  // must not count is the one whose `relationClass` is `''`.
  function outgoingAtoms(turnId: number): number {
    return getOutgoingEdges(db, { kind: "turn", id: turnId }).filter(
      (edge) => edge.relationClass !== "",
    ).length;
  }

  function incomingAtoms(turnId: number): number {
    return getIncomingEdges(db, { kind: "turn", id: turnId }).filter(
      (edge) => edge.relationClass !== "",
    ).length;
  }

  test("the cap is 20", () => {
    expect(MAX_TURN_RELATION_DEGREE).toBe(20);
  });

  // -----------------------------------------------------------------------
  // Pinned case 1: 19 outgoing + 2 new -> refused WHOLE
  // -----------------------------------------------------------------------

  test("19 outgoing + 2 new atoms is refused whole, by name, with zero writes", () => {
    const citing = seedTurn(1);
    const cited: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      cited.push(seedTurn(100 + index));
    }
    for (let index = 0; index < 19; index += 1) {
      storeEdge(citing, cited[index]!);
    }
    expect(outgoingAtoms(citing)).toBe(19);

    const result = attach(citing, [address(cited[19]!), address(cited[20]!)]);

    expect(result.written).toEqual([]);
    expect(result.restated).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toBe("outgoing-degree-cap");
    // The message names the node whose degree is the problem, so the writer
    // knows whether to retract here or to point somewhere else.
    expect(result.rejected[0]!.raw).toBe(address(citing));
    expect(formatRelationRejections(result.rejected, "relation")).toContain("20 outgoing");
    // Neither of the two landed — the refusal is whole, not per-atom.
    expect(outgoingAtoms(citing)).toBe(19);
  });

  test("19 outgoing + 1 new lands: the cap is a ceiling of 20, not a ceiling of 19", () => {
    const citing = seedTurn(1);
    const cited: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      cited.push(seedTurn(100 + index));
    }
    for (let index = 0; index < 19; index += 1) {
      storeEdge(citing, cited[index]!);
    }

    const result = attach(citing, [address(cited[19]!)]);

    expect(result.rejected).toEqual([]);
    expect(result.written).toHaveLength(1);
    expect(outgoingAtoms(citing)).toBe(20);
  });

  // -----------------------------------------------------------------------
  // Pinned case 2: 20 + a restatement -> no-op SUCCESS
  // -----------------------------------------------------------------------

  test("20 outgoing + a restatement of a stored atom succeeds as a no-op", () => {
    const citing = seedTurn(1);
    const cited: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      cited.push(seedTurn(100 + index));
    }
    for (const target of cited) {
      storeEdge(citing, target);
    }
    expect(outgoingAtoms(citing)).toBe(20);

    // Re-asserting a row already stored adds nothing to any degree, so the cap
    // has nothing to refuse — a writer at the ceiling can still restate.
    const result = attach(citing, [address(cited[0]!)]);

    expect(result.rejected).toEqual([]);
    expect(result.written).toEqual([]);
    expect(result.restated).toHaveLength(1);
    expect(outgoingAtoms(citing)).toBe(20);
  });

  test("20 outgoing + one genuinely new atom is refused", () => {
    const citing = seedTurn(1);
    const cited: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      cited.push(seedTurn(100 + index));
    }
    for (let index = 0; index < 20; index += 1) {
      storeEdge(citing, cited[index]!);
    }

    const result = attach(citing, [address(cited[20]!)]);

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toBe("outgoing-degree-cap");
    expect(outgoingAtoms(citing)).toBe(20);
  });

  // -----------------------------------------------------------------------
  // Pinned case 3: at the cap, retract 1 + attach 1 in one call -> SUCCESS
  // -----------------------------------------------------------------------

  test("at the cap, a retract-then-attach pair succeeds — the retraction ran first", () => {
    const citing = seedTurn(1);
    const cited: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      cited.push(seedTurn(100 + index));
    }
    for (let index = 0; index < 20; index += 1) {
      storeEdge(citing, cited[index]!);
    }

    // Both write faces order their halves this way (`note.ts`: "Retraction runs
    // BEFORE the attach"), so the count the cap reads is already the
    // post-retraction one and no special case is needed for the pair.
    const retraction = retractTurnRelations(
      db,
      citing,
      [{ relationClass: "use", targets: [address(cited[0]!)] }],
      NOW + 1,
    );
    expect(retraction.deleted).toHaveLength(1);
    expect(outgoingAtoms(citing)).toBe(19);

    const result = attach(citing, [address(cited[20]!)]);

    expect(result.rejected).toEqual([]);
    expect(result.written).toHaveLength(1);
    expect(outgoingAtoms(citing)).toBe(20);
  });

  // -----------------------------------------------------------------------
  // Pinned case 4: a CITED turn already AT the cap -> the WHOLE call refused
  // -----------------------------------------------------------------------

  /**
   * This case used to reach the cap by putting TWO relation classes on ONE
   * pair in one call — "two atoms into one node", which is what D2's multi-row
   * identity made of them. main-agent-edges D5 retires that arithmetic: one
   * pair is one row, the most specific class wins, and a single citing turn
   * can therefore never contribute more than ONE incoming atom to a target.
   * So the over-cap state is reached the only way that is left — a target
   * already AT 20 — and what the case still proves is the part that survives
   * unchanged: the whole call is refused with zero writes, and the offending
   * endpoint is named, so the innocent target beside it does not land either.
   */
  test("a cited turn already at the cap refuses the WHOLE call, naming that turn", () => {
    const target = seedTurn(1);
    for (let index = 0; index < MAX_TURN_RELATION_DEGREE; index += 1) {
      storeEdge(seedTurn(200 + index), target);
    }
    expect(incomingAtoms(target)).toBe(MAX_TURN_RELATION_DEGREE);

    const citing = seedTurn(2);
    const innocent = seedTurn(3);
    const result = attachTurnRelations(
      db,
      citing,
      [
        { relationClass: "use", targets: [address(target)] },
        { relationClass: "verify", targets: [address(innocent)] },
      ],
      NOW + 1,
    );

    expect(result.written).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toBe("incoming-degree-cap");
    expect(result.rejected[0]!.raw).toBe(address(target));
    expect(incomingAtoms(target)).toBe(MAX_TURN_RELATION_DEGREE);
    // Nothing landed — not even the target that was never over its cap.
    expect(outgoingAtoms(citing)).toBe(0);
  });

  /**
   * The other half of what the retired "+2" arithmetic used to say, stated the
   * way D5 makes it true: two classes on one pair are ONE atom, so a call that
   * would once have been two additions is now one and lands at the boundary.
   */
  test("two classes on one pair are ONE incoming atom — a call at 19 incoming still lands", () => {
    const target = seedTurn(1);
    for (let index = 0; index < 19; index += 1) {
      storeEdge(seedTurn(200 + index), target);
    }

    const citing = seedTurn(2);
    const result = attachTurnRelations(
      db,
      citing,
      [
        { relationClass: "use", targets: [address(target)] },
        { relationClass: "verify", targets: [address(target)] },
      ],
      NOW + 1,
    );

    expect(result.rejected).toEqual([]);
    expect(incomingAtoms(target)).toBe(20);
  });

  test("a cited turn at 19 incoming + 1 new atom lands", () => {
    const target = seedTurn(1);
    for (let index = 0; index < 19; index += 1) {
      storeEdge(seedTurn(200 + index), target);
    }

    const result = attach(seedTurn(2), [address(target)]);

    expect(result.rejected).toEqual([]);
    expect(incomingAtoms(target)).toBe(20);
  });

  // -----------------------------------------------------------------------
  // What the caps do NOT count
  // -----------------------------------------------------------------------

  test("bare existence rows do not count toward either cap", () => {
    const citing = seedTurn(1);
    const cited: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      cited.push(seedTurn(100 + index));
    }
    // 20 bare rows: prose naming a target, carrying no relation word. Seeded
    // PAST the write path — main-agent-edges D1 retired the wordless write
    // (`bare-row-retired`), but the stored population stands until ticket 01's
    // cutover deletes it, and until then it must still not exhaust a turn's
    // edge budget.
    // On the PRE-CUTOVER shape: the cutover deleted every wordless row and
    // `relation_class` is NOT NULL on the rebuilt table, so the population
    // exists only while D9's fence defers the migration — and there the caps
    // must still not count it.
    downgradeToPreCutoverShape(db);
    for (let index = 0; index < 20; index += 1) {
      seedPreCutoverEdge(db, {
        citingId: citing,
        citedId: cited[index]!,
        relation: null,
        provenance: "text-ref",
        createdAtEpoch: NOW,
      });
    }
    expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toHaveLength(20);
    expect(outgoingAtoms(citing)).toBe(0);

    const result = attach(citing, [address(cited[20]!)]);

    expect(result.rejected).toEqual([]);
    expect(outgoingAtoms(citing)).toBe(1);
  });

  test("the same target twice in one call is one atom, so a call at the boundary still lands", () => {
    const citing = seedTurn(1);
    const cited: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      cited.push(seedTurn(100 + index));
    }
    for (let index = 0; index < 19; index += 1) {
      storeEdge(citing, cited[index]!);
    }

    // Dedupe runs before the cap: two spellings of one claim are one addition.
    const result = attach(citing, [address(cited[19]!), address(cited[19]!)]);

    expect(result.rejected).toEqual([]);
    expect(result.written).toHaveLength(1);
    expect(outgoingAtoms(citing)).toBe(20);
  });
});
