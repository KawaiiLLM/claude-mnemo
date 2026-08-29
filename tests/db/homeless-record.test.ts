import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { claimNextNoteSettlementJob, enqueueNoteSettlementWindows } from "../../src/db/note-settlement";
import {
  ensureHomelessRecordTables,
  HomelessGroupImmutabilityError,
  HomelessSupersessionOutcomeConflictError,
  HomelessSupersessionSuccessorTransitionError,
  TASKLESS_TASK_SCOPE_ID,
  loadHomelessGroup,
  loadHomelessGroupMembers,
  loadHomelessRetractionAuditsForGroup,
  recordHomelessRetractionAudit,
  resolveActiveHomelessDisposition,
  writeHomelessGroup,
  writeHomelessSupersessions,
} from "../../src/db/homeless-record";

const NOW = 1_800_000_000;

function freshDb(): Database {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  ensureHomelessRecordTables(db);
  return db;
}

function seedJob(db: Database, contentSessionId: string): { jobId: number; sessionId: number } {
  const sessionId = upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-homeless-record",
    title: "homeless-record fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId, windowStart: 1, windowEnd: 1, triggerType: "consecutive" }],
    NOW,
    NOW - 100_000,
  );
  const job = claimNextNoteSettlementJob(db, sessionId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return { jobId: job.id, sessionId };
}

