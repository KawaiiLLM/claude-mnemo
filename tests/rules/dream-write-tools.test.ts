import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createRuleStore, type CreateRuleInput } from "../../src/db/rules";
import { initializeDatabase, initializeSchema } from "../../src/db/schema";
import {
  createDreamRuleWriteTools,
  RULE_CLAIM_SIMILARITY_THRESHOLD,
} from "../../src/rules/dream-write-tools";

function ruleInput(overrides: Partial<CreateRuleInput> = {}): CreateRuleInput {
  return {
    name: "bash-timeout",
    claim: "运行长耗时 Bash 命令前必须设置 timeout。",
    rationale: "避免命令无界等待。",
    scope: "global",
    triggerKind: "tool",
    triggerSpec: {
      kind: "tool",
      tool: "Bash",
      param_absent: "timeout",
    },
    status: "provisional",
    createdAtEpoch: 100,
    ...overrides,
  };
}

function proposalInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "new-rule",
    claim: "运行长耗时 Bash 命令前必须设置 timeout。",
    rationale: "避免命令无界等待。",
    scope: "global",
    trigger_kind: "tool" as const,
    trigger_spec: {
      kind: "tool" as const,
      tool: "Bash",
      param_absent: "timeout",
    },
    ...overrides,
  };
}

