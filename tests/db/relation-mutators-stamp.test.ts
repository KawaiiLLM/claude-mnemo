import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { clearLane, insertLane, mergeLaneTag } from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  createSegment,
  mergeSegments,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import {
  checkRelationsGate,
  COMPACT_REPAIR_WRITER,
  getFieldStamp,
  LANE_CLEAR_WRITER,
  LANE_MERGE_WRITER,
  PRUNE_TRIGGER_WRITER,
  recordFieldCompleteness,
  RELATIONS_GATE_FIELD,
  snapshotWriteGateSequence,
} from "../../src/db/write-gate";
import { claimCompactBoundaries } from "../../src/hooks/capture-repair";

/**
 * Settlement-read-once ticket 00, spec D0 — "every mutator of a turn's
 * OUTGOING rows stamps".
 *
 * `checkRelationsGate` makes one promise: a stage-2 edge write on X is refused
 * when X's outgoing rows changed under the writer BY ANY PATH. At HEAD it kept
 * that promise for exactly two paths — `note` and the settlement turn facade —
 * while three others rewrote or deleted the same rows in raw SQL and stamped
 * nothing: `mergeLaneTag`, `clearLane`, and the compact occupied-turn repair.
 * A fourth, deleting a CITED turn, is invisible to every TypeScript guard
 * because the prune is a trigger.
 *
 * The shape of every test here is the same three steps, because that is the
 * shape of the incident it prevents: a writer earns a grant by reading the
 * set, something else moves the rows, the writer's next edge write must be
 * refused and must NAME what moved them. A stamp that lands under the wrong
 * writer id is as useless as no stamp at all — "changed by unknown" tells a
 * settlement run nothing it can act on — so each path is pinned to its own
 * reserved id, not merely to "some stamp exists".
 *
 * The negative is load-bearing too (D0, RULED T2404): incoming edges and the
 * `E<n>/#tag` qualifiers resolved from endpoints' current owning tasks are
 * ADVISORY — current at read, not fenced — so a TASK merge, which moves
 * membership and re-resolves those qualifiers without touching one edge row,
 * must NOT stale anybody's grant.
 */
