import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { retractMemoryEdges, writeMemoryEdges } from "../../src/db/memory-edges";
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
import { retainAllImpressions } from "../support/impression-payload";
import {
  SETTLEMENT_ERA_CUTOFF_EPOCH,
  settlementScopeProvenanceFor,
} from "../support/settlement-config";

/**
 * SETTLEMENT-GATE-TAXONOMY TICKET 03 — ONE EVALUATOR, EVALUATED TWICE.
 *
 * Two properties, one fixture, both judged at the REAL seams (`lane_check`'s
 * rendered text and `commit`'s own result) and never on an evaluator internal:
 *
 *   1. ONE `lane_check` CALL DOES NOT CONTRADICT ITSELF. Ticket 01's fourth
 *      finding: the report-2 connectivity section was scope-projected while the
 *      LANE DISPOSITION block appended below it re-ran the gate UNPROJECTED, so
 *      one tool result printed "this lane is fine" above "this lane owes a
 *      disposition". That is the disagreement job 166's abandonment note named
 *      in its own words.
 *   2. PREVIEW AND VERDICT AGREE ON A MOVING DATABASE. The spec rejects a
 *      literally shared, computed-once snapshot — the run's own writes make one
 *      stale. What replaces it is one DEFINITION evaluated twice, so a write
 *      landing between the preview and the commit moves BOTH answers, in the
 *      same direction, and no third answer exists.
 */

const NOW = 1_800_000_000;

/**
 * `tags` draws from a closed vocabulary (a segment's own tag, or a lane
 * declared in it). These containers keep the fixture's bare words legal
 * without making the test about the vocabulary.
 */
function seedTagContainers(db: Database): void {
  for (const tag of ["lease", "lane"]) {
    const held = db
      .query<{ id: number }, [string]>(
        "SELECT id FROM segments WHERE json_extract(tags, '$[0]') = ?",
      )
      .get(tag);
    if (!held) {
      createSegment(db, { title: `${tag} container`, tags: [tag], nowEpoch: 100 });
    }
  }
}

interface EvaluatorFixture {
  sessionDbId: number;
  job: NoteSettlementJob;
  laneSegmentId: number;
  /** o1..o6 — the OUTSIDE lane's six members, prompts 1..6. */
  outsideTurnIds: number[];
  /** w1/w2 — the settlement window itself, prompts 7/8. */
  windowTurnIds: number[];
}

/**
 * One segment, two declared lanes.
 *
 *   - `window-lane` — w1/w2 (prompts 7-8), the job's own window, joined by one
 *     `extends` so it is WHOLE.
 *   - `outside-lane` — o1..o6 (prompts 1-6), claimed by `indexes` edges only
 *     (o2->o1, o3->o2, o5->o4): three islands ({o1,o2,o3}, {o4,o5}, {o6}) and
 *     therefore two fractures, o1<->o4 and o4<->o6. SEVERED, and provably so.
 *
 * THE DISCOVERY EDGE is what makes this fixture say something after ticket 02.
 * `w1 --grounds--> o1` carries `window-lane` on its TAIL and `outside-lane` on
 * its HEAD, so the loader DISCOVERS `outside-lane` from the seed and widens its
 * edges — the lane is fully materialised and genuinely reported, not a phantom
 * of a truncated edge set. But `w1` does not carry the lane's tag, so it is not
 * a MEMBER: every one of `outside-lane`'s members sits outside a writable set
 * of {w1, w2}.
 *
 * That is exactly the shape the two halves used to disagree about: the
 * projection drops the lane from report 2 (no island member is writable) while
 * the unprojected disposition gate still demanded a repair for it.
 */
