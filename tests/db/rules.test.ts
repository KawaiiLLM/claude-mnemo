import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createRuleStore, type CreateRuleInput } from "../../src/db/rules";
import { initializeSchema } from "../../src/db/schema";

function ruleInput(overrides: Partial<CreateRuleInput> = {}): CreateRuleInput {
  return {
    name: "bash-timeout",
    claim: "运行长耗时 Bash 命令前必须设置 timeout。",
    rationale: "防止工具调用无限挂起。",
    scope: "global",
    triggerKind: "tool",
    triggerSpec: {
      kind: "tool",
      tool: "Bash",
      param_absent: "timeout",
      command_prefix: ["npm test", "bun test"],
    },
    status: "provisional",
    evidence: [{ ref: "S1/T2", note: "曾发生挂起", at: 100 }],
    createdAtEpoch: 100,
    ...overrides,
  };
}

describe("RuleStore", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => db.close());

  test("migrates the unified rules and rule_events ledger", () => {
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);
    expect(tables).toContain("rules");
    expect(tables).toContain("rule_events");

    const eventColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(rule_events)")
      .all()
      .map(({ name }) => name);
    expect(eventColumns).toEqual([
      "id",
      "event_uid",
      "rule_id",
      "event_kind",
      "source_event_id",
      "turn_ref",
      "label",
      "rationale",
      "adjustment_json",
      "status_before",
      "status_after",
      "created_at_epoch",
    ]);

    const judgmentIndex = db.query<{ sql: string }, []>(
      `SELECT sql FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_rule_events_one_judgment_per_hit'`,
    ).get();
    expect(judgmentIndex?.sql).toContain(
      "ON rule_events(source_event_id) WHERE event_kind = 'judgment'",
    );
    expect(() => initializeSchema(db)).not.toThrow();
    expect(db.query<{ count: number }, []>(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_rule_events_one_judgment_per_hit'`,
    ).get()?.count).toBe(1);
  });

  test("creates, reads, updates, and lists rules and unified events", () => {
    const store = createRuleStore(db);
    const created = store.create(ruleInput());
    expect(store.get(created.id)).toEqual(created);
    expect(store.list()).toEqual([created]);

    const updated = store.update(created.id, {
      claim: "运行可能挂起的 Bash 命令前必须设置 timeout。",
      status: "confirmed",
      updatedAtEpoch: 200,
      event: {
        eventUid: "confirm-1",
        eventKind: "status_changed",
        rationale: "证据充分",
      },
    });
    expect(updated.status).toBe("confirmed");
    expect(store.listEvents(created.id)).toMatchObject([
      {
        eventUid: "confirm-1",
        eventKind: "status_changed",
        statusBefore: "provisional",
        statusAfter: "confirmed",
        rationale: "证据充分",
        createdAtEpoch: 200,
      },
    ]);

    const hit = store.createEvent({
      eventUid: "hit-1",
      ruleId: created.id,
      eventKind: "hit",
      turnRef: "T42",
      adjustment: { input: "bun test" },
      createdAtEpoch: 201,
    });
    const judgment = store.createEvent({
      eventUid: "judgment-1",
      ruleId: created.id,
      eventKind: "judgment",
      sourceEventId: hit.id,
      label: "helpful",
      rationale: "避免了无界等待",
      adjustment: { action: "retain" },
      createdAtEpoch: 202,
    });
    expect(judgment.sourceEventId).toBe(hit.id);
    expect(judgment.adjustment).toEqual({ action: "retain" });
    expect(() => store.createEvent({
      eventUid: "judgment-2",
      ruleId: created.id,
      eventKind: "judgment",
      sourceEventId: hit.id,
      label: "harmful",
      rationale: "conflicts with the first judgment",
      createdAtEpoch: 203,
    })).toThrow();
    expect(() => store.createEvent({
      eventUid: "hit-1",
      ruleId: created.id,
      eventKind: "hit",
      createdAtEpoch: 204,
    })).toThrow();
  });

  test("requires an event for every status change", () => {
    const store = createRuleStore(db);
    const rule = store.create(ruleInput());
    expect(() =>
      store.update(rule.id, { status: "retired", updatedAtEpoch: 200 }),
    ).toThrow("status changes require a rule event");
    expect(store.get(rule.id)?.status).toBe("provisional");
  });

  test("makes rules and their event ledger non-deletable", () => {
    const store = createRuleStore(db);
    const rule = store.create(ruleInput({ status: "refuted" }));
    const event = store.createEvent({
      eventUid: "refuted-1",
      ruleId: rule.id,
      eventKind: "status_changed",
      statusBefore: "provisional",
      statusAfter: "refuted",
      createdAtEpoch: 101,
    });

    expect(() => db.query("DELETE FROM rules WHERE id = ?").run(rule.id)).toThrow(
      "rules are append-only",
    );
    expect(() =>
      db.query("DELETE FROM rule_events WHERE id = ?").run(event.id),
    ).toThrow("rule_events is append-only");
    expect(() =>
      db.query("UPDATE rule_events SET label = 'changed' WHERE id = ?").run(event.id),
    ).toThrow("rule_events is append-only");
  });

  test("validates all three trigger_spec shapes and applies prompt defaults", () => {
    const store = createRuleStore(db);
    const prompt = store.create(
      ruleInput({
        name: "cost-attribution",
        triggerKind: "prompt",
        triggerSpec: { kind: "prompt", keywords: ["成本异常", "cost"] },
      }),
    );
    expect(prompt.triggerSpec).toEqual({
      kind: "prompt",
      keywords: ["成本异常", "cost"],
      match: "any",
    });

    const result = store.create(
      ruleInput({
        name: "connection-reset",
        triggerKind: "result",
        triggerSpec: {
          kind: "result",
          tool: "Bash",
          patterns: ["ECONNRESET", "connection reset"],
        },
      }),
    );
    expect(result.triggerSpec?.kind).toBe("result");

    const digest = store.create(
      ruleInput({
        name: "exclusive-claim",
        triggerKind: "none",
        triggerSpec: null,
        status: "digest_only",
      }),
    );
    expect(digest.triggerSpec).toBeNull();
  });

  test.each([
    ["prompt keyword count", { triggerKind: "prompt", triggerSpec: { kind: "prompt", keywords: Array(9).fill("valid") } }],
    ["prompt keyword length", { triggerKind: "prompt", triggerSpec: { kind: "prompt", keywords: ["ab"] } }],
    ["tool prefix count", { triggerSpec: { kind: "tool", tool: "Bash", command_prefix: ["a", "b", "c", "d", "e"] } }],
    ["result pattern count", { triggerKind: "result", triggerSpec: { kind: "result", patterns: ["a", "b", "c", "d", "e"] } }],
    ["result pattern length", { triggerKind: "result", triggerSpec: { kind: "result", patterns: ["x".repeat(65)] } }],
    ["kind mismatch", { triggerKind: "prompt", triggerSpec: { kind: "result", patterns: ["error"] } }],
    ["unknown field", { triggerSpec: { kind: "tool", tool: "Bash", regex: ".*" } }],
    ["none with spec", { triggerKind: "none", triggerSpec: { kind: "tool", tool: "Bash" } }],
    ["trigger_spec byte cap", { triggerSpec: { kind: "tool", tool: "Bash", path_glob: `/${"界".repeat(400)}` } }],
  ] as const)("rejects invalid trigger_spec: %s", (_label, override) => {
    const store = createRuleStore(db);
    expect(() => store.create(ruleInput(override as Partial<CreateRuleInput>))).toThrow();
  });

  test("enforces rule identity, content, scope, and epoch conventions", () => {
    const store = createRuleStore(db);
    expect(() => store.create(ruleInput({ name: "Not_Kebab" }))).toThrow();
    expect(() => store.create(ruleInput({ claim: "x".repeat(301) }))).toThrow();
    expect(() => store.create(ruleInput({ scope: "relative/project" }))).toThrow();
    expect(() => store.create(ruleInput({ createdAtEpoch: 1.5 }))).toThrow();
  });

  test("the migration rejects trigger specs that bypass the store", () => {
    const insert = (triggerSpec: string) =>
      db.query(
        `INSERT INTO rules (
           name, claim, rationale, scope, trigger_kind, trigger_spec, status,
           created_at_epoch, updated_at_epoch, last_evidence_at_epoch
         ) VALUES ('direct-rule', 'claim', 'why', 'global', 'prompt', ?,
                   'provisional', 1, 1, 1)`,
      ).run(triggerSpec);

    expect(() =>
      insert(JSON.stringify({ kind: "prompt", keywords: ["ab"] })),
    ).toThrow("invalid trigger_spec");
    expect(() =>
      insert(JSON.stringify({ keywords: ["valid"] })),
    ).toThrow("invalid trigger_spec");
    expect(() =>
      insert(JSON.stringify({ kind: null, keywords: ["valid"] })),
    ).toThrow("invalid trigger_spec");
    expect(() =>
      insert(
        JSON.stringify({ kind: "prompt", keywords: ["valid"], match: null }),
      ),
    ).toThrow("invalid trigger_spec");
    expect(() =>
      insert(JSON.stringify({ kind: "prompt" })),
    ).toThrow("invalid trigger_spec");
    expect(() =>
      insert(
        JSON.stringify({
          kind: "prompt",
          keywords: ["valid"],
          regex: ".*",
        }),
      ),
    ).toThrow("invalid trigger_spec");
    expect(() =>
      insert(
        JSON.stringify({
          kind: "prompt",
          keywords: ["界".repeat(1_100)],
        }),
      ),
    ).toThrow("invalid trigger_spec");
  });

  test("only judgments may link to a same-rule hit", () => {
    const store = createRuleStore(db);
    const first = store.create(ruleInput());
    const second = store.create(ruleInput({ name: "second-rule" }));
    const hit = store.createEvent({
      eventUid: "source-hit",
      ruleId: first.id,
      eventKind: "hit",
      createdAtEpoch: 101,
    });

    expect(() =>
      store.createEvent({
        eventUid: "invalid-hit-link",
        ruleId: first.id,
        eventKind: "hit",
        sourceEventId: hit.id,
        createdAtEpoch: 102,
      }),
    ).toThrow("only valid for judgment");
    expect(() =>
      store.createEvent({
        eventUid: "missing-judgment-link",
        ruleId: first.id,
        eventKind: "judgment",
        createdAtEpoch: 102,
      }),
    ).toThrow("require sourceEventId");
    expect(() =>
      store.createEvent({
        eventUid: "cross-rule-judgment-link",
        ruleId: second.id,
        eventKind: "judgment",
        sourceEventId: hit.id,
        createdAtEpoch: 102,
      }),
    ).toThrow("same rule");
  });
});
