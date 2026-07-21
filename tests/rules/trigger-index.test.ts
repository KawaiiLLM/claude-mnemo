import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createRuleStore } from "../../src/db/rules";
import { initializeSchema } from "../../src/db/schema";
import { type RuleStatus, triggerIndexSchema } from "../../src/rules/schema";
import {
  renderSharedTriggerIndex,
  renderTriggerIndex,
  serializeTriggerIndex,
} from "../../src/rules/trigger-index";

describe("trigger index renderer", () => {
  let db: Database;
  const project = "/projects/mnemo";

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => db.close());

  function seed(
    index: number,
    status: RuleStatus = "provisional",
    lastEvidenceAtEpoch = 100 + index,
    scope = "global",
  ) {
    return createRuleStore(db).create({
      name: `rule-${index}`,
      claim: `条件 ${index} 出现时执行动作 ${index}。`,
      rationale: `原因 ${index}`,
      scope,
      triggerKind: "tool",
      triggerSpec: { kind: "tool", tool: `Tool${index}` },
      status,
      createdAtEpoch: 10 + index,
      lastEvidenceAtEpoch,
    });
  }

  test("renders byte-identical valid JSON for the same settled DB state", () => {
    seed(1, "confirmed");
    seed(2, "provisional");
    seed(3, "confirmed", 999, "/projects/other");
    createRuleStore(db).create({
      name: "digest-rule",
      claim: "形成排他性断言前先检查反例。",
      rationale: "认知规则无机器触发条件。",
      scope: "global",
      triggerKind: "none",
      triggerSpec: null,
      status: "digest_only",
      createdAtEpoch: 20,
      lastEvidenceAtEpoch: 20,
    });

    const first = serializeTriggerIndex(
      renderTriggerIndex(db, { project, createdAtEpoch: 1_000 }),
    );
    const second = serializeTriggerIndex(
      renderTriggerIndex(db, { project, createdAtEpoch: 1_001 }),
    );
    expect(second).toBe(first);
    expect(triggerIndexSchema.parse(JSON.parse(first)).rules.map((rule) => rule.id))
      .toEqual([1, 2]);
  });

  test("evicts the eleventh slot with confirmed before provisional", () => {
    for (let index = 1; index <= 10; index += 1) seed(index);
    const confirmed = seed(11, "confirmed", 1);

    const rendered = renderTriggerIndex(db, {
      project,
      createdAtEpoch: 1_000,
    });
    expect(rendered.rules).toHaveLength(10);
    expect(rendered.rules[0]?.id).toBe(confirmed.id);
    expect(rendered.rules.map(({ id }) => id)).not.toContain(1);
    expect(createRuleStore(db).get(1)?.status).toBe("digest_only");
    expect(createRuleStore(db).listEvents(1)[0]).toMatchObject({
      eventKind: "evicted",
      statusBefore: "provisional",
      statusAfter: "digest_only",
    });
  });

  test("breaks equal-priority ties deterministically by rule id", () => {
    for (let index = 1; index <= 11; index += 1) {
      seed(index, "provisional", 100);
    }
    const rendered = renderTriggerIndex(db, { project, createdAtEpoch: 1_000 });
    expect(rendered.rules.map(({ id }) => id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(createRuleStore(db).get(11)?.status).toBe("digest_only");
  });

  test("restores digest_only when a slot becomes available", () => {
    for (let index = 1; index <= 11; index += 1) seed(index);
    renderTriggerIndex(db, { project, createdAtEpoch: 1_000 });
    const store = createRuleStore(db);
    expect(store.get(1)?.status).toBe("digest_only");

    store.update(11, {
      status: "retired",
      updatedAtEpoch: 1_001,
      event: {
        eventUid: "retire-11",
        eventKind: "status_changed",
        rationale: "superseded",
      },
    });
    const rendered = renderTriggerIndex(db, { project, createdAtEpoch: 1_002 });
    expect(rendered.rules).toHaveLength(10);
    expect(rendered.rules.map(({ id }) => id)).toContain(1);
    expect(store.get(1)?.status).toBe("provisional");
    expect(store.listEvents(1).at(-1)).toMatchObject({
      eventKind: "restored",
      statusBefore: "digest_only",
      statusAfter: "provisional",
    });
  });

  test("shared compilation keeps independent ten-slot pools for each project", () => {
    for (let index = 1; index <= 11; index += 1) {
      seed(index, "provisional", 100 + index, "/projects/alpha");
    }
    for (let index = 12; index <= 22; index += 1) {
      seed(index, "provisional", 100 + index, "/projects/beta");
    }

    const rendered = renderSharedTriggerIndex(db, { createdAtEpoch: 1_000 });
    expect(triggerIndexSchema.parse(rendered)).toEqual(rendered);
    expect(rendered.rules).toHaveLength(20);
    const alpha = rendered.rules.filter(({ scope }) => scope === "/projects/alpha");
    const beta = rendered.rules.filter(({ scope }) => scope === "/projects/beta");
    expect(alpha).toHaveLength(10);
    expect(beta).toHaveLength(10);
    expect(createRuleStore(db).get(1)?.status).toBe("digest_only");
    expect(createRuleStore(db).get(12)?.status).toBe("digest_only");
  });
});
