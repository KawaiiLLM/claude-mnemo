import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { computeSettlementWritableTurnIds } from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";

/**
 * The IMMUTABLE WRITABLE SET (tag-mandate ticket 05, spec "the writable set
 * is IMMUTABLE and declared" + "Anchoring and repairability").
 *
 * The set is what BOTH the settlement facade's range check and the commit
 * gate read, so its shape is load-bearing twice over: too small and a window
 * is pinned on a commit whose repair it is not allowed to make (the
 * terminal-state trap the anchoring rule exists to prevent); too large and
 * one window's settlement acquires write reach over the session's whole
 * citation chain, which contradicts "stock cleans itself window by window".
 * Every test below pins one boundary of that middle.
 */

const NOW = 1_800_000_000;

let db: Database;
let sessionDbId: number;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
  sessionDbId = upsertSession(db, {
    contentSessionId: "settlement-writable-set-session",
    project: "/tmp/project-settlement-writable-set",
    title: "settlement writable-set fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
});

afterEach(() => {
  db.close();
});

function seedTurn(
  promptNumber: number,
  options: { status?: string; wasRolledBack?: boolean } = {},
): number {
  return db
    .query<{ id: number }, [number, number, string, string, string, number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, was_rolled_back
       ) VALUES (?, ?, ?, ?, ?, 3, ?, '["design"]', ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      options.status ?? "active",
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 900 + promptNumber,
      options.wasRolledBack ? 1 : 0,
    )!.id;
}

function edge(citingId: number, citedId: number, relation: string, tags: string[] = []): void {
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: citingId },
        cited: { kind: "turn", id: citedId },
        relation,
        provenance: "asserted",
        ...deriveSideTags(tags),
      },
    ],
    NOW,
  );
}

describe("the deadlock-guard closure", () => {
  test("a cited endpoint OUTSIDE the rendered turns joins the set — the tag repair needs it writable", () => {
    const outside = seedTurn(1);
    const windowTurn = seedTurn(2);
    edge(windowTurn, outside, "extends");

    // The base set is only the rendered turn; the closure is what adds the
    // endpoint whose `tags` an E1 repair (retract + tagged re-add, which the
    // subset invariant requires on BOTH endpoints) has to write.
    expect([...computeSettlementWritableTurnIds(db, [windowTurn])]).toEqual([
      outside,
      windowTurn,
    ]);
  });

  test("closure runs from the whole base set, lookback turns included, not from the window alone", () => {
    const lookbackTarget = seedTurn(1);
    const lookbackTurn = seedTurn(2);
    const windowTurn = seedTurn(3);
    edge(lookbackTurn, lookbackTarget, "narrows");

    // The gate judges errors anchored at lookback turns too, so a lookback
    // turn's own edge endpoint must be as repairable as a window turn's.
    expect([...computeSettlementWritableTurnIds(db, [lookbackTurn, windowTurn])]).toEqual([
      lookbackTarget,
      lookbackTurn,
      windowTurn,
    ]);
  });

  test("ONE HOP only — the added endpoint's own cited turn stays outside", () => {
    const far = seedTurn(1);
    const near = seedTurn(2);
    const windowTurn = seedTurn(3);
    edge(windowTurn, near, "extends");
    edge(near, far, "extends");

    // A fixpoint here would drag the session's transitive citation chain into
    // one window's writable scope. `near`'s own untagged edge stays
    // repairable by retraction, which is always the citing turn's power.
    const writable = computeSettlementWritableTurnIds(db, [windowTurn]);
    expect(writable.has(near)).toBe(true);
    expect(writable.has(far)).toBe(false);
  });

  test("direction matters: an OUTSIDE turn citing a window turn does not become writable", () => {
    const windowTurn = seedTurn(1);
    const outsideCiter = seedTurn(2);
    edge(outsideCiter, windowTurn, "extends");

    // That edge's error anchors at `outsideCiter` — outside the set, so it
    // blocks its OWN window and this run owes it nothing.
    expect([...computeSettlementWritableTurnIds(db, [windowTurn])]).toEqual([windowTurn]);
  });

  test("every relation word closes, not only the two mandated ones", () => {
    const consumed = seedTurn(1);
    const indexed = seedTurn(2);
    const windowTurn = seedTurn(3);
    edge(windowTurn, consumed, "consume");
    edge(windowTurn, indexed, "indexes");

    // E4 repairs touch tagged edges of ANY word, and the checklist's duty 3
    // completes a lane along override/consume/indexes too.
    expect([...computeSettlementWritableTurnIds(db, [windowTurn])]).toEqual([
      consumed,
      indexed,
      windowTurn,
    ]);
  });

  test("dead endpoints never join: a rolled-back or skipped cited turn is not a node", () => {
    const rolledBack = seedTurn(1, { wasRolledBack: true });
    const skipped = seedTurn(2, { status: "skipped" });
    const windowTurn = seedTurn(3);
    edge(windowTurn, rolledBack, "extends");
    edge(windowTurn, skipped, "extends");

    // Law 8 (`db/turn-liveness.ts`): a dead turn is never a node, so it can
    // neither anchor an error nor be required by one — write reach to it
    // would be reach nothing needs.
    expect([...computeSettlementWritableTurnIds(db, [windowTurn])]).toEqual([windowTurn]);
  });

  test("the declared set is ASCENDING and deduplicated — a byte-stable declaration", () => {
    const first = seedTurn(1);
    const second = seedTurn(2);
    const third = seedTurn(3);
    edge(third, first, "extends");
    edge(third, second, "extends");

    // The prompt prints this set (ticket 06); an order that wandered between
    // runs would churn the prompt cache for no semantic change.
    expect([...computeSettlementWritableTurnIds(db, [third, second, third])]).toEqual([
      first,
      second,
      third,
    ]);
  });

  test("a bare citation (no relation) closes nothing", () => {
    const cited = seedTurn(1);
    const windowTurn = seedTurn(2);
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: windowTurn },
          cited: { kind: "turn", id: cited },
          relation: null,
          provenance: "asserted",
          ...deriveSideTags([]),
        },
      ],
      NOW,
    );

    // A bare row carries no relation word, so it can carry no legality
    // verdict either — nothing about it can ever refuse a commit.
    expect([...computeSettlementWritableTurnIds(db, [windowTurn])]).toEqual([windowTurn]);
  });
});
