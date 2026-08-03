import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import { createRuleStore } from "../../src/db/rules";
import {
  advanceSettlementCursor,
  claimNextSettlementJob,
  countSettlementTerminalTurns,
  enqueueSessionEndSettlementJob,
  enqueueSettlementBoundaries,
  failSettlementJob,
  getSettlementCursor,
  listSettlementJobs,
  SETTLEMENT_LEASE_MS,
  type SettlementJob,
} from "../../src/db/settlement";
import { getSessionEffectiveCitations } from "../../src/db/citations";
import {
  applySettlementBatch,
  buildSettlementPrompt,
  computeSettlementSignals,
  parseSettlementBatch,
  renderMechanicalSignals,
  renderSettlementWindow,
  ROLLED_BACK_TAG,
} from "../../src/worker/settlement";
import { contentDateAt } from "../../src/diary/calendar";
import { DEFAULT_CONFIG } from "../../src/shared/config";
import { createWorkerCore } from "../../src/worker/server";
import type { WorkerQuerySession } from "../../src/worker/query-session";

interface SeedTurnInput {
  status?: string;
  grade?: number | null;
  title?: string;
  content?: string;
  type?: string;
  createdAtEpoch?: number;
}

function seedSession(db: Database, contentSessionId = "settle-1"): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/projects/settle",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: 100,
    updatedAtEpoch: 100,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(
  db: Database,
  sessionId: number,
  promptNumber: number,
  input: SeedTurnInput = {},
): number {
  return db
    .query<{ id: number }, [number, number, string, string, string, number | null, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, content, significance_grade, type, created_at_epoch
       ) VALUES (?, ?, ?, 'prompt', 'response', ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      sessionId,
      promptNumber,
      input.status ?? "extracted",
      input.title ?? `title ${promptNumber}`,
      input.content ?? `content ${promptNumber}`,
      input.grade === undefined ? 1 : input.grade,
      input.type ?? "change",
      input.createdAtEpoch ?? 1_000 + promptNumber,
    )!.id;
}

function seedTurns(
  db: Database,
  sessionId: number,
  count: number,
  input: SeedTurnInput = {},
): number[] {
  const ids: number[] = [];
  for (let promptNumber = 1; promptNumber <= count; promptNumber += 1) {
    ids.push(seedTurn(db, sessionId, promptNumber, input));
  }
  return ids;
}

function cite(
  db: Database,
  citingTurnId: number,
  citedTurnId: number,
  relation = "builds-on",
): void {
  db.query(
    `INSERT OR IGNORE INTO turn_citations
       (citing_turn_id, cited_turn_id, relation, created_at_epoch)
     VALUES (?, ?, ?, 1)`,
  ).run(citingTurnId, citedTurnId, relation);
  db.query("UPDATE turns SET cites_recorded = 1 WHERE id = ?").run(citingTurnId);
}

