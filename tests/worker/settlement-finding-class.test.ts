import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { insertLane } from "../../src/db/lanes";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { createNoteSettlementSdkQuery } from "../../src/worker/note-settlement-sdk-query";
import { LANE_CHECK_WARNING_NOTICE } from "../../src/shared/lane-checker-render";
import {
  SETTLEMENT_ERA_CUTOFF_EPOCH,
  settlementScopeProvenanceFor,
} from "../support/settlement-config";

/**
 * SETTLEMENT-GATE-TAXONOMY TICKET 04 — ONE RULE DECIDES EVERY CLASS.
 *
 * > BLOCKING ERROR = a hard post-state invariant of this stage is violated,
 * > AND the finding anchors inside this run's judgment set,
 * > AND the run has a bounded, legal, honest repair action.
 *
 * The two things this file pins, both at the real registered handlers and
 * never against the predicate directly:
 *
 *   1. E3 AND E6 ON THE SAME ANCHOR SPLIT, and the split comes from the rule's
 *      THIRD condition rather than from a per-check exception. Same turn, same
 *      writability, same provenance, same distance — the only difference is
 *      what repairing each one would take, and stage 2 holds the pen for one
 *      and not the other. Both surfaces then say the same thing about both,
 *      which is what the old hand-written carve-out could not manage: the
 *      render printed E3 under `## ERRORS` and the gate silently dropped it.
 *   2. `LaneCoverage` STOPS UNDER-REPORTING TRUNCATION. Report 1 prints a
 *      member count, and after ticket 02's judgment narrowing that count is
 *      routinely a slice of the lane while the coverage verdict still read
 *      `whole`. A count that reads wider than it means is the MISLEADING half
 *      of this project's failure taxonomy.
 */

const NOW = 1_800_000_000;

interface ClassFixture {
  sessionDbId: number;
  job: NoteSettlementJob;
  segmentId: number;
  /** Prompt 1000 — a window turn with an EMPTY type (E3) that also cites a DRAFT edge (E6). */
  dirtyTurn: number;
  /** Prompt 1001 — the second window turn, and the draft edge's cited end. */
  windowTail: number;
  writableTurnIds: number[];
}

/**
 * ONE TURN CARRYING BOTH CLASSES. Prompt 1000 has an empty `type` (E3 anchors
 * at the turn itself) and cites a bare, both-sides-unsettled edge (E6 anchors
 * at the citing turn, which is this same turn). So every input the rule reads
 * except the class itself is held constant between the two findings.
 *
 * The lane exists and has SEVEN declared members, of which this projection
 * emits four — that is the coverage test's denominator, and it is a fact about
 * the registry rather than about this projection.
 */
