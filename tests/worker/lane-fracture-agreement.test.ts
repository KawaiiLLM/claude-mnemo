import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { loadLaneCheckScope } from "../../src/db/lane-checker-load";
import { computeLaneFractures, loadRunLaneTouches } from "../../src/db/lane-disposition";
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
import { checkLanes } from "../../src/shared/lane-checker";
import { retainAllImpressions } from "../support/impression-payload";
import { createNoteSettlementSdkQuery } from "../../src/worker/note-settlement-sdk-query";
import {
  SETTLEMENT_ERA_CUTOFF_EPOCH,
  settlementScopeProvenanceFor,
} from "../support/settlement-config";

/**
 * SETTLEMENT-GATE-TAXONOMY TICKET 01 — THE FROZEN-AGREEMENT FIXTURE.
 *
 * Three code paths answer "which fractures does this lane have right now":
 *
 *   1. the `lane_check` PREVIEW      — `checkWindowLanes()`
 *   2. the terminal COMMIT gate      — `evaluateLaneDispositionGate()`
 *   3. a WHOLE-LANE `{kind:"lanes"}` projection
 *
 * (1) and (2) are one function by construction. (3) is a second evaluator.
 * On a database that is not moving, all three must name the SAME pairs.
 *
 * ARM 3 USED TO BE `remember(justify)`, which built exactly that whole-lane
 * projection internally and enumerated the lane's current fractures in its own
 * refusal text. Settlement-gate-taxonomy ticket 06 retired the verb (user
 * ruling S15069/T2278); the ARM survives it, because what made it a second
 * opinion was the PROJECTION and not the entry point, and this file is a
 * diagnosis of what already happened. It is computed directly now
 * (`wholeLaneFracturePairs`) — same loader, same core, same
 * `computeLaneFractures`, no tool call and no write.
 *
 * They do not. The discriminator is not the evaluator — it is
 * `loadLaneCheckScope`'s asymmetry between two things it does in one pass:
 *
 *   - lane MEMBERSHIP is resolved for EVERY turn that lands in the
 *     projection (`laneTags`, resolved at the end from the turn's own `tags`
 *     column), and the SEGMENT-GLOBAL pass drags in every live turn of every
 *     involved lane's segment;
 *   - lane EDGE WIDENING (`loadEdgesForTag`) runs only for lanes the seed
 *     DISCOVERED.
 *
 * So a lane nobody asked about materialises with its FULL membership and a
 * TRUNCATED edge set, and reads as severed into as many islands as it has
 * members.
 *
 * WHICH of its edges survive is decided by the segment-global pass alone, and
 * that pass carries only `SEGMENT_GRAPH_RELATIONS`
 * (narrows/extends/consume/grounds). The supplementary citedness/override
 * passes do NOT make up the difference: they run over `memberIdList`, which
 * is fixed BEFORE the segment-global pass widens the turn set, so a turn that
 * arrives that late is invisible to them too. `indexes` — the word an index
 * or roll-up turn uses to claim its lane — is therefore lost wholesale.
 * Measured on the production database for E60's `execution-repair` lane:
 * the window projection kept extends 27, grounds 3, consume 1, narrows 1 and
 * (incidentally) one override and one verifies, and dropped all 20 `indexes`
 * rows plus the second `verifies`.
 *
 * Production shape (job 166, S15069 window 2202-2251, abandoned after 21
 * refused commits): NONE of the job's 109 writable turns carried
 * `execution-repair`, yet all 39 of that lane's members were pulled into the
 * window projection with 34 of its 55 claiming edges — the 21 missing rows
 * were all `indexes`. The gate blocked on 5 phantom fractures; every
 * `justify` the agent landed was bound to the WHOLE-LANE fracture set, which
 * is disjoint from the phantom one. Nothing the run could legally write
 * would ever have satisfied the gate.
 *
 * ONE FIXTURE, TWO RUNS, ONE KNOB. Both tests below share the identical
 * frozen database and differ only in `writableTurnIds`. When the ghost lane's
 * members are in the seed, the lane is DISCOVERED, its `indexes` edges load,
 * and all three evaluators agree. When they are not, they did not.
 *
 * TICKET 02 CLOSED THE ASYMMETRY and the second test's assertions moved with
 * it. `laneTags` is now resolved only for the lanes this projection actually
 * WIDENED (`db/lane-checker-load.ts`'s `emittedLaneTagsFor`), so an
 * undiscovered lane has no member, is not enumerated by the core, and is
 * reported by nobody — the phantom fractures are gone by CONSTRUCTION rather
 * than filtered out downstream. What the second test pins now is the property
 * this whole batch exists for: whatever the gate names is a SUBSET of what a
 * whole-lane view says is really there, so a run is never shown a pair the
 * graph does not have.
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

interface GhostLaneFixture {
  sessionDbId: number;
  job: NoteSettlementJob;
  laneSegmentId: number;
  /** g1..g6 — the GHOST lane's six members, prompts 1..6. */
  ghostTurnIds: number[];
  /** w1/w2 — the settlement window itself, prompts 7/8, carrying a lane of their own. */
  windowTurnIds: number[];
}

