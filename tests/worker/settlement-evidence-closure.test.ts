import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { insertLane } from "../../src/db/lanes";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  createNoteSettlementSdkQuery,
  evaluateSettlementCommitGate,
} from "../../src/worker/note-settlement-sdk-query";
import {
  SETTLEMENT_ERA_CUTOFF_EPOCH,
  settlementScopeProvenanceFor,
} from "../support/settlement-config";

/**
 * SETTLEMENT-GATE-TAXONOMY TICKET 02 — THE EVIDENCE CLOSURE.
 *
 * A settlement dispatch's writable set is window ∪ declared lookback ∪
 * deadlock-guard closure, and a closure turn can sit anywhere: job 166's
 * reached 91 prompts back and into a DIFFERENT session. The judgment set is
 * narrower and defined in prompt numbers — the window plus the 50 prompts
 * immediately preceding it, same session.
 *
 * A turn in the gap is EVIDENCE: loaded, readable, and reported by nobody. Its
 * own older defects belong to the window that owns them, and a run that is
 * refused over one has no honest repair to offer — that is the shape that
 * burned job 166.
 *
 * ONE FIXTURE, ONE KNOB. Both gate tests build the identical database and
 * differ only in whether the scope carries a judgment window.
 */

const NOW = 1_800_000_000;

interface EvidenceFixture {
  sessionDbId: number;
  job: NoteSettlementJob;
  /** Prompt 900 — inside the writable set, 100 prompts before the window, so outside the judgment set. */
  lookbackTurn: number;
  /** Prompt 899 — the cited end of the lookback turn's draft edge. */
  lookbackCited: number;
  /**
   * Prompt 898 — a CLEAN evidence turn with no edge of its own. Ticket 04's
   * hole test writes a fresh draft from prompt 899 to this one, so the defect
   * it creates anchors at a turn that carried none, and the pre-existing
   * defect at prompt 900 stays a separate, untouched control.
   */
  evidenceRoot: number;
  windowTurnIds: number[];
}

/**
 * One segment, one declared lane, two DRAFT edges of the same shape — one
 * written from a lookback turn long ago, one from the window itself. Both are
 * error class E6 ("neither side names a lane"), both anchor at their CITING
 * turn, and both citing turns are in the writable set. The ONLY thing that
 * separates them is where their prompt number falls.
 */
