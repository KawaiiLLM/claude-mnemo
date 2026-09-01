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
 *   3. `remember(justify)`           — its own `{kind:"lanes"}` projection
 *
 * (1) and (2) are one function by construction. (3) is a second evaluator.
 * On a database that is not moving, all three must name the SAME pairs.
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
 * this whole batch exists for: whatever the gate demands is a SUBSET of what
 * `justify` will accept, so a run always has a legal move.
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
  // The OTHER representative of the fracture a run will justify below needs a
  // real promoted note: the justify's full-content grant is only meaningful
  // against a field that has something in it.
  db.query<unknown, [string, string, number]>(
    "UPDATE turns SET title = ?, content = ? WHERE id = ?",
  ).run("g4 note", "g4 body sentence. ".repeat(40), g4);

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
 * The pairs `remember(justify)` itself enumerates when it refuses a
 * non-current fracture — its own answer to the same question, in raw turn
 * ids, translated back into prompt numbers so it compares against the gate's.
 */
function justifyFracturePairs(text: string, promptNumberById: ReadonlyMap<number, number>): string[] {
  const listed = /by representative turn id: (.+?)\.$/m.exec(text);
  if (!listed) {
    return [];
  }
  return listed[1]!
    .split(", ")
    .map((entry) => {
      const [a, b] = entry.split("<->").map((raw) => Number(raw.trim()));
      return `${promptNumberById.get(a!) ?? a}<->${promptNumberById.get(b!) ?? b}`;
    })
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
): Promise<{ justify: string[]; preview: string[]; gate: string[] }> {
  const { sessionDbId, job, laneSegmentId, ghostTurnIds } = fixture;
  const promptNumberById = new Map(ghostTurnIds.map((id, index) => [id, index + 1]));
  const answers = { justify: [] as string[], preview: [] as string[], gate: [] as string[] };

  const { toolImpl, handlers } = captureToolImpl();
  const queryImpl = mock(() =>
    (async function* () {
      // ---- ARM 3: `remember(justify)`'s own projection ----------------
      // A justify naming a pair that is NOT a fracture is refused with the
      // lane's CURRENT fracture list attached. That refusal IS the evaluator's
      // answer, taken without writing anything: the database is still frozen.
      const refused = (await handlers.get("remember")!({
        action: "justify",
        id: `E${laneSegmentId}`,
        tag: "ghost-lane",
        representative: `S${sessionDbId}/T1`,
        otherRepresentative: `S${sessionDbId}/T2`,
        reason:
          `S${sessionDbId}/T1 and S${sessionDbId}/T2 are consecutive steps of one repair, ` +
          "no gap between them.",
      })) as { content: Array<{ text: string }> };
      answers.justify = justifyFracturePairs(refused.content[0]!.text, promptNumberById);

      // ---- the TOUCH ---------------------------------------------------
      // The gate only judges a lane this run engaged with. Reproduce
      // production's own touch source: a LANDED justify on a fracture the
      // whole-lane view really has (g1<->g4). Recall obligations first — the
      // lane in full, then the other representative's content.
      await handlers.get("recall")!({ id: `E${laneSegmentId}/#ghost-lane` });
      await handlers.get("recall")!({
        id: `S${sessionDbId}/T4`,
        filter: { fields: ["content"] },
        turn: 4_000,
      });
      const landed = (await handlers.get("remember")!({
        action: "justify",
        id: `E${laneSegmentId}`,
        tag: "ghost-lane",
        representative: `S${sessionDbId}/T1`,
        otherRepresentative: `S${sessionDbId}/T4`,
        reason:
          `S${sessionDbId}/T1 and S${sessionDbId}/T4 are two independent repairs; no relation ` +
          "word holds between them.",
      })) as { content: Array<{ text: string }> };
      expect(landed.content[0]!.text).toContain("Landed justify");

      // ---- ARM 1: the `lane_check` preview -----------------------------
      const preview = (await handlers.get("lane_check")!({})) as {
        content: Array<{ text: string }>;
      };
      answers.preview = gateFracturePairs(preview.content[0]!.text);

      // ---- ARM 2: the terminal commit gate -----------------------------
      const committed = (await handlers.get("commit")!({
        report: "no friction this window",
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

  return answers;
}

describe("settlement-gate-taxonomy ticket 01 — the three fracture evaluators on a frozen database", () => {
  test("when the lane is IN the seed, lane_check, the commit gate and justify name the SAME fracture", async () => {
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

      // Justify's answer, taken before any write landed: the lane's two real
      // fractures.
      expect(sets.justify).toEqual(["1<->4", "4<->6"]);
      // After the g1<->g4 justify landed, one fracture is disposed of and the
      // other is not — and BOTH surfaces say exactly that, in the same words.
      expect(sets.preview).toEqual(["4<->6"]);
      expect(sets.gate).toEqual(["4<->6"]);
      // THE INVARIANT this whole ticket is about: what the gate still demands
      // is a SUBSET of what justify will accept, so the run has a legal move.
      expect(sets.gate.every((pair) => sets.justify.includes(pair))).toBe(true);

      expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");
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

      // Justify is unchanged — it projects the whole lane (`{kind:"lanes"}`)
      // and sees the truth. It is the CONTROL: the lane really does have two
      // fractures, so nothing below passes because the fixture is empty.
      expect(sets.justify).toEqual(["1<->4", "4<->6"]);

      // TICKET 02'S INVARIANT: a lane that is REPORTED is a lane whose edges
      // were WIDENED. `ghost-lane` was not discovered, so `loadEdgesForTag`
      // never ran for it, so its members claim it in no projection, so the
      // core never enumerates it — and there is nothing for the gate to
      // fracture. Not "the phantom fractures were filtered out downstream":
      // the lane is absent from the projection entirely.
      expect(sets.gate).toEqual([]);
      expect(sets.preview).toEqual([]);

      // WHAT THE WHOLE BATCH IS FOR, stated as an assertion: what the gate
      // demands is a SUBSET of what justify will accept, so the run always has
      // a legal move. Before ticket 02 the two sets were DISJOINT here —
      // `1<->2, 2<->3, 3<->4, 4<->5, 5<->6` against `1<->4, 4<->6` — and no
      // sequence of legal calls could clear the commit. That is job 166's
      // 81-minute abandonment reduced to eight turns.
      expect(sets.gate.every((pair) => sets.justify.includes(pair))).toBe(true);

      // RED CAPABILITY, and it is the LOADER's own line that carries it:
      // restore `laneTags: laneTagsFor(segmentId, row.tags)` in place of
      // `emittedLaneTagsFor(...)` in `db/lane-checker-load.ts` — i.e. resolve
      // membership for lanes whose edges were never widened — and this test
      // goes red with `gate` back at the five phantom pairs while `justify`
      // stays at two. Verified by running it.
      expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");
    } finally {
      db?.close();
    }
  });
});
