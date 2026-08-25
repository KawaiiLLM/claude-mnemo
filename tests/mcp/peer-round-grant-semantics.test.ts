import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { insertLane } from "../../src/db/lanes";
import { createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import {
  checkFieldGate,
  claimWriterId,
  getFieldCompleteness,
  recordFieldCompleteness,
  recordReadGrant,
  sessionWriterId,
  snapshotWriteGateSequence,
  stampField,
} from "../../src/db/write-gate";
import { createDatabaseBackedHandlers } from "../../src/mcp/handlers";
import { isNoteSuccess, noteTool } from "../../src/mcp/note";
import { recallMemory } from "../../src/mcp/recall";
import { resetToolCallSyntaxRejectionsForTests } from "../../src/shared/tool-call-syntax";
import { evaluateSettlementMembershipWrite } from "../../src/worker/note-settlement-membership-facade";
import {
  evaluateSettlementTurnWrite,
  type SettlementTurnFacadeContext,
} from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * The peer cross-review round's grant-semantics repairs
 * (`.scratch/tag-mandate/repairs/RB-grant-semantics.md`, findings P1-6, P1-7,
 * P1-8, P2-1, P2-2, P2-3, P2-6). One file because the seven findings are one
 * claim: an authorization is a fact about what a reader was actually SHOWN,
 * measured against what the graph actually IS at the moment of the write.
 *
 * Each describe block below reproduces the peer's own failure scenario first
 * and pins the repaired behaviour, so a regression in any one of them reads as
 * that finding coming back rather than as an unexplained assertion.
 */

const NOW = 1_800_000_000;

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
  resetToolCallSyntaxRejectionsForTests();
});

afterEach(() => {
  db.close();
});

function seedSession(contentSessionId: string): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/peer-round-grants",
    title: `${contentSessionId} title`,
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(
  sessionDbId: number,
  promptNumber: number,
  overrides: { title?: string; content?: string; status?: string } = {},
): number {
  return db
    .query<{ id: number }, [number, number, string, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, content, created_at_epoch
       ) VALUES (?, ?, ?, 'prompt', 'response', ?, ?, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      overrides.status ?? "extracted",
      overrides.title ?? `turn ${promptNumber}`,
      overrides.content ?? `content ${promptNumber}`,
      NOW - 1_000 + promptNumber,
    )!.id;
}

function grantCount(writer: string, entityType: string, entityId: number): number {
  return db
    .query<{ c: number }, [string, string, number]>(
      `SELECT COUNT(*) AS c FROM write_gate_reads
       WHERE writer = ? AND entity_type = ? AND entity_id = ?`,
    )
    .get(writer, entityType, entityId)!.c;
}

// ---------------------------------------------------------------------------
// P1-6 — grants derive from the FINAL delivery envelope
// ---------------------------------------------------------------------------

