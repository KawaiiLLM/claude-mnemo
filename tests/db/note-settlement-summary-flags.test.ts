import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { computeSettlementSummaryFlags } from "../../src/db/note-settlement-summary-flags";
import { initializeSchema } from "../../src/db/schema";
import { createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

/**
 * Ticket 08 (ADR-0004's flagging half). `computeSettlementSummaryFlags` is a
 * mechanical, read-only check — not a model duty — run after commit over
 * the window's own material. Two heuristics: a non-empty content/insight
 * carrying no citation at all ("citation-less"), and a citation naming a
 * turn superseded by a member of THIS window ("cited-turn-superseded").
 * Scope is content/insight only (the summary layer) — never the six
 * Working State fields.
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
    contentSessionId: "settlement-summary-flags-session",
    project: "/tmp/project-settlement-summary-flags",
    title: "settlement summary flags fixture",
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
       ) VALUES (?, ?, 'active', ?, ?, 3, ?)
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

describe("computeSettlementSummaryFlags — scope", () => {
  test("an empty content/insight is not a claim and is never flagged", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });

    expect(computeSettlementSummaryFlags(db, [segment.id], new Set([t1]))).toEqual([]);
  });

  test("an unattached segment id is silently skipped, not an error", () => {
    const t1 = seedTurn(seedSession(), 1);
    expect(computeSettlementSummaryFlags(db, [99999], new Set([t1]))).toEqual([]);
  });

  test("the six Working State fields are never scanned, only content/insight (the summary layer)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const segment = createSegment(db, {
      title: "chapter",
      content: null,
      insight: null,
      nowEpoch: NOW,
    });
    // A citation-less Working State row would be a flag candidate under a
    // scope that (wrongly) included it; this proves it plays no part.
    db.query<unknown, [string, number]>(
      "UPDATE segments SET goal = ? WHERE id = ?",
    ).run("- ship the thing", segment.id);

    expect(computeSettlementSummaryFlags(db, [segment.id], new Set([t1]))).toEqual([]);
  });
});

describe("computeSettlementSummaryFlags — citation-less claims", () => {
  test("flags a non-empty content with no citation at all", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const segment = createSegment(db, {
      title: "chapter",
      content: "Revision complete and verified.",
      nowEpoch: NOW,
    });

    const flags = computeSettlementSummaryFlags(db, [segment.id], new Set([t1]));
    expect(flags).toEqual([{ segmentId: segment.id, field: "content", reason: "citation-less" }]);
  });

  test("flags insight independently of content", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const segment = createSegment(db, {
      title: "chapter",
      content: `Fenced it. [S${sessionDbId}/T1]`,
      insight: "The generation check always wins.",
      nowEpoch: NOW,
    });

    const flags = computeSettlementSummaryFlags(db, [segment.id], new Set([t1]));
    expect(flags).toEqual([{ segmentId: segment.id, field: "insight", reason: "citation-less" }]);
  });

  test("a cited content is not flagged as citation-less", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const segment = createSegment(db, {
      title: "chapter",
      content: `Fenced it. [S${sessionDbId}/T1]`,
      nowEpoch: NOW,
    });

    expect(computeSettlementSummaryFlags(db, [segment.id], new Set([t1]))).toEqual([]);
  });
});

describe("computeSettlementSummaryFlags — a cited turn superseded within this window", () => {
  test("flags content citing a turn that a WINDOW member superseded", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1); // the cited, now-overturned turn
    const t2 = seedTurn(sessionDbId, 2); // the window member that overturns it
    const segment = createSegment(db, {
      title: "chapter",
      content: `The lease approach works. [S${sessionDbId}/T1]`,
      nowEpoch: NOW,
    });
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t2 },
          cited: { kind: "turn", id: t1 },
          relation: "supersedes",
          provenance: "judged",
        },
      ],
      NOW,
      { eligibleForRelation: "unrestricted" },
    );

    const flags = computeSettlementSummaryFlags(db, [segment.id], new Set([t2]));
    expect(flags).toEqual([
      {
        segmentId: segment.id,
        field: "content",
        reason: "cited-turn-superseded",
        citedRef: `[S${sessionDbId}/T1]`,
      },
    ]);
  });

  test("a supersedes edge OUTSIDE this window's member set does not flag — only this window's own finding counts", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const segment = createSegment(db, {
      title: "chapter",
      content: `The lease approach works. [S${sessionDbId}/T1]`,
      nowEpoch: NOW,
    });
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t2 },
          cited: { kind: "turn", id: t1 },
          relation: "supersedes",
          provenance: "judged",
        },
      ],
      NOW,
      { eligibleForRelation: "unrestricted" },
    );

    // windowTurnIds does NOT include t2 — an earlier window's own
    // supersession, already flaggable by an earlier settlement pass.
    expect(computeSettlementSummaryFlags(db, [segment.id], new Set([t1]))).toEqual([]);
  });

  test("a non-supersedes relation on the cited turn does not flag", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const segment = createSegment(db, {
      title: "chapter",
      content: `The lease approach works. [S${sessionDbId}/T1]`,
      nowEpoch: NOW,
    });
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t2 },
          cited: { kind: "turn", id: t1 },
          relation: "depends-on",
          provenance: "judged",
        },
      ],
      NOW,
      { eligibleForRelation: "unrestricted" },
    );

    expect(computeSettlementSummaryFlags(db, [segment.id], new Set([t2]))).toEqual([]);
  });
});