function seedEvaluatorFixture(db: Database): EvaluatorFixture {
  const sessionDbId = upsertSession(db, {
    contentSessionId: "settlement-one-evaluator-session",
    project: "/tmp/project-settlement-one-evaluator",
    title: "one evaluator fixture",
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
         ) VALUES (?, ?, 'active', ?, ?, 3, ?, '["design"]', ?)
         RETURNING id`,
      )
      .get(
        sessionDbId,
        promptNumber,
        `prompt ${promptNumber}`,
        `response ${promptNumber}`,
        NOW - 900 + promptNumber,
        JSON.stringify(tags),
      )!.id;
  }

  const laneSegmentId = createSegment(db, {
    title: "one evaluator fixture",
    tags: ["one-evaluator-task"],
    nowEpoch: NOW,
  }).id;

  const outsideTags = ["one-evaluator-task", "outside-lane"];
  const o1 = insertTurn(1, outsideTags);
  const o2 = insertTurn(2, outsideTags);
  const o3 = insertTurn(3, outsideTags);
  const o4 = insertTurn(4, outsideTags);
  const o5 = insertTurn(5, outsideTags);
  const o6 = insertTurn(6, outsideTags);
  // The other representative of the fracture the run justifies below needs a
  // real promoted note: the justify's full-content grant is only meaningful
  // against a field that has something in it.
  db.query<unknown, [string, string, number]>(
    "UPDATE turns SET title = ?, content = ? WHERE id = ?",
  ).run("o4 note", "o4 body sentence. ".repeat(40), o4);

  const w1 = insertTurn(7, ["one-evaluator-task", "window-lane"]);
  const w2 = insertTurn(8, ["one-evaluator-task", "window-lane"]);

  addSegmentMembers(db, laneSegmentId, [o1, o2, o3, o4, o5, o6, w1, w2], NOW);
  insertLane(db, laneSegmentId, "outside-lane", NOW);
  insertLane(db, laneSegmentId, "window-lane", NOW);

  const outsideClaim = (citing: number, cited: number) => ({
    citing: { kind: "turn" as const, id: citing },
    cited: { kind: "turn" as const, id: cited },
    relation: "indexes" as const,
    provenance: "asserted" as const,
    tailTag: "outside-lane",
    headTag: "outside-lane",
  });

  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: w2 },
        cited: { kind: "turn", id: w1 },
        relation: "extends",
        provenance: "asserted",
        tailTag: "window-lane",
        headTag: "window-lane",
      },
      // THE DISCOVERY EDGE — one lane per side, which is what lets the seed
      // find `outside-lane` without w1 ever becoming a member of it.
      {
        citing: { kind: "turn", id: w1 },
        cited: { kind: "turn", id: o1 },
        relation: "grounds",
        provenance: "asserted",
        tailTag: "window-lane",
        headTag: "outside-lane",
      },
      outsideClaim(o2, o1),
      outsideClaim(o3, o2),
      outsideClaim(o5, o4),
    ],
    NOW,
  );

  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 7, windowEnd: 8, triggerType: "consecutive" }],
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
    laneSegmentId,
    outsideTurnIds: [o1, o2, o3, o4, o5, o6],
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

/**
 * ONE `## Report N` section of a rendered lane check, header included and the
 * next header excluded. The two-halves test below asserts on the connectivity
 * SECTION rather than on the whole text, because "the lane is absent" has to
 * mean "absent from the half that describes connectivity" and not "absent from
 * a string that happens not to mention it anywhere".
 */
function reportSection(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start === -1) {
    return "";
  }
  const rest = text.slice(start + heading.length);
  const end = rest.indexOf("\n## ");
  return heading + (end === -1 ? rest : rest.slice(0, end));
}

/** Every `[E6]` anchor address in a text, sorted — the same parse for the preview's render and for the commit refusal's. */
function draftErrorAnchors(text: string): string[] {
  const anchors: string[] = [];
  const pattern = /\[E6\] (?:anchor )?(S\d+\/T\d+)/g;
  let match = pattern.exec(text);
  while (match !== null) {
    anchors.push(match[1]!);
    match = pattern.exec(text);
  }
  return [...new Set(anchors)].sort();
}

/** Drives one settlement run against the fixture, with the body scripted against the REAL registered handlers. */
async function runSettlement(
  db: Database,
  fixture: EvaluatorFixture,
  writableTurnIds: number[],
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
    dataRoot: "/tmp/claude-mnemo-settlement-one-evaluator",
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
      7,
      8,
    ),
    contextBuiltAtEpoch: NOW,
    windowStart: 7,
    windowEnd: 8,
  });
}