describe("P1-6 — the worker envelope's cut decides the grant, not the render", () => {
  /**
   * The peer's scenario: a serialized page longer than the worker channel's
   * 100K envelope. Everything past the cut is invisible to the model, and used
   * to be granted anyway — a whole-field overwrite licensed by bytes nobody
   * received.
   */
  function seedOversizedWindow(): { sessionDbId: number; turnIds: number[] } {
    const sessionDbId = seedSession("p1-6-envelope");
    const turnIds: number[] = [];
    for (let promptNumber = 1; promptNumber <= 12; promptNumber += 1) {
      turnIds.push(
        seedTurn(sessionDbId, promptNumber, {
          content: `${promptNumber}:`.padEnd(15_000, `body-${promptNumber} `),
        }),
      );
    }
    return { sessionDbId, turnIds };
  }

  test("entities past the 100K cut earn NO grant and NO completeness; the delivered ones keep both", async () => {
    const { sessionDbId, turnIds } = seedOversizedWindow();
    const writer = claimWriterId(7, 1);
    const handlers = createDatabaseBackedHandlers(db, {
      audience: "worker",
      resolveReaderId: () => writer,
      now: () => NOW,
    });

    const result = await handlers.recall!({
      id: `S${sessionDbId}/T*`,
      pageSize: 50,
      // Both budgets wide open: this test is about the ENVELOPE's cut, so
      // neither pagination nor the per-item knife may do the cutting.
      pageBudget: 5_000_000,
      turn: 1_000_000,
    });
    const delivered = result.content[0]!.text;

    // The envelope really did cut (otherwise the assertions below are vacuous).
    expect(delivered.length).toBeLessThanOrEqual(100_000);
    expect(delivered).toContain("[工具返回已达上限");

    const firstTurn = turnIds[0]!;
    const lastTurn = turnIds[turnIds.length - 1]!;
    // floor-and-render-fidelity ticket 03 retired the dbid:T<n> correlation
    // token this used to key on; each seeded turn's own content marker
    // (`body-<promptNumber> `, distinct per turn — the trailing space rules
    // out `body-1 ` matching inside `body-12 `) identifies whose bytes
    // actually crossed the envelope just as unambiguously.
    expect(delivered).toContain("body-1 ");
    expect(delivered).not.toContain("body-12 ");

    expect(grantCount(writer, "turn", firstTurn)).toBe(1);
    expect(grantCount(writer, "turn", lastTurn)).toBe(0);
    expect(
      getFieldCompleteness(db, writer, "turn", firstTurn, "content")?.complete,
    ).toBe(true);
    expect(getFieldCompleteness(db, writer, "turn", lastTurn, "content")).toBeNull();
  });

  test("the undelivered turn's own whole-field write is refused for want of the read it never got", async () => {
    const { sessionDbId, turnIds } = seedOversizedWindow();
    const writer = claimWriterId(7, 1);
    const lastTurn = turnIds[turnIds.length - 1]!;
    // Another writer owns the field, so the gate has to consult a grant.
    stampField(db, "turn", lastTurn, "content", sessionWriterId(sessionDbId), NOW - 900);

    const handlers = createDatabaseBackedHandlers(db, {
      audience: "worker",
      resolveReaderId: () => writer,
      now: () => NOW,
    });
    await handlers.recall!({
      id: `S${sessionDbId}/T*`,
      pageSize: 50,
      pageBudget: 5_000_000,
      turn: 1_000_000,
    });

    const verdict = checkFieldGate(db, writer, "turn", lastTurn, "content", "S1/T12", {
      requireCompleteRead: true,
    });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("never-read");
  });

  test("a page that fits the envelope grants everything it rendered — the cut is the only thing that withholds", async () => {
    const sessionDbId = seedSession("p1-6-small");
    const turnIds = [seedTurn(sessionDbId, 1), seedTurn(sessionDbId, 2)];
    const writer = claimWriterId(8, 1);
    const handlers = createDatabaseBackedHandlers(db, {
      audience: "worker",
      resolveReaderId: () => writer,
      now: () => NOW,
    });

    await handlers.recall!({ id: `S${sessionDbId}/T*`, pageSize: 50 });

    for (const turnId of turnIds) {
      expect(grantCount(writer, "turn", turnId)).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// P1-7 — completeness is sequenced, not boolean-forever
// ---------------------------------------------------------------------------

describe("P1-7 — a stale complete:true does not reactivate through an unrelated read", () => {
  test("read-complete -> another writer writes -> unrelated-field re-read -> the whole-field write REFUSES", () => {
    const sessionDbId = seedSession("p1-7-primitive");
    const turnId = seedTurn(sessionDbId, 1);
    const reader = sessionWriterId(99);
    const otherWriter = sessionWriterId(sessionDbId);

    // 1. A render that showed `content` whole.
    const firstRead = snapshotWriteGateSequence(db);
    recordReadGrant(db, reader, "turn", turnId, NOW, firstRead);
    recordFieldCompleteness(
      db,
      reader,
      [{ entityType: "turn", entityId: turnId, field: "content", complete: true }],
      NOW,
      firstRead,
    );

    // 2. Another writer changes the field.
    stampField(db, "turn", turnId, "content", otherWriter, NOW + 1);

    // 3. An UNRELATED-field read: the grant refreshes past that write, the
    //    completeness record does not (nothing showed `content` again).
    const secondRead = snapshotWriteGateSequence(db);
    recordReadGrant(db, reader, "turn", turnId, NOW + 2, secondRead);

    const refused = checkFieldGate(db, reader, "turn", turnId, "content", "S1/T1", {
      requireCompleteRead: true,
    });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toBe("incomplete-read");
    // The message says WHICH of the two shapes this is — the writer saw the
    // field whole once, so "it was cut short" would send it hunting a budget
    // problem that does not exist.
    expect(!refused.ok && refused.message).toContain("changed it after that read");

    // 4. Re-reading the field itself unlocks it.
    const thirdRead = snapshotWriteGateSequence(db);
    recordFieldCompleteness(
      db,
      reader,
      [{ entityType: "turn", entityId: turnId, field: "content", complete: true }],
      NOW + 3,
      thirdRead,
    );
    expect(
      checkFieldGate(db, reader, "turn", turnId, "content", "S1/T1", {
        requireCompleteRead: true,
      }).ok,
    ).toBe(true);
  });

  test("end to end through recall + note: a title-only re-read does not re-license a content overwrite", () => {
    const owner = seedSession("p1-7-owner");
    const other = seedSession("p1-7-other");
    const turnId = seedTurn(owner, 1, { content: "the owner's own paragraph" });
    const address = `S${owner}/T1`;
    const options = { eraCutoffEpoch: SETTLEMENT_ERA_CUTOFF_EPOCH };

    // The owner writes the field, so it holds another writer's content.
    expect(
      isNoteSuccess(
        noteTool(
          db,
          { turn: address, title: "owner title", content: "the owner's own paragraph" },
          { ...options, callerSessionId: owner },
        ),
      ),
    ).toBe(true);

    // The other session reads it whole — a legitimate complete read.
    recallMemory(db, {
      id: address,
      turn: 50_000,
      readerId: sessionWriterId(other),
      now: () => NOW,
    });

    // The owner rewrites it.
    expect(
      isNoteSuccess(
        noteTool(
          db,
          { turn: address, content: "the owner's SECOND paragraph", mode: { content: "write" } },
          { ...options, callerSessionId: owner },
        ),
      ),
    ).toBe(true);

    // The other session re-reads only the TITLE: its grant moves past the
    // rewrite while its complete view of `content` stays where it was.
    recallMemory(db, {
      id: address,
      filter: { fields: ["title"] },
      turn: 50_000,
      readerId: sessionWriterId(other),
      now: () => NOW + 1,
    });

    const refused = noteTool(
      db,
      {
        turn: address,
        content: "a stranger's replacement",
        mode: { content: "write" },
        crossSession: true,
      },
      { ...options, callerSessionId: other },
    );
    expect(isNoteSuccess(refused)).toBe(false);
    expect(refused.content[0]!.text).toContain("changed it after that read");
    expect(getTurnById(db, turnId)!.content).toBe("the owner's SECOND paragraph");

    // Reading `content` again is the remedy, and it works.
    recallMemory(db, {
      id: address,
      filter: { fields: ["content"] },
      turn: 50_000,
      readerId: sessionWriterId(other),
      now: () => NOW + 2,
    });
    expect(
      isNoteSuccess(
        noteTool(
          db,
          {
            turn: address,
            content: "a stranger's replacement",
            mode: { content: "write" },
            crossSession: true,
          },
          { ...options, callerSessionId: other },
        ),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P1-8 — relations are a gated surface with their own revision
// ---------------------------------------------------------------------------

describe("P1-8 — a relation write rests on having read the relation set", () => {
  function seedPair(): { sessionDbId: number; citing: number; cited: number } {
    const sessionDbId = seedSession("p1-8-relations");
    const cited = seedTurn(sessionDbId, 1);
    const citing = seedTurn(sessionDbId, 2);
    updateTurnById(db, cited, { type: ["design"] });
    updateTurnById(db, citing, { type: ["correction"] });
    return { sessionDbId, citing, cited };
  }

  test("an attach with no relations read is refused, naming the read that earns it", () => {
    const { sessionDbId } = seedPair();
    // The turn itself has been read — the entity grant the `type` gate asks
    // for is in hand, and it is still not enough.
    recallMemory(db, {
      id: `S${sessionDbId}/T2`,
      readerId: sessionWriterId(sessionDbId),
      now: () => NOW,
    });

    const refused = noteTool(
      db,
      { turn: `S${sessionDbId}/T2`, override: [`S${sessionDbId}/T1`] },
      { callerSessionId: sessionDbId },
    );

    expect(isNoteSuccess(refused)).toBe(false);
    expect(refused.content[0]!.text).toContain("relations of");
    expect(refused.content[0]!.text).toContain('filter={fields:["relations"]}');
  });

  test("after a relations recall the same call lands", () => {
    const { sessionDbId, citing } = seedPair();
    recallMemory(db, {
      id: `S${sessionDbId}/T2`,
      filter: { fields: ["relations"] },
      readerId: sessionWriterId(sessionDbId),
      now: () => NOW,
    });

    const landed = noteTool(
      db,
      { turn: `S${sessionDbId}/T2`, override: [`S${sessionDbId}/T1`] },
      { callerSessionId: sessionDbId },
    );

    expect(isNoteSuccess(landed)).toBe(true);
    expect(
      db
        .query<{ c: number }, [number]>(
          `SELECT COUNT(*) AS c FROM memory_edges
           WHERE citing_kind = 'turn' AND citing_id = ? AND relation IS NOT NULL`,
        )
        .get(citing)!.c,
    ).toBe(1);
  });

  test("another writer's edge write moves the revision, and the stale reader is caught by it", () => {
    const { sessionDbId, citing } = seedPair();
    const third = seedTurn(sessionDbId, 3);
    updateTurnById(db, third, { type: ["design"] });
    const otherSession = seedSession("p1-8-other");

    // Both writers read the (empty) relation set.
    for (const reader of [sessionWriterId(sessionDbId), sessionWriterId(otherSession)]) {
      recallMemory(db, {
        id: `S${sessionDbId}/T2`,
        filter: { fields: ["relations"] },
        readerId: reader,
        now: () => NOW,
      });
    }

    // The other session attaches first — the set is no longer what either of
    // them read.
    expect(
      isNoteSuccess(
        noteTool(
          db,
          {
            turn: `S${sessionDbId}/T2`,
            override: [`S${sessionDbId}/T1`],
            crossSession: true,
          },
          { callerSessionId: otherSession },
        ),
      ),
    ).toBe(true);

    const refused = noteTool(
      db,
      { turn: `S${sessionDbId}/T2`, override: [`S${sessionDbId}/T3`] },
      { callerSessionId: sessionDbId },
    );
    expect(isNoteSuccess(refused)).toBe(false);
    expect(refused.content[0]!.text).toContain("were changed by");
    expect(
      db
        .query<{ c: number }, [number]>(
          `SELECT COUNT(*) AS c FROM memory_edges
           WHERE citing_kind = 'turn' AND citing_id = ? AND relation IS NOT NULL`,
        )
        .get(citing)!.c,
    ).toBe(1);

    // Re-reading the current set clears it.
    recallMemory(db, {
      id: `S${sessionDbId}/T2`,
      filter: { fields: ["relations"] },
      readerId: sessionWriterId(sessionDbId),
      now: () => NOW + 1,
    });
    expect(
      isNoteSuccess(
        noteTool(
          db,
          { turn: `S${sessionDbId}/T2`, override: [`S${sessionDbId}/T3`] },
          { callerSessionId: sessionDbId },
        ),
      ),
    ).toBe(true);
  });

  test("the writer that made the current revision may keep writing without re-reading", () => {
    const { sessionDbId } = seedPair();
    const third = seedTurn(sessionDbId, 3);
    updateTurnById(db, third, { type: ["design"] });
    recallMemory(db, {
      id: `S${sessionDbId}/T2`,
      filter: { fields: ["relations"] },
      readerId: sessionWriterId(sessionDbId),
      now: () => NOW,
    });

    expect(
      isNoteSuccess(
        noteTool(
          db,
          { turn: `S${sessionDbId}/T2`, override: [`S${sessionDbId}/T1`] },
          { callerSessionId: sessionDbId },
        ),
      ),
    ).toBe(true);
    // Second edge, same run, no second read: writing is reading.
    expect(
      isNoteSuccess(
        noteTool(
          db,
          { turn: `S${sessionDbId}/T2`, override: [`S${sessionDbId}/T3`] },
          { callerSessionId: sessionDbId },
        ),
      ),
    ).toBe(true);
  });

  test("a retraction stays bare-addressed — the mandate's own exemption survives the new gate", () => {
    const { sessionDbId } = seedPair();
    recallMemory(db, {
      id: `S${sessionDbId}/T2`,
      filter: { fields: ["relations"] },
      readerId: sessionWriterId(sessionDbId),
      now: () => NOW,
    });
    noteTool(
      db,
      { turn: `S${sessionDbId}/T2`, override: [`S${sessionDbId}/T1`] },
      { callerSessionId: sessionDbId },
    );

    const retracted = noteTool(
      db,
      { turn: `S${sessionDbId}/T2`, retractOverride: [`S${sessionDbId}/T1`] },
      { callerSessionId: sessionDbId },
    );
    expect(isNoteSuccess(retracted)).toBe(true);
    expect(retracted.content[0]!.text).toContain("Retracted 1 relation(s)");
  });
});

// ---------------------------------------------------------------------------
// The settlement facade's own repairs (P2-1, P2-3, P2-6)
// ---------------------------------------------------------------------------

function claimWindow(sessionDbId: number, windowStart: number, windowEnd: number): NoteSettlementJob {
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

function facadeContext(
  job: NoteSettlementJob,
  writableTurnIds: number[],
): SettlementTurnFacadeContext {
  return {
    jobId: job.id,
    claimGeneration: job.claimGeneration,
    sessionId: job.sessionId,
    reviewableTurnIds: new Set(writableTurnIds),
    contextBuiltAtEpoch: NOW,
  };
}

describe("P2-1 — a non-empty type/tags replacement needs a COMPLETE metadata read", () => {
  test("a content-only read no longer licenses a silent tag replacement; a metadata read does", () => {
    const sessionDbId = seedSession("p2-1-metadata");
    const turnId = seedTurn(sessionDbId, 1);
    // Ticket 14: `tags` draws from a closed vocabulary — a named segment plus
    // the two lanes declared in it. The question this test asks (which READ
    // licenses a replacement) is unchanged by that.
    const home = createSegment(db, { title: "lane home", tags: ["lane-home"], nowEpoch: NOW });
    insertLane(db, home.id, "lane-alpha", NOW);
    insertLane(db, home.id, "lane-beta", NOW);
    updateTurnById(db, turnId, { type: ["implement"], tags: ["lane-home", "lane-alpha"] });
    // Another writer owns the facets, so the gate must consult this claim's
    // own read rather than admitting on the never-written rule.
    stampField(db, "turn", turnId, "tags", sessionWriterId(sessionDbId), NOW - 900);
    const job = claimWindow(sessionDbId, 1, 1);
    const writer = claimWriterId(job.id, job.claimGeneration);
    const context = facadeContext(job, [turnId]);

    // A read that delivers content and NOT the metadata line.
    recallMemory(db, {
      id: `S${sessionDbId}/T1`,
      filter: { fields: ["content"] },
      turn: 50_000,
      readerId: writer,
      now: () => NOW,
    });

    const yielded = evaluateSettlementTurnWrite(
      db,
      context,
      { turn: `S${sessionDbId}/T1`, tags: ["lane-home", "lane-beta"], mode: { tags: "write" } },
      NOW + 1,
    );
    expect(yielded.ok).toBe(true);
    expect(yielded.ok && yielded.outcome.review?.tags?.landed).toBe(false);
    expect(yielded.ok && yielded.outcome.review?.tags?.yieldedReason).toContain(
      "not delivered in full",
    );
    expect(getTurnById(db, turnId)!.tags).toEqual(["lane-home", "lane-alpha"]);

    // The metadata line is where type/tags render, so that is the read.
    recallMemory(db, {
      id: `S${sessionDbId}/T1`,
      filter: { fields: ["metadata"] },
      turn: 50_000,
      readerId: writer,
      now: () => NOW + 2,
    });
    const landed = evaluateSettlementTurnWrite(
      db,
      context,
      { turn: `S${sessionDbId}/T1`, tags: ["lane-home", "lane-beta"], mode: { tags: "write" } },
      NOW + 3,
    );
    expect(landed.ok && landed.outcome.review?.tags?.landed).toBe(true);
    expect(getTurnById(db, turnId)!.tags).toEqual(["lane-home", "lane-beta"]);
  });
});

describe("P2-3 — turn liveness is re-checked inside the mutation", () => {
  test("note: a rolled-back turn takes no write at all, prose included", () => {
    const sessionDbId = seedSession("p2-3-rolled-back");
    const turnId = seedTurn(sessionDbId, 1);
    db.query<unknown, [number]>("UPDATE turns SET was_rolled_back = 1 WHERE id = ?").run(turnId);

    const refused = noteTool(
      db,
      { turn: `S${sessionDbId}/T1`, title: "late", content: "a note for a rewound turn" },
      { callerSessionId: sessionDbId, eraCutoffEpoch: SETTLEMENT_ERA_CUTOFF_EPOCH },
    );
    expect(isNoteSuccess(refused)).toBe(false);
    expect(refused.content[0]!.text).toContain("was rolled back");
  });

  test("note: a dormant turn refuses a facet-only write and accepts the late note that revives it", () => {
    const sessionDbId = seedSession("p2-3-skipped");
    const turnId = seedTurn(sessionDbId, 1, { status: "skipped" });
    const options = {
      callerSessionId: sessionDbId,
      eraCutoffEpoch: SETTLEMENT_ERA_CUTOFF_EPOCH,
    };

    const refused = noteTool(db, { turn: `S${sessionDbId}/T1`, type: ["fix"] }, options);
    expect(isNoteSuccess(refused)).toBe(false);
    expect(refused.content[0]!.text).toContain("is skipped");
    expect(getTurnById(db, turnId)!.type).toEqual([]);

    const revived = noteTool(
      db,
      { turn: `S${sessionDbId}/T1`, title: "the late note", content: "filling the hole" },
      options,
    );
    expect(isNoteSuccess(revived)).toBe(true);
    expect(getTurnById(db, turnId)!.status).toBe("extracted");
  });

  test("settlement: a turn skipped mid-run takes no type correction", () => {
    const sessionDbId = seedSession("p2-3-settlement");
    const turnId = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = facadeContext(job, [turnId]);
    // The context was built while the turn was live; the status moves during
    // the run, which is exactly the window this check closes.
    db.query<unknown, [number]>("UPDATE turns SET status = 'skipped' WHERE id = ?").run(turnId);

    const refused = evaluateSettlementTurnWrite(
      db,
      context,
      { turn: `S${sessionDbId}/T1`, type: ["implement"] },
      NOW + 1,
    );
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toContain("is skipped");
    expect(getTurnById(db, turnId)!.type).toEqual([]);
  });

  test("settlement: reassign and propose refuse a dead turn by name, and record nothing", () => {
    const sessionDbId = seedSession("p2-3-membership");
    const liveTurn = seedTurn(sessionDbId, 1);
    const deadTurn = seedTurn(sessionDbId, 2);
    db.query<unknown, [number]>("UPDATE turns SET was_rolled_back = 1 WHERE id = ?").run(deadTurn);
    const segment = createSegment(db, { title: "a home", nowEpoch: NOW });
    const job = claimWindow(sessionDbId, 1, 2);
    const context = facadeContext(job, [liveTurn, deadTurn]);

    const reassign = evaluateSettlementMembershipWrite(
      db,
      context,
      {
        action: "reassign",
        turns: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
        id: `E${segment.id}`,
      },
      NOW + 1,
    );
    expect(reassign.ok).toBe(false);
    expect(!reassign.ok && reassign.message).toContain("was rolled back");
    expect(
      db
        .query<{ c: number }, [number]>(
          "SELECT COUNT(*) AS c FROM segment_members WHERE segment_id = ?",
        )
        .get(segment.id)!.c,
    ).toBe(0);

    const propose = evaluateSettlementMembershipWrite(
      db,
      context,
      {
        action: "propose",
        addresses: [`S${sessionDbId}/T2`],
        title: "a cluster built on a rewound turn",
      },
      NOW + 2,
    );
    expect(propose.ok).toBe(false);
    expect(!propose.ok && propose.message).toContain("was rolled back");
  });
});

describe("P2-6 — a malformed mode.* rejection counts against the turn it names", () => {
  test("the second consecutive malformed edit on one address escalates", () => {
    const sessionDbId = seedSession("p2-6-loop");
    const turnId = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = facadeContext(job, [turnId]);
    const malformed = {
      turn: `S${sessionDbId}/T1`,
      mode: {
        content: {
          mode: "edit" as const,
          oldString: '<parameter name="content">the glued call</parameter>',
          newString: "a repair",
        },
      },
    };

    const first = evaluateSettlementTurnWrite(db, context, malformed, NOW + 1);
    expect(first.ok).toBe(false);
    expect(!first.ok && first.message).toContain("tool-call syntax");
    expect(!first.ok && first.message).not.toContain("in a row");

    const second = evaluateSettlementTurnWrite(db, context, malformed, NOW + 2);
    expect(second.ok).toBe(false);
    // The whole point of P2-6: the run is counted against `S<n>/T<m>`, so the
    // second rejection can say the retry is copying a broken call.
    expect(!second.ok && second.message).toContain(
      `This is rejection 2 in a row for S${sessionDbId}/T1`,
    );
  });

  test("a call with no parseable address at all still counts against nothing", () => {
    const sessionDbId = seedSession("p2-6-unaddressable");
    const turnId = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = facadeContext(job, [turnId]);
    const malformed = {
      turn: "not-an-address",
      mode: {
        content: {
          mode: "edit" as const,
          oldString: '<parameter name="content">the glued call</parameter>',
          newString: "a repair",
        },
      },
    };

    evaluateSettlementTurnWrite(db, context, malformed, NOW + 1);
    const second = evaluateSettlementTurnWrite(db, context, malformed, NOW + 2);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.message).not.toContain("in a row");
  });
});

// ---------------------------------------------------------------------------
// P2-2 — a grant never exceeds what the page delivered
// ---------------------------------------------------------------------------

describe("P2-2 — empty and error pages grant nothing; a route grants what it shows", () => {
  test("an out-of-range observation page grants neither its turn nor its session", () => {
    const sessionDbId = seedSession("p2-2-observations");
    const turnId = seedTurn(sessionDbId, 1);
    db.query<unknown, [number]>(
      `INSERT INTO observations (
         turn_id, tool_name, tool_input, tool_result, status, title, content,
         excluded_from_extraction, created_at_epoch
       ) VALUES (?, 'Edit', '{}', 'ok', 'extracted', 'Edit a.ts', 'edited', 0, ?)`,
    ).run(turnId, NOW);
    const reader = sessionWriterId(42);

    recallMemory(db, {
      id: `S${sessionDbId}/T1/O*`,
      page: 99,
      readerId: reader,
      now: () => NOW,
    });

    expect(grantCount(reader, "turn", turnId)).toBe(0);
    expect(grantCount(reader, "session", sessionDbId)).toBe(0);

    // Page 1 delivers the row, and grants its context.
    recallMemory(db, { id: `S${sessionDbId}/T1/O*`, readerId: reader, now: () => NOW + 1 });
    expect(grantCount(reader, "turn", turnId)).toBe(1);
    expect(grantCount(reader, "session", sessionDbId)).toBe(1);
  });

  test("a segment address that resolves to nothing grants nothing", () => {
    const reader = sessionWriterId(43);
    const output = recallMemory(db, { id: "E4321", readerId: reader, now: () => NOW });

    expect(output).toContain("not found");
    expect(grantCount(reader, "segment", 4321)).toBe(0);
  });

  test("the session-detail route grants the session and not the turns it previews", () => {
    const sessionDbId = seedSession("p2-2-session-detail");
    const turnId = seedTurn(sessionDbId, 1);
    const reader = sessionWriterId(44);

    recallMemory(db, { id: `S${sessionDbId}`, readerId: reader, now: () => NOW });

    expect(grantCount(reader, "session", sessionDbId)).toBe(1);
    expect(grantCount(reader, "turn", turnId)).toBe(0);
  });
});