describe("settlement job state machine", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = seedSession(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a jump across several boundaries enqueues every crossed boundary", () => {
    seedTurns(db, sessionId, 49);
    expect(enqueueSettlementBoundaries(db, sessionId, 10)).toEqual([]);

    for (let promptNumber = 50; promptNumber <= 151; promptNumber += 1) {
      seedTurn(db, sessionId, promptNumber);
    }
    expect(countSettlementTerminalTurns(db, sessionId)).toBe(151);

    const created = enqueueSettlementBoundaries(db, sessionId, 20);
    expect(created.map((job) => job.boundary)).toEqual([50, 100, 150]);
    expect(listSettlementJobs(db, sessionId).map((job) => job.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  test("re-enqueueing the same boundary is a no-op (UNIQUE session+boundary)", () => {
    seedTurns(db, sessionId, 60);
    expect(enqueueSettlementBoundaries(db, sessionId, 20).length).toBe(1);
    expect(enqueueSettlementBoundaries(db, sessionId, 30)).toEqual([]);
    expect(listSettlementJobs(db, sessionId).length).toBe(1);
  });

  test("only extracted/skipped turns count toward a boundary", () => {
    seedTurns(db, sessionId, 40);
    seedTurn(db, sessionId, 41, { status: "skipped" });
    for (let promptNumber = 42; promptNumber <= 60; promptNumber += 1) {
      seedTurn(db, sessionId, promptNumber, { status: "active" });
    }
    expect(countSettlementTerminalTurns(db, sessionId)).toBe(41);
    expect(enqueueSettlementBoundaries(db, sessionId, 20)).toEqual([]);
  });

  test("frozen members survive a later finalization — the cohort never drifts", () => {
    seedTurns(db, sessionId, 50);
    const [job] = enqueueSettlementBoundaries(db, sessionId, 20);
    expect(job!.frozenMemberIds.length).toBe(50);

    // A turn that finalizes AFTER the boundary was crossed belongs to the next
    // window; re-reading the job must not adopt it.
    const late = seedTurn(db, sessionId, 51);
    expect(listSettlementJobs(db, sessionId)[0]!.frozenMemberIds).not.toContain(
      late,
    );
    expect(listSettlementJobs(db, sessionId)[0]!.frozenMemberIds.length).toBe(50);
  });

  test("a window is the trailing 100 terminal turns ending at the boundary", () => {
    const ids = seedTurns(db, sessionId, 150);
    const jobs = enqueueSettlementBoundaries(db, sessionId, 20);
    const boundary150 = jobs.find((job) => job.boundary === 150)!;
    expect(boundary150.frozenMemberIds.length).toBe(100);
    expect(boundary150.frozenMemberIds[0]).toBe(ids[50]!);
    expect(boundary150.frozenMemberIds.at(-1)).toBe(ids[149]!);
    const boundary50 = jobs.find((job) => job.boundary === 50)!;
    expect(boundary50.frozenMemberIds.length).toBe(50);
  });

  test("claims are ascending and at most one per session is live", () => {
    seedTurns(db, sessionId, 150);
    enqueueSettlementBoundaries(db, sessionId, 20);

    const first = claimNextSettlementJob(db, sessionId, 30, 30_000);
    expect(first?.boundary).toBe(50);
    expect(first?.attempts).toBe(1);
    // A second claim while the first lease is live returns nothing.
    expect(claimNextSettlementJob(db, sessionId, 31, 31_000)).toBeNull();
  });

  test("crash-after-claim: an expired lease returns the job to pending", () => {
    seedTurns(db, sessionId, 50);
    enqueueSettlementBoundaries(db, sessionId, 20);
    const claimed = claimNextSettlementJob(db, sessionId, 30, 30_000)!;
    expect(claimed.status).toBe("claimed");

    // Worker dies here — no done, no failed. Nothing is claimable until the
    // lease expires…
    expect(
      claimNextSettlementJob(db, sessionId, 100, 30_000 + SETTLEMENT_LEASE_MS - 1),
    ).toBeNull();
    // …and the reclaim consumes a second attempt, so a crash loop is bounded.
    const reclaimed = claimNextSettlementJob(
      db,
      sessionId,
      1_000,
      30_000 + SETTLEMENT_LEASE_MS + 1_000,
    );
    expect(reclaimed?.id).toBe(claimed.id);
    expect(reclaimed?.attempts).toBe(2);
  });

  test("a failed job is reclaimable until attempts hit 3, then terminal", () => {
    seedTurns(db, sessionId, 50);
    enqueueSettlementBoundaries(db, sessionId, 20);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const job = claimNextSettlementJob(db, sessionId, 30 * attempt, 30_000 * attempt);
      expect(job?.attempts).toBe(attempt);
      failSettlementJob(
        db,
        job!.id,
        `attempt ${attempt} rejected`,
        30 * attempt,
        job!.claimGeneration,
      );
    }
    expect(claimNextSettlementJob(db, sessionId, 500, 500_000)).toBeNull();
    const [terminal] = listSettlementJobs(db, sessionId);
    expect(terminal!.status).toBe("failed");
    expect(terminal!.attempts).toBe(3);
    expect(terminal!.lastError).toContain("attempt 3");
  });

  test("a crash on the third attempt goes terminal, never a fourth claim", () => {
    seedTurns(db, sessionId, 50);
    enqueueSettlementBoundaries(db, sessionId, 20);

    // Each attempt ends with the worker DYING — no done, no failed — so only
    // the lease resolves it. Reclaim must respect the cap the claim consumed.
    let atMs = 30_000;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const job = claimNextSettlementJob(
        db,
        sessionId,
        Math.floor(atMs / 1_000),
        atMs,
      );
      expect(job?.attempts).toBe(attempt);
      atMs += SETTLEMENT_LEASE_MS + 1_000;
    }

    expect(
      claimNextSettlementJob(db, sessionId, Math.floor(atMs / 1_000), atMs),
    ).toBeNull();
    const [terminal] = listSettlementJobs(db, sessionId);
    expect(terminal!.status).toBe("failed");
    // Not 4: the third crash is where the budget ends.
    expect(terminal!.attempts).toBe(3);
    expect(terminal!.lastError).toContain("lease expired");
  });

  test("a stale lease owner cannot commit over the worker that reclaimed its job", () => {
    const ids = seedTurns(db, sessionId, 50, { grade: 3 });
    const victim = ids[0]!;
    // A supersedes edge so the stale worker would write a role tag too: the
    // rollback has to take back every write, not just the grades.
    cite(db, ids[1]!, victim, "supersedes");
    enqueueSettlementBoundaries(db, sessionId, 20);

    const workerA = claimNextSettlementJob(db, sessionId, 30, 30_000)!;
    const signalsA = computeSettlementSignals(
      db,
      sessionId,
      workerA.frozenMemberIds.map((id) => getTurnById(db, id)!),
    );
    expect(signalsA.supersessions.length).toBe(1);

    // Worker A stalls past its lease; worker B reclaims the SAME row and gets a
    // new generation.
    const workerB = claimNextSettlementJob(
      db,
      sessionId,
      700,
      30_000 + SETTLEMENT_LEASE_MS + 1_000,
    )!;
    expect(workerB.id).toBe(workerA.id);
    expect(workerB.attempts).toBe(2);
    expect(workerB.claimGeneration).toBe(workerA.claimGeneration + 1);

    // A finally comes back. Its answer is discarded whole — no grade, no tag,
    // no done, no cursor.
    expect(
      applySettlementBatch(db, workerA, [{ turnId: victim, grade: 0 }], signalsA, 710),
    ).toBeNull();
    expect(getTurnById(db, victim)!.significanceGrade).toBe(3);
    expect(getTurnById(db, victim)!.tags).not.toContain(ROLLED_BACK_TAG);
    expect(listSettlementJobs(db, sessionId)[0]!.status).toBe("claimed");
    expect(getSettlementCursor(db, sessionId)).toBe(0);
    // …and A cannot fail B's claim out from under it either.
    expect(
      failSettlementJob(db, workerA.id, "stale failure", 710, workerA.claimGeneration),
    ).toBeNull();
    expect(listSettlementJobs(db, sessionId)[0]!.status).toBe("claimed");

    // B's result is the one that lands.
    const summary = applySettlementBatch(
      db,
      workerB,
      [{ turnId: victim, grade: 4 }],
      computeSettlementSignals(
        db,
        sessionId,
        workerB.frozenMemberIds.map((id) => getTurnById(db, id)!),
      ),
      720,
    );
    expect(summary!.grades).toEqual([{ turnId: victim, from: 3, to: 4 }]);
    expect(getTurnById(db, victim)!.significanceGrade).toBe(4);
    expect(getSettlementCursor(db, sessionId)).toBe(50);
  });

  test("a terminally failed boundary is abandoned and the cursor advances across it", () => {
    seedTurns(db, sessionId, 150);
    enqueueSettlementBoundaries(db, sessionId, 20);

    // Boundary 50 burns all three attempts through the real failure path.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const job = claimNextSettlementJob(db, sessionId, 30 * attempt, 30_000 * attempt)!;
      expect(job.boundary).toBe(50);
      failSettlementJob(
        db,
        job.id,
        `attempt ${attempt} rejected`,
        30 * attempt,
        job.claimGeneration,
      );
    }

    // The gap is a durable disposition, not a wedge: the next boundary claims.
    const next = claimNextSettlementJob(db, sessionId, 500, 500_000)!;
    expect(next.boundary).toBe(100);
    const summary = applySettlementBatch(
      db,
      next,
      [],
      computeSettlementSignals(
        db,
        sessionId,
        next.frozenMemberIds.map((id) => getTurnById(db, id)!),
      ),
      510,
    );

    // "Settlement resolved up to here", not "succeeded up to here".
    expect(summary!.cursor).toEqual({ from: 0, to: 100 });
    expect(getSettlementCursor(db, sessionId)).toBe(100);
    expect(
      listSettlementJobs(db, sessionId).map((job) => [
        job.boundary,
        job.status,
        job.attempts,
      ]),
    ).toEqual([
      // The audit trail of the gap survives.
      [50, "failed", 3],
      [100, "done", 1],
      [150, "pending", 0],
    ]);
  });

  test("the cursor advances only across consecutive completions and never backwards", () => {
    seedTurns(db, sessionId, 150);
    enqueueSettlementBoundaries(db, sessionId, 20);
    expect(getSettlementCursor(db, sessionId)).toBe(0);

    const settle = (job: SettlementJob) =>
      applySettlementBatch(
        db,
        job,
        [],
        computeSettlementSignals(
          db,
          sessionId,
          job.frozenMemberIds.map((id) => getTurnById(db, id)!),
        ),
        job.boundary,
      );

    // Boundary 50 fails once, with attempts left — so it is still OPEN, not
    // resolved, and boundary 100 is what the next pass reaches.
    const first50 = claimNextSettlementJob(db, sessionId, 30, 30_000)!;
    expect(first50.boundary).toBe(50);
    failSettlementJob(db, first50.id, "transient", 31, first50.claimGeneration);

    const job100 = claimNextSettlementJob(db, sessionId, 40, 40_000, {
      excludeJobIds: new Set([first50.id]),
    })!;
    expect(job100.boundary).toBe(100);
    expect(settle(job100)!.cursor).toEqual({ from: 0, to: 0 });
    expect(getSettlementCursor(db, sessionId)).toBe(0);

    // 50 lands on a later pass and the cursor jumps both boundaries at once.
    const retry50 = claimNextSettlementJob(db, sessionId, 50, 50_000)!;
    expect(retry50.boundary).toBe(50);
    expect(retry50.attempts).toBe(2);
    expect(settle(retry50)!.cursor).toEqual({ from: 0, to: 100 });
    expect(getSettlementCursor(db, sessionId)).toBe(100);

    // Monotonic: re-opening a later job cannot pull the cursor back. Only raw
    // SQL can produce that state, which is the point of asserting it.
    db.query("UPDATE settlement_jobs SET status = 'pending' WHERE boundary = 100").run();
    expect(advanceSettlementCursor(db, sessionId, 60)).toBe(100);
  });
});