function seedClassFixture(db: Database, options: { withE4?: boolean } = {}): ClassFixture {
  const sessionDbId = upsertSession(db, {
    contentSessionId: "settlement-finding-class-session",
    project: "/tmp/project-settlement-finding-class",
    title: "settlement finding class fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;

  function insertTurn(promptNumber: number, type: string, tags: readonly string[]): number {
    return db
      .query<{ id: number }, [number, number, string, string, number, string, string]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           tool_call_count, created_at_epoch, type, tags
         ) VALUES (?, ?, 'active', ?, ?, 2, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        sessionDbId,
        promptNumber,
        `prompt ${promptNumber}`,
        `response ${promptNumber}`,
        NOW - 100_000 + promptNumber,
        type,
        JSON.stringify(tags),
      )!.id;
  }

  // TWO FAR ISLANDS (prompts 10/11 and 12/13), both far outside any judgment
  // window this job could declare. The narrowing keeps the components the
  // judgment anchors touch plus ONE boundary witness, so exactly one of these
  // two islands is emitted and the other is not — which is what makes the
  // lane's whole membership (6) and this projection's view of it (4) differ.
  const far1 = insertTurn(10, '["design"]', ["class-task", "gamma", "delta"]);
  const far2 = insertTurn(11, '["design"]', ["class-task", "gamma", "delta"]);
  const far3 = insertTurn(12, '["design"]', ["class-task", "gamma", "delta"]);
  const far4 = insertTurn(13, '["design"]', ["class-task", "gamma", "delta"]);
  const near = insertTurn(999, '["design"]', ["class-task", "gamma", "delta"]);
  const dirtyTurn = insertTurn(1000, "[]", ["class-task", "gamma", "delta"]);
  const windowTail = insertTurn(1001, '["design"]', ["class-task", "gamma", "delta"]);

  const segmentId = createSegment(db, {
    title: "finding class fixture",
    tags: ["class-task"],
    nowEpoch: NOW,
  }).id;
  addSegmentMembers(
    db,
    segmentId,
    [far1, far2, far3, far4, near, dirtyTurn, windowTail],
    NOW,
  );
  insertLane(db, segmentId, "gamma", NOW);
  // A SECOND declared lane, carried by every member (main-agent-edges spec
  // D6): E6 is "a blank side whose endpoint has ≥2 lanes" now, so a fixture
  // whose members sit in one lane raises no draft finding at all and this
  // test's E3/E6 split would have nothing to split.
  insertLane(db, segmentId, "delta", NOW);

  writeMemoryEdges(
    db,
    [
      // Each far pair is an island of its own, joined by a placed edge, so the
      // lane's membership is real rather than a set of orphans.
      {
        citing: { kind: "turn", id: far2 },
        cited: { kind: "turn", id: far1 },
        relationClass: "use",
        provenance: "asserted",
        ...deriveSideTags(["gamma"]),
      },
      {
        citing: { kind: "turn", id: far4 },
        cited: { kind: "turn", id: far3 },
        relationClass: "use",
        provenance: "asserted",
        ...deriveSideTags(["gamma"]),
      },
      {
        citing: { kind: "turn", id: windowTail },
        cited: { kind: "turn", id: near },
        relationClass: "use",
        provenance: "asserted",
        ...deriveSideTags(["gamma"]),
      },
      // THE AMBIGUOUS SIDE (E6): both sides blank on endpoints carrying two
      // lanes, anchored at the same turn whose type is empty.
      {
        citing: { kind: "turn", id: dirtyTurn },
        cited: { kind: "turn", id: windowTail },
        relationClass: "use",
        provenance: "asserted",
        ...deriveSideTags([]),
      },
    ],
    NOW,
  );

  // AN E4, on request: a stored side naming a lane its own endpoint does not
  // carry. Written past `writeMemoryEdges` because the write gate refuses
  // exactly this shape — E4 is a rule re-checked over STOCK, and stock is what
  // a later tag edit produces.
  if (options.withE4 === true) {
    insertLane(db, segmentId, "epsilon", NOW);
    db.query<unknown, [number, number, number]>(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, provenance,
          tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
       VALUES ('turn', ?, 'turn', ?, 'asserted', 'epsilon', 'gamma', 'use', '', ?)`,
    ).run(dirtyTurn, near, NOW);
  }

  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 1000, windowEnd: 1001, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return {
    sessionDbId,
    job,
    segmentId,
    dirtyTurn,
    windowTail,
    writableTurnIds: [near, dirtyTurn, windowTail],
  };
}

function captureToolImpl() {
  const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();
  const toolImpl = mock(
    (
      name: string,
      _description: string,
      _shape: unknown,
      handler: (args: Record<string, unknown>) => unknown,
    ) => {
      handlers.set(name, handler);
      return { name };
    },
  );
  return { toolImpl, handlers };
}

/** One settlement run over the fixture, returning the `lane_check` render and the `commit` result. */
async function runOnce(
  db: Database,
  fixture: ClassFixture,
  body: (handlers: Map<string, (args: Record<string, unknown>) => unknown>) => Promise<void>,
): Promise<void> {
  const { toolImpl, handlers } = captureToolImpl();
  const queryImpl = mock(() =>
    (async function* () {
      await body(handlers);
      yield { type: "result", subtype: "success", is_error: false, result: "done" };
    })(),
  );
  const runQuery = createNoteSettlementSdkQuery({
    db,
    dataRoot: "/tmp/claude-mnemo-settlement-finding-class",
    queryImpl: queryImpl as never,
    createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
    toolImpl: toolImpl as never,
    now: () => NOW,
  });
  await runQuery({
    prompt: "settle",
    systemPrompt: "system",
    model: "claude-sonnet-5",
    jobId: fixture.job.id,
    claimGeneration: fixture.job.claimGeneration,
    stage: fixture.job.stage,
    sessionId: fixture.sessionDbId,
    writableTurnIds: new Set(fixture.writableTurnIds),
    scopeProvenance: settlementScopeProvenanceFor(
      db,
      fixture.sessionDbId,
      fixture.writableTurnIds,
      1000,
      1001,
    ),
    contextBuiltAtEpoch: NOW,
    windowStart: 1000,
    windowEnd: 1001,
  });
}

describe("settlement-gate-taxonomy ticket 04 — one rule, one class, both surfaces", () => {
  // RED CAPABILITY: delete the `if (finding.error.class === "E3") return false`
  // arm of `hasBoundedLegalHonestRepair`
  // (`worker/note-settlement-finding-class.ts`) — i.e. restore the reading
  // where the rule's third condition is satisfied by the anchor's relation
  // authority alone — and this test fails on the FIRST assertion below: the
  // ERRORS block comes back carrying "2 error(s)" and the commit refuses over
  // the type debt no edge pass can discharge. Verified by running it.
  /**
   * REPLACED (main-agent-edges ticket 14). This test read "E3 and E6 on the
   * SAME anchor split", and the split it pinned was E6 blocking while E3 did
   * not. Ruling S15069/T2465-T2466 demoted E6 to a warning, so the two now land
   * on the SAME side — which is a stronger statement of the same property, and
   * the acceptance case for "commit with an outstanding E6 SUCCEEDS".
   *
   * The rule still has something to split, and the test below this one is where
   * it splits: an E4 on the same anchor blocks while both of these do not.
   */
  test("E3 and E6 on the SAME anchor are BOTH warnings, and commit succeeds over them", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const fixture = seedClassFixture(db);
      let previewText = "";
      let commitText = "";

      await runOnce(db, fixture, async (handlers) => {
        previewText = (
          (await handlers.get("lane_check")!({})) as { content: Array<{ text: string }> }
        ).content[0]!.text;
        commitText = (
          (await handlers.get("commit")!({ report: "no friction this window" })) as {
            content: Array<{ text: string }>;
          }
        ).content[0]!.text;
      });

      // THE ERRORS BLOCK IS EMPTY. Neither class blocks, and the block is
      // exactly what the gate refuses over, so it holds nothing.
      const errorsBlock = previewText.split("## WARNINGS")[0]!;
      expect(errorsBlock).toContain("(none)");
      expect(errorsBlock).not.toContain("[E6]");
      expect(errorsBlock).not.toContain("[E3]");

      // BOTH FACTS ARE STILL SHOWN — narrowing what blocks is not hiding the
      // fact — and both are below the warnings header, whose promise is true.
      const warningsHalf = previewText.split("## WARNINGS")[1]!;
      expect(warningsHalf).toContain(LANE_CHECK_WARNING_NOTICE);
      expect(warningsHalf).toContain("## Grammar findings this run cannot repair -- 2 finding(s)");
      expect(warningsHalf).toContain("[E3]");
      expect(warningsHalf).toContain("[E6]");
      expect(warningsHalf).toContain(`anchor S${fixture.sessionDbId}/T1000`);

      // AND THE GATE AGREES: nothing refuses, and the job is DONE.
      expect(commitText).not.toContain("Commit refused");
      expect(commitText).toContain("Committed.");
      expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    } finally {
      db?.close();
    }
  });

  /**
   * THE OTHER HALF OF THE SAME ACCEPTANCE CRITERION: E4 alone still refuses,
   * after E6's demotion. Same fixture, same anchor, one extra stock row whose
   * stored side names a lane its own endpoint does not carry.
   */
  test("an E4 on that same anchor STILL refuses commit, and the E3/E6 stay off the blocking list", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const fixture = seedClassFixture(db, { withE4: true });
      let previewText = "";
      let commitText = "";

      await runOnce(db, fixture, async (handlers) => {
        previewText = (
          (await handlers.get("lane_check")!({})) as { content: Array<{ text: string }> }
        ).content[0]!.text;
        commitText = (
          (await handlers.get("commit")!({ report: "no friction this window" })) as {
            content: Array<{ text: string }>;
          }
        ).content[0]!.text;
      });

      const errorsBlock = previewText.split("## WARNINGS")[0]!;
      expect(errorsBlock).toContain("[E4]");
      expect(errorsBlock).not.toContain("[E6]");
      expect(errorsBlock).not.toContain("[E3]");

      expect(commitText).toContain("Commit refused");
      expect(commitText).toContain("[E4]");
      expect(commitText).not.toContain("[E6]");
      expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");
    } finally {
      db?.close();
    }
  });

  // RED CAPABILITY: drop `projection.laneMemberTotals` from the `checkLanes`
  // call in `evaluateWindowLanes` (or return `[]` from the loader's own
  // accumulator) and the coverage line loses its denominator entirely — the
  // verdict falls back to `whole` and the "SLICE" sentence disappears. Both
  // assertions below go red, and nothing else in the suite does.
  test("report 1's coverage says the members it lists are a SLICE, with both counts", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const fixture = seedClassFixture(db);
      let previewText = "";

      await runOnce(db, fixture, async (handlers) => {
        previewText = (
          (await handlers.get("lane_check")!({})) as { content: Array<{ text: string }> }
        ).content[0]!.text;
      });

      // The lane has SEVEN declared members; this projection emits five (two
      // touched components plus the one boundary witness). The old line said
      // `whole` over that member list, because every claiming edge's endpoint
      // happened to be loaded — which is the narrower question it was actually
      // answering all along.
      expect(previewText).toContain(
        "coverage: partial -- 5 of 7 declared member(s) loaded; " +
          "the members above are a SLICE of this lane, not all of it",
      );
      // And the count the reader would otherwise have taken for the lane is
      // right there above it, which is exactly why the line has to say so.
      expect(previewText).toContain("Lane E1:{gamma}");
    } finally {
      db?.close();
    }
  });
});
