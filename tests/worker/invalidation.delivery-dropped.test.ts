import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import {
  DELIVERY_DROPPED_NOTIFIED_TAG,
  DELIVERY_DROPPED_PENDING_TAG,
  flagDeliveryDropped,
  getReminderItems,
  markReminderItemsNotified,
} from "../../src/worker/invalidation";
import { buildReminderEnvelope } from "../../src/worker/server";

function seedTurn(
  db: Database,
  sessionId: number,
  opts: {
    promptNumber: number;
    status: string;
    title?: string | null;
    content?: string | null;
    userPrompt?: string;
    wasRolledBack?: 0 | 1;
    tags?: string[];
    epoch?: number;
  },
): number {
  return db
    .query<{ id: number }, []>(
      `
        INSERT INTO turns (
          session_id, prompt_number, content_prompt_id, status, user_prompt, title, content,
          was_interrupted, was_rolled_back, tags, created_at_epoch, updated_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        RETURNING id
      `,
    )
    .get(
      sessionId,
      opts.promptNumber,
      `p${opts.promptNumber}`,
      opts.status,
      opts.userPrompt ?? `Prompt ${opts.promptNumber}`,
      opts.title === undefined ? `Title ${opts.promptNumber}` : opts.title,
      opts.content === undefined ? `Content ${opts.promptNumber}` : opts.content,
      opts.wasRolledBack ?? 0,
      JSON.stringify(opts.tags ?? []),
      opts.epoch ?? opts.promptNumber,
      opts.epoch ?? opts.promptNumber,
    )!.id;
}

describe("delivery-dropped reminder reason (D9)", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "content-session-delivery-dropped",
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

  test("flagDeliveryDropped keeps an active turn active (no auto-promotion)", () => {
    const turnId = seedTurn(db, sessionId, {
      promptNumber: 7,
      status: "active",
      title: null,
      content: null,
      userPrompt: "Run /goal migration",
    });

    flagDeliveryDropped(db, turnId, 100);

    const turn = getTurnById(db, turnId)!;
    expect(turn.status).toBe("active");
    expect(turn.tags).toContain(DELIVERY_DROPPED_PENDING_TAG);
  });

  test("reminder renders a not-yet-extracted line with a prompt and no count", () => {
    const turnId = seedTurn(db, sessionId, {
      promptNumber: 7,
      status: "active",
      title: null,
      content: null,
      userPrompt: "Run /goal migration",
    });
    flagDeliveryDropped(db, turnId, 100);

    const envelope = buildReminderEnvelope(getReminderItems(db, sessionId));
    expect(envelope).toContain(
      `- T${turnId} (delivery_dropped, not yet extracted): prompt="Run /goal migration" -- one or more parts of this turn could not be delivered; record intent if possible`,
    );
    expect(envelope).not.toMatch(/\d+ parts/);
  });

  test("reminder renders a partially-extracted line with title and no count", () => {
    const turnId = seedTurn(db, sessionId, {
      promptNumber: 7,
      status: "extracted",
      title: "Migrate goal pipeline",
      content: "Did the thing",
    });
    flagDeliveryDropped(db, turnId, 100);

    const envelope = buildReminderEnvelope(getReminderItems(db, sessionId));
    expect(envelope).toContain(
      `- T${turnId} (delivery_dropped): "Migrate goal pipeline" -- record may be incomplete, one or more parts could not be delivered after repeated failures`,
    );
  });

  test("excludes undone turns", () => {
    const turnId = seedTurn(db, sessionId, {
      promptNumber: 7,
      status: "undone",
      tags: [DELIVERY_DROPPED_PENDING_TAG],
    });
    void turnId;
    expect(getReminderItems(db, sessionId)).toEqual([]);
  });

  test("markReminderItemsNotified flips the delivery tag and stops re-sending", () => {
    const turnId = seedTurn(db, sessionId, {
      promptNumber: 7,
      status: "extracted",
      tags: [DELIVERY_DROPPED_PENDING_TAG],
    });

    markReminderItemsNotified(db, getReminderItems(db, sessionId), 200);

    const turn = getTurnById(db, turnId)!;
    expect(turn.tags).toEqual([DELIVERY_DROPPED_NOTIFIED_TAG]);
    expect(getReminderItems(db, sessionId)).toEqual([]);
  });

  test("content-less provisional turn dropped → shows prompt + not yet extracted", () => {
    const turnId = seedTurn(db, sessionId, {
      promptNumber: 8,
      status: "provisional",
      title: null,
      content: null,
      userPrompt: "Run /goal migration provisional",
    });
    flagDeliveryDropped(db, turnId, 100);

    const envelope = buildReminderEnvelope(getReminderItems(db, sessionId));
    expect(envelope).toContain("not yet extracted");
    expect(envelope).toContain(`prompt="Run /goal migration provisional"`);
    expect(envelope).toContain(
      "one or more parts of this turn could not be delivered; record intent if possible",
    );
  });

  test("provisional turn WITH content dropped → shows record may be incomplete (no prompt)", () => {
    const turnId = seedTurn(db, sessionId, {
      promptNumber: 9,
      status: "provisional",
      title: "Partial Title",
      content: null,
      userPrompt: "Run /goal migration with title",
    });
    flagDeliveryDropped(db, turnId, 100);

    const envelope = buildReminderEnvelope(getReminderItems(db, sessionId));
    expect(envelope).toContain("record may be incomplete");
    expect(envelope).not.toContain("not yet extracted");
    expect(envelope).not.toContain(`prompt="`);
  });

  test("content-less skipped turn dropped → NOT not-yet-extracted (deliberately closed)", () => {
    const turnId = seedTurn(db, sessionId, {
      promptNumber: 10,
      status: "skipped",
      title: null,
      content: null,
      userPrompt: "trivial confirmation",
    });
    flagDeliveryDropped(db, turnId, 100);

    const envelope = buildReminderEnvelope(getReminderItems(db, sessionId));
    expect(envelope).not.toContain("not yet extracted");
    expect(envelope).not.toContain(`prompt="`);
  });

  test("content-less failed turn dropped → NOT not-yet-extracted (terminal)", () => {
    const turnId = seedTurn(db, sessionId, {
      promptNumber: 11,
      status: "failed",
      title: null,
      content: null,
      userPrompt: "derailed turn",
    });
    flagDeliveryDropped(db, turnId, 100);

    const envelope = buildReminderEnvelope(getReminderItems(db, sessionId));
    expect(envelope).not.toContain("not yet extracted");
    expect(envelope).not.toContain(`prompt="`);
  });

  test("delivery-dropped and rollback on the same turn merge into one line", () => {
    seedTurn(db, sessionId, {
      promptNumber: 7,
      status: "extracted",
      title: "Rolled and dropped",
      content: "partial",
      wasRolledBack: 1,
      tags: [
        "invalidated:notify-pending:rollback",
        DELIVERY_DROPPED_PENDING_TAG,
      ],
    });

    const items = getReminderItems(db, sessionId);
    expect(items).toHaveLength(1);
    expect(items[0]!.reasons.map((reason) => reason.key)).toEqual([
      "rollback",
      "delivery-dropped",
    ]);

    const envelope = buildReminderEnvelope(items);
    expect(envelope).toContain("was_rolled_back+delivery_dropped");
    // both the rollback flag and the delivery-dropped tail survive the merge
    expect(envelope).toContain("could not be delivered");
  });
});
