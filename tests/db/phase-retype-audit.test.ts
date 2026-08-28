import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { loadPhaseRetypeAuditsForTurn, recordPhaseRetypeAudit } from "../../src/db/phase-retype-audit";
import { upsertSession } from "../../src/db/sessions";
import { claimNextNoteSettlementJob, enqueueNoteSettlementWindows } from "../../src/db/note-settlement";

const NOW = 1_800_000_000;

function seedJobAndTurn(db: Database): { jobId: number; turnId: number } {
  const sessionId = upsertSession(db, {
    contentSessionId: "phase-retype-audit-fixture",
    project: "/tmp/project-phase-retype-audit",
    title: "phase-retype-audit fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
  const turnId = db
    .query<{ id: number }, [number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type
       ) VALUES (?, 1, 'active', 'p', 'r', 1, ?, '["fix"]')
       RETURNING id`,
    )
    .get(sessionId, NOW)!.id;
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
  return { jobId: job.id, turnId };
}

describe("phase_retype_audits — the persistent record a compound retype owes", () => {
  test("a written record round-trips every field, including the arrays as real arrays", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const { jobId, turnId } = seedJobAndTurn(db);

    expect(loadPhaseRetypeAuditsForTurn(db, turnId)).toEqual([]);

    recordPhaseRetypeAudit(db, {
      jobId,
      turnId,
      oldTypes: ["fix"],
      newTypes: ["fix", "measure"],
      basisWord: "measure",
      reason: "a benchmark run genuinely measured the fix's effect",
      createdAtEpoch: NOW,
    });

    const rows = loadPhaseRetypeAuditsForTurn(db, turnId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.jobId).toBe(jobId);
    expect(rows[0]!.turnId).toBe(turnId);
    expect(rows[0]!.oldTypes).toEqual(["fix"]);
    expect(rows[0]!.newTypes).toEqual(["fix", "measure"]);
    expect(rows[0]!.basisWord).toBe("measure");
    expect(rows[0]!.reason).toBe("a benchmark run genuinely measured the fix's effect");

    db.close();
  });

  test("several retypes on the same turn accumulate, ascending by id — never overwritten", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const { jobId, turnId } = seedJobAndTurn(db);

    recordPhaseRetypeAudit(db, {
      jobId,
      turnId,
      oldTypes: ["fix"],
      newTypes: ["fix", "measure"],
      basisWord: "measure",
      reason: "first pass",
      createdAtEpoch: NOW,
    });
    recordPhaseRetypeAudit(db, {
      jobId,
      turnId,
      oldTypes: ["fix", "measure"],
      newTypes: ["fix", "measure", "research"],
      basisWord: "research",
      reason: "second pass, a distinct finding",
      createdAtEpoch: NOW + 10,
    });

    const rows = loadPhaseRetypeAuditsForTurn(db, turnId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.basisWord)).toEqual(["measure", "research"]);
    expect(rows[0]!.id).toBeLessThan(rows[1]!.id);

    db.close();
  });
});