describe("settlement batch validation", () => {
  const frozen = new Set([11, 12, 13]);

  test("an empty batch is valid and means all-confirm", () => {
    expect(parseSettlementBatch("[]", frozen)).toEqual({ ok: true, items: [] });
  });

  test("partial coverage is valid", () => {
    expect(parseSettlementBatch('[{"turnId":12,"grade":0}]', frozen)).toEqual({
      ok: true,
      items: [{ turnId: 12, grade: 0 }],
    });
  });

  test("a fenced array still parses", () => {
    const parsed = parseSettlementBatch(
      '```json\n[{"turnId":11,"grade":4}]\n```',
      frozen,
    );
    expect(parsed).toEqual({ ok: true, items: [{ turnId: 11, grade: 4 }] });
  });

  test.each([
    ["unknown id", '[{"turnId":99,"grade":2}]', "outside the frozen window"],
    ["duplicate id", '[{"turnId":11,"grade":2},{"turnId":11,"grade":3}]', "repeats"],
    ["grade above range", '[{"turnId":11,"grade":5}]', "integer 0-4"],
    ["grade below range", '[{"turnId":11,"grade":-1}]', "integer 0-4"],
    ["fractional grade", '[{"turnId":11,"grade":2.5}]', "integer 0-4"],
    ["extra key", '[{"turnId":11,"grade":2,"why":"x"}]', "exactly the keys"],
    ["missing grade", '[{"turnId":11}]', "exactly the keys"],
    ["renamed key", '[{"turn_id":11,"grade":2}]', "exactly the keys"],
    ["string turnId", '[{"turnId":"11","grade":2}]', "not an integer"],
    ["not an array", '{"turnId":11,"grade":2}', "not a JSON array"],
    ["prose", "I settled the window.", "not JSON"],
    ["empty", "   ", "empty response"],
  ])("rejects the whole batch: %s", (_label, payload, reason) => {
    const parsed = parseSettlementBatch(payload, frozen);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false ? parsed.reason : "").toContain(reason);
  });
});