function seedTurn(db: Database, sessionId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, ?, 'active', 'p', 'r', 1, ?)
       RETURNING id`,
    )
    .get(sessionId, promptNumber, NOW)!.id;
}

describe("homeless_groups — the immutable group record (spec Rev 5)", () => {
  test("tables exist and a written group round-trips with its members", () => {
    const db = freshDb();
    const { jobId, sessionId } = seedJob(db, "homeless-shape");
    const turn1 = seedTurn(db, sessionId, 1);
    const turn2 = seedTurn(db, sessionId, 2);

    const result = writeHomelessGroup(db, {
      jobId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "orphan-topic",
      memberFingerprint: "fp-1",
      reason: "no legal task container at transition time",
      transitionSeq: 1,
      turnIds: [turn1, turn2],
      createdAtEpoch: NOW,
    });

    expect(result.outcome).toBe("created");
    const group = loadHomelessGroup(db, result.groupId);
    expect(group).not.toBeNull();
    expect(group!.jobId).toBe(jobId);
    expect(group!.taskScopeId).toBe(TASKLESS_TASK_SCOPE_ID);
    expect(group!.canonicalLabel).toBe("orphan-topic");
    expect(group!.memberFingerprint).toBe("fp-1");
    expect(group!.transitionSeq).toBe(1);
    expect(loadHomelessGroupMembers(db, result.groupId)).toEqual([turn1, turn2].sort((a, b) => a - b));

    db.close();
  });

  test("the NULL trap is closed by construction: two taskless groups under the same (job, label) CONFLICT on the unique key, not a silent second row", () => {
    const db = freshDb();
    const { jobId, sessionId } = seedJob(db, "homeless-null-trap");
    const turn1 = seedTurn(db, sessionId, 1);

    // First row via the raw table, exactly as the naive nullable design's
    // FIRST insert would also have produced.
    db.query<unknown, [number, number, string, string, string, number, number]>(
      `INSERT INTO homeless_groups (
         job_id, task_scope_id, canonical_label, member_fingerprint, reason,
         transition_seq, created_at_epoch
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(jobId, TASKLESS_TASK_SCOPE_ID, "dup-label", "fp-a", "reason a", 1, NOW);

    // A second taskless row under the identical (job, label) must hit the
    // UNIQUE index directly — proving 0-as-sentinel (never NULL) actually
    // closes the trap, rather than merely being asserted in prose.
    expect(() =>
      db
        .query<unknown, [number, number, string, string, string, number, number]>(
          `INSERT INTO homeless_groups (
             job_id, task_scope_id, canonical_label, member_fingerprint, reason,
             transition_seq, created_at_epoch
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(jobId, TASKLESS_TASK_SCOPE_ID, "dup-label", "fp-b", "reason b", 2, NOW),
    ).toThrow(/UNIQUE constraint failed/);

    const rows = db
      .query<{ count: number }, [number, number, string]>(
        `SELECT COUNT(*) AS count FROM homeless_groups WHERE job_id = ? AND task_scope_id = ? AND canonical_label = ?`,
      )
      .get(jobId, TASKLESS_TASK_SCOPE_ID, "dup-label")!;
    expect(rows.count).toBe(1);

    void turn1;
    db.close();
  });

  test("immutability: same key + same fingerprint + same reason is a success no-op, not a second row", () => {
    const db = freshDb();
    const { jobId, sessionId } = seedJob(db, "homeless-noop");
    const turn1 = seedTurn(db, sessionId, 1);

    const first = writeHomelessGroup(db, {
      jobId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "stable-label",
      memberFingerprint: "fp-stable",
      reason: "no legal task container",
      transitionSeq: 1,
      turnIds: [turn1],
      createdAtEpoch: NOW,
    });
    expect(first.outcome).toBe("created");

    const second = writeHomelessGroup(db, {
      jobId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "stable-label",
      memberFingerprint: "fp-stable",
      reason: "no legal task container",
      transitionSeq: 1,
      turnIds: [turn1],
      createdAtEpoch: NOW + 10,
    });
    expect(second.outcome).toBe("no-op");
    expect(second.groupId).toBe(first.groupId);

    const count = db
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM homeless_groups`)
      .get()!.count;
    expect(count).toBe(1);

    db.close();
  });

  test("immutability: same key + different fingerprint is REFUSED with HomelessGroupImmutabilityError, and the stored row is untouched (no UPDATE path)", () => {
    const db = freshDb();
    const { jobId, sessionId } = seedJob(db, "homeless-refuse-fp");
    const turn1 = seedTurn(db, sessionId, 1);

    const first = writeHomelessGroup(db, {
      jobId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "fp-conflict",
      memberFingerprint: "fp-original",
      reason: "no legal task container",
      transitionSeq: 1,
      turnIds: [turn1],
      createdAtEpoch: NOW,
    });

    expect(() =>
      writeHomelessGroup(db, {
        jobId,
        taskScopeId: TASKLESS_TASK_SCOPE_ID,
        canonicalLabel: "fp-conflict",
        memberFingerprint: "fp-changed",
        reason: "no legal task container",
        transitionSeq: 2,
        turnIds: [turn1],
        createdAtEpoch: NOW + 100,
      }),
    ).toThrow(HomelessGroupImmutabilityError);

    const stored = loadHomelessGroup(db, first.groupId)!;
    expect(stored.memberFingerprint).toBe("fp-original");
    expect(stored.transitionSeq).toBe(1);

    db.close();
  });

  test("immutability: same key + same fingerprint but a different reason is also REFUSED", () => {
    const db = freshDb();
    const { jobId, sessionId } = seedJob(db, "homeless-refuse-reason");
    const turn1 = seedTurn(db, sessionId, 1);

    writeHomelessGroup(db, {
      jobId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "reason-conflict",
      memberFingerprint: "fp-same",
      reason: "reason A",
      transitionSeq: 1,
      turnIds: [turn1],
      createdAtEpoch: NOW,
    });

    expect(() =>
      writeHomelessGroup(db, {
        jobId,
        taskScopeId: TASKLESS_TASK_SCOPE_ID,
        canonicalLabel: "reason-conflict",
        memberFingerprint: "fp-same",
        reason: "reason B",
        transitionSeq: 2,
        turnIds: [turn1],
        createdAtEpoch: NOW + 100,
      }),
    ).toThrow(HomelessGroupImmutabilityError);

    db.close();
  });

  test("no UPDATE statement exists against homeless_groups in this module's source", async () => {
    const source = await Bun.file(
      new URL("../../src/db/homeless-record.ts", import.meta.url),
    ).text();
    expect(/UPDATE\s+homeless_groups/i.test(source)).toBe(false);
  });
});

