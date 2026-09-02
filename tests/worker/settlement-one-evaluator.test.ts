import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { loadLaneCheckScope } from "../../src/db/lane-checker-load";
import { computeLaneFractures, loadRunLaneTouches } from "../../src/db/lane-disposition";
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
import { checkLanes } from "../../src/shared/lane-checker";
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
 * SETTLEMENT-GATE-TAXONOMY TICKET 06 replaced this fixture's CONTROL. It used
 * to prove "this lane really is severed, and this run really touched it" with a
 * landed `remember(justify)` — a verb that only accepted a current fracture and
 * that recorded a lane touch of its own. Both halves of that control retired
 * with the verb, and a fixture that loses its control keeps passing while
 * testing nothing. What replaces it: `wholeLaneFracturePairs` (justify's own
 * `{kind:"lanes"}` projection, recomputed directly) for the severed half, and a
 * real EDGE SIDE naming the lane on one of its own members — production's own
 * touch shape, and the one job 166's ledger should have held instead of a
 * self-arming justify row — for the touched half, asserted off the durable
 * ledger the gate itself reads.
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

  const outsideTags = ["one-evaluator-task", "outside-lane", "spare-lane"];
  const o1 = insertTurn(1, outsideTags);
  const o2 = insertTurn(2, outsideTags);
  const o3 = insertTurn(3, outsideTags);
  const o4 = insertTurn(4, outsideTags);
  const o5 = insertTurn(5, outsideTags);
  const o6 = insertTurn(6, outsideTags);

  const w1 = insertTurn(7, ["one-evaluator-task", "window-lane", "spare-lane"]);
  const w2 = insertTurn(8, ["one-evaluator-task", "window-lane", "spare-lane"]);

  addSegmentMembers(db, laneSegmentId, [o1, o2, o3, o4, o5, o6, w1, w2], NOW);
  insertLane(db, laneSegmentId, "outside-lane", NOW);
  insertLane(db, laneSegmentId, "window-lane", NOW);
  // A SECOND lane on every member (main-agent-edges spec D6): E6 is the
  // AMBIGUOUS side now, so a blank side needs something to be ambiguous
  // between for this fixture's draft edges to be findings at all.
  insertLane(db, laneSegmentId, "spare-lane", NOW);

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

/**
 * THE CONTROL THAT REPLACED A LANDED `justify` (settlement-gate-taxonomy
 * ticket 06).
 *
 * Ticket 03's fixture proved "this lane really IS severed" by landing a
 * `justify` on one of its fractures: the verb only accepted a pair that was a
 * CURRENT fracture, so acceptance was the proof. `justify` retired with ticket
 * 06, and a fixture that simply loses its control keeps passing while testing
 * nothing — so the control is rebuilt from the SAME thing `justify` was doing
 * underneath: its own whole-lane `{kind:"lanes"}` projection, recomputed here
 * directly. This is deliberately NOT the evaluator under test: it takes the
 * lane by name, projects it whole, and knows nothing about a writable set, a
 * judgment window or a run.
 */
