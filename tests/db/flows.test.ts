import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { deriveFlowsForSessions } from "../../src/db/flows";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { promoteTurnFromNote } from "../../src/db/turns";

/**
 * `deriveFlowsForSessions` (the DB-facing half of flow derivation,
 * flow-relations spec ticket 02) — indexes-rescope spec law 8 / ticket 03's
 * deleted/dormant node predicate, at this call site. Before this ticket the
 * turn query here applied NO filter at all: a rolled-back or skipped turn's
 * `narrows`/`extends`/`override`/`grounds`/`consume` edges could still seed
 * or join a flow.
 */
describe("deriveFlowsForSessions — deleted/dormant node predicate (indexes-rescope spec law 8, ticket 03)", () => {
  let db: Database;
  let sessionId: number;

  const insertTurn = (
    promptNumber: number,
    options: { status?: string; wasRolledBack?: boolean } = {},
  ): number =>
    db
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, type, was_rolled_back, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, 100)
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.status ?? "extracted",
        JSON.stringify(["design"]), // decision-phase for every turn — narrows/extends require it
        options.wasRolledBack ? 1 : 0,
      )!.id;

  const edge = (
    citingId: number,
    citedId: number,
    relation: "narrows" | "extends" | "override" | "grounds" | "consume",
  ): void => {
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citingId },
          cited: { kind: "turn", id: citedId },
          relation,
          provenance: "asserted",
        },
      ],
      500,
    );
  };

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "flows-liveness",
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

  test("a rolled-back turn contributes no node and no edge to the derivation", () => {
    const root = insertTurn(1);
    const rolledBack = insertTurn(2, { wasRolledBack: true });
    edge(rolledBack, root, "extends");

    const derivation = deriveFlowsForSessions(db, [sessionId]);

    // root is an unremarkable one-node flow …
    expect(derivation.flowById.get(root)?.members).toEqual([root]);
    // … and the rolled-back turn is invisible everywhere: not a member of
    // any flow, not homeless (homeless still means "a real input turn"),
    // simply absent.
    expect(derivation.flowsByTurn.has(rolledBack)).toBe(false);
    expect(derivation.homeless).not.toContain(rolledBack);
    for (const flow of derivation.flows) {
      expect(flow.members).not.toContain(rolledBack);
    }
  });

  // The round trip must drive db/turns.ts's REAL promotion path
  // (promoteTurnFromNote), not a hand-set status — a hand-set status would
  // prove only that the SQL predicate reads `status`, not that the actual
  // lifecycle transition the spec describes (a late note landing on a
  // stranded turn) produces the restoration.
  test("a skipped turn is dormant — absent while skipped, restored WHOLE by the real promotion path", () => {
    const root = insertTurn(1);
    const dormant = insertTurn(2, { status: "active" });
    // The edge is written FIRST, while the turn is still live — exactly the
    // shape a stranded turn leaves behind: another turn already cited it
    // before session end swept it to `skipped`.
    edge(dormant, root, "extends");
    db.query("UPDATE turns SET status = 'skipped' WHERE id = ?").run(dormant);

    const whileSkipped = deriveFlowsForSessions(db, [sessionId]);
    expect(whileSkipped.flowsByTurn.has(dormant)).toBe(false);
    expect(whileSkipped.flowById.get(root)?.members).toEqual([root]);

    promoteTurnFromNote(db, dormant, {
      title: "late note",
      content: "written after the fact, closing the backlog",
      insight: null,
      updatedAtEpoch: 600,
    });

    const afterPromotion = deriveFlowsForSessions(db, [sessionId]);
    // Restored WHOLE: the SAME `extends` edge (never rewritten by this test)
    // now joins the branch, with no re-judgment step in between. `dormant`
    // is the CITING (newer) end of `extends`, so once it is live it becomes
    // the branch's own terminus — root demotes from "its own one-node flow"
    // to a member reached through it, exactly the shape the edge always
    // described and could not express while its citing end was hidden.
    expect(afterPromotion.flowById.get(dormant)?.members).toEqual([root, dormant]);
    expect(afterPromotion.flowsByTurn.get(root)).toEqual([dormant]);
    expect(afterPromotion.flowsByTurn.get(dormant)).toEqual([dormant]);
  });

  test("behavior parity: an ordinary narrows/extends/override chain with nothing skipped or rolled back derives unchanged", () => {
    const t1 = insertTurn(1);
    const t2 = insertTurn(2);
    const t3 = insertTurn(3);
    edge(t2, t1, "extends");
    edge(t3, t2, "extends");

    const derivation = deriveFlowsForSessions(db, [sessionId]);
    expect(derivation.flows).toHaveLength(1);
    expect(derivation.flowById.get(t3)?.members).toEqual([t1, t2, t3]);
    expect(derivation.flowById.get(t3)?.settlement).toBe(t3);
    expect(derivation.homeless).toEqual([]);
  });
});