describe("mechanical signals and rule exemption", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = seedSession(db);
  });

  afterEach(() => {
    db.close();
  });

  test("in-degree confirms; zero-in-degree provisional G3 becomes a demotion candidate", () => {
    const cited = seedTurn(db, sessionId, 1, { grade: 3 });
    const uncited = seedTurn(db, sessionId, 2, { grade: 3 });
    // Grade 0 citer on purpose: confirmation is by CONSUMPTION, at any grade.
    // The "G≥2 citers only" variant measured strictly worse (63 → 73 misses).
    const citer = seedTurn(db, sessionId, 3, { grade: 0 });
    cite(db, citer, cited);

    const cohort = [cited, uncited, citer].map((id) => getTurnById(db, id)!);
    const signals = computeSettlementSignals(db, sessionId, cohort);

    expect(signals.confirmedTurnIds).toEqual([cited]);
    expect(signals.demotionCandidateTurnIds).toEqual([uncited]);
    expect(signals.members.find((m) => m.turnId === cited)!.inDegree).toBe(1);
  });

  test("a supersedes edge becomes a supersession event, not a mechanical demotion", () => {
    const victim = seedTurn(db, sessionId, 1, { grade: 3 });
    const corrector = seedTurn(db, sessionId, 2, { grade: 3 });
    cite(db, corrector, victim, "supersedes");

    const cohort = [victim, corrector].map((id) => getTurnById(db, id)!);
    const signals = computeSettlementSignals(db, sessionId, cohort);

    expect(signals.supersessions).toEqual([
      { victimTurnId: victim, victimPromptNumber: 1, supersededBy: [corrector] },
    ]);
    // Confirmed by its corrector's citation — never demoted mechanically.
    expect(signals.confirmedTurnIds).toContain(victim);
    expect(signals.demotionCandidateTurnIds).not.toContain(victim);
  });

  test("a multi-evidence proposal exempts its evidence turns from nomination", () => {
    const evidenceA = seedTurn(db, sessionId, 1, { grade: 3 });
    const evidenceB = seedTurn(db, sessionId, 2, { grade: 3 });
    const unrelated = seedTurn(db, sessionId, 3, { grade: 3 });
    const store = createRuleStore(db);
    const rule = store.create({
      name: "shell-timeouts",
      claim: "always pass an explicit shell timeout",
      rationale: "open-ended shells read as stuck",
      scope: "global",
      triggerKind: "none",
      triggerSpec: null,
      status: "provisional",
      evidence: [
        { ref: `S${sessionId}/T1`, note: "first sighting", at: 10 },
        { ref: `S${sessionId}/T2`, note: "second sighting", at: 20 },
      ],
      createdAtEpoch: 30,
    });
    store.createEvent({
      eventUid: "propose:shell-timeouts",
      ruleId: rule.id,
      eventKind: "proposed",
      createdAtEpoch: 30,
    });

    const cohort = [evidenceA, evidenceB, unrelated].map(
      (id) => getTurnById(db, id)!,
    );
    const signals = computeSettlementSignals(db, sessionId, cohort);

    expect(signals.ruleExemptTurnIds.sort()).toEqual(
      [evidenceA, evidenceB].sort(),
    );
    expect(signals.demotionCandidateTurnIds).toEqual([unrelated]);
  });

  test("a judgment exempts the turn its source hit fired on", () => {
    const hitTurn = seedTurn(db, sessionId, 1, { grade: 3 });
    const other = seedTurn(db, sessionId, 2, { grade: 3 });
    const store = createRuleStore(db);
    const rule = store.create({
      name: "read-before-edit",
      claim: "read a file before editing it",
      rationale: "edits fail on unread files",
      scope: "/projects/settle",
      triggerKind: "none",
      triggerSpec: null,
      status: "provisional",
      evidence: [],
      createdAtEpoch: 30,
    });
    const hit = store.createEvent({
      eventUid: "hit:1",
      ruleId: rule.id,
      eventKind: "hit",
      turnRef: `S${sessionId}/T1`,
      createdAtEpoch: 40,
    });
    store.createEvent({
      eventUid: "judgment:1",
      ruleId: rule.id,
      eventKind: "judgment",
      sourceEventId: hit.id,
      label: "followed",
      createdAtEpoch: 50,
    });

    const cohort = [hitTurn, other].map((id) => getTurnById(db, id)!);
    const signals = computeSettlementSignals(db, sessionId, cohort);

    expect(signals.ruleExemptTurnIds).toEqual([hitTurn]);
    expect(signals.demotionCandidateTurnIds).toEqual([other]);
  });

  test("one usable evidence ref is not the multi-evidence signal, so it exempts nothing", () => {
    // `propose_rule` enforces ≥2 refs; an `evidence_added` record written by any
    // other path can carry one usable ref plus noise, and honouring that would
    // exempt on a single incidental mention.
    const lone = seedTurn(db, sessionId, 1, { grade: 3 });
    const store = createRuleStore(db);
    const rule = store.create({
      name: "thin-evidence",
      claim: "claim",
      rationale: "rationale",
      scope: "global",
      triggerKind: "none",
      triggerSpec: null,
      status: "provisional",
      evidence: [
        { ref: `S${sessionId}/T1`, note: "the only real one", at: 10 },
        { ref: "not-a-ref-at-all", note: "malformed", at: 11 },
        { ref: `S${sessionId}/T4242`, note: "dangling", at: 12 },
      ],
      createdAtEpoch: 30,
    });
    store.createEvent({
      eventUid: "evidence:thin",
      ruleId: rule.id,
      eventKind: "evidence_added",
      createdAtEpoch: 30,
    });

    const signals = computeSettlementSignals(db, sessionId, [
      getTurnById(db, lone)!,
    ]);
    expect(signals.ruleExemptTurnIds).toEqual([]);
    expect(signals.demotionCandidateTurnIds).toEqual([lone]);
  });

  test("two refs naming the SAME turn are one piece of evidence, not two", () => {
    const lone = seedTurn(db, sessionId, 1, { grade: 3 });
    const store = createRuleStore(db);
    const rule = store.create({
      name: "duplicate-evidence",
      claim: "claim",
      rationale: "rationale",
      scope: "global",
      triggerKind: "none",
      triggerSpec: null,
      status: "provisional",
      evidence: [
        { ref: `S${sessionId}/T1`, note: "first", at: 10 },
        { ref: `S${sessionId}/T1`, note: "same turn again", at: 11 },
      ],
      createdAtEpoch: 30,
    });
    store.createEvent({
      eventUid: "propose:duplicate-evidence",
      ruleId: rule.id,
      eventKind: "proposed",
      createdAtEpoch: 30,
    });

    const signals = computeSettlementSignals(db, sessionId, [
      getTurnById(db, lone)!,
    ]);
    expect(signals.ruleExemptTurnIds).toEqual([]);
  });

  test("a dangling S#/T# ref exempts nothing", () => {
    const only = seedTurn(db, sessionId, 1, { grade: 3 });
    const store = createRuleStore(db);
    const rule = store.create({
      name: "dangling-ref",
      claim: "claim",
      rationale: "rationale",
      scope: "global",
      triggerKind: "none",
      triggerSpec: null,
      status: "provisional",
      evidence: [
        { ref: `S${sessionId}/T9999`, note: "no such turn", at: 10 },
        { ref: "S9999/T1", note: "no such session", at: 11 },
      ],
      createdAtEpoch: 30,
    });
    store.createEvent({
      eventUid: "propose:dangling-ref",
      ruleId: rule.id,
      eventKind: "proposed",
      createdAtEpoch: 30,
    });

    const signals = computeSettlementSignals(db, sessionId, [
      getTurnById(db, only)!,
    ]);
    expect(signals.ruleExemptTurnIds).toEqual([]);
    expect(signals.demotionCandidateTurnIds).toEqual([only]);
  });

  test("signal lists label turns by DB id even when ids and prompt numbers diverge", () => {
    // Explicit ids far from the prompt numbers: a bare `T2` would be a legal
    // reading in BOTH namespaces, and only the arc rows use prompt numbers.
    const victim = 7001;
    const corrector = 7002;
    const uncited = 7003;
    for (const [id, promptNumber] of [
      [victim, 1],
      [corrector, 2],
      [uncited, 3],
    ] as const) {
      db.query(
        `INSERT INTO turns (
           id, session_id, prompt_number, status, user_prompt, assistant_response,
           title, content, significance_grade, type, created_at_epoch
         ) VALUES (?, ?, ?, 'extracted', 'prompt', 'response', ?, ?, 3, 'change', ?)`,
      ).run(
        id,
        sessionId,
        promptNumber,
        `title ${promptNumber}`,
        `content ${promptNumber}`,
        1_000 + promptNumber,
      );
    }
    cite(db, corrector, victim, "supersedes");

    const cohort = [victim, corrector, uncited].map((id) => getTurnById(db, id)!);
    const rendered = renderMechanicalSignals(
      computeSettlementSignals(db, sessionId, cohort),
    );

    expect(rendered).toContain(
      `turnId=${victim} was superseded by turnId=${corrector}`,
    );
    expect(rendered).toContain(`turnId=${uncited}`);
    // The prompt-number reading must be impossible to pick up by accident.
    expect(rendered).not.toContain(`T${victim}`);
    expect(rendered).not.toContain(`T${uncited}`);
    expect(rendered).not.toMatch(/\bT\d+\b/);
  });

  test("the arc view renders against the SAME citation snapshot the signals used", () => {
    const victim = seedTurn(db, sessionId, 1, { grade: 3 });
    const corrector = seedTurn(db, sessionId, 2, { grade: 3 });
    cite(db, corrector, victim, "supersedes");
    const cohort = [victim, corrector].map((id) => getTurnById(db, id)!);
    const signals = computeSettlementSignals(db, sessionId, cohort);

    // The corrector's effective grade is promoted BY the citation graph, so the
    // arc's grade column is a direct readout of which snapshot it drew from.
    const withRealSnapshot = renderSettlementWindow(
      db,
      sessionId,
      cohort,
      signals,
      getSessionEffectiveCitations(db, sessionId),
    );
    // An empty snapshot is a graph with no edges. If the arc still showed the
    // promotion it would be re-reading the DB behind the caller's back — the
    // second read that can disagree with the signal table.
    const withEmptySnapshot = renderSettlementWindow(
      db,
      sessionId,
      cohort,
      signals,
      new Map(),
    );

    expect(withRealSnapshot).not.toBe(withEmptySnapshot);
    expect(withRealSnapshot).toMatch(/T2 [^\n]*G3/);
    expect(withEmptySnapshot).toMatch(/T2 [^\n]*G0/);
  });

  test("the prompt carries the roster, the signal package and the calibration block", () => {
    const cited = seedTurn(db, sessionId, 1, { grade: 3, title: "locked the schema" });
    const uncited = seedTurn(db, sessionId, 2, { grade: 3 });
    const citer = seedTurn(db, sessionId, 3, { grade: 2 });
    cite(db, citer, cited);
    const cohort = [cited, uncited, citer].map((id) => getTurnById(db, id)!);
    const signals = computeSettlementSignals(db, sessionId, cohort);
    const [job] = [
      {
        id: 1,
        sessionId,
        boundary: 50,
        frozenMemberIds: cohort.map((turn) => turn.id),
        status: "claimed" as const,
        attempts: 1,
        claimedAtEpoch: 1,
        claimGeneration: 1,
        changeSummary: null,
        lastError: null,
        createdAtEpoch: 1,
        updatedAtEpoch: 1,
      },
    ];

    const prompt = buildSettlementPrompt({
      db,
      sessionId,
      job: job!,
      cohort,
      signals,
    });

    expect(prompt).toContain(`<settlement session="S${sessionId}" boundary="50"`);
    expect(prompt).toContain("<window-roster");
    expect(prompt).toContain(`turnId=${cited} P1 G3 extracted in_degree=1`);
    expect(prompt).toContain("demotion candidates");
    // The signal list speaks the roster's namespace, never the arc's.
    expect(prompt).toContain(
      `demotion candidates (provisional Grade 3, cited by nothing in the window):\n  turnId=${uncited}`,
    );
    // Drill-down is explicitly offered on the candidates (spec §A).
    expect(prompt).toContain("recall()");
    expect(prompt).toContain("<significance-calibration");
    expect(prompt).toContain("settlement window, boundary 50");
    expect(prompt).toContain("EXACTLY the two keys turnId and grade");
  });

  test("a window under 30 rows draws no percentages and no deviation gate", () => {
    const ids = seedTurns(db, sessionId, 5, { grade: 3 });
    const cohort = ids.map((id) => getTurnById(db, id)!);
    const signals = computeSettlementSignals(db, sessionId, cohort);
    const prompt = buildSettlementPrompt({
      db,
      sessionId,
      job: {
        id: 1,
        sessionId,
        boundary: 5,
        frozenMemberIds: ids,
        status: "claimed",
        attempts: 1,
        claimedAtEpoch: 1,
        claimGeneration: 1,
        changeSummary: null,
        lastError: null,
        createdAtEpoch: 1,
        updatedAtEpoch: 1,
      },
      cohort,
      signals,
    });
    expect(prompt).toContain("Window under 30 turns");
    expect(prompt).not.toContain("above the 15% ceiling");
  });

  test("the frozen cohort is the calibration denominator, skipped and ungraded included", () => {
    const ids: number[] = [];
    for (let promptNumber = 1; promptNumber <= 40; promptNumber += 1) {
      ids.push(
        seedTurn(db, sessionId, promptNumber, {
          grade: promptNumber <= 7 ? 3 : promptNumber <= 20 ? null : 1,
          status: promptNumber > 35 ? "skipped" : "extracted",
        }),
      );
    }
    const cohort = ids.map((id) => getTurnById(db, id)!);
    const signals = computeSettlementSignals(db, sessionId, cohort);
    expect(signals.gradeWindow.total).toBe(40);
    expect(signals.gradeWindow.ungraded).toBe(13);
    expect(signals.gradeWindow.counts[3]).toBe(7);
    // 7/40 = 17.5% > 15% → the evidence gate fires on the frozen cohort.
    const prompt = buildSettlementPrompt({
      db,
      sessionId,
      job: {
        id: 1,
        sessionId,
        boundary: 40,
        frozenMemberIds: ids,
        status: "claimed",
        attempts: 1,
        claimedAtEpoch: 1,
        claimGeneration: 1,
        changeSummary: null,
        lastError: null,
        createdAtEpoch: 1,
        updatedAtEpoch: 1,
      },
      cohort,
      signals,
    });
    expect(prompt).toContain("above the 15% ceiling");
  });
});

