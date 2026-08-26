import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  computeSettlementWritableTurnIds,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  buildNoteSettlementContext,
  resolveSettlementScopeProvenance,
  type NoteSettlementContext,
} from "../../src/worker/note-settlement-context";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Settlement-ergonomics ticket 04 (spec D0) — `resolveSettlementScopeProvenance`
 * carves the flat writable set (`computeSettlementWritableTurnIds`' own
 * output) into three FROZEN, MUTUALLY EXCLUSIVE id sets: `window`,
 * `baseLookback`, `closureOnly`. Every test here pins one of the properties
 * the ticket names — union equals the flat set, no two buckets overlap, and
 * a dual-membership turn resolves by precedence rather than by which check
 * happens to run last.
 */

const NOW = 1_800_000_000;

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

function seedSession(): number {
  return upsertSession(db, {
    contentSessionId: "settlement-context-scope-session",
    project: "/tmp/project-settlement-context-scope",
    title: "settlement scope-provenance fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(sessionDbId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, ?, 'active', ?, ?, 2, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
    )!.id;
}

function edge(citingId: number, citedId: number, relation: string): void {
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: citingId },
        cited: { kind: "turn", id: citedId },
        relation,
        provenance: "asserted",
        ...deriveSideTags([]),
      },
    ],
    NOW,
  );
}

function claimWindow(sessionDbId: number, start: number, end: number): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: start, windowEnd: end, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job;
}

describe("resolveSettlementScopeProvenance", () => {
  test("three buckets are mutually exclusive and their union is the flat writable set", () => {
    const sessionDbId = seedSession();
    for (let promptNumber = 1; promptNumber <= 12; promptNumber += 1) {
      seedTurn(sessionDbId, promptNumber);
    }
    // Window T9..T12 (4 turns) -> lookback defaults to the same size, so the
    // rendered lookback is T5..T8 (priorFloor = max(1, 9-4) = 5).
    const window10 = db.query<{ id: number }, [number, number]>(
      "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
    ).get(sessionDbId, 10)!.id;
    const window11 = db.query<{ id: number }, [number, number]>(
      "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
    ).get(sessionDbId, 11)!.id;
    const lookback6 = db.query<{ id: number }, [number, number]>(
      "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
    ).get(sessionDbId, 6)!.id;
    const lookback7 = db.query<{ id: number }, [number, number]>(
      "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
    ).get(sessionDbId, 7)!.id;
    const outside1 = db.query<{ id: number }, [number, number]>(
      "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
    ).get(sessionDbId, 1)!.id;
    const outside2 = db.query<{ id: number }, [number, number]>(
      "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
    ).get(sessionDbId, 2)!.id;

    // A window turn citing INTO the rendered lookback: T6 is already a base
    // member (priorTurns), so this must NOT create a second, closure-derived
    // route into the set — it is the realistic "lookback turn that is also
    // an edge's external endpoint" case the ticket names.
    edge(window10, lookback6, "extends");
    // A window turn citing OUTSIDE both window and lookback: T2 can only
    // enter the writable set through the deadlock-guard closure.
    edge(window11, outside2, "extends");
    // A LOOKBACK turn (part of the base set too) citing outside: closure runs
    // from the whole base, not the window alone, so T1 also closes in.
    edge(lookback7, outside1, "narrows");

    const job = claimWindow(sessionDbId, 9, 12);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const writableTurnIds = computeSettlementWritableTurnIds(db, context.reviewableTurnIds);

    const provenance = resolveSettlementScopeProvenance(context, writableTurnIds);

    expect(provenance.window).toEqual(new Set([9, 10, 11, 12].map((n) =>
      db.query<{ id: number }, [number, number]>(
        "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
      ).get(sessionDbId, n)!.id,
    )));
    expect(provenance.baseLookback).toEqual(new Set([5, 6, 7, 8].map((n) =>
      db.query<{ id: number }, [number, number]>(
        "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
      ).get(sessionDbId, n)!.id,
    )));
    expect(provenance.closureOnly).toEqual(new Set([outside1, outside2]));

    // Mutual exclusion: no id sits in more than one bucket.
    for (const id of provenance.window) {
      expect(provenance.baseLookback.has(id)).toBe(false);
      expect(provenance.closureOnly.has(id)).toBe(false);
    }
    for (const id of provenance.baseLookback) {
      expect(provenance.closureOnly.has(id)).toBe(false);
    }

    // Union equals the flat set today's code already produces — the property
    // that proves the three-way split widened nothing.
    const union = new Set([
      ...provenance.window,
      ...provenance.baseLookback,
      ...provenance.closureOnly,
    ]);
    expect(union).toEqual(new Set(writableTurnIds));
    expect(
      provenance.window.size + provenance.baseLookback.size + provenance.closureOnly.size,
    ).toBe(writableTurnIds.size);
  });

  test("precedence: window claims a dual-membership turn before base-lookback does", () => {
    const sessionDbId = seedSession();
    const windowTurn = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;

    // Real windows and their own lookback never share a turn id (disjoint
    // prompt-number ranges within one session) — this scenario is
    // synthesized by overriding `priorTurns` to also claim the window's own
    // turn, so the precedence RULE is pinned even though today's builder
    // never produces the overlap itself.
    const dualMembershipContext: NoteSettlementContext = {
      ...context,
      priorTurns: [...context.priorTurns, context.windowTurns[0]!],
    };
    const writableTurnIds = new Set([windowTurn]);

    const provenance = resolveSettlementScopeProvenance(dualMembershipContext, writableTurnIds);

    expect(provenance.window).toEqual(new Set([windowTurn]));
    expect(provenance.baseLookback.has(windowTurn)).toBe(false);
    expect(provenance.closureOnly.has(windowTurn)).toBe(false);
  });
});
