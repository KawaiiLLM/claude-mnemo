import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDatabase } from "../../src/db/database";
import { loadEndpointLaneFacts } from "../../src/db/edge-side-resolution";
import { insertLane } from "../../src/db/lanes";
import {
  MAIN_AGENT_EDGES_TURN_TAGS_RECEIPT,
  readMainAgentEdgesCutoverState,
  type TurnTagsNormalisationReceipt,
} from "../../src/db/main-agent-edges-cutover";
import { memoryEdgesPredatesCutover } from "../../src/db/memory-edges";
import { claimNextNoteSettlementJob } from "../../src/db/note-settlement";
import {
  MEMBERSHIP_CUTOVER_RECEIPT,
  initializeSchema,
  runMainAgentEdgesCutover,
} from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { readTurnTags } from "../../src/db/turn-tags";
import { getFieldStamp } from "../../src/db/write-gate";
import {
  downgradeToPreCutoverShape,
  downgradeTurnsTagsToPreCutover,
} from "../support/pre-cutover-edge-shape";

/**
 * MAIN-AGENT-EDGES TICKET 12 — THE TAGS NORMALISATION RUNS FIRST.
 *
 * D9's transform 1 used to live inside the cutover one-shot: fenced on the
 * settlement claim set, and running AFTER `cutoverNamedTaskMembershipTags`.
 * Both facts were defects, and both are what these tests pin.
 *
 *   - P1-1: the membership cutover reads `turns.tags` and writes through
 *     `writeMembershipTags`, whose own read is `readTurnTags` — THE parser,
 *     which THROWS on a malformed value. A database with one such row could
 *     not get past the migration that would have fixed it.
 *   - P2-B: while the fence holds, the one-shot does nothing, so every
 *     `loadEndpointLaneFacts` read — same strict parser — threw for as long as
 *     a settlement claim was live.
 *
 * The fix is order, not tolerance: normalise on the very first open, before
 * any consumer of the column, whatever the fence says.
 */