describe("settlement success transaction", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = seedSession(db);
  });

  afterEach(() => {
    db.close();
  });

  test("grades, back-links, an old→new change summary and the cursor land together", () => {
    const victim = seedTurn(db, sessionId, 1, { grade: 3 });
    const corrector = seedTurn(db, sessionId, 2, { grade: 3 });
    const untouched = seedTurn(db, sessionId, 3, { grade: 2 });
    cite(db, corrector, victim, "supersedes");
    for (let promptNumber = 4; promptNumber <= 50; promptNumber += 1) {
      seedTurn(db, sessionId, promptNumber);
    }
    const [job] = enqueueSettlementBoundaries(db, sessionId, 100);
    const claimed = claimNextSettlementJob(db, sessionId, 110, 110_000)!;
    const cohort = claimed.frozenMemberIds.map((id) => getTurnById(db, id)!);
    const signals = computeSettlementSignals(db, sessionId, cohort);

    const summary = applySettlementBatch(
      db,
      claimed,
      [
        { turnId: victim, grade: 1 },
        { turnId: corrector, grade: 4 },
        // A no-op decision (already grade 2) is not recorded as a change.
        { turnId: untouched, grade: 2 },
      ],
      signals,
      120,
    );

    expect(getTurnById(db, victim)!.significanceGrade).toBe(1);
    expect(getTurnById(db, corrector)!.significanceGrade).toBe(4);
    expect(summary.grades).toEqual([
      { turnId: victim, from: 3, to: 1 },
      { turnId: corrector, from: 3, to: 4 },
    ]);
    expect(summary.backlinks).toEqual([
      { victimTurnId: victim, supersededBy: [corrector], taggedRolledBack: true },
    ]);
    expect(getTurnById(db, victim)!.tags).toContain(ROLLED_BACK_TAG);
    expect(summary.cursor).toEqual({ from: 0, to: 50 });

    const persisted = listSettlementJobs(db, sessionId)[0]!;
    expect(persisted.status).toBe("done");
    expect(persisted.boundary).toBe(job!.boundary);
    expect(JSON.parse(persisted.changeSummary!).grades).toEqual([
      { turnId: victim, from: 3, to: 1 },
      { turnId: corrector, from: 3, to: 4 },
    ]);
    expect(getSettlementCursor(db, sessionId)).toBe(50);
  });

  test("a write that fails mid-batch leaves no half-written settlement", () => {
    const first = seedTurn(db, sessionId, 1, { grade: 3 });
    const poisoned = seedTurn(db, sessionId, 2, { grade: 3 });
    for (let promptNumber = 3; promptNumber <= 50; promptNumber += 1) {
      seedTurn(db, sessionId, promptNumber);
    }
    enqueueSettlementBoundaries(db, sessionId, 100);
    const claimed = claimNextSettlementJob(db, sessionId, 110, 110_000)!;
    const cohort = claimed.frozenMemberIds.map((id) => getTurnById(db, id)!);
    const signals = computeSettlementSignals(db, sessionId, cohort);
    // Fail the SECOND grade write, after the first has already been applied.
    db.query(
      `CREATE TRIGGER settle_boom BEFORE UPDATE ON turns
       WHEN NEW.id = ${poisoned}
       BEGIN SELECT RAISE(ABORT, 'settle boom'); END`,
    ).run();

    expect(() =>
      applySettlementBatch(
        db,
        claimed,
        [
          { turnId: first, grade: 0 },
          { turnId: poisoned, grade: 0 },
        ],
        signals,
        120,
      ),
    ).toThrow(/settle boom/);

    db.query("DROP TRIGGER settle_boom").run();
    expect(getTurnById(db, first)!.significanceGrade).toBe(3);
    expect(getTurnById(db, poisoned)!.significanceGrade).toBe(3);
    const job = listSettlementJobs(db, sessionId)[0]!;
    expect(job.status).toBe("claimed");
    expect(job.changeSummary).toBeNull();
    expect(getSettlementCursor(db, sessionId)).toBe(0);
  });

  test("an empty batch still completes the job and advances the cursor", () => {
    seedTurns(db, sessionId, 50, { grade: 2 });
    enqueueSettlementBoundaries(db, sessionId, 100);
    const claimed = claimNextSettlementJob(db, sessionId, 110, 110_000)!;
    const cohort = claimed.frozenMemberIds.map((id) => getTurnById(db, id)!);
    const summary = applySettlementBatch(
      db,
      claimed,
      [],
      computeSettlementSignals(db, sessionId, cohort),
      120,
    );

    expect(summary.grades).toEqual([]);
    expect(getSettlementCursor(db, sessionId)).toBe(50);
    expect(listSettlementJobs(db, sessionId)[0]!.status).toBe("done");
  });

  test("settlement does not invalidate a settled diary day", () => {
    const turnId = seedTurn(db, sessionId, 1, { grade: 3, createdAtEpoch: 1_700_000_000 });
    for (let promptNumber = 2; promptNumber <= 50; promptNumber += 1) {
      seedTurn(db, sessionId, promptNumber, { createdAtEpoch: 1_700_000_000 });
    }
    // Make the turn's content day a SETTLED, in-window diary day, which is the
    // only shape `markSettledDiaryDayStaleForTurn` can flip.
    const contentDate = contentDateAt(
      1_700_000_000,
      DEFAULT_CONFIG.dreamAgentTimeZone,
      DEFAULT_CONFIG.dreamAgentHour,
    );
    db.query(
      `INSERT INTO diary_day_state (date, settled_at_epoch, needs_regen)
       VALUES (?, 1, 0)`,
    ).run(contentDate);
    db.query(
      "INSERT INTO diary_state (key, value) VALUES ('cutover_date', '2000-01-01')",
    ).run();

    enqueueSettlementBoundaries(db, sessionId, 100);
    const claimed = claimNextSettlementJob(db, sessionId, 110, 110_000)!;
    const cohort = claimed.frozenMemberIds.map((id) => getTurnById(db, id)!);
    applySettlementBatch(
      db,
      claimed,
      [{ turnId, grade: 1 }],
      computeSettlementSignals(db, sessionId, cohort),
      120,
    );

    const afterSettle = db
      .query<{ needsRegen: number }, [string]>(
        "SELECT needs_regen AS needsRegen FROM diary_day_state WHERE date = ?",
      )
      .get(contentDate)!;
    expect(afterSettle.needsRegen).toBe(0);

    // Control: the SAME day IS invalidated by a narrative change, proving the
    // assertion above is about the grade write and not an inert fixture.
    updateTurnById(db, turnId, { title: "a different conclusion" });
    expect(
      db
        .query<{ needsRegen: number }, [string]>(
          "SELECT needs_regen AS needsRegen FROM diary_day_state WHERE date = ?",
        )
        .get(contentDate)!.needsRegen,
    ).toBe(1);
  });
});