/**
 * One segment, three declared lanes:
 *
 *   - `window-lane`  — w1/w2, the job's actual window. Whole.
 *   - `carrier-lane` — g1..g6, chained by `extends`. Whole, and the reason
 *     the six ghost turns reach the window projection at all: `extends` is a
 *     `SEGMENT_GRAPH_RELATIONS` word, so the loader's segment-global pass
 *     loads those rows and their endpoints join the turn set.
 *   - `ghost-lane`   — the SAME six turns, claimed by `indexes` edges only:
 *     g2->g1, g3->g2 and g5->g4. Truthfully three islands
 *     ({g1,g2,g3}, {g4,g5}, {g6}) and therefore two fractures, g1<->g4 and
 *     g4<->g6.
 *
 * `indexes` is carried by no supplementary pass and by no segment-global
 * relation, so those three rows reach a projection ONLY through
 * `loadEdgesForTag("ghost-lane")` — which runs only if the seed discovered
 * the lane.
 */
function seedGhostLaneFixture(db: Database): GhostLaneFixture {
  const sessionDbId = upsertSession(db, {
    contentSessionId: "lane-fracture-agreement-session",
    project: "/tmp/project-lane-fracture-agreement",
    title: "lane fracture agreement fixture",
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
    title: "ghost-lane fixture",
    tags: ["ghost-lane-task"],
    nowEpoch: NOW,
  }).id;

  const ghostTags = ["ghost-lane-task", "ghost-lane", "carrier-lane"];
  const g1 = insertTurn(1, ghostTags);
  const g2 = insertTurn(2, ghostTags);
  const g3 = insertTurn(3, ghostTags);
  const g4 = insertTurn(4, ghostTags);
  const g5 = insertTurn(5, ghostTags);
  const g6 = insertTurn(6, ghostTags);
  // The window's turns claim `carrier-lane` TOO — which is what keeps the
  // second test honest after ticket 02. A seed turn's own tags are a DISCOVERY
  // source, so `carrier-lane` is widened in BOTH runs, its whole membership
  // (g1..g6 included) is emitted in both, and the six ghost turns are
  // therefore in the projection either way. Without this the judgment
  // narrowing alone would keep them out and the second test would pass by
  // scope luck rather than by the invariant it names.
  const w1 = insertTurn(7, ["ghost-lane-task", "window-lane", "carrier-lane"]);
  const w2 = insertTurn(8, ["ghost-lane-task", "window-lane", "carrier-lane"]);

  addSegmentMembers(db, laneSegmentId, [g1, g2, g3, g4, g5, g6, w1, w2], NOW);
  insertLane(db, laneSegmentId, "ghost-lane", NOW);
  insertLane(db, laneSegmentId, "carrier-lane", NOW);
  insertLane(db, laneSegmentId, "window-lane", NOW);

  const carrier = (citing: number, cited: number) => ({
    citing: { kind: "turn" as const, id: citing },
    cited: { kind: "turn" as const, id: cited },
    relation: "extends" as const,
    provenance: "asserted" as const,
    ...deriveSideTags(["carrier-lane"]),
  });
  const ghostClaim = (citing: number, cited: number) => ({
    citing: { kind: "turn" as const, id: citing },
    cited: { kind: "turn" as const, id: cited },
    relation: "indexes" as const,
    provenance: "asserted" as const,
    ...deriveSideTags(["ghost-lane"]),
  });

  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: w2 },
        cited: { kind: "turn", id: w1 },
        relation: "extends",
        provenance: "asserted",
        ...deriveSideTags(["window-lane"]),
      },
      carrier(g2, g1),
      carrier(g3, g2),
      carrier(g4, g3),
      carrier(g5, g4),
      carrier(g6, g5),
      ghostClaim(g2, g1),
      ghostClaim(g3, g2),
      ghostClaim(g5, g4),
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
    ghostTurnIds: [g1, g2, g3, g4, g5, g6],
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