describe("homeless_supersessions — member-row-level resolution", () => {
  test("at most one live successor per (old_group_id, turn_id): a second mapping for the same pair hits the unique key", () => {
    const db = freshDb();
    const { jobId, sessionId } = seedJob(db, "homeless-supersede-unique");
    const turn1 = seedTurn(db, sessionId, 1);

    const oldGroup = writeHomelessGroup(db, {
      jobId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "old-label",
      memberFingerprint: "fp-old",
      reason: "no legal task container",
      transitionSeq: 1,
      turnIds: [turn1],
      createdAtEpoch: NOW,
    });

    writeHomelessSupersessions(db, {
      transitionSeq: 5,
      createdAtEpoch: NOW + 10,
      mappings: [
        { oldGroupId: oldGroup.groupId, turnId: turn1, successorKind: "homed", successorGroupId: null },
      ],
    });

    expect(() =>
      writeHomelessSupersessions(db, {
        transitionSeq: 9,
        createdAtEpoch: NOW + 20,
        mappings: [
          { oldGroupId: oldGroup.groupId, turnId: turn1, successorKind: "homed", successorGroupId: null },
        ],
      }),
    ).toThrow(/UNIQUE constraint failed/);

    db.close();
  });

  test("all mappings one transition writes for one turn must agree on the outcome", () => {
    const db = freshDb();
    const { jobId, sessionId } = seedJob(db, "homeless-supersede-agree");
    const turn1 = seedTurn(db, sessionId, 1);

    const groupA = writeHomelessGroup(db, {
      jobId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "group-a",
      memberFingerprint: "fp-a",
      reason: "no legal task container",
      transitionSeq: 1,
      turnIds: [turn1],
      createdAtEpoch: NOW,
    });
    const groupB = writeHomelessGroup(db, {
      jobId,
      taskScopeId: 42,
      canonicalLabel: "group-b",
      memberFingerprint: "fp-b",
      reason: "no legal task container",
      transitionSeq: 1,
      turnIds: [turn1],
      createdAtEpoch: NOW,
    });

    expect(() =>
      writeHomelessSupersessions(db, {
        transitionSeq: 10,
        createdAtEpoch: NOW + 10,
        mappings: [
          { oldGroupId: groupA.groupId, turnId: turn1, successorKind: "homed", successorGroupId: null },
          { oldGroupId: groupB.groupId, turnId: turn1, successorKind: "regrouped", successorGroupId: groupA.groupId },
        ],
      }),
    ).toThrow(HomelessSupersessionOutcomeConflictError);

    db.close();
  });

  test("a regrouped successor group must carry the SAME transition_seq as the mapping", () => {
    const db = freshDb();
    const { jobId, sessionId } = seedJob(db, "homeless-supersede-seq");
    const turn1 = seedTurn(db, sessionId, 1);

    const oldGroup = writeHomelessGroup(db, {
      jobId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "old-label-seq",
      memberFingerprint: "fp-old",
      reason: "no legal task container",
      transitionSeq: 1,
      turnIds: [turn1],
      createdAtEpoch: NOW,
    });
    // Successor created at transition_seq 3, but the mapping below claims
    // transition_seq 10 — a mismatch.
    const wrongSeqSuccessor = writeHomelessGroup(db, {
      jobId,
      taskScopeId: 7,
      canonicalLabel: "mismatched-successor",
      memberFingerprint: "fp-succ",
      reason: "regrouped under a real lane",
      transitionSeq: 3,
      turnIds: [],
      createdAtEpoch: NOW,
    });

    expect(() =>
      writeHomelessSupersessions(db, {
        transitionSeq: 10,
        createdAtEpoch: NOW + 10,
        mappings: [
          {
            oldGroupId: oldGroup.groupId,
            turnId: turn1,
            successorKind: "regrouped",
            successorGroupId: wrongSeqSuccessor.groupId,
          },
        ],
      }),
    ).toThrow(HomelessSupersessionSuccessorTransitionError);

    db.close();
  });

  test("a regrouped mapping whose successor group WAS created at the same transition_seq succeeds", () => {
    const db = freshDb();
    const { jobId, sessionId } = seedJob(db, "homeless-supersede-seq-ok");
    const turn1 = seedTurn(db, sessionId, 1);

    const oldGroup = writeHomelessGroup(db, {
      jobId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "old-label-ok",
      memberFingerprint: "fp-old",
      reason: "no legal task container",
      transitionSeq: 1,
      turnIds: [turn1],
      createdAtEpoch: NOW,
    });
    const successor = writeHomelessGroup(db, {
      jobId,
      taskScopeId: 7,
      canonicalLabel: "matched-successor",
      memberFingerprint: "fp-succ",
      reason: "regrouped under a real lane",
      transitionSeq: 10,
      turnIds: [],
      createdAtEpoch: NOW,
    });

    expect(() =>
      writeHomelessSupersessions(db, {
        transitionSeq: 10,
        createdAtEpoch: NOW + 10,
        mappings: [
          {
            oldGroupId: oldGroup.groupId,
            turnId: turn1,
            successorKind: "regrouped",
            successorGroupId: successor.groupId,
          },
        ],
      }),
    ).not.toThrow();

    db.close();
  });
});