describe("settlement-gate-taxonomy ticket 03 — one lane_check call does not contradict itself", () => {
  test("the connectivity section and the LANE DISPOSITION block of ONE rendered result agree about a lane outside the writable set", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedEvaluatorFixture(db);
      const { sessionDbId, laneSegmentId } = fixture;

      let justifyRefusal = "";
      let landedJustify = "";
      let laneCheckText = "";

      await runSettlement(db, fixture, fixture.windowTurnIds, async (handlers) => {
        // THE TOUCH, and the CONTROL that this fixture is not vacuous. A
        // landed `justify` is production's own touch source (job 166's
        // `lane_run_touches` held exactly one row, and it came from a
        // justify), and `justify`'s whole-lane projection is a second opinion
        // this ticket deliberately does not reconcile — which makes it a
        // witness. It only accepts a pair that IS a current fracture, so the
        // fact that it takes o1<->o4 proves the lane really is severed.
        await handlers.get("recall")!({ id: `E${laneSegmentId}/#outside-lane` });
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T4`,
          filter: { fields: ["content"] },
          turn: 4_000,
        });
        landedJustify = (
          (await handlers.get("remember")!({
            action: "justify",
            id: `E${laneSegmentId}`,
            tag: "outside-lane",
            representative: `S${sessionDbId}/T1`,
            otherRepresentative: `S${sessionDbId}/T4`,
            reason:
              `S${sessionDbId}/T1 and S${sessionDbId}/T4 are two independent repairs; no relation ` +
              "word holds between them.",
          })) as { content: Array<{ text: string }> }
        ).content[0]!.text;

        // The lane STILL owes o4<->o6 by the whole-lane view — `justify`'s own
        // refusal enumerates it. So at the instant of the `lane_check` below,
        // "this lane is severed and this run touched it" is TRUE.
        justifyRefusal = (
          (await handlers.get("remember")!({
            action: "justify",
            id: `E${laneSegmentId}`,
            tag: "outside-lane",
            representative: `S${sessionDbId}/T1`,
            otherRepresentative: `S${sessionDbId}/T2`,
            reason:
              `S${sessionDbId}/T1 and S${sessionDbId}/T2 are consecutive steps of one repair, ` +
              "no gap between them.",
          })) as { content: Array<{ text: string }> }
        ).content[0]!.text;

        laneCheckText = (
          (await handlers.get("lane_check")!({})) as { content: Array<{ text: string }> }
        ).content[0]!.text;
      });

      // The controls: the touch landed, and the lane is severed with one
      // fracture still undisposed.
      expect(landedJustify).toContain("Landed justify");
      expect(justifyRefusal).toContain("do not name a CURRENT fracture");

      // ---- HALF ONE of the SAME rendered result: connectivity ------------
      const connectivity = reportSection(laneCheckText, "## Report 2");
      expect(connectivity).toContain("window-lane");
      expect(connectivity).not.toContain("outside-lane");

      // ---- HALF TWO of that SAME text: the disposition block --------------
      // It used to print `severed fracture S1/T4 <-> S1/T6` here, under a
      // connectivity section that had just said nothing at all about the lane.
      expect(laneCheckText).not.toContain("LANE DISPOSITION");
      expect(laneCheckText).not.toContain("severed fracture");

      // Not an empty or failed render — the half that DOES have something to
      // say still says it, so the two silences above are the projection's and
      // not a report that never ran.
      expect(laneCheckText).toContain("## Report 2");
      expect(laneCheckText).toContain("## ERRORS");
    } finally {
      db?.close();
    }
  });

  test("the terminal commit agrees with that preview — it does not demand the disposition the report declined to describe", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedEvaluatorFixture(db);
      const { sessionDbId, laneSegmentId } = fixture;

      let commitText = "";
      await runSettlement(db, fixture, fixture.windowTurnIds, async (handlers) => {
        await handlers.get("recall")!({ id: `E${laneSegmentId}/#outside-lane` });
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T4`,
          filter: { fields: ["content"] },
          turn: 4_000,
        });
        await handlers.get("remember")!({
          action: "justify",
          id: `E${laneSegmentId}`,
          tag: "outside-lane",
          representative: `S${sessionDbId}/T1`,
          otherRepresentative: `S${sessionDbId}/T4`,
          reason:
            `S${sessionDbId}/T1 and S${sessionDbId}/T4 are two independent repairs; no relation ` +
            "word holds between them.",
        });
        commitText = (
          (await handlers.get("commit")!({
            report: "no friction this window",
            // The landed justify above touches two impression containers; a
            // compliant writer judges them, and this fixture's subject is the
            // disposition gate, not the impression ledger.
            impressions: retainAllImpressions(db!, fixture.job.id, fixture.windowTurnIds),
          })) as {
            content: Array<{ text: string }>;
          }
        ).content[0]!.text;
      });

      expect(commitText).toContain("Committed");
      expect(commitText).not.toContain("severed lane fracture");
      expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    } finally {
      db?.close();
    }
  });
});

describe("settlement-gate-taxonomy ticket 03 — preview and terminal verdict agree on a MOVING database", () => {
  /**
   * THE REASON THE TICKET REJECTS A COMPUTED-ONCE SNAPSHOT, stated as a test.
   *
   * The run's writable set here is the whole fixture, so every finding below is
   * this window's own. A DRAFT edge is minted between two tool calls and
   * retracted between two more, and at each instant the preview's error set and
   * the commit's verdict are read at their real seams and compared:
   *
   *   instant A (dirty) — preview names `[E6] S/T8`; commit REFUSES over the
   *                       same anchor.
   *   instant B (clean) — preview names none; commit SUCCEEDS.
   *
   * Two instants, two answers, and the two surfaces never differ within one.
   * A shared snapshot taken at the run's first evaluation would keep answering
   * with instant A's set at instant B — which is the third answer this asserts
   * cannot exist.
   */
  test("a write between the preview and the commit moves BOTH answers, in the same direction", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedEvaluatorFixture(db);
      const writable = [...fixture.outsideTurnIds, ...fixture.windowTurnIds];
      const [w1, w2] = fixture.windowTurnIds as [number, number];
      const draft = {
        citing: { kind: "turn" as const, id: w2 },
        cited: { kind: "turn" as const, id: w1 },
        relation: "verifies" as const,
        provenance: "asserted" as const,
        // Both sides unsettled — a DRAFT edge, which is E6.
        tailTag: "",
        headTag: "",
      };

      const previews: string[][] = [];
      const verdicts: string[][] = [];
      let finalCommit = "";

      await runSettlement(db, fixture, writable, async (handlers) => {
        const laneCheck = async (): Promise<string> =>
          (
            (await handlers.get("lane_check")!({})) as { content: Array<{ text: string }> }
          ).content[0]!.text;
        const commit = async (): Promise<string> =>
          (
            (await handlers.get("commit")!({ report: "no friction this window" })) as {
              content: Array<{ text: string }>;
            }
          ).content[0]!.text;

        // ---- THE WRITE that makes the database move -----------------------
        writeMemoryEdges(db!, [draft], NOW);

        // ---- INSTANT A: dirty ---------------------------------------------
        previews.push(draftErrorAnchors(await laneCheck()));
        const refusal = await commit();
        expect(refusal).toContain("Commit refused");
        verdicts.push(draftErrorAnchors(refusal));

        // ---- THE SECOND WRITE, in the opposite direction ------------------
        retractMemoryEdges(db!, [
          { citing: draft.citing, cited: draft.cited, relation: draft.relation, tailTag: "", headTag: "" },
        ]);

        // ---- INSTANT B: clean ---------------------------------------------
        previews.push(draftErrorAnchors(await laneCheck()));
        finalCommit = await commit();
        verdicts.push(draftErrorAnchors(finalCommit));
      });

      const anchor = `S${fixture.sessionDbId}/T8`;

      // THE AGREEMENT, per instant. Not "the preview eventually catches up":
      // at each instant the two surfaces name the identical set.
      expect(previews[0]).toEqual([anchor]);
      expect(verdicts[0]).toEqual([anchor]);
      expect(previews[1]).toEqual([]);
      expect(verdicts[1]).toEqual([]);

      // AND THE ANSWER MOVED. Both assertions above would also hold for a
      // frozen database; this is what makes the fixture about a moving one.
      expect(previews[0]).not.toEqual(previews[1]!);
      expect(verdicts[0]).not.toEqual(verdicts[1]!);

      // The last verdict is a real terminal one, so "agreed on nothing to
      // report" is not the same as "never got that far".
      expect(finalCommit).toContain("Committed");
      expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    } finally {
      db?.close();
    }
  });
});