describe("SessionEnd tail settlement job", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = seedSession(db);
  });

  afterEach(() => {
    db.close();
  });

  test("no activity snapshot → no tail job", () => {
    seedTurns(db, sessionId, 30);
    expect(enqueueSessionEndSettlementJob(db, sessionId, 10, false)).toBeNull();
    expect(listSettlementJobs(db, sessionId)).toEqual([]);
  });

  test("activity plus a terminal count past the cursor enqueues a tail job", () => {
    seedTurns(db, sessionId, 137);
    enqueueSettlementBoundaries(db, sessionId, 10);
    db.query("UPDATE settlement_jobs SET status = 'done'").run();
    advanceSettlementCursor(db, sessionId, 11);
    expect(getSettlementCursor(db, sessionId)).toBe(100);

    const tail = enqueueSessionEndSettlementJob(db, sessionId, 12, true);
    expect(tail?.boundary).toBe(137);
    expect(tail?.frozenMemberIds.length).toBe(100);
    // Idempotent under the same identity key.
    expect(enqueueSessionEndSettlementJob(db, sessionId, 13, true)).toBeNull();
    expect(listSettlementJobs(db, sessionId).map((job) => job.boundary)).toEqual([
      50, 100, 137,
    ]);
  });

  test("a terminal count still at the cursor enqueues nothing", () => {
    seedTurns(db, sessionId, 50);
    enqueueSettlementBoundaries(db, sessionId, 10);
    db.query("UPDATE settlement_jobs SET status = 'done'").run();
    advanceSettlementCursor(db, sessionId, 11);
    expect(enqueueSessionEndSettlementJob(db, sessionId, 12, true)).toBeNull();
  });
});

