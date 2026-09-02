import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { MAX_TURN_RELATION_DEGREE } from "../../src/db/citations";
import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { insertLane } from "../../src/db/lanes";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { claimWriterId } from "../../src/db/write-gate";
import { recallMemory } from "../../src/mcp/recall";
import { createSettlementDirectWriteEngine } from "../../src/worker/note-settlement-direct-write";
import {
  settlementTurnWriteInputSchema,
  type SettlementTurnFacadeContext,
} from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";
import { wordEdgeClass } from "../support/edge-row-fixtures";

/**
 * MAIN-AGENT-EDGES 03b — F2 and F4, the peer's two "drive it through the real
 * route" escapes from ticket 03's implementation review.
 *
 * `grep -rn "declare:" tests/` returned ZERO hits before this file: the
 * `declare` parameter (`settlementNoteInputShape.declare`, D4) had storage
 * coverage (`declareEdgeSides`, pinned in `tests/db/logical-edge-writes.test.ts`)
 * but no test had ever sent it through the actual production entry — the
 * settlement `note` shape's own zod parse
 * (`settlementTurnWriteInputSchema`), the turn facade loop
 * (`evaluateSettlementTurnWrite`), and the direct-write rollback wrapper
 * (`createSettlementDirectWriteEngine`'s `writeNote`) — the three layers a
 * live settlement call actually crosses. Every test below builds its input
 * as a plain object and runs it through `settlementTurnWriteInputSchema.parse`
 * FIRST, exactly as the SDK's `leasedTool` wrapper parses a live call's
 * `arguments` before the handler ever sees them, then hands the PARSED value
 * to `engine.writeNote` — never `evaluateSettlementTurnWrite` called directly
 * on a hand-typed object that skips the schema a real call goes through.
 *
 * F4 shares this file because it needs the same infrastructure: one real
 * `note` call carrying both a retraction and a new attach on a citer sitting
 * exactly at the degree cap, proving retraction-before-attach ordering at the
 * FACADE, not only at the storage primitive two direct calls already pin in
 * `tests/db/relation-degree-caps.test.ts`.
 */

const NOW = 1_800_000_000;
const HOME_TAG = "declare-route-home";
const LANE_A = "lane-a";
const LANE_B = "lane-b";

let db: Database;
let laneHomeSegmentId: number;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
  laneHomeSegmentId = createSegment(db, {
    title: "declare route lane home",
    tags: [HOME_TAG],
    nowEpoch: NOW,
  }).id;
  insertLane(db, laneHomeSegmentId, LANE_A, NOW);
  insertLane(db, laneHomeSegmentId, LANE_B, NOW);
});

afterEach(() => {
  db.close();
});