describe("turns.tags normalisation (main-agent-edges D9 transform 1, ticket 12)", () => {
  const NOW = 1_800_000_000;

  let db: Database;
  let sessionId: number;
  let segmentId: number;
  let nextPrompt = 1;

  const addTurn = (): number =>
    db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', ?, '[]', '[]')
         RETURNING id`,
      )
      .get(sessionId, nextPrompt, 100 + nextPrompt++)!.id;

  const setRawTags = (turnId: number, raw: string | null) =>
    db
      .query<unknown, [string | null, number]>("UPDATE turns SET tags = ? WHERE id = ?")
      .run(raw, turnId);

  const rawTags = (turnId: number): string | null =>
    db.query<{ tags: string | null }, [number]>("SELECT tags FROM turns WHERE id = ?").get(turnId)!
      .tags;

  const tagsReceipt = (): TurnTagsNormalisationReceipt =>
    JSON.parse(
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM migration_receipts WHERE name = ?",
        )
        .get(MAIN_AGENT_EDGES_TURN_TAGS_RECEIPT)!.payload,
    ) as TurnTagsNormalisationReceipt;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    claimNextNoteSettlementJob(db, 1, NOW, NOW * 1000);
    sessionId = upsertSession(db, {
      contentSessionId: "tags-normalisation",
      project: "tags-normalisation",
      title: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, { title: "Task", tags: ["the-task"], nowEpoch: 10 }).id;
    insertLane(db, segmentId, "alpha", 10);
    nextPrompt = 1;
  });
  afterEach(() => db.close());

  test("THE ORDER: three malformed tags rows inside a NAMED TASK open, migrate to '[]' and then take the task tag — the membership cutover can no longer be reached before the value it parses is legal", () => {
    const nullTurn = addTurn();
    const junkTurn = addTurn();
    const objectTurn = addTurn();
    const cleanTurn = addTurn();
    addSegmentMembers(db, segmentId, [nullTurn, junkTurn, objectTurn, cleanTurn], 10);

    // Back to the shape in which a malformed value is storable, and owing both
    // migrations again.
    downgradeTurnsTagsToPreCutover(db);
    setRawTags(nullTurn, null);
    setRawTags(junkTurn, "not json");
    setRawTags(objectTurn, '{"a":1}');
    setRawTags(cleanTurn, "[]");
    db.query<unknown, [string]>("DELETE FROM migration_receipts WHERE name = ?").run(
      MEMBERSHIP_CUTOVER_RECEIPT,
    );

    initializeSchema(db);

    expect(tagsReceipt()).toEqual({
      nullToEmpty: 1,
      nonArrayToEmpty: 2,
      nonStringMembersDropped: 0,
      turnsChanged: 3,
    });
    // Normalised to '[]', then given the task's own tag by the membership
    // cutover that runs after it — one fact per row, not two.
    for (const turnId of [nullTurn, junkTurn, objectTurn, cleanTurn]) {
      expect(readTurnTags(rawTags(turnId))).toEqual(["the-task"]);
      expect(
        db
          .query<{ n: number }, [number]>(
            "SELECT COUNT(*) AS n FROM segment_members WHERE turn_id = ?",
          )
          .get(turnId)!.n,
      ).toBe(1);
    }
    // The old bytes are receipted, NULL kept as NULL.
    expect(
      db
        .query<{ turnId: number; tags: string | null }, []>(
          "SELECT turn_id AS turnId, tags FROM main_agent_edges_cutover_turn_tags_archive ORDER BY turn_id",
        )
        .all(),
    ).toEqual([
      { turnId: nullTurn, tags: null },
      { turnId: junkTurn, tags: "not json" },
      { turnId: objectTurn, tags: '{"a":1}' },
    ]);
    // Each normalised turn carries a `tags` stamp. The writer read here is the
    // MEMBERSHIP cutover's, not the normalisation's — it wrote the same field
    // afterwards, which is exactly the order this test exists to prove.
    for (const turnId of [nullTurn, junkTurn, objectTurn]) {
      expect(getFieldStamp(db, "turn", turnId, "tags")?.writer).toBe(
        "migration:membership-cutover",
      );
    }
    // The column is back under the invariant, so the malformed value cannot
    // return by any path.
    expect(() => setRawTags(cleanTurn, "not json")).toThrow();
  });

  test("P2-B: the FENCE defers the one-shot while a claim is live, and the normalisation runs anyway — a malformed row does not make every lane read throw for the length of a settlement run", () => {
    const citing = addTurn();
    const cited = addTurn();
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    downgradeToPreCutoverShape(db);
    setRawTags(citing, "not json");
    setRawTags(cited, null);
    // A live claim: the fence's own condition.
    db.query<unknown, [number, number, number, number]>(
      `INSERT INTO note_settlement_jobs
         (session_id, window_start, window_end, trigger_type, status, stage, claimed_at_epoch,
          attempts, retry_at_epoch, created_at_epoch, updated_at_epoch)
       VALUES (?, 1, 2, 'consecutive', 'claimed', 'topics', ?, 0, 0, ?, ?)`,
    ).run(sessionId, NOW, NOW, NOW);

    initializeSchema(db);

    // The one-shot did NOT run: the database is still in the pre-cutover shape
    // and there is no completion marker.
    expect(memoryEdgesPredatesCutover(db)).toBe(true);
    expect(readMainAgentEdgesCutoverState(db)).toBeNull();
    expect(runMainAgentEdgesCutover(db, NOW, NOW * 1000)).toEqual({
      ran: "deferred",
      claimedJobs: 1,
    });
    // The normalisation did run, outside the fence.
    expect(rawTags(citing)).toBe("[]");
    expect(rawTags(cited)).toBe("[]");
    // Which is what the strict readers of the deferral window need: this threw
    // `MalformedTurnTagsError` for as long as the claim was live.
    expect(() => loadEndpointLaneFacts(db, [citing, cited])).not.toThrow();
    expect(loadEndpointLaneFacts(db, [citing, cited]).get(citing)).toEqual({
      segmentId,
      lanes: [],
    });
  });

  test("receipt-guarded: a second open normalises nothing and does not re-archive", () => {
    const turnId = addTurn();
    downgradeTurnsTagsToPreCutover(db);
    setRawTags(turnId, "not json");

    initializeSchema(db);
    expect(tagsReceipt().turnsChanged).toBe(1);
    // Nothing wrote this field after the normalisation, so its own writer id
    // is what stands.
    expect(getFieldStamp(db, "turn", turnId, "tags")?.writer).toBe(
      "migration:main-agent-edges-cutover",
    );
    const archived = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM main_agent_edges_cutover_turn_tags_archive",
      )
      .get()!.n;

    initializeSchema(db);
    expect(tagsReceipt().turnsChanged).toBe(1);
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM main_agent_edges_cutover_turn_tags_archive",
        )
        .get()!.n,
    ).toBe(archived);
  });
});