describe("resolveActiveHomelessDisposition — the sole event-reduction entry point", () => {
  test("a turn homed by a later transition yields NO active homeless state", () => {
    const db = freshDb();
    const { jobId, sessionId } = seedJob(db, "homeless-active-homed");
    const turn1 = seedTurn(db, sessionId, 1);

    const group = writeHomelessGroup(db, {
      jobId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "will-be-homed",
      memberFingerprint: "fp-1",
      reason: "no legal task container",
      transitionSeq: 1,
      turnIds: [turn1],
      createdAtEpoch: NOW,
    });

    expect(resolveActiveHomelessDisposition(db, turn1)?.groupId).toBe(group.groupId);

    writeHomelessSupersessions(db, {
      transitionSeq: 5,
      createdAtEpoch: NOW + 10,
      mappings: [
        { oldGroupId: group.groupId, turnId: turn1, successorKind: "homed", successorGroupId: null },
      ],
    });

    expect(resolveActiveHomelessDisposition(db, turn1)).toBeNull();

    db.close();
  });

  test("partial overlap re-disposes exactly the covered members — uncovered members keep the old group's disposition", () => {
    const db = freshDb();
    const { jobId, sessionId } = seedJob(db, "homeless-active-partial");
    const turn1 = seedTurn(db, sessionId, 1);
    const turn2 = seedTurn(db, sessionId, 2);
    const turn3 = seedTurn(db, sessionId, 3);

    const oldGroup = writeHomelessGroup(db, {
      jobId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "old-partial",
      memberFingerprint: "fp-old",
      reason: "no legal task container",
      transitionSeq: 1,
      turnIds: [turn1, turn2, turn3],
      createdAtEpoch: NOW,
    });

    const newGroup = writeHomelessGroup(db, {
      jobId,
      taskScopeId: 3,
      canonicalLabel: "new-home",
      memberFingerprint: "fp-new",
      reason: "regrouped under a real lane",
      transitionSeq: 10,
      turnIds: [],
      createdAtEpoch: NOW + 10,
    });

    writeHomelessSupersessions(db, {
      transitionSeq: 10,
      createdAtEpoch: NOW + 10,
      mappings: [
        { oldGroupId: oldGroup.groupId, turnId: turn1, successorKind: "homed", successorGroupId: null },
        { oldGroupId: oldGroup.groupId, turnId: turn2, successorKind: "regrouped", successorGroupId: newGroup.groupId },
      ],
    });

    expect(resolveActiveHomelessDisposition(db, turn1)).toBeNull();
    expect(resolveActiveHomelessDisposition(db, turn2)?.groupId).toBe(newGroup.groupId);
    // turn3 was never covered by the transition_seq=10 supersession — it
    // keeps the OLD group's disposition untouched.
    expect(resolveActiveHomelessDisposition(db, turn3)?.groupId).toBe(oldGroup.groupId);

    db.close();
  });

  test("highest transition_seq wins regardless of job id order", () => {
    const db = freshDb();
    // jobLow gets the SMALLER job id but the HIGHER transition_seq; jobHigh
    // gets the LARGER job id but the LOWER transition_seq. If job id order
    // were ever used as a time proxy, this test would pick the wrong one.
    const { jobId: jobLowId, sessionId: sessionLow } = seedJob(db, "homeless-active-seq-low-id");
    const { jobId: jobHighId, sessionId: sessionHigh } = seedJob(db, "homeless-active-seq-high-id");
    expect(jobLowId).toBeLessThan(jobHighId);

    const turnLow = seedTurn(db, sessionLow, 1);
    // Same physical turn identity is what matters for the reduction, so we
    // reuse the SAME turn id across both groups by inserting it into both
    // sessions' fixtures is not meaningful — instead, attach both groups to
    // the SAME turn row directly (a turn can be a member of two homeless
    // groups from two different task scopes at once).
    void sessionHigh;

    const groupHighSeq = writeHomelessGroup(db, {
      jobId: jobLowId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "high-seq-group",
      memberFingerprint: "fp-high",
      reason: "no legal task container",
      transitionSeq: 200,
      turnIds: [turnLow],
      createdAtEpoch: NOW,
    });
    const groupLowSeq = writeHomelessGroup(db, {
      jobId: jobHighId,
      taskScopeId: 9,
      canonicalLabel: "low-seq-group",
      memberFingerprint: "fp-low",
      reason: "no legal task container",
      transitionSeq: 50,
      turnIds: [],
      createdAtEpoch: NOW,
    });
    // Attach the same turn to the low-transition_seq, high-job-id group too,
    // via a raw insert (writeHomelessGroup already inserted turnLow above).
    db.query<unknown, [number, number]>(
      `INSERT INTO homeless_members (group_id, turn_id) VALUES (?, ?)`,
    ).run(groupLowSeq.groupId, turnLow);

    const disposition = resolveActiveHomelessDisposition(db, turnLow);
    expect(disposition?.groupId).toBe(groupHighSeq.groupId);
    expect(disposition?.transitionSeq).toBe(200);

    db.close();
  });

  test("a turn with no homeless events at all resolves to null", () => {
    const db = freshDb();
    const { sessionId } = seedJob(db, "homeless-active-none");
    const turn1 = seedTurn(db, sessionId, 1);
    expect(resolveActiveHomelessDisposition(db, turn1)).toBeNull();
    db.close();
  });
});

