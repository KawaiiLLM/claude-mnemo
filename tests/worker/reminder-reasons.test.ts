import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import {
  getReminderItems,
  getSilencedReminderItems,
  markReminderItemsNotified,
  type ReminderItem,
} from "../../src/worker/invalidation";
import { buildReminderEnvelope } from "../../src/worker/server";

function seedTurn(
  db: Database,
  sessionId: number,
  opts: {
    promptNumber: number;
    status?: string;
    title?: string | null;
    content?: string | null;
    wasInterrupted?: 0 | 1;
    wasRolledBack?: 0 | 1;
    tags?: string[];
    epoch?: number;
  },
): void {
  db.query(
    `
      INSERT INTO turns (
        session_id, prompt_number, content_prompt_id, status, user_prompt, title, content,
        was_interrupted, was_rolled_back, tags, created_at_epoch, updated_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    sessionId,
    opts.promptNumber,
    `p${opts.promptNumber}`,
    opts.status ?? "extracted",
    `Prompt ${opts.promptNumber}`,
    opts.title === undefined ? `Title ${opts.promptNumber}` : opts.title,
    opts.content === undefined ? `Content ${opts.promptNumber}` : opts.content,
    opts.wasInterrupted ?? 0,
    opts.wasRolledBack ?? 0,
    JSON.stringify(opts.tags ?? []),
    opts.epoch ?? opts.promptNumber,
    opts.epoch ?? opts.promptNumber,
  );
}

describe("reminder reason registry (D0)", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "content-session-reminder-reasons",
      project: "claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("collects interrupt / rollback / both with status filtering and recency order", () => {
    // active invalidated turn -> excluded by interrupt.qualifies (extracted|skipped only)
    seedTurn(db, sessionId, {
      promptNumber: 1,
      status: "active",
      wasInterrupted: 1,
      tags: ["invalidated:notify-pending:interrupt"],
      epoch: 50,
    });
    seedTurn(db, sessionId, {
      promptNumber: 2,
      status: "extracted",
      wasInterrupted: 1,
      tags: ["invalidated:notify-pending:interrupt"],
      epoch: 10,
    });
    seedTurn(db, sessionId, {
      promptNumber: 3,
      status: "skipped",
      wasRolledBack: 1,
      tags: ["invalidated:notify-pending:rollback"],
      epoch: 20,
    });
    seedTurn(db, sessionId, {
      promptNumber: 4,
      status: "extracted",
      wasInterrupted: 1,
      wasRolledBack: 1,
      tags: [
        "invalidated:notify-pending:interrupt",
        "invalidated:notify-pending:rollback",
      ],
      epoch: 30,
    });

    const items = getReminderItems(db, sessionId);
    // active turn 1 excluded; final display sort is ascending by promptNumber
    expect(items.map((item) => item.promptNumber)).toEqual([2, 3, 4]);

    const both = items.find((item) => item.promptNumber === 4)!;
    expect(both.reasons.map((reason) => reason.key)).toEqual([
      "interrupt",
      "rollback",
    ]);
  });

  test("envelope is byte-identical for interrupt / rollback / both", () => {
    seedTurn(db, sessionId, {
      promptNumber: 2,
      status: "extracted",
      title: "Interrupted title",
      content: "Interrupted content",
      wasInterrupted: 1,
      tags: ["invalidated:notify-pending:interrupt"],
      epoch: 10,
    });
    seedTurn(db, sessionId, {
      promptNumber: 3,
      status: "extracted",
      title: "Rolled-back title",
      content: "Rolled-back content",
      wasRolledBack: 1,
      tags: ["invalidated:notify-pending:rollback"],
      epoch: 20,
    });
    seedTurn(db, sessionId, {
      promptNumber: 4,
      status: "extracted",
      title: "Both title",
      content: "Both content",
      wasInterrupted: 1,
      wasRolledBack: 1,
      tags: [
        "invalidated:notify-pending:interrupt",
        "invalidated:notify-pending:rollback",
      ],
      epoch: 30,
    });

    const envelope = buildReminderEnvelope(getReminderItems(db, sessionId));
    expect(envelope).toBe(
      `<reminder>
  The following turns were invalidated and need one-time attention.
  - T2 (was_interrupted): "Interrupted title" -- Interrupted content
  - T3 (was_rolled_back): "Rolled-back title" -- Rolled-back content
  - T4 (was_interrupted+was_rolled_back): "Both title" -- Both content
</reminder>`,
    );
  });

  test("rollback replacement clause stays inside the parens", () => {
    const item: ReminderItem = {
      turnId: 1,
      promptNumber: 5,
      priorTitle: "Rolled-back title",
      priorContent: "Rolled-back content",
      reasons: [
        {
          key: "rollback",
          pendingTag: "invalidated:notify-pending:rollback",
          notifiedTag: "invalidated:notified:rollback",
          flagToken: "was_rolled_back",
          parenExtra: "replaced by T7",
          bodyLead: null,
          tail: null,
        },
      ],
    };

    expect(buildReminderEnvelope([item])).toBe(
      `<reminder>
  The following turns were invalidated and need one-time attention.
  - T5 (was_rolled_back, replaced by T7): "Rolled-back title" -- Rolled-back content
</reminder>`,
    );
  });

  test("markReminderItemsNotified flips literal tags without promoting status", () => {
    seedTurn(db, sessionId, {
      promptNumber: 2,
      status: "skipped",
      wasRolledBack: 1,
      tags: ["invalidated:notify-pending:rollback"],
    });
    const turnId = getReminderItems(db, sessionId)[0]!.turnId;

    markReminderItemsNotified(db, getReminderItems(db, sessionId), 999);

    const turn = getTurnById(db, turnId)!;
    expect(turn.status).toBe("skipped");
    expect(turn.tags).toEqual(["invalidated:notified:rollback"]);
    expect(getReminderItems(db, sessionId)).toEqual([]);
  });

  test("grammar is reason-agnostic: bodyLead / parenExtra / tail flow through", () => {
    const item: ReminderItem = {
      turnId: 1,
      promptNumber: 9,
      priorTitle: null,
      priorContent: null,
      reasons: [
        {
          key: "fake-reason",
          pendingTag: "fake:notify-pending",
          notifiedTag: "fake:notified",
          flagToken: "custom_flag",
          parenExtra: "extra clause",
          bodyLead: 'prompt="hi there"',
          tail: "a tail note",
        },
      ],
    };

    expect(buildReminderEnvelope([item])).toBe(
      `<reminder>
  The following turns were invalidated and need one-time attention.
  - T9 (custom_flag, extra clause): prompt="hi there" -- a tail note
</reminder>`,
    );
  });

  test("tag namespace isolation: a hyphenated agent topic tag never triggers a reminder", () => {
    // The agent's freeform topic tag `delivery-dropped` (hyphen) must NOT be
    // mistaken for the internal colon-namespaced reminder tag.
    seedTurn(db, sessionId, {
      promptNumber: 1,
      status: "active",
      tags: ["delivery-dropped", "api-delivery"],
    });

    expect(getReminderItems(db, sessionId)).toEqual([]);
    expect(getSilencedReminderItems(db, sessionId)).toEqual([]);
  });
});