/** `S<n>/T<m>` prompt-number pairs, sorted, from a commit/lane_check LANE-DISPOSITION block. */
function gateFracturePairs(text: string): string[] {
  const pairs: string[] = [];
  const pattern = /severed fracture S\d+\/T(\d+) <-> S\d+\/T(\d+)/g;
  let match = pattern.exec(text);
  while (match !== null) {
    pairs.push(`${match[1]}<->${match[2]}`);
    match = pattern.exec(text);
  }
  return pairs.sort();
}

/**
 * ARM 3, computed directly (ticket 06). The whole lane, by name, through the
 * same `{kind:"lanes"}` loader `remember(justify)` used to build for itself —
 * so this arm answers the identical question with the identical machinery,
 * minus a retired tool call. Pairs are translated into prompt numbers so they
 * compare against the gate's own rendering.
 */
function wholeLaneFracturePairs(
  db: Database,
  segmentId: number,
  tag: string,
  promptNumberById: ReadonlyMap<number, number>,
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
  return computeLaneFractures(segmentId, component)
    .map(
      (fracture) =>
        `${promptNumberById.get(fracture.representativeA) ?? fracture.representativeA}<->` +
        `${promptNumberById.get(fracture.representativeB) ?? fracture.representativeB}`,
    )
    .sort();
}

/**
 * One run against the frozen fixture, parameterised ONLY by the writable set.
 * Returns the three evaluators' answers to the identical question.
 */