describe("homeless_retraction_audits — full composite identity of a deleted relation row", () => {
  test("a written audit row round-trips every field of the deleted relation's identity", () => {
    const db = freshDb();
    const { jobId, sessionId } = seedJob(db, "homeless-audit-roundtrip");
    const turn1 = seedTurn(db, sessionId, 1);

    const group = writeHomelessGroup(db, {
      jobId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "audit-source",
      memberFingerprint: "fp-1",
      reason: "no legal task container",
      transitionSeq: 1,
      turnIds: [turn1],
      createdAtEpoch: NOW,
    });

    const auditId = recordHomelessRetractionAudit(db, {
      jobId,
      causeGroupId: group.groupId,
      edgeId: 999,
      citingKind: "turn",
      citingId: turn1,
      citedKind: "turn",
      citedId: turn1,
      relationWord: "refines",
      tailTag: "old-lane",
      headTag: "old-lane",
      outcome: "retracted",
      createdAtEpoch: NOW + 5,
    });

    const rows = loadHomelessRetractionAuditsForGroup(db, group.groupId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(auditId);
    expect(rows[0]!.jobId).toBe(jobId);
    expect(rows[0]!.edgeId).toBe(999);
    expect(rows[0]!.citingKind).toBe("turn");
    expect(rows[0]!.citedKind).toBe("turn");
    expect(rows[0]!.relationWord).toBe("refines");
    expect(rows[0]!.tailTag).toBe("old-lane");
    expect(rows[0]!.headTag).toBe("old-lane");
    expect(rows[0]!.outcome).toBe("retracted");

    db.close();
  });

  test("the 'relation retracted, bare restored' outcome is representable and distinguishable from a plain retraction", () => {
    const db = freshDb();
    const { jobId, sessionId } = seedJob(db, "homeless-audit-bare-restored");
    const turn1 = seedTurn(db, sessionId, 1);

    const group = writeHomelessGroup(db, {
      jobId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "audit-bare",
      memberFingerprint: "fp-1",
      reason: "no legal task container",
      transitionSeq: 1,
      turnIds: [turn1],
      createdAtEpoch: NOW,
    });

    recordHomelessRetractionAudit(db, {
      jobId,
      causeGroupId: group.groupId,
      edgeId: 111,
      citingKind: "turn",
      citingId: turn1,
      citedKind: "turn",
      citedId: turn1,
      relationWord: "implements",
      tailTag: "old-lane",
      headTag: "old-lane",
      outcome: "retracted-bare-restored",
      createdAtEpoch: NOW + 5,
    });

    const rows = loadHomelessRetractionAuditsForGroup(db, group.groupId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("retracted-bare-restored");

    db.close();
  });

  test("the write helper composes into the caller's own deleting transaction: a rollback discards the deletion AND the audit row together", () => {
    const db = freshDb();
    const { jobId, sessionId } = seedJob(db, "homeless-audit-atomic");
    const turn1 = seedTurn(db, sessionId, 1);

    const group = writeHomelessGroup(db, {
      jobId,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "audit-atomic",
      memberFingerprint: "fp-1",
      reason: "no legal task container",
      transitionSeq: 1,
      turnIds: [turn1],
      createdAtEpoch: NOW,
    });

    // Simulate "the deleting transaction": a relation row is deleted from a
    // scratch table standing in for memory_edges, the audit is recorded
    // alongside it, and the whole thing is rolled back by a thrown error —
    // proving recordHomelessRetractionAudit does not open its own
    // transaction (which would have committed the audit row regardless).
    db.exec(`CREATE TABLE IF NOT EXISTS scratch_relation (id INTEGER PRIMARY KEY)`);
    db.query(`INSERT INTO scratch_relation (id) VALUES (777)`).run();

    const txn = db.transaction(() => {
      db.query(`DELETE FROM scratch_relation WHERE id = 777`).run();
      recordHomelessRetractionAudit(db, {
        jobId,
        causeGroupId: group.groupId,
        edgeId: 777,
        citingKind: "turn",
        citingId: turn1,
        citedKind: "turn",
        citedId: turn1,
        relationWord: "refines",
        tailTag: "old-lane",
        headTag: "old-lane",
        outcome: "retracted",
        createdAtEpoch: NOW + 5,
      });
      throw new Error("simulated failure after both writes");
    });

    expect(() => txn.immediate()).toThrow("simulated failure after both writes");

    const survivingScratchRow = db
      .query<{ id: number }, []>(`SELECT id FROM scratch_relation WHERE id = 777`)
      .get();
    expect(survivingScratchRow).not.toBeNull(); // the delete was rolled back
    expect(loadHomelessRetractionAuditsForGroup(db, group.groupId)).toHaveLength(0); // so was the audit row

    db.close();
  });
});