describe("dream rule write tools", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => db.close());

  test("rejects a tombstoned similar claim and returns its rejection reason", () => {
    const store = createRuleStore(db);
    const tombstone = store.create(ruleInput());
    store.update(tombstone.id, {
      status: "refuted",
      updatedAtEpoch: 110,
      event: {
        eventUid: "refute-bash-timeout",
        eventKind: "status_changed",
        rationale: "该规则把偶发挂起误判为普遍要求。",
      },
    });

    const result = createDreamRuleWriteTools({ db, now: () => 200 }).proposeRule(
      proposalInput({ claim: "运行长耗时 Bash 命令时必须设置 timeout。" }),
    );

    expect(result).toMatchObject({
      status: "rejected",
      reason: "similar_claim",
      candidates: [{
        id: tombstone.id,
        status: "refuted",
        rejection_reason: "该规则把偶发挂起误判为普遍要求。",
      }],
    });
    if (result.status !== "rejected") throw new Error("expected rejection");
    expect(result.candidates[0]?.similarity).toBeGreaterThan(
      RULE_CLAIM_SIMILARITY_THRESHOLD,
    );
    expect(RULE_CLAIM_SIMILARITY_THRESHOLD).toBeGreaterThan(0);
    expect(store.list()).toHaveLength(1);
  });

  test("rebuilds missing rule FTS rows before searching an existing database", () => {
    const store = createRuleStore(db);
    const existing = store.create(ruleInput());
    db.query("DELETE FROM memory_fts WHERE layer = 'rule'").run();

    initializeDatabase(db);
    const result = createDreamRuleWriteTools({ db, now: () => 200 }).proposeRule(
      proposalInput(),
    );

    expect(result).toMatchObject({
      status: "rejected",
      reason: "similar_claim",
      candidates: [{ id: existing.id }],
    });
  });

  test("uses the same Unicode normalization for rule FTS recall and scoring", () => {
    const store = createRuleStore(db);
    const existing = store.create(ruleInput({
      name: "fullwidth-bash",
      claim: "Ｂａｓｈ commands require timeout.",
    }));

    const result = createDreamRuleWriteTools({ db, now: () => 200 }).proposeRule(
      proposalInput({ claim: "Bash commands require timeout." }),
    );

    expect(result).toMatchObject({
      status: "rejected",
      reason: "similar_claim",
      candidates: [{ id: existing.id, similarity: 1 }],
    });
  });

  test("reports a missing tombstone rejection reason as null", () => {
    const store = createRuleStore(db);
    const tombstone = store.create(ruleInput({ status: "retired" }));

    const result = createDreamRuleWriteTools({ db, now: () => 200 }).proposeRule(
      proposalInput(),
    );

    expect(result).toMatchObject({
      status: "rejected",
      candidates: [{ id: tombstone.id, rejection_reason: null }],
    });
  });

  test("redirects an active similar claim to evidence instead of creating it", () => {
    const store = createRuleStore(db);
    const active = store.create(ruleInput({ status: "confirmed" }));

    const result = createDreamRuleWriteTools({ db, now: () => 200 }).proposeRule(
      proposalInput(),
    );

    expect(result).toMatchObject({
      status: "rejected",
      reason: "similar_claim",
      candidates: [{
        id: active.id,
        status: "confirmed",
        suggested_action: "add_evidence",
      }],
    });
    expect(store.list()).toHaveLength(1);
  });

  test("appends evidence to the active duplicate idempotently", () => {
    const store = createRuleStore(db);
    const active = store.create(ruleInput({ status: "confirmed" }));
    const tools = createDreamRuleWriteTools({ db, now: () => 200 });
    const input = proposalInput({
      add_evidence_to: active.id,
      evidence: [{ ref: "S7/T3", note: "再次验证 timeout 避免挂起。", at: 190 }],
    });

    const first = tools.proposeRule(input);
    const second = tools.proposeRule(input);

    expect(first).toMatchObject({ status: "evidence_added", idempotent: false });
    expect(second).toMatchObject({ status: "evidence_added", idempotent: true });
    expect(store.get(active.id)?.evidence).toEqual(input.evidence);
    expect(store.get(active.id)?.lastEvidenceAtEpoch).toBe(190);
    expect(store.listEvents(active.id).filter(({ eventKind }) =>
      eventKind === "evidence_added"
    )).toHaveLength(1);
  });

  test("creates a distinct proposal and records the explicit distinction idempotently", () => {
    const store = createRuleStore(db);
    const existing = store.create(ruleInput());
    const tools = createDreamRuleWriteTools({ db, now: () => 200 });
    const input = proposalInput({
      name: "bounded-bash-timeout",
      distinct_from: [existing.id],
    });

    const first = tools.proposeRule(input);
    const second = tools.proposeRule(input);

    expect(first).toMatchObject({ status: "created", idempotent: false });
    expect(second).toMatchObject({
      status: "created",
      idempotent: true,
      rule: { id: first.status === "created" ? first.rule.id : -1 },
    });
    expect(store.list()).toHaveLength(2);
    const created = store.list().find((rule) => rule.name === "bounded-bash-timeout")!;
    expect(created.status).toBe("provisional");
    expect(store.listEvents(created.id)).toMatchObject([
      {
        eventKind: "proposed",
        adjustment: { distinct_from: [existing.id] },
      },
    ]);
  });

  test("rejects an exact name match without writing a rule or event", () => {
    const store = createRuleStore(db);
    const existing = store.create(ruleInput());

    const result = createDreamRuleWriteTools({ db, now: () => 200 }).proposeRule(
      proposalInput({ name: existing.name, claim: "完全不同的规则正文。" }),
    );

    expect(result).toMatchObject({
      status: "rejected",
      reason: "exact_name",
      candidates: [{ id: existing.id, name: existing.name }],
    });
    expect(store.list()).toHaveLength(1);
    expect(store.listEvents(existing.id)).toEqual([]);
  });

  test("submits an open-vocabulary judgment once for repeated identical input", () => {
    const store = createRuleStore(db);
    const rule = store.create(ruleInput());
    const hit = store.createEvent({
      eventUid: "hit-1",
      ruleId: rule.id,
      eventKind: "hit",
      createdAtEpoch: 150,
    });
    const tools = createDreamRuleWriteTools({ db, now: () => 200 });
    const input = {
      rule_id: rule.id,
      source_event_id: hit.id,
      label: "helped-by-preventing-a-stall",
      rationale: "提示促使命令设置了有限等待时间。",
      adjustment: { action: "retain", count_delta: 1 },
    };

    const first = tools.submitJudgment(input);
    const second = tools.submitJudgment(input);

    expect(first).toMatchObject({ idempotent: false, event: { label: input.label } });
    expect(second).toMatchObject({
      idempotent: true,
      event: { id: first.event.id },
    });
    expect(store.listEvents(rule.id).filter((event) => event.eventKind === "judgment"))
      .toHaveLength(1);
  });

  test("returns the existing judgment when the same hit is judged differently", () => {
    const store = createRuleStore(db);
    const rule = store.create(ruleInput());
    const hit = store.createEvent({
      eventUid: "hit-conflict",
      ruleId: rule.id,
      eventKind: "hit",
      createdAtEpoch: 150,
    });
    const tools = createDreamRuleWriteTools({ db, now: () => 200 });

    const first = tools.submitJudgment({
      rule_id: rule.id,
      source_event_id: hit.id,
      label: "helpful",
      rationale: "提示对结果产生了正面作用。",
      adjustment: { status: "confirmed" },
    });
    const conflicting = tools.submitJudgment({
      rule_id: rule.id,
      source_event_id: hit.id,
      label: "harmful",
      rationale: "提示导致了负面结果。",
      adjustment: { status: "refuted" },
    });

    expect(first).toMatchObject({
      status: "recorded",
      idempotent: false,
      event: { label: "helpful" },
      rule: { status: "confirmed" },
    });
    expect(conflicting).toMatchObject({
      status: "conflict",
      idempotent: false,
      event_uid: first.event_uid,
      event: { id: first.event.id, label: "helpful" },
      rule: { id: rule.id, status: "confirmed" },
    });
    expect(store.get(rule.id)?.status).toBe("confirmed");
    expect(store.listEvents(rule.id).filter((event) => event.eventKind === "judgment"))
      .toHaveLength(1);
  });

  test("records status_before and status_after when adjustment changes status", () => {
    const store = createRuleStore(db);
    const rule = store.create(ruleInput());
    const hit = store.createEvent({
      eventUid: "hit-status",
      ruleId: rule.id,
      eventKind: "hit",
      createdAtEpoch: 150,
    });

    const tools = createDreamRuleWriteTools({ db, now: () => 200 });
    const input = {
      rule_id: rule.id,
      source_event_id: hit.id,
      label: "harmful",
      rationale: "提示在该场景导致不必要的提前终止。",
      adjustment: {
        action: "refute",
        status: "refuted",
        claim_before: rule.claim,
      },
    };

    const result = tools.submitJudgment(input);
    const retried = tools.submitJudgment(input);

    expect(store.get(rule.id)?.status).toBe("refuted");
    expect(result.event).toMatchObject({
      eventKind: "judgment",
      sourceEventId: hit.id,
      statusBefore: "provisional",
      statusAfter: "refuted",
      adjustment: input.adjustment,
    });
    expect(retried).toMatchObject({ idempotent: true, event: { id: result.event.id } });
    expect(store.listEvents(rule.id).filter((event) => event.eventKind === "judgment"))
      .toHaveLength(1);
  });

  test("requires rationale and an object-shaped adjustment", () => {
    const tools = createDreamRuleWriteTools({ db, now: () => 200 });
    expect(() => tools.submitJudgment({
      rule_id: 1,
      source_event_id: 1,
      label: "anything",
      rationale: "",
    })).toThrow();
    expect(() => tools.submitJudgment({
      rule_id: 1,
      source_event_id: 1,
      label: "anything",
      rationale: "required",
      adjustment: ["not", "an", "object"],
    })).toThrow();
  });
});
