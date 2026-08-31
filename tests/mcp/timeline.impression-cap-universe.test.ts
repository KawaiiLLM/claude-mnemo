import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  createSegment,
  type SegmentRecord,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { settledMemberCountForLane } from "../../src/mcp/timeline";
import { impressionCapForLane } from "../../src/shared/lane-impressions";

/**
 * Lane-impressions ticket 01 — the CAP-UNIVERSE fixture (spec, peer round-5
 * finding 2): one lane holding settled, unsettled, and rewound members — only
 * the settled canonical era-scoped count feeds the cap. The counting side is
 * `settledMemberCountForLane`, which reads the SAME universe loader the
 * frontier section and lane-adjacency view read (settlement COVERAGE — a
 * `status='done'` window — never the recall content route's member index,
 * which deliberately keeps rewound members visible).
 *
 * Fixture idiom follows tests/mcp/timeline.frontier-section.test.ts.
 */

const BASE_EPOCH = 1_756_700_000;

function makeDb(): Database {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  return db;
}

function makeSession(db: Database, contentSessionId: string): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/projects/impression-cap",
    title: `Session ${contentSessionId}`,
    insight: null,
    createdAtEpoch: BASE_EPOCH,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  }).id;
}

function makeTask(db: Database, title: string, tag: string): SegmentRecord {
  return createSegment(db, { title, tags: [tag], nowEpoch: BASE_EPOCH });
}

interface TurnSpec {
  prompt: number;
  epoch: number;
  tags?: string[];
  status?: string;
  rolledBack?: boolean;
}

function makeTurn(db: Database, sessionId: number, spec: TurnSpec): number {
  return db
    .query<
      { id: number },
      [number, number, string, string, number, number]
    >(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, type, tags, created_at_epoch, was_rolled_back
       ) VALUES (?, ?, ?, 'asked', 'answered', 'probe row', '[]', ?, ?, ?)
       RETURNING id`,
    )
    .get(
      sessionId,
      spec.prompt,
      spec.status ?? "extracted",
      JSON.stringify(spec.tags ?? []),
      spec.epoch,
      spec.rolledBack ? 1 : 0,
    )!.id;
}

/** The settled truth: one COMMITTED (`done`) settlement window. */
function settleWindow(
  db: Database,
  sessionId: number,
  windowStart: number,
  windowEnd: number,
): void {
  db.query(
    `INSERT INTO note_settlement_jobs (
       session_id, window_start, window_end, trigger_type,
       status, attempts, retry_at_epoch, created_at_epoch, updated_at_epoch
     ) VALUES (?, ?, ?, 'consecutive', 'done', 1, 0, ?, ?)`,
  ).run(sessionId, windowStart, windowEnd, BASE_EPOCH, BASE_EPOCH);
}

/**
 * One lane, every member class at once:
 *   - t1, t2  settled   (inside the done window, live, canonical)
 *   - t3      unsettled (a lane member no committed window covers)
 *   - t4      REWOUND   (inside the done window — coverage alone must not count it)
 *   - t5      non-canonical (compact-synthetic tag list, inside the window)
 */
function seedCapUniverse(db: Database) {
  const sessionId = makeSession(db, "cap-universe");
  const task = makeTask(db, "Cap task", "cap-task");
  insertLane(db, task.id, "alpha", BASE_EPOCH);

  const t1 = makeTurn(db, sessionId, { prompt: 1, epoch: BASE_EPOCH + 100, tags: ["alpha"] });
  const t2 = makeTurn(db, sessionId, { prompt: 2, epoch: BASE_EPOCH + 200, tags: ["alpha"] });
  const t3 = makeTurn(db, sessionId, { prompt: 5, epoch: BASE_EPOCH + 500, tags: ["alpha"] });
  const t4 = makeTurn(db, sessionId, {
    prompt: 3,
    epoch: BASE_EPOCH + 300,
    tags: ["alpha"],
    rolledBack: true,
  });
  const t5 = makeTurn(db, sessionId, {
    prompt: 4,
    epoch: BASE_EPOCH + 400,
    tags: ["alpha", "compact:synthetic"],
  });
  addSegmentMembers(db, task.id, [t1, t2, t3, t4, t5], BASE_EPOCH);
  settleWindow(db, sessionId, 1, 4);

  return { sessionId, task, t1, t2, t3, t4, t5 };
}

describe("impression cap universe", () => {
  test("only settled canonical members count: unsettled, rewound and compact-synthetic lane members all stay out of the denominator", () => {
    const db = makeDb();
    const { task } = seedCapUniverse(db);
    expect(settledMemberCountForLane(db, task.id, "alpha", null)).toBe(2);
    db.close();
  });

  test("the post-commit projection adds the committing window's members, deduplicated against the already-settled set", () => {
    const db = makeDb();
    const { task, t1, t3 } = seedCapUniverse(db);
    // The committing window will settle t3.
    expect(settledMemberCountForLane(db, task.id, "alpha", null, [t3])).toBe(3);
    // An id both settled and projected counts once.
    expect(settledMemberCountForLane(db, task.id, "alpha", null, [t1, t3])).toBe(3);
    db.close();
  });

  test("a lane with no settled history counts its projection alone; no members at all floors the cap at 100 with no special case", () => {
    const db = makeDb();
    const { task, t3 } = seedCapUniverse(db);
    insertLane(db, task.id, "brand-new", BASE_EPOCH);
    expect(settledMemberCountForLane(db, task.id, "brand-new", null)).toBe(0);
    expect(impressionCapForLane(0)).toBe(100);
    expect(settledMemberCountForLane(db, task.id, "brand-new", null, [t3])).toBe(1);
    db.close();
  });

  test("the count feeds the ruled integer formula: clamp(10 × settled, 100, 500)", () => {
    const db = makeDb();
    const { task } = seedCapUniverse(db);
    const settled = settledMemberCountForLane(db, task.id, "alpha", null);
    expect(impressionCapForLane(settled)).toBe(100); // 2 members → 20 → floor
    db.close();
  });

  test("the era scope binds: with a cutoff above every member epoch and no grants, nothing counts", () => {
    const db = makeDb();
    const { task } = seedCapUniverse(db);
    const farFuture = BASE_EPOCH + 1_000_000;
    expect(settledMemberCountForLane(db, task.id, "alpha", farFuture)).toBe(0);
    db.close();
  });
});