describe("settlement end to end under a mock model", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function createCore(respond: (prompt: string) => string | null) {
    return createWorkerCore({
      db,
      config: { ...DEFAULT_CONFIG, maxQueuedBatches: 0 },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        const input = args[0] as { sessionDbId: number };
        const queryDeps = args[1] as {
          onMessage?: (message: unknown) => void;
        };
        return {
          sessionId: `agent-${input.sessionDbId}`,
          queryPid: undefined,
          async sendPrompt(prompt: string) {
            const text = respond(prompt);
            if (text !== null) {
              queryDeps.onMessage?.({
                type: "assistant",
                session_id: `agent-${input.sessionDbId}`,
                message: { content: [{ type: "text", text }] },
              });
            }
            return { session_id: `agent-${input.sessionDbId}` };
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });
  }

  test("crossing three boundaries settles all three and lands the grades", async () => {
    const sessionId = seedSession(db, "settle-e2e");
    const ids = seedTurns(db, sessionId, 151, { grade: 3 });
    const boundaries: number[] = [];
    const core = createCore((prompt) => {
      const match = /<settlement session="S\d+" boundary="(\d+)"/.exec(prompt);
      if (!match) {
        return null;
      }
      const boundary = Number(match[1]);
      boundaries.push(boundary);
      // Demote the window's first member, confirm everything else.
      const first = /turnId=(\d+) /.exec(prompt)![1];
      return `[{"turnId": ${first}, "grade": 1}]`;
    });

    await core.flushSession(sessionId);

    expect(boundaries).toEqual([50, 100, 150]);
    expect(listSettlementJobs(db, sessionId).map((job) => job.status)).toEqual([
      "done",
      "done",
      "done",
    ]);
    expect(getSettlementCursor(db, sessionId)).toBe(150);
    // Boundary 50's window starts at turn 1; 100's at 1; 150's at 51.
    expect(getTurnById(db, ids[0]!)!.significanceGrade).toBe(1);
    expect(getTurnById(db, ids[50]!)!.significanceGrade).toBe(1);
    expect(getTurnById(db, ids[150]!)!.significanceGrade).toBe(3);
  });

  test("a rejected batch fails its job, holds the cursor, and stops the pass", async () => {
    const sessionId = seedSession(db, "settle-reject");
    seedTurns(db, sessionId, 100, { grade: 3 });
    const core = createCore(() => '[{"turnId": 1, "grade": 9}]');

    await core.settleSession(sessionId);

    const jobs = listSettlementJobs(db, sessionId);
    expect(jobs.map((job) => [job.boundary, job.status, job.attempts])).toEqual([
      [50, "failed", 1],
      // The later boundary is never attempted while an earlier window is open.
      [100, "pending", 0],
    ]);
    expect(jobs[0]!.lastError).toContain("integer 0-4");
    expect(getSettlementCursor(db, sessionId)).toBe(0);
    // No half-write: every grade is untouched.
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM turns WHERE significance_grade != 3",
        )
        .get()!.count,
    ).toBe(0);
  });

  test("a settle failure is retried on the NEXT pass, one attempt per pass", async () => {
    const sessionId = seedSession(db, "settle-retry");
    seedTurns(db, sessionId, 50, { grade: 3 });
    let responses = 0;
    const core = createCore(() => {
      responses += 1;
      return responses < 3 ? "not json" : "[]";
    });

    await core.settleSession(sessionId);
    expect(listSettlementJobs(db, sessionId)[0]).toMatchObject({
      status: "failed",
      attempts: 1,
    });

    await core.settleSession(sessionId);
    expect(listSettlementJobs(db, sessionId)[0]).toMatchObject({
      status: "failed",
      attempts: 2,
    });

    await core.settleSession(sessionId);
    expect(listSettlementJobs(db, sessionId)[0]).toMatchObject({
      status: "done",
      attempts: 3,
    });
    expect(getSettlementCursor(db, sessionId)).toBe(50);
  });

  test("a SessionEnd tail timeout abandons the settle wait and leaves the job claimed", async () => {
    const sessionId = seedSession(db, "settle-tail-timeout");
    seedTurns(db, sessionId, 50, { grade: 3 });
    let settlePushes = 0;
    let fireTailRace: (() => void) | undefined;
    let fireSettleDeadline: (() => void) | undefined;
    let currentMs = 1_000_000;
    const core = createWorkerCore({
      db,
      config: {
        ...DEFAULT_CONFIG,
        maxQueuedBatches: 0,
        sessionEndTailTimeoutMs: 1_234,
      },
      now: () => Math.floor(currentMs / 1_000),
      nowMs: () => currentMs,
      setTimeoutImpl(callback, delayMs) {
        // Two 1_234ms timers are armed from the SAME deadline: finishSession's
        // outer race first, then the settle wait's own ceiling.
        if (delayMs === 1_234) {
          if (!fireTailRace) {
            fireTailRace = () => void callback();
            return "tail-race";
          }
          fireSettleDeadline = () => void callback();
          return "settle-deadline";
        }
        return setTimeout(() => void callback(), delayMs);
      },
      clearTimeoutImpl(handle) {
        if (handle !== "tail-race" && handle !== "settle-deadline") {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        }
      },
      createWorkerQuerySessionImpl: (() => ({
        sessionId: "settle-agent",
        queryPid: undefined,
        async sendPrompt(prompt: string) {
          if (prompt.startsWith("<settlement ")) {
            settlePushes += 1;
            // The model never answers. Before the settle wait was bounded this
            // held finishSession open past the budget it had just declared.
            return new Promise<never>(() => {});
          }
          return { session_id: "settle-agent" };
        },
        async close() {},
      } satisfies WorkerQuerySession)) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
      logger: { warn() {}, error() {} },
    });

    const finishPromise = core.finishSession(sessionId);
    for (let tick = 0; tick < 200 && !fireSettleDeadline; tick += 1) {
      await Promise.resolve();
    }
    expect(settlePushes).toBe(1);
    expect(fireSettleDeadline).toBeDefined();
    fireSettleDeadline?.();
    await finishPromise;

    // The push never reached the model, so no attempt was spent on a verdict:
    // the row stays claimed for the lease, not marked failed.
    const [job] = listSettlementJobs(db, sessionId);
    expect(job!.status).toBe("claimed");
    expect(job!.attempts).toBe(1);
    expect(job!.lastError).toBeNull();
    expect(getSettlementCursor(db, sessionId)).toBe(0);

    // Nothing else may take it before the lease runs out…
    expect(claimNextSettlementJob(db, sessionId, 1_001, currentMs + 1_000)).toBeNull();
    // …and the reclaim gets a fresh generation, which is what fences the
    // abandoned attempt out if it ever does come back.
    const reclaimed = claimNextSettlementJob(
      db,
      sessionId,
      Math.floor((currentMs + SETTLEMENT_LEASE_MS + 2_000) / 1_000),
      currentMs + SETTLEMENT_LEASE_MS + 2_000,
    );
    expect(reclaimed?.attempts).toBe(2);
    expect(reclaimed?.claimGeneration).toBe(job!.claimGeneration + 1);
  });

  test("the settle prompt reaches the agent as its own message class, envelope-free", async () => {
    const sessionId = seedSession(db, "settle-contract");
    const ids = seedTurns(db, sessionId, 50, { grade: 3 });
    // A pending reminder would ride along on an ordinary work unit and be
    // marked notified on delivery. A settle answers with JSON and acts on no
    // envelope, so it must not consume that notice.
    db.query(
      `UPDATE turns
       SET was_rolled_back = 1,
           tags = '["invalidated:notify-pending:rollback"]'
       WHERE id = ?`,
    ).run(ids[0]!);
    const prompts: string[] = [];
    const core = createCore((prompt) => {
      prompts.push(prompt);
      return "[]";
    });

    await core.settleSession(sessionId);

    expect(prompts.length).toBe(1);
    expect(prompts[0]!.startsWith("<settlement ")).toBe(true);
    expect(prompts[0]).toContain("Do NOT call remember()");
    expect(prompts[0]).not.toContain("<batch>");
    expect(prompts[0]).not.toContain("<reminder>");
    expect(getTurnById(db, ids[0]!)!.tags).toEqual([
      "invalidated:notify-pending:rollback",
    ]);
  });
});
