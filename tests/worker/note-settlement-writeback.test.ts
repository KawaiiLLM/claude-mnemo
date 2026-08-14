import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getShadowNote } from "../../src/db/shadow-notes";
import { getTurnById } from "../../src/db/turns";
import { applyNoteSettlementWriteBack } from "../../src/worker/note-settlement-writeback";
import type { NoteSettlementResponse } from "../../src/worker/note-settlement-response";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Ticket 02 (spec D7/D8) — the mechanical backfill's write path. It must draft
 * a reconstructed note's turn exactly as `note.ts`'s agent-written path does:
 * same title, same derivation, same columns. This does not re-cover the rest
 * of `applyNoteSettlementWriteBack` (segments, edges, the gap-coverage guard —
 * untested elsewhere and out of this ticket's scope); it isolates the one
 * behaviour this ticket adds.
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
    contentSessionId: "settlement-writeback-session",
    project: "/tmp/project-settlement-writeback",
    title: "settlement writeback fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedHoleTurn(sessionDbId: number, promptNumber: number): number {
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

function claimWindow(
  sessionDbId: number,
  windowStart: number,
  windowEnd: number,
): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart, windowEnd, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job;
}

function emptyResponse(
  reconstructedNotes: NoteSettlementResponse["reconstructedNotes"],
): NoteSettlementResponse {
  return {
    segments: [],
    edges: [],
    reconstructedNotes,
    sessionSummary: null,
  };
}

test("a mechanical reconstruction drafts its turn's type and tag exactly as an agent-written note does", () => {
  const sessionDbId = seedSession();
  const turnId = seedHoleTurn(sessionDbId, 1);
  const job = claimWindow(sessionDbId, 1, 1);

  const result = applyNoteSettlementWriteBack(db, {
    job,
    response: emptyResponse([
      {
        turn: `S${sessionDbId}/T1`,
        title: "implement+shadow-store: reconstructed from raw material",
        content: "Backfilled by settlement, not by the agent.",
        insight: null,
      },
    ]),
    nowEpoch: NOW,
    reconstructableTurnIds: new Set([turnId]),
    exposedSegmentIds: new Set(),
    rideTurnId: turnId,
  });

  expect(result.committed).toBe(true);
  expect(result.notesReconstructed).toBe(1);

  const turn = getTurnById(db, turnId)!;
  expect(turn.type).toBe("implement");
  expect(turn.tags).toContain("topic:shadow-store");
  expect(getShadowNote(db, turnId)?.writerOrigin).toBe("settlement");
});

test("an unrecognised activity word leaves the reconstruction's type empty, same as the agent path", () => {
  const sessionDbId = seedSession();
  const turnId = seedHoleTurn(sessionDbId, 1);
  const job = claimWindow(sessionDbId, 1, 1);

  applyNoteSettlementWriteBack(db, {
    job,
    response: emptyResponse([
      {
        turn: `S${sessionDbId}/T1`,
        title: "addendum+the-plan: appended a clause",
        content: "The activity word has no alias.",
        insight: null,
      },
    ]),
    nowEpoch: NOW,
    reconstructableTurnIds: new Set([turnId]),
    exposedSegmentIds: new Set(),
    rideTurnId: turnId,
  });

  const turn = getTurnById(db, turnId)!;
  expect(turn.type).toBeNull();
  expect(turn.tags).toContain("topic:the-plan");
});

test("a malformed reconstruction title drafts neither, and the reconstruction still commits", () => {
  const sessionDbId = seedSession();
  const turnId = seedHoleTurn(sessionDbId, 1);
  const job = claimWindow(sessionDbId, 1, 1);

  const result = applyNoteSettlementWriteBack(db, {
    job,
    response: emptyResponse([
      {
        turn: `S${sessionDbId}/T1`,
        title: "a plain title with no delimiters",
        content: "No shape to parse.",
        insight: null,
      },
    ]),
    nowEpoch: NOW,
    reconstructableTurnIds: new Set([turnId]),
    exposedSegmentIds: new Set(),
    rideTurnId: turnId,
  });

  expect(result.committed).toBe(true);
  expect(result.notesReconstructed).toBe(1);
  const turn = getTurnById(db, turnId)!;
  expect(turn.type).toBeNull();
  expect(turn.tags).toEqual([]);
});

test("a yielded reconstruction (an agent note already won) never touches the turn's type or tag", () => {
  const sessionDbId = seedSession();
  const turnId = seedHoleTurn(sessionDbId, 1);
  const job = claimWindow(sessionDbId, 1, 1);

  // Simulate the agent's own note landing first — upsertReconstructedShadowNote
  // refuses to overwrite an `agent`-origin row, so this window's directive for
  // the same turn must yield without drafting anything onto it either.
  db.query<unknown, [number, string, string, string, number, number]>(
    `INSERT INTO shadow_notes (
       turn_id, title, content, writer_origin, created_at_epoch, updated_at_epoch
     ) VALUES (?, ?, ?, 'agent', ?, ?)`,
  ).run(turnId, "agent's own title", "agent's own content", NOW - 10, NOW - 10);

  const result = applyNoteSettlementWriteBack(db, {
    job,
    response: emptyResponse([
      {
        turn: `S${sessionDbId}/T1`,
        title: "implement+shadow-store: reconstructed too late",
        content: "The agent already answered.",
        insight: null,
      },
    ]),
    nowEpoch: NOW,
    reconstructableTurnIds: new Set([turnId]),
    exposedSegmentIds: new Set(),
    rideTurnId: turnId,
  });

  expect(result.committed).toBe(true);
  expect(result.notesYielded).toBe(1);
  expect(result.notesReconstructed).toBe(0);
  const turn = getTurnById(db, turnId)!;
  expect(turn.type).toBeNull();
  expect(turn.tags).toEqual([]);
});