function wholeLaneFracturePairs(
  db: Database,
  segmentId: number,
  tag: string,
): string[] {
  const projection = loadLaneCheckScope(db, {
    kind: "lanes",
    laneKeys: [{ segment: String(segmentId), tag }],
  });
  const result = checkLanes(
    projection.turns,
    projection.edges,
    projection.outOfVocabularyEdges,
    projection.segmentFacts,
  );
  const component = result.components.find(
    (entry) => entry.key.segment === String(segmentId) && entry.key.tag === tag,
  );
  if (!component) {
    return [];
  }
  return computeLaneFractures(segmentId, component).map(
    (fracture) => `${fracture.representativeA}<->${fracture.representativeB}`,
  );
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
      const [, o4] = [fixture.outsideTurnIds[0]!, fixture.outsideTurnIds[3]!];

      // CONTROL A, taken BEFORE the run and off a projection that knows
      // nothing about it: the lane really is severed, into three pieces with
      // two fractures. Without this the assertions below are satisfied by a
      // lane that is simply whole.
      const wholeLaneBefore = wholeLaneFracturePairs(db, laneSegmentId, "outside-lane");

      let noteReceipt = "";
      let laneCheckText = "";

      await runSettlement(db, fixture, fixture.windowTurnIds, async (handlers) => {
        // THE TOUCH, and it is production's own shape: an EDGE SIDE naming the
        // lane, written on a turn this run may write. `w2 --grounds--> o4`
        // carries `window-lane` on its tail and `outside-lane` on its head, so
        // the touch ledger records `(o4, outside-lane)` and o4 IS a member of
        // one of that lane's islands — which is exactly the predicate the
        // disposition gate resolves a touch through. It is NOT one of
        // `outside-lane`'s OWN edges (its tail names another lane), so it
        // stitches nothing and the topology the control measured is unchanged.
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T8`,
          filter: { fields: ["relations"] },
          turn: 4_000,
        });
        noteReceipt = (
          (await handlers.get("note")!({
            turn: `S${sessionDbId}/T8`,
            use: [
              { turn: `S${sessionDbId}/T4`, tailTag: "window-lane", headTag: "outside-lane" },
            ],
          })) as { content: Array<{ text: string }> }
        ).content[0]!.text;

        laneCheckText = (
          (await handlers.get("lane_check")!({})) as { content: Array<{ text: string }> }
        ).content[0]!.text;
      });

      // ---- THE CONTROLS, both asserted -----------------------------------
      // A: the lane was severed with two fractures at the instant `lane_check`
      // ran, by an evaluator this ticket does not touch.
      expect(wholeLaneBefore.length).toBe(2);
      expect(wholeLaneFracturePairs(db, laneSegmentId, "outside-lane")).toEqual(
        wholeLaneBefore,
      );
      // B: this run TOUCHED that lane — the durable ledger the gate itself
      // reads holds the (member, lane) pair, so "severed AND touched" is true
      // and an unprojected disposition block has every reason to fire.
      expect(noteReceipt).toContain("Landed");
      expect(
        loadRunLaneTouches(db, fixture.job.id).turnTagPairs.has(`${o4}:outside-lane`),
      ).toBe(true);

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

      // The same control as the test above, and for the same reason: the lane
      // this commit declines to demand anything about is genuinely severed.
      expect(wholeLaneFracturePairs(db, laneSegmentId, "outside-lane").length).toBe(2);

      let commitText = "";
      await runSettlement(db, fixture, fixture.windowTurnIds, async (handlers) => {
        // The same production-shaped touch: an edge side naming `outside-lane`
        // on one of its own members, written from a window turn.
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T8`,
          filter: { fields: ["relations"] },
          turn: 4_000,
        });
        await handlers.get("note")!({
          turn: `S${sessionDbId}/T8`,
          use: [
            { turn: `S${sessionDbId}/T4`, tailTag: "window-lane", headTag: "outside-lane" },
          ],
        });
        // The edge write above touches two impression containers; a compliant
        // writer decides them before it commits, and this fixture's subject is
        // the disposition gate, not the impression ledger.
        await retainAllImpressions(handlers, db!, fixture.job.id, fixture.windowTurnIds);
        commitText = (
          (await handlers.get("commit")!({
            report: "no friction this window",
          })) as {
            content: Array<{ text: string }>;
          }
        ).content[0]!.text;
      });

      expect(
        loadRunLaneTouches(db, fixture.job.id).turnTagPairs.has(
          `${fixture.outsideTurnIds[3]!}:outside-lane`,
        ),
      ).toBe(true);
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
      const [, w2] = fixture.windowTurnIds as [number, number];
      // MAIN-AGENT-EDGES D1 ("one pair, one row"): this draft has to land on a
      // pair the fixture has NOT already written. It used to be `w2 -> w1`,
      // which the fixture seeds with both sides on `window-lane`; a second
      // write onto that pair no longer mints a row — it promotes the stored one
      // in place and leaves both stored sides exactly as they are, so no draft
      // ever appeared and E6 had nothing to name. `w2 -> o6` is free, and the
      // anchor this test asserts on is the CITING turn either way.
      const o6 = fixture.outsideTurnIds[5]!;
      const draft = {
        citing: { kind: "turn" as const, id: w2 },
        cited: { kind: "turn" as const, id: o6 },
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
        // MAIN-AGENT-EDGES D4 (ruling T2432 P1): a retraction is PAIR-addressed
        // and deletes every row of the pair. The relation word and the two side
        // tags left the address entirely — they were never a discriminator a
        // caller could be trusted to have read correctly.
        retractMemoryEdges(db!, [{ citing: draft.citing, cited: draft.cited }]);

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