async function collectFractureSets(
  db: Database,
  fixture: GhostLaneFixture,
  writableTurnIds: number[],
): Promise<{
  wholeLane: string[];
  wholeLaneAfter: string[];
  preview: string[];
  gate: string[];
  previewText: string;
  touched: boolean;
}> {
  const { sessionDbId, job, laneSegmentId, ghostTurnIds } = fixture;
  const promptNumberById = new Map(ghostTurnIds.map((id, index) => [id, index + 1]));
  const [g1, , g3] = ghostTurnIds as [number, number, number];
  // The touch below is only expressible when the ghost turns are writable —
  // see the second test's own note on what that costs it.
  const canTouch = writableTurnIds.includes(g3);

  // ---- ARM 3: the whole-lane projection, on the FROZEN database ---------
  const wholeLane = wholeLaneFracturePairs(db, laneSegmentId, "ghost-lane", promptNumberById);

  const answers = {
    wholeLane,
    wholeLaneAfter: [] as string[],
    preview: [] as string[],
    gate: [] as string[],
    /** The `lane_check` render VERBATIM — ticket 04 reads the phantom-fracture criterion off it directly. */
    previewText: "",
    touched: false,
  };

  const { toolImpl, handlers } = captureToolImpl();
  const queryImpl = mock(() =>
    (async function* () {
      // ---- the TOUCH ---------------------------------------------------
      // The gate only judges a lane this run engaged with. Ticket 06 retired
      // the source production actually used here (a landed `justify`, which
      // named the lane directly and so armed a gate against a lane the run had
      // written no member of), so the touch is now what it should always have
      // been: an EDGE SIDE naming the lane, on one of the lane's OWN members.
      // `g3 --extends--> g1` sits INSIDE island {g1,g2,g3}, so it merges
      // nothing and the topology arm 3 just measured is untouched — asserted,
      // not assumed, by `wholeLaneAfter`.
      if (canTouch) {
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T3`,
          filter: { fields: ["relations"] },
          turn: 4_000,
        });
        const written = (await handlers.get("note")!({
          turn: `S${sessionDbId}/T3`,
          extends: [
            { turn: `S${sessionDbId}/T1`, tailTag: "ghost-lane", headTag: "ghost-lane" },
          ],
        })) as { content: Array<{ text: string }> };
        expect(written.content[0]!.text).toContain("Landed");
      }

      // ---- ARM 1: the `lane_check` preview -----------------------------
      const preview = (await handlers.get("lane_check")!({})) as {
        content: Array<{ text: string }>;
      };
      answers.previewText = preview.content[0]!.text;
      answers.preview = gateFracturePairs(answers.previewText);

      // ---- ARM 2: the terminal commit gate -----------------------------
      // SETTLEMENT-GATE-TAXONOMY TICKET 04: this commit SUCCEEDS — a fracture
      // is a warning, so the disposition gate no longer refuses ahead of
      // everything else, and the run reaches the obligations that were always
      // behind it. The `impressions` judgment is one of them, derived from the
      // same durable touch ledger the gate reads.
      const committed = (await handlers.get("commit")!({
        report: "no friction this window",
        impressions: retainAllImpressions(db, job.id, writableTurnIds),
      })) as { content: Array<{ text: string }> };
      answers.gate = gateFracturePairs(committed.content[0]!.text);

      yield { type: "result", subtype: "success", is_error: false, result: "done" };
    })(),
  );

  const runQuery = createNoteSettlementSdkQuery({
    db,
    dataRoot: "/tmp/claude-mnemo-lane-fracture-agreement",
    queryImpl: queryImpl as never,
    createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
    toolImpl: toolImpl as never,
    now: () => NOW,
  });

  await runQuery({
    prompt: "settle",
    systemPrompt: "system",
    model: "claude-sonnet-5",
    jobId: job.id,
    claimGeneration: job.claimGeneration,
    stage: job.stage,
    sessionId: sessionDbId,
    writableTurnIds: new Set(writableTurnIds),
    // Ticket 03: a dispatch with no provenance now fails CLOSED on the
    // system-failure channel, so a fixture that drives the real tool path has
    // to model it. Prompts 7-8 are the window; the ghost turns, when the
    // parameterised writable set carries them, are its declared lookback.
    scopeProvenance: settlementScopeProvenanceFor(db, sessionDbId, writableTurnIds, 7, 8),
    contextBuiltAtEpoch: NOW,
    windowStart: 7,
    windowEnd: 8,
  });

  answers.wholeLaneAfter = wholeLaneFracturePairs(
    db,
    laneSegmentId,
    "ghost-lane",
    promptNumberById,
  );
  answers.touched = loadRunLaneTouches(db, job.id).turnTagPairs.has(`${g1}:ghost-lane`);
  return answers;
}

describe("settlement-gate-taxonomy ticket 01 — the three fracture evaluators on a frozen database", () => {
  test("when the lane is IN the seed, lane_check, the commit gate and the whole-lane projection name the SAME fractures", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedGhostLaneFixture(db);

      const sets = await collectFractureSets(db, fixture, [
        ...fixture.windowTurnIds,
        ...fixture.ghostTurnIds,
      ]);

      // ARM 3, on the frozen database: the lane's two real fractures. This is
      // the CONTROL — everything below is vacuous if the lane is whole.
      expect(sets.wholeLane).toEqual(["1<->4", "4<->6"]);
      // …and the run's own touch write did not move it, so the three arms were
      // all answering about the same topology.
      expect(sets.wholeLaneAfter).toEqual(sets.wholeLane);
      // The SECOND control: the run really did touch this lane, on the durable
      // ledger the gate itself reads. Ticket 06 note: this used to be a landed
      // `justify`, and that was the self-arming source job 166 died on.
      expect(sets.touched).toBe(true);

      // BOTH surfaces name both fractures, in the same words.
      expect(sets.preview).toEqual(["1<->4", "4<->6"]);
      expect(sets.gate).toEqual(["1<->4", "4<->6"]);
      // THE INVARIANT this whole ticket is about: what the gate NAMES is a
      // SUBSET of what a whole-lane view says is really there — never a pair
      // the graph does not have. Before ticket 02 the two sets were DISJOINT.
      expect(sets.gate.every((pair) => sets.wholeLane.includes(pair))).toBe(true);

      // TICKET 04: the fracture is on the receipt of a SUCCESSFUL commit. Both
      // surfaces still name it, in the same words — that is what this test has
      // always pinned — but the job is `done`, not held `claimed` on a
      // refusal. It read `claimed` here for as long as a fracture refused.
      expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    } finally {
      db?.close();
    }
  });

  test("when the lane is OUT of the seed, it is reported by nobody — a lane whose edges were not widened has no members", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedGhostLaneFixture(db);

      // The ONLY difference from the test above: the ghost lane's members are
      // not in the writable set, so the loader never DISCOVERS the lane and
      // never widens its `indexes` edges.
      const sets = await collectFractureSets(db, fixture, fixture.windowTurnIds);

      // ARM 3 is unchanged — it projects the whole lane (`{kind:"lanes"}`) and
      // sees the truth. It is the CONTROL: the lane really does have two
      // fractures, so nothing below passes because the fixture is empty.
      expect(sets.wholeLane).toEqual(["1<->4", "4<->6"]);

      // TICKET 02'S INVARIANT, read off the RENDER — and this is the assertion
      // that carries this test: `ghost-lane` was not discovered, so
      // `loadEdgesForTag` never ran for it, so its members claim it in no
      // projection, so the core never enumerates it. Not "the phantom
      // fractures were filtered out downstream": the lane is absent from the
      // projection entirely, in either section, in any form. Demoting a
      // phantom to a warning would have kept printing findings about a graph
      // that is not there, which is the misleading half of the taxonomy.
      expect(sets.previewText).not.toContain("ghost-lane");
      // …and the report is not simply empty: the lane the seed DID discover is
      // described, severed and all, in the same string.
      expect(sets.previewText).toContain("carrier-lane");
      expect(sets.previewText).toContain("SEVERED");

      expect(sets.gate).toEqual([]);
      expect(sets.preview).toEqual([]);
      expect(sets.gate.every((pair) => sets.wholeLane.includes(pair))).toBe(true);

      // HONEST LIMIT, stated rather than papered over (settlement-gate-taxonomy
      // ticket 06). `sets.gate === []` here is OVER-DETERMINED: the lane is
      // both UNWIDENED and UNTOUCHED, and no single mutation can separate the
      // two. It used to be touched — by a landed `justify`, which addressed the
      // lane by `(segment, tag)` and needed no writable member — and that is
      // exactly the self-arming source this ticket retired. Every touch source
      // left is a write to the graph, and this run has no ghost-lane member it
      // may write; an edge side reaching one from `w2` would put the lane in
      // the SEED and destroy the premise. The RENDER assertions above are not
      // over-determined and are what ticket 04's criterion is read off.
      expect(sets.touched).toBe(false);

      // RED CAPABILITY, and it is the LOADER's own line that carries it:
      // restore `laneTags: laneTagsFor(segmentId, row.tags)` in place of
      // `emittedLaneTagsFor(...)` in `db/lane-checker-load.ts` — i.e. resolve
      // membership for lanes whose edges were never widened — and this test
      // goes red on `previewText` naming `ghost-lane` at the five phantom
      // pairs while arm 3 stays at two. Verified by running it.
      //
      // TICKET 04: `done` rather than `claimed`, for the same reason as the
      // test above — a fracture no longer refuses. Here the two sets were
      // already empty, so this line moved because the OTHER gate did.
      expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    } finally {
      db?.close();
    }
  });
});