function seedSession(): number {
  return upsertSession(db, {
    contentSessionId: "settlement-declare-route",
    project: "/tmp/project-settlement-declare-route",
    title: "declare route fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

/** Every fixture turn lives in the lane home, carrying both declared lanes — declarable (>= 2 lanes). */
function seedTurn(sessionDbId: number, promptNumber: number, tags: string[] = [HOME_TAG, LANE_A, LANE_B]): number {
  return db
    .query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tags, created_at_epoch
       ) VALUES (?, ?, 'active', 'p', 'r', ?, ?)
       RETURNING id`,
    )
    .get(sessionDbId, promptNumber, JSON.stringify(tags), NOW - 1_000 + promptNumber)!.id;
}

function claimWindow(
  sessionDbId: number,
  windowStart: number,
  windowEnd: number,
): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart, windowEnd, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job;
}

function baseContext(
  job: NoteSettlementJob,
  reviewableTurnIds: number[],
): SettlementTurnFacadeContext {
  return {
    jobId: job.id,
    claimGeneration: job.claimGeneration,
    stage: job.stage,
    sessionId: job.sessionId,
    reviewableTurnIds: new Set(reviewableTurnIds),
    contextBuiltAtEpoch: NOW,
  };
}

/** Peer round P1-8's relations read, the same one a real run makes before it writes an edge. */
function grantRelationsRead(context: SettlementTurnFacadeContext, turnAddress: string): void {
  recallMemory(db, {
    id: turnAddress,
    filter: { fields: ["relations"] },
    readerId: claimWriterId(context.jobId, context.claimGeneration, context.stage),
  });
}

/** The real route: zod parse, then the direct-write engine's own transaction. */
function callNote(
  engine: ReturnType<typeof createSettlementDirectWriteEngine>,
  rawInput: Record<string, unknown>,
) {
  const parsed = settlementTurnWriteInputSchema.parse(rawInput);
  return engine.writeNote(parsed);
}

function address(sessionDbId: number, promptNumber: number): string {
  return `S${sessionDbId}/T${promptNumber}`;
}

// ---------------------------------------------------------------------------
// F2 — `declare` end to end
// ---------------------------------------------------------------------------

describe("`declare` driven through the real settlement route (03b F2)", () => {
  test("a matching class declares the ambiguous side, and the receipt/counters/touches all show it", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    const context = baseContext(job, [t1]);
    const engine = createSettlementDirectWriteEngine({ db, context, now: () => NOW });

    grantRelationsRead(context, address(sessionDbId, 1));
    const attach = callNote(engine, { turn: address(sessionDbId, 1), use: [address(sessionDbId, 2)] });
    expect(attach.content[0]!.text).toContain("Landed 1 relation");

    // The declare-only call: the CAS `class` names what the pair actually
    // carries (`use`, from the attach above), and only `headTag` is placed —
    // `tailTag` is OMITTED, not sent as anything.
    const declared = callNote(engine, {
      turn: address(sessionDbId, 1),
      declare: [{ turn: address(sessionDbId, 2), class: "use", headTag: LANE_B }],
    });

    expect(declared.content[0]!.text).toContain("Declared a side on 1 edge(s)");
    const edge = getOutgoingEdges(db, { kind: "turn", id: t1 }).find((row) => row.cited.id === t2)!;
    expect(edge.headTag).toBe(LANE_B);
    expect(edge.tailTag).toBe(""); // omitted — left alone, not cleared
  });

  test("a stale class refuses, naming the pair's current class, and rolls back the WHOLE call", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const t3 = seedTurn(sessionDbId, 3);
    const job = claimWindow(sessionDbId, 1, 3);
    const context = baseContext(job, [t1]);
    const engine = createSettlementDirectWriteEngine({ db, context, now: () => NOW });

    grantRelationsRead(context, address(sessionDbId, 1));
    callNote(engine, { turn: address(sessionDbId, 1), use: [address(sessionDbId, 2)] });

    // ONE call: a genuinely legal `use` attach to a THIRD turn, riding beside
    // a `declare` entry whose CAS precondition (`correct`) is stale — the
    // pair is actually `use`. Both halves share the engine's one transaction
    // (`note-settlement-direct-write.ts` ~684-712), so the declare's
    // rejection must take the legal attach down with it.
    const result = callNote(engine, {
      turn: address(sessionDbId, 1),
      use: [address(sessionDbId, 3)],
      declare: [{ turn: address(sessionDbId, 2), class: "correct", headTag: LANE_B }],
    });

    expect(result.content[0]!.text).toContain("Parameter error");
    expect(result.content[0]!.text).toContain("declare rejected:");
    expect(result.content[0]!.text).toContain("stale: the pair is now `use`, not `correct`");
    // Nothing landed — not even the legal attach to T3 that preceded the
    // declare in call order.
    expect(getOutgoingEdges(db, { kind: "turn", id: t1 })).toHaveLength(1);
    expect(
      getOutgoingEdges(db, { kind: "turn", id: t1 }).some((row) => row.cited.id === t3),
    ).toBe(false);
    // And the side the declare wanted never moved either.
    const edge = getOutgoingEdges(db, { kind: "turn", id: t1 }).find((row) => row.cited.id === t2)!;
    expect(edge.headTag).toBe("");
  });

  test("`tailTag: null` CLEARS a stored side; an OMITTED `headTag` in the SAME call leaves it alone", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    const context = baseContext(job, [t1]);
    const engine = createSettlementDirectWriteEngine({ db, context, now: () => NOW });

    grantRelationsRead(context, address(sessionDbId, 1));
    callNote(engine, { turn: address(sessionDbId, 1), use: [address(sessionDbId, 2)] });
    callNote(engine, {
      turn: address(sessionDbId, 1),
      declare: [{ turn: address(sessionDbId, 2), tailTag: LANE_A, headTag: LANE_B }],
    });
    let edge = getOutgoingEdges(db, { kind: "turn", id: t1 }).find((row) => row.cited.id === t2)!;
    expect(edge.tailTag).toBe(LANE_A);
    expect(edge.headTag).toBe(LANE_B);

    // The three-state contract in one call: `tailTag: null` clears; `headTag`
    // is not sent at all (never even a key on the object) and must survive
    // exactly as it stood — an explicit `null` must not collapse into
    // `''`-means-unchanged, and an omission must not collapse into a clear.
    const cleared = callNote(engine, {
      turn: address(sessionDbId, 1),
      declare: [{ turn: address(sessionDbId, 2), tailTag: null }],
    });
    expect(cleared.content[0]!.text).toContain("Declared a side on 1 edge(s)");

    edge = getOutgoingEdges(db, { kind: "turn", id: t1 }).find((row) => row.cited.id === t2)!;
    expect(edge.tailTag).toBe("");
    expect(edge.headTag).toBe(LANE_B);
  });

  test("a no-op declare (both sides already at the requested value) reports `declared: 0` and nothing changes", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    const context = baseContext(job, [t1]);
    const engine = createSettlementDirectWriteEngine({ db, context, now: () => NOW });

    grantRelationsRead(context, address(sessionDbId, 1));
    callNote(engine, { turn: address(sessionDbId, 1), use: [address(sessionDbId, 2)] });
    callNote(engine, {
      turn: address(sessionDbId, 1),
      declare: [{ turn: address(sessionDbId, 2), tailTag: LANE_A }],
    });

    const noop = callNote(engine, {
      turn: address(sessionDbId, 1),
      declare: [{ turn: address(sessionDbId, 2), tailTag: LANE_A }],
    });
    expect(noop.content[0]!.text).not.toContain("Declared a side on");
  });
});

// ---------------------------------------------------------------------------
// F4 — one call at the cap: a retraction and a new attach together
// ---------------------------------------------------------------------------

describe("one real settlement call at the degree cap, retracting and attaching together (03b F4)", () => {
  test("a citer at exactly 20 outgoing atoms: retract one, attach one, in ONE call — succeeds", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const cited: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      cited.push(seedTurn(sessionDbId, 100 + index));
    }
    // 20 stored atoms — AT the cap, before this call runs at all.
    for (let index = 0; index < MAX_TURN_RELATION_DEGREE; index += 1) {
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: t1 },
            cited: { kind: "turn", id: cited[index]! },
            ...wordEdgeClass("extends"),
            provenance: "asserted",
            tailTag: "",
            headTag: "",
            relationClass: "use",
          },
        ],
        NOW,
      );
    }
    expect(getOutgoingEdges(db, { kind: "turn", id: t1 })).toHaveLength(
      MAX_TURN_RELATION_DEGREE,
    );

    const job = claimWindow(sessionDbId, 1, 121);
    const context = baseContext(job, [t1]);
    const engine = createSettlementDirectWriteEngine({ db, context, now: () => NOW });
    grantRelationsRead(context, address(sessionDbId, 1));

    // ONE call: retract the pair to `cited[0]`, attach a brand-new 21st
    // target — both faces (`note.ts` and this facade) run retraction BEFORE
    // the attach, so the cap this call is judged against is already the
    // POST-retraction count (19), not the pre-call 20.
    const result = callNote(engine, {
      turn: address(sessionDbId, 1),
      retractUse: [address(sessionDbId, 100)],
      use: [address(sessionDbId, 120)],
    });

    expect(result.content[0]!.text).not.toContain("Parameter error");
    expect(result.content[0]!.text).toContain("Landed 1 relation");
    expect(result.content[0]!.text).toContain("Retracted 1 relation");
    const after = getOutgoingEdges(db, { kind: "turn", id: t1 });
    expect(after).toHaveLength(MAX_TURN_RELATION_DEGREE);
    expect(after.some((row) => row.cited.id === cited[0])).toBe(false);
    expect(after.some((row) => row.cited.id === cited[20])).toBe(true);
  });
});