describe("every mutator of a turn's outgoing relation rows stamps (spec D0)", () => {
  const NOW = 1_800_000_000;
  const READER = "session:4242";

  let db: Database;
  let sessionId: number;
  let segmentId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "relation-mutators",
      project: "/tmp/relation-mutators",
      title: null,
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, {
      title: "Mutators",
      tags: ["home"],
      nowEpoch: NOW,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  function seedTurn(promptNumber: number, tags: string[] = ["home"]): number {
    const id = db
      .query<{ id: number }, [number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch, tags)
         VALUES (?, ?, 'extracted', 'fixture', ${NOW}, ?) RETURNING id`,
      )
      .get(sessionId, promptNumber, JSON.stringify(tags))!.id;
    addSegmentMembers(db, segmentId, [id], NOW);
    return id;
  }

  function seedEdge(
    citing: number,
    cited: number,
    sides: { tailTag?: string; headTag?: string } = {},
  ): number {
    return writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "extends" as never,
          provenance: "asserted",
          tailTag: sides.tailTag ?? "",
          headTag: sides.headTag ?? "",
        },
      ],
      NOW,
    ).written[0]!.id;
  }

  /** The grant D0 measures against: this run SAW the set, at this sequence. */
  function grantRelationsRead(turnId: number): void {
    recordFieldCompleteness(
      db,
      READER,
      [
        {
          entityType: "turn",
          entityId: turnId,
          field: RELATIONS_GATE_FIELD,
          complete: true,
        },
      ],
      NOW,
      snapshotWriteGateSequence(db),
    );
    expect(checkRelationsGate(db, READER, turnId, "S/T").ok).toBe(true);
  }

  function expectStale(turnId: number, writer: string): void {
    const verdict = checkRelationsGate(db, READER, turnId, "S1/T1");
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("stale");
    expect(!verdict.ok && verdict.reason === "stale" && verdict.staleWriter).toBe(writer);
    expect(!verdict.ok && verdict.message).toContain(writer);
  }

  test("mergeLaneTag: a fold that rewrites a citing turn's edge sides stales its grant, naming lane:merge", () => {
    insertLane(db, segmentId, "lane-a", NOW);
    insertLane(db, segmentId, "lane-b", NOW);
    const citing = seedTurn(1);
    const cited = seedTurn(2);
    seedEdge(citing, cited, { tailTag: "lane-a", headTag: "lane-a" });

    grantRelationsRead(citing);
    mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW + 1);

    expectStale(citing, LANE_MERGE_WRITER);
  });

  test("mergeLaneTag: a COLLISION casualty stales its citer too — the row is gone, not merely renamed", () => {
    insertLane(db, segmentId, "lane-a", NOW);
    insertLane(db, segmentId, "lane-b", NOW);
    const citing = seedTurn(1);
    const cited = seedTurn(2);
    // Two rows that become one identity key once `lane-a` folds into `lane-b`.
    seedEdge(citing, cited, { tailTag: "lane-a", headTag: "lane-a" });
    seedEdge(citing, cited, { tailTag: "lane-b", headTag: "lane-b" });

    grantRelationsRead(citing);
    const receipt = mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW + 1);
    expect(receipt.collisions.length).toBeGreaterThan(0);

    expectStale(citing, LANE_MERGE_WRITER);
  });

  test("mergeLaneTag: a fold that touches NO edge of a turn leaves that turn's grant standing", () => {
    insertLane(db, segmentId, "lane-a", NOW);
    insertLane(db, segmentId, "lane-b", NOW);
    const bystander = seedTurn(1);
    const cited = seedTurn(2);
    seedEdge(bystander, cited, { tailTag: "lane-c", headTag: "lane-c" });

    grantRelationsRead(bystander);
    mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW + 1);

    expect(checkRelationsGate(db, READER, bystander, "S1/T1").ok).toBe(true);
    expect(getFieldStamp(db, "turn", bystander, RELATIONS_GATE_FIELD)).toBeNull();
  });

  test("clearLane: deleting a lane's edges stales every citer's grant, naming lane:clear", () => {
    insertLane(db, segmentId, "lane-a", NOW);
    const citing = seedTurn(1, ["home", "lane-a"]);
    const cited = seedTurn(2, ["home", "lane-a"]);
    seedEdge(citing, cited, { tailTag: "lane-a", headTag: "lane-a" });

    grantRelationsRead(citing);
    const outcome = clearLane(db, segmentId, "lane-a", NOW + 1, false);
    expect(outcome.kind).toBe("cleared");

    expectStale(citing, LANE_CLEAR_WRITER);
  });

  test("compact occupied-turn repair: emptying a turn's outgoing set stales its grant, naming compact:repair", () => {
    const cited = seedTurn(1);
    const occupied = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, content_prompt_id, status,
                            title, created_at_epoch, updated_at_epoch, tags)
         VALUES (?, 7, 'prompt-9', 'extracted', 'Real title', ${NOW}, ${NOW}, '[]')
         RETURNING id`,
      )
      .get(sessionId)!.id;
    seedEdge(occupied, cited);

    grantRelationsRead(occupied);
    const outcome = claimCompactBoundaries(
      db,
      sessionId,
      [
        {
          uuid: "boundary-1",
          boundaryLineNumber: 10,
          promptId: "prompt-9",
          wrapperLineNumber: 11,
          summary: "a compact",
          trigger: "auto",
          preCompactTokenCount: null,
        },
      ],
      NOW + 1,
      () => {},
    );
    expect(outcome.converted).toBe(1);

    expectStale(occupied, COMPACT_REPAIR_WRITER);
  });

  test("compact repair of a turn that cited NOTHING stamps nothing — no set moved, no re-read owed", () => {
    const occupied = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, content_prompt_id, status,
                            title, created_at_epoch, updated_at_epoch, tags)
         VALUES (?, 7, 'prompt-9', 'extracted', 'Real title', ${NOW}, ${NOW}, '[]')
         RETURNING id`,
      )
      .get(sessionId)!.id;

    grantRelationsRead(occupied);
    claimCompactBoundaries(
      db,
      sessionId,
      [
        {
          uuid: "boundary-1",
          boundaryLineNumber: 10,
          promptId: "prompt-9",
          wrapperLineNumber: 11,
          summary: "a compact",
          trigger: "auto",
          preCompactTokenCount: null,
        },
      ],
      NOW + 1,
      () => {},
    );

    expect(getFieldStamp(db, "turn", occupied, RELATIONS_GATE_FIELD)).toBeNull();
    expect(checkRelationsGate(db, READER, occupied, "S1/T1").ok).toBe(true);
  });

  // ---------------------------------------------------------------------
  // The trigger — the path no TypeScript guard can reach
  // ---------------------------------------------------------------------

  test("a cited turn deleted by DIRECT SQL stales the surviving citer, naming trigger:prune", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);
    seedEdge(citing, cited);

    grantRelationsRead(citing);
    // No API, no transaction wrapper, no chance for a TypeScript guard to
    // run: exactly what the prune trigger exists to cover.
    db.query<unknown, [number]>("DELETE FROM turns WHERE id = ?").run(cited);

    expect(
      db.query<{ c: number }, []>("SELECT count(*) AS c FROM memory_edges").get()!.c,
    ).toBe(0);
    expectStale(citing, PRUNE_TRIGGER_WRITER);
  });

  test("the same holds under an ON DELETE CASCADE — deleting the session prunes and stamps", () => {
    const otherSession = upsertSession(db, {
      contentSessionId: "relation-mutators-other",
      project: "/tmp/relation-mutators",
      title: null,
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;
    const citing = seedTurn(1);
    const cited = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch, tags)
         VALUES (?, 1, 'extracted', 'fixture', ${NOW}, '[]') RETURNING id`,
      )
      .get(otherSession)!.id;
    seedEdge(citing, cited);

    grantRelationsRead(citing);
    db.query<unknown, [number]>("DELETE FROM sessions WHERE id = ?").run(otherSession);

    expectStale(citing, PRUNE_TRIGGER_WRITER);
  });

  test("the prune stamps SURVIVORS only — the deleted turn's own outgoing rows leave no stamp behind", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);
    seedEdge(citing, cited);

    db.query<unknown, [number]>("DELETE FROM turns WHERE id = ?").run(citing);

    // The citer is gone; nothing may claim a revision on it.
    expect(getFieldStamp(db, "turn", citing, RELATIONS_GATE_FIELD)).toBeNull();
    // And the CITED turn, whose own outgoing set never moved, is untouched.
    expect(getFieldStamp(db, "turn", cited, RELATIONS_GATE_FIELD)).toBeNull();
  });

  test("deleting a turn nobody cites stamps nobody", () => {
    const lonely = seedTurn(1);
    const bystander = seedTurn(2);
    grantRelationsRead(bystander);

    db.query<unknown, [number]>("DELETE FROM turns WHERE id = ?").run(lonely);

    expect(getFieldStamp(db, "turn", bystander, RELATIONS_GATE_FIELD)).toBeNull();
    expect(checkRelationsGate(db, READER, bystander, "S1/T1").ok).toBe(true);
  });

  test("an EXISTING database carrying the delete-only trigger is migrated to the stamping one", () => {
    // `CREATE TRIGGER IF NOT EXISTS` is why this migration has to exist: every
    // database opened before this ticket already has a trigger of this name,
    // so the schema declaration sees it and does nothing. This reproduces that
    // state exactly — the pre-ticket body — and re-opens.
    db.exec("DROP TRIGGER memory_edges_prune_deleted_turn");
    db.exec(`
      CREATE TRIGGER memory_edges_prune_deleted_turn
        AFTER DELETE ON turns
        BEGIN
          DELETE FROM memory_edges
          WHERE (citing_kind = 'turn' AND citing_id = OLD.id)
             OR (cited_kind = 'turn' AND cited_id = OLD.id);
        END;
    `);

    initializeSchema(db);

    const citing = seedTurn(1);
    const cited = seedTurn(2);
    seedEdge(citing, cited);
    grantRelationsRead(citing);
    db.query<unknown, [number]>("DELETE FROM turns WHERE id = ?").run(cited);

    expectStale(citing, PRUNE_TRIGGER_WRITER);
  });

  // ---------------------------------------------------------------------
  // The negative: advisory qualifiers do not fence
  // ---------------------------------------------------------------------

  test("a TASK merge does NOT stale a grant — membership re-resolves a qualifier, it moves no edge row", () => {
    const destination = createSegment(db, {
      title: "Destination",
      tags: ["away"],
      nowEpoch: NOW,
    }).id;
    const citing = seedTurn(1);
    const cited = seedTurn(2);
    const edgeId = seedEdge(citing, cited);

    grantRelationsRead(citing);
    const outcome = mergeSegments(db, segmentId, destination, NOW + 1);
    expect(outcome.kind).toBe("merged");

    // The row itself is untouched — which is the whole reason the grant stands.
    expect(
      db
        .query<{ c: number }, [number]>("SELECT count(*) AS c FROM memory_edges WHERE id = ?")
        .get(edgeId)!.c,
    ).toBe(1);
    expect(getFieldStamp(db, "turn", citing, RELATIONS_GATE_FIELD)).toBeNull();
    expect(checkRelationsGate(db, READER, citing, "S1/T1").ok).toBe(true);
  });
});