function seedEvidenceFixture(db: Database): EvidenceFixture {
  const sessionDbId = upsertSession(db, {
    contentSessionId: "settlement-evidence-closure-session",
    project: "/tmp/project-settlement-evidence-closure",
    title: "settlement evidence closure fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;

  function insertTurn(promptNumber: number, tags: readonly string[]): number {
    return db
      .query<{ id: number }, [number, number, string, string, number, string]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           tool_call_count, created_at_epoch, type, tags
         ) VALUES (?, ?, 'active', ?, ?, 2, ?, '["design"]', ?)
         RETURNING id`,
      )
      .get(
        sessionDbId,
        promptNumber,
        `prompt ${promptNumber}`,
        `response ${promptNumber}`,
        NOW - 100_000 + promptNumber,
        JSON.stringify(tags),
      )!.id;
  }

  const evidenceRoot = insertTurn(898, ["evidence-task", "beta"]);
  const lookbackCited = insertTurn(899, ["evidence-task", "beta"]);
  const lookbackTurn = insertTurn(900, ["evidence-task", "beta"]);
  const w1 = insertTurn(1000, ["evidence-task", "beta"]);
  const w2 = insertTurn(1001, ["evidence-task", "beta"]);

  const segmentId = createSegment(db, {
    title: "evidence closure fixture",
    tags: ["evidence-task"],
    nowEpoch: NOW,
  }).id;
  addSegmentMembers(db, segmentId, [evidenceRoot, lookbackCited, lookbackTurn, w1, w2], NOW);
  insertLane(db, segmentId, "beta", NOW);

  const draft = (citing: number, cited: number) => ({
    citing: { kind: "turn" as const, id: citing },
    cited: { kind: "turn" as const, id: cited },
    relation: "extends" as const,
    provenance: "asserted" as const,
    ...deriveSideTags([]),
  });
  writeMemoryEdges(db, [draft(lookbackTurn, lookbackCited), draft(w2, w1)], NOW);

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
    lookbackTurn,
    lookbackCited,
    evidenceRoot,
    windowTurnIds: [w1, w2],
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

describe("settlement-gate-taxonomy ticket 02 — an old error on a lookback turn is invisible and non-blocking", () => {
  test("the commit gate refuses over the window's own draft edge and says nothing about the lookback turn's", () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const fixture = seedEvidenceFixture(db);
      const writableTurnIds = new Set([fixture.lookbackTurn, ...fixture.windowTurnIds]);

      const refusal = evaluateSettlementCommitGate(db, {
        writableTurnIds,
        judgment: { sessionId: fixture.sessionDbId, windowStart: 1000, windowEnd: 1001 },
      });

      expect(refusal).not.toBeNull();
      // The window's own defect blocks — the gate has not gone quiet.
      expect(refusal).toContain(`S${fixture.sessionDbId}/T1001`);
      expect(refusal).toContain("1 error(s)");
      // The lookback turn's identical defect does not appear at all: not as a
      // blocking line, and not as one of the two "further error(s)"
      // accounting remainders either. It is not a finding of this window.
      expect(refusal).not.toContain(`S${fixture.sessionDbId}/T900`);
      expect(refusal).not.toContain("further error(s)");
    } finally {
      db?.close();
    }
  });

  test("THE KNOB: drop the judgment window and the same call refuses over both", () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const fixture = seedEvidenceFixture(db);
      const writableTurnIds = new Set([fixture.lookbackTurn, ...fixture.windowTurnIds]);

      // The ONLY difference from the test above. A scope with no judgment
      // window judges everything it loads, which is the pre-ticket behaviour
      // and what every non-settlement caller still gets.
      const refusal = evaluateSettlementCommitGate(db, { writableTurnIds });

      expect(refusal).not.toBeNull();
      expect(refusal).toContain("2 error(s)");
      expect(refusal).toContain(`S${fixture.sessionDbId}/T1001`);
      expect(refusal).toContain(`S${fixture.sessionDbId}/T900`);
    } finally {
      db?.close();
    }
  });

  test("`lane_check` prints the same list the gate blocks on — the lookback defect is in neither", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const fixture = seedEvidenceFixture(db);
      let laneCheckText = "";

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const preview = (await handlers.get("lane_check")!({})) as {
            content: Array<{ text: string }>;
          };
          laneCheckText = preview.content[0]!.text;
          yield { type: "result", subtype: "success", is_error: false, result: "done" };
        })(),
      );

      const runQuery = createNoteSettlementSdkQuery({
        db,
        dataRoot: "/tmp/claude-mnemo-settlement-evidence-closure",
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
        writableTurnIds: new Set([fixture.lookbackTurn, ...fixture.windowTurnIds]),
        scopeProvenance: settlementScopeProvenanceFor(
          db,
          fixture.sessionDbId,
          [fixture.lookbackTurn, ...fixture.windowTurnIds],
          1000,
          1001,
        ),
        contextBuiltAtEpoch: NOW,
        windowStart: 1000,
        windowEnd: 1001,
      });

      // The window's own E6 is shown — so this is not a render that lost its
      // error section.
      expect(laneCheckText).toContain("[E6]");
      expect(laneCheckText).toContain(`S${fixture.sessionDbId}/T1001`);
      expect(laneCheckText).toContain("1 error(s)");
      // The lookback turn's E6 is not, on either scope.
      expect(laneCheckText).not.toContain(`S${fixture.sessionDbId}/T900: extends`);
    } finally {
      db?.close();
    }
  });
});

/**
 * SETTLEMENT-GATE-TAXONOMY TICKET 04 — THE HOLE TICKET 02 OPENED, CLOSED.
 *
 * Ticket 02 made the judgment set narrower than the writable set, and left a
 * gap between them: a run could DIRTY a writable turn outside its judgment set
 * — mint a draft edge on a closure endpoint 100 prompts back — and commit
 * clean, because its own brand-new finding anchored where nothing may be
 * judged.
 *
 * TWO READINGS WERE AVAILABLE AND THE OTHER ONE IS THE OBVIOUS ONE, so this
 * fixture pins the one that shipped:
 *
 *   - NOT "intersect write authority with the judgment set". Those turns are
 *     writable precisely because this job's own projection made their edges
 *     stale and the citing turn is the only turn that can repair them;
 *     narrowing authority reinstates the deadlock the closure exists to break.
 *   - "Writing at a turn re-admits it as an anchor, whatever the distance."
 *     A finding where this run just wrote is not somebody else's debt at any
 *     distance, and it can never deadlock: whatever the run wrote, it can
 *     retract.
 *
 * ONE RUN, TWO DEFECTS OF THE IDENTICAL SHAPE, both on evidence turns:
 * prompt 900's draft edge was already in the database, prompt 899's is minted
 * by the run itself. Only the second is judged. That is what makes this a test
 * of AUTHORSHIP rather than of "everything writable is judged after all".
 */
describe("settlement-gate-taxonomy ticket 04 — a defect this run CREATES on an evidence turn is judged", () => {
  test("the run's own draft on prompt 899 blocks the commit; the pre-existing one on prompt 900 still does not", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const fixture = seedEvidenceFixture(db);
      const writableTurnIds = [
        fixture.evidenceRoot,
        fixture.lookbackCited,
        fixture.lookbackTurn,
        ...fixture.windowTurnIds,
      ];
      let beforeText = "";
      let afterText = "";
      let commitText = "";

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          // CONTROL, before this run has written anything: the two evidence
          // turns are loaded and readable, and neither one's own defect is a
          // finding of this window.
          beforeText = (
            (await handlers.get("lane_check")!({})) as { content: Array<{ text: string }> }
          ).content[0]!.text;

          // The run DIRTIES prompt 899 — a bare address is a DRAFT edge, which
          // is error class E6 by construction, on a turn 101 prompts before
          // the window.
          await handlers.get("recall")!({
            id: `S${fixture.sessionDbId}/T899`,
            filter: { fields: ["relations"] },
            turn: 4_000,
          });
          const written = (await handlers.get("note")!({
            turn: `S${fixture.sessionDbId}/T899`,
            extends: [`S${fixture.sessionDbId}/T898`],
          })) as { content: Array<{ text: string }> };
          expect(written.content[0]!.text).not.toContain("refused");

          afterText = (
            (await handlers.get("lane_check")!({})) as { content: Array<{ text: string }> }
          ).content[0]!.text;

          commitText = (
            (await handlers.get("commit")!({ report: "no friction this window" })) as {
              content: Array<{ text: string }>;
            }
          ).content[0]!.text;

          yield { type: "result", subtype: "success", is_error: false, result: "done" };
        })(),
      );

      const runQuery = createNoteSettlementSdkQuery({
        db,
        dataRoot: "/tmp/claude-mnemo-settlement-evidence-closure",
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
        writableTurnIds: new Set(writableTurnIds),
        scopeProvenance: settlementScopeProvenanceFor(
          db,
          fixture.sessionDbId,
          writableTurnIds,
          1000,
          1001,
        ),
        contextBuiltAtEpoch: NOW,
        windowStart: 1000,
        windowEnd: 1001,
      });

      // BEFORE: neither evidence turn's defect is reported. (The window's own
      // turns carry a draft too — that one is prompt 1001's and is judged
      // throughout, which is what keeps the ERRORS block from being empty for
      // an uninteresting reason.)
      expect(beforeText).toContain(`anchor S${fixture.sessionDbId}/T1001`);
      expect(beforeText).not.toContain(`anchor S${fixture.sessionDbId}/T899`);
      expect(beforeText).not.toContain(`anchor S${fixture.sessionDbId}/T900`);

      // AFTER: the defect this run authored is a finding, at full distance.
      expect(afterText).toContain(`anchor S${fixture.sessionDbId}/T899`);
      // …and the identical one it did NOT author, 1 prompt further out, still
      // is not. Same class, same writability, same distance band: authorship
      // is the only difference between them.
      expect(afterText).not.toContain(`anchor S${fixture.sessionDbId}/T900`);

      // The gate agrees with the preview, because one rule built both.
      expect(commitText).toContain("Commit refused");
      expect(commitText).toContain(`S${fixture.sessionDbId}/T899`);
      expect(commitText).not.toContain(`S${fixture.sessionDbId}/T900`);
    } finally {
      db?.close();
    }
  });
});
