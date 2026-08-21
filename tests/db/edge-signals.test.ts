import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  getTurnEdgeSignals,
  getTurnEdgeSignalsForTurn,
  RELATION_IS_SCORED,
  type TurnEdgeSignals,
} from "../../src/db/edge-signals";
import { writeMemoryEdges, type CitationRelation } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { EDGE_RELATIONS } from "../../src/shared/turn-phase";
import { upsertSession } from "../../src/db/sessions";
import { promoteTurnFromNote } from "../../src/db/turns";

/**
 * Ticket 07 (turn-edge-mechanism spec) — the pure read layer that derives a
 * turn's scoring signal tuple from `memory_edges`. No rendering, no numeric
 * weight, no combined scalar score is tested here (none exists): only the
 * three signals (override, refines-excess-by-phase, encodes) and the guard
 * that every OTHER relation in the closed set (plus legacy `supersedes`)
 * moves none of them.
 */
describe("edge scoring signals", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-edge-signals",
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

  function addTurn(
    promptNumber: number,
    options: { type?: string[]; wasRolledBack?: boolean } = {},
  ): number {
    return db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, type, was_rolled_back, created_at_epoch)
         VALUES (?, ?, 'extracted', ?, ?, 100)
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        JSON.stringify(options.type ?? []),
        options.wasRolledBack ? 1 : 0,
      )!.id;
  }

  /** Direct edge writer — bypasses mcp/note.ts's phase validation on purpose: this module is a
   * READER and must handle whatever shape the graph carries, ticket-01-legal or not (e.g. an
   * `extends` edge whose endpoints are evidence-phase — legal under the retired nine-cell
   * grammar's same-phase `refines` diagonal, no longer writable fresh under the six-row law, but
   * still exactly what the blanket refines->extends rename left sitting in the graph). */
  function edge(
    citingId: number,
    citedId: number,
    relation: CitationRelation,
    createdAtEpoch: number,
  ): void {
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
      createdAtEpoch,
    );
  }

  const ZERO: TurnEdgeSignals = { overridden: false, refinesExcess: { decision: 0, delivery: 0 }, encodesCount: 0 };

  test("linked-list baseline graph: everyone reads all-zero signals", () => {
    // T1 <- T2 <- T3 <- T4 <- T5, each `refines` its immediate predecessor.
    // Every node's live refines in-degree is at most 1 — the baseline.
    const t1 = addTurn(1, { type: ["design"] });
    const t2 = addTurn(2, { type: ["design"] });
    const t3 = addTurn(3, { type: ["design"] });
    const t4 = addTurn(4, { type: ["design"] });
    const t5 = addTurn(5, { type: ["design"] });
    edge(t2, t1, "refines", 1000);
    edge(t3, t2, "refines", 1000);
    edge(t4, t3, "refines", 1000);
    edge(t5, t4, "refines", 1000);

    const signals = getTurnEdgeSignals(db, [t1, t2, t3, t4, t5]);
    for (const id of [t1, t2, t3, t4, t5]) {
      expect(signals.get(id)).toEqual(ZERO);
    }
  });

  test("one leapfrog extends on top of the baseline chain: only that node rises", () => {
    const t1 = addTurn(1, { type: ["design"] });
    const t2 = addTurn(2, { type: ["design"] });
    const t3 = addTurn(3, { type: ["design"] });
    const t4 = addTurn(4, { type: ["design"] });
    const t5 = addTurn(5, { type: ["design"] });
    edge(t2, t1, "extends", 1000);
    edge(t3, t2, "extends", 1000);
    edge(t4, t3, "extends", 1000);
    edge(t5, t4, "extends", 1000);
    // T5 leapfrogs all the way back to T1, arriving strictly AFTER T1's
    // baseline edge (from T2).
    edge(t5, t1, "extends", 2000);

    const signals = getTurnEdgeSignals(db, [t1, t2, t3, t4, t5]);
    expect(signals.get(t1)).toEqual({
      overridden: false,
      refinesExcess: { decision: 1, delivery: 0 },
      encodesCount: 0,
    });
    for (const id of [t2, t3, t4, t5]) {
      expect(signals.get(id)).toEqual(ZERO);
    }
  });

  test("extends source-phase bucketing: decision-sourced, delivery-sourced, and a dual-phase source counted once as decision", () => {
    const target = addTurn(1, { type: ["design"] });
    const baseline = addTurn(2, { type: ["design"] });
    const decisionLeapfrog = addTurn(3, { type: ["design"] });
    const deliveryLeapfrog = addTurn(4, { type: ["ops"] });
    const dualPhaseLeapfrog = addTurn(5, { type: ["review", "design"] });

    edge(baseline, target, "extends", 1000); // baseline, excluded
    edge(decisionLeapfrog, target, "extends", 2000); // decision bucket
    edge(deliveryLeapfrog, target, "extends", 3000); // delivery bucket
    edge(dualPhaseLeapfrog, target, "extends", 4000); // decision bucket (counted once)

    const signal = getTurnEdgeSignalsForTurn(db, target);
    expect(signal.refinesExcess).toEqual({ decision: 2, delivery: 1 });
    expect(signal.overridden).toBe(false);
    expect(signal.encodesCount).toBe(0);
  });

  test("flow-relations spec.md migration item 6 — carry-over pin: E→E extends (a legacy same-phase `refines` row the blanket rename left as `extends`, no longer writable fresh under the six-row law) is graph-legal to carry but its evidence-phase excess source is still SKIPPED at scoring, not miscounted into either bucket", () => {
    const target = addTurn(1, { type: ["research"] });
    const baseline = addTurn(2, { type: ["research"] });
    const evidenceLeapfrog = addTurn(3, { type: ["measure"] });
    edge(baseline, target, "extends", 1000); // baseline, excluded regardless of phase
    edge(evidenceLeapfrog, target, "extends", 2000); // excess, but evidence-only source

    const signal = getTurnEdgeSignalsForTurn(db, target);
    expect(signal.refinesExcess).toEqual({ decision: 0, delivery: 0 });
    expect(signal.overridden).toBe(false);
    expect(signal.encodesCount).toBe(0);

    // The edge is still fully present in the graph, under the CURRENT key
    // (`extends`, migration item 1's blanket rename of the retired `refines`
    // word) — scoring invisibility is a read-time skip (`primaryPhaseBucket`
    // returns null, nothing increments), not a write-time rejection or a
    // hidden/deleted row. This is the evidence-source skip carrying over
    // UNCHANGED through the interim rename (spec.md migration item 6).
    const stored = db
      .query<{ count: number }, [number, number]>(
        `SELECT COUNT(*) AS count FROM memory_edges
         WHERE relation = 'extends' AND citing_id = ? AND cited_id = ?`,
      )
      .get(evidenceLeapfrog, target)!.count;
    expect(stored).toBe(1);
  });

  test("override victim: overridden is true only from a LIVE override source", () => {
    const victim = addTurn(1, { type: ["design"] });
    const liveAttacker = addTurn(2, { type: ["design"] });
    edge(liveAttacker, victim, "override", 1000);

    const rolledBackVictim = addTurn(3, { type: ["design"] });
    const rolledBackAttacker = addTurn(4, { type: ["design"], wasRolledBack: true });
    edge(rolledBackAttacker, rolledBackVictim, "override", 1000);

    const signals = getTurnEdgeSignals(db, [victim, rolledBackVictim]);
    expect(signals.get(victim)!.overridden).toBe(true);
    // A rolled-back source's override does not count — the target reads clean.
    expect(signals.get(rolledBackVictim)!.overridden).toBe(false);
  });

  test("relation-matrix ticket 03 — E→E override: all-phase zeroing pinned, an evidence-phase override still zeroes its evidence-phase target out of milestone selection", () => {
    const victim = addTurn(1, { type: ["research"] });
    const attacker = addTurn(2, { type: ["measure"] });
    edge(attacker, victim, "override", 1000);

    const signal = getTurnEdgeSignalsForTurn(db, victim);
    // `overridden: true` is the exact bit `mcp/timeline.ts`'s milestone
    // candidate filter (`!signals.get(id)!.overridden`) excludes on — this IS
    // "zeroed out of milestone selection", not merely a step toward it.
    expect(signal.overridden).toBe(true);
    expect(signal.refinesExcess).toEqual({ decision: 0, delivery: 0 });
    expect(signal.encodesCount).toBe(0);
  });

  test("flow-relations ticket 02 — L→E grounds (was encodes): all-phase crediting pinned, a delivery-phase source still credits an evidence-phase target's encodesCount", () => {
    const target = addTurn(1, { type: ["research"] });
    const deliverySource = addTurn(2, { type: ["implement"] });
    edge(deliverySource, target, "grounds", 1000);

    const signal = getTurnEdgeSignalsForTurn(db, target);
    expect(signal.encodesCount).toBe(1);
    expect(signal.overridden).toBe(false);
    expect(signal.refinesExcess).toEqual({ decision: 0, delivery: 0 });
  });

  test("encodesCount (now sourced from grounds): raw in-degree, live sources only", () => {
    const decisionA = addTurn(1, { type: ["design"] });
    const decisionB = addTurn(2, { type: ["design"] });
    const deliveryX = addTurn(3, { type: ["implement"] });
    const deliveryY = addTurn(4, { type: ["ops"] });
    const rolledBackDelivery = addTurn(5, { type: ["implement"], wasRolledBack: true });

    edge(deliveryX, decisionA, "grounds", 1000);
    edge(deliveryY, decisionA, "grounds", 1000);
    edge(deliveryX, decisionB, "grounds", 1000);
    edge(rolledBackDelivery, decisionB, "grounds", 1000);

    const signals = getTurnEdgeSignals(db, [decisionA, decisionB]);
    expect(signals.get(decisionA)!.encodesCount).toBe(2);
    // decisionB has 2 incoming encodes edges but one source is rolled back.
    expect(signals.get(decisionB)!.encodesCount).toBe(1);
  });

  // Flow-relations spec, ticket 05 (`.scratch/flow-relations/spec.md`,
  // migration item 6, "Election interim"): ticket 02's rename merges the
  // retired `grounded-on` word into `grounds` (which the encodes key now
  // reads). ADR-0010 locked `grounded-on` to a decision-phase SOURCE citing
  // an evidence- or delivery-phase target ("decision speaks footing") — a
  // shape RELATION_IS_SCORED never scored under the old seven-word keys
  // (`grounded-on: false`, git show 598f0ee~1). PINNED interim distortion,
  // named in spec.md itself: this exact shape, now stored as `grounds`,
  // begins crediting encodesCount. Not a redesign — the scoring pass decides
  // whether grounded-on-shaped grounds edges should keep crediting.
  test("flow-relations spec.md migration item 6 — interim distortion (a): a grounds edge BORN grounded-on-shaped (decision-phase source citing delivery-phase footing, previously unscored) now credits its target's encodesCount", () => {
    const target = addTurn(1, { type: ["implement"] }); // delivery phase — grounded-on's old decision->delivery cell
    const decisionFooting = addTurn(2, { type: ["design"] }); // decision-phase source — grounded-on's source lock
    edge(decisionFooting, target, "grounds", 1000);

    const signal = getTurnEdgeSignalsForTurn(db, target);
    expect(signal.encodesCount).toBe(1);
    expect(signal.overridden).toBe(false);
    expect(signal.refinesExcess).toEqual({ decision: 0, delivery: 0 });
  });

  // Flow-relations spec, ticket 05, migration item 6: `narrows` starts empty
  // (migration item 2) and RELATION_IS_SCORED.narrows is false — the
  // refinesExcess query only matches relation = 'extends', so a `narrows`
  // edge is invisible to every signal computed here. PINNED interim
  // distortion, spec.md's own wording: "narrows scores nothing until ruled".
  test("flow-relations spec.md migration item 6 — interim distortion (b): a narrows edge moves neither refinesExcess bucket, and no other signal", () => {
    const target = addTurn(1, { type: ["design"] });
    const narrower = addTurn(2, { type: ["design"] });
    edge(narrower, target, "narrows", 1000);

    const signal = getTurnEdgeSignalsForTurn(db, target);
    expect(signal).toEqual(ZERO);
  });

  // Relation-matrix spec, "自引用" (ticket 05, user ruling T1180): a self edge
  // PARTICIPATES in scoring, no exclusion. This query joins `citing` on
  // `citing_id` and filters only on `citing.was_rolled_back` — a self row
  // (citing_id = cited_id) satisfies that join and the WHERE the same as any
  // other row, so no code change was needed here; this pins that the query
  // shape does NOT accidentally exclude it.
  test("a self-grounds counts toward the turn's own encodesCount (ticket 05)", () => {
    const selfEncoder = addTurn(1, { type: ["research", "review"] });
    const otherSource = addTurn(2, { type: ["implement"] });
    edge(selfEncoder, selfEncoder, "grounds", 1000);
    edge(otherSource, selfEncoder, "grounds", 1000);

    const signal = getTurnEdgeSignalsForTurn(db, selfEncoder);
    expect(signal.encodesCount).toBe(2);
  });

  test("unscored relations (grounded-on, evidence-for/against, depends-on, legacy supersedes) contribute nothing", () => {
    const target = addTurn(1, { type: ["design"] });
    const groundedOnSource = addTurn(2, { type: ["design"] });
    const evidenceForSource = addTurn(3, { type: ["research"] });
    const evidenceAgainstSource = addTurn(4, { type: ["measure"] });
    const dependsOnCiter = addTurn(5, { type: ["implement"] });
    const dependsOnTarget = addTurn(6, { type: ["implement"] });
    const supersedesSource = addTurn(7, { type: ["design"] });

    edge(groundedOnSource, target, "grounded-on", 1000);
    edge(evidenceForSource, target, "evidence-for", 1000);
    edge(evidenceAgainstSource, target, "evidence-against", 1000);
    edge(dependsOnCiter, dependsOnTarget, "depends-on", 1000);
    edge(supersedesSource, target, "supersedes", 1000);

    const signals = getTurnEdgeSignals(db, [target, dependsOnTarget]);
    expect(signals.get(target)).toEqual(ZERO);
    expect(signals.get(dependsOnTarget)).toEqual(ZERO);
  });

  test("guard: RELATION_IS_SCORED classifies exactly override/extends/grounds as scored (spec.md's election-interim 1:1 rename), everything else in the eight-word closed set as not — compile-time exhaustive over EDGE_RELATIONS", () => {
    expect(RELATION_IS_SCORED).toEqual({
      override: true,
      narrows: false,
      extends: true,
      indexes: false,
      consume: false,
      grounds: true,
      verifies: false,
      refutes: false,
    });
    // Every current closed-set word has an entry (TypeScript already enforces
    // this at compile time via the Record type; this is the runtime mirror).
    for (const relation of EDGE_RELATIONS) {
      expect(RELATION_IS_SCORED[relation]).toBeDefined();
    }
  });

  test("empty graph: all-zero signals, no crash on dangling or edgeless ids", () => {
    const lonely = addTurn(1, { type: ["design"] });
    const signals = getTurnEdgeSignals(db, [lonely, 999_999]);
    expect(signals.get(lonely)).toEqual(ZERO);
    expect(signals.get(999_999)).toEqual(ZERO);
    expect(getTurnEdgeSignals(db, [])).toEqual(new Map());
  });

  // Indexes-rescope spec law 8 / ticket 03: before this ticket only the
  // CITING (source) side was ever filtered here, and only on
  // `was_rolled_back` (never `status`). A rolled-back or skipped TARGET —
  // the row this whole module keys its output by — was never checked at
  // all, so a caller handing this function a dead/dormant id could still
  // read real computed signals for it.
  describe("deleted/dormant node predicate (indexes-rescope spec law 8, ticket 03)", () => {
    test("a rolled-back TARGET reads all-zero signals even though its incoming edges are real and live-sourced", () => {
      const rolledBackTarget = addTurn(1, { type: ["design"], wasRolledBack: true });
      const liveAttacker = addTurn(2, { type: ["design"] });
      const liveGrounder = addTurn(3, { type: ["implement"] });
      edge(liveAttacker, rolledBackTarget, "override", 1000);
      edge(liveGrounder, rolledBackTarget, "grounds", 1000);

      const signal = getTurnEdgeSignalsForTurn(db, rolledBackTarget);
      expect(signal).toEqual(ZERO);
    });

    // The round trip drives db/turns.ts's REAL promotion path
    // (promoteTurnFromNote), not a hand-set status: the edges are written
    // while the target is still live (exactly what a stranded, later-cited
    // turn looks like), session end strands it to `skipped`, and only a late
    // note's promotion should bring its signals back — untouched, the same
    // edges, no re-write.
    test("a skipped target's signals vanish while skipped and return, edges unrewritten, after the real promotion path", () => {
      const dormant = addTurn(1, { type: ["design"] });
      const attacker = addTurn(2, { type: ["design"] });
      const grounder = addTurn(3, { type: ["implement"] });
      edge(attacker, dormant, "override", 1000);
      edge(grounder, dormant, "grounds", 1000);
      db.query("UPDATE turns SET status = 'skipped' WHERE id = ?").run(dormant);

      expect(getTurnEdgeSignalsForTurn(db, dormant)).toEqual(ZERO);

      promoteTurnFromNote(db, dormant, {
        title: "late note",
        content: "closes the backlog",
        insight: null,
        updatedAtEpoch: 2000,
      });

      const restored = getTurnEdgeSignalsForTurn(db, dormant);
      expect(restored.overridden).toBe(true);
      expect(restored.encodesCount).toBe(1);
    });

    // A skipped SOURCE must stop feeding a live target's signals too — the
    // symmetric case to edge-signals.ts's pre-existing rolled-back-source
    // coverage above, now extended to the dormant half of the predicate.
    test("a skipped source's override/grounds edges do not count toward a live target, and resume after promotion", () => {
      const target = addTurn(1, { type: ["design"] });
      const dormantSource = addTurn(2, { type: ["design"] });
      edge(dormantSource, target, "override", 1000);
      db.query("UPDATE turns SET status = 'skipped' WHERE id = ?").run(
        dormantSource,
      );

      expect(getTurnEdgeSignalsForTurn(db, target).overridden).toBe(false);

      promoteTurnFromNote(db, dormantSource, {
        title: "late note",
        content: "closes the backlog",
        insight: null,
        updatedAtEpoch: 2000,
      });

      expect(getTurnEdgeSignalsForTurn(db, target).overridden).toBe(true);
    });
  });

  test("getTurnEdgeSignalsForTurn matches the batched result for a single id", () => {
    const t1 = addTurn(1, { type: ["design"] });
    const t2 = addTurn(2, { type: ["design"] });
    edge(t2, t1, "override", 1000);

    expect(getTurnEdgeSignalsForTurn(db, t1)).toEqual(
      getTurnEdgeSignals(db, [t1]).get(t1)!,
    );
    expect(getTurnEdgeSignalsForTurn(db, t1).overridden).toBe(true);
  });
});
