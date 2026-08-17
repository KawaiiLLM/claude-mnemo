import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { attachSegmentToSession, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { formatTurnCollapsed } from "../../src/mcp/format";
import { buildCollapsedTurnsForSession } from "../../src/mcp/recall";
import { upsertShadowNote } from "../../src/db/shadow-notes";
import { buildNoteSettlementContext } from "../../src/worker/note-settlement-context";
import { renderNoteSettlementPrompt } from "../../src/worker/note-settlement-prompt";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Ticket 08 (ADR-0002/0007): what the settlement prompt has to SAY about
 * membership and proposals, and what the context has to put in front of it
 * (the session's attached segments — never a global roster or topic
 * registry, both retired with the segment facade).
 *
 * Every assertion here is a sentence the ticket names as a deliverable, so it
 * is pinned as a substring of the rendered prompt: the prompt IS the
 * mechanism, and a guard that only checked "some membership text exists"
 * would pass whether or not the rule survived a later edit.
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
    contentSessionId: "settlement-prompt-session",
    project: "/tmp/project-settlement-prompt",
    title: "settlement prompt fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(
  sessionDbId: number,
  promptNumber: number,
  facets: { type?: string[]; tags?: string[] } = {},
): number {
  return db
    .query<{ id: number }, [number, number, string, string, number, string, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, tags
       ) VALUES (?, ?, 'active', ?, ?, 2, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
      JSON.stringify(facets.type ?? []),
      JSON.stringify(facets.tags ?? []),
    )!.id;
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

/** A rendered prompt over a one-turn window, with whatever segments/topics the test seeded first. */
function renderPrompt(): string {
  const sessionDbId = seedSession();
  seedTurn(sessionDbId, 1);
  const job = claimWindow(sessionDbId, 1, 1);
  const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
  return renderNoteSettlementPrompt(context);
}

describe("duty 3 — membership within attached segments, never forced (ticket 08, ADR-0002)", () => {
  test("the prompt states assign, the attached-only scope, and that homeless is legal, never forced", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("MEMBERSHIP & PROPOSALS, via the `remember` tool");
    expect(prompt).toContain("action=\"assign\"");
    expect(prompt).toContain("session's ATTACHED segments");
    expect(prompt).toContain("NOT a legal target");
    expect(prompt).toContain("HOMELESS");
    expect(prompt).toContain("LEGAL and NEVER FORCED");
    // The retired arc-partition/body/lifecycle instructions must be gone,
    // not merely contradicted somewhere else in the same prompt.
    expect(prompt).not.toContain("A SEGMENT IS ONE ARC");
    expect(prompt).not.toContain("SEGMENT LIFECYCLE");
    expect(prompt).not.toContain("noCandidateReason");
  });

  test("the prompt states propose — a cluster of at least two, text-only, never a segment", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("action=\"propose\"");
    expect(prompt).toContain("at least two");
    expect(prompt).toContain("TEXT-ONLY suggestion");
    expect(prompt).toContain("creates NO segment");
    expect(prompt).toContain("never auto-adopted");
    expect(prompt).toContain("propose a single turn or an incoherent grab-bag");
  });

  test("segment creation/naming/Working State is stated as NOT this dispatch's to do", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("is NOT this dispatch's to do");
    expect(prompt).toContain("user/main agent's, through");
  });
});

describe("duty 5 — commit's completion rule matches the re-keyed gate (ticket 08)", () => {
  test("the prompt states the attached-set-dependent membership requirement", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain(
      "if this session has any attached segments — you",
    );
    expect(prompt).toContain("called `remember` (assign or propose) at least once");
    expect(prompt).toContain("A session with NO attached segments needs no");
    expect(prompt).toContain("membership call at all");
  });
});

describe("the attached-segments surface (ticket 08) — the ONLY legal assign targets", () => {
  test("an unattached segment does not render, whatever its recency", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const notAttached = createSegment(db, { title: "elsewhere, never attached", nowEpoch: NOW });

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    expect(context.attachedSegments).toEqual([]);

    const prompt = renderNoteSettlementPrompt(context);
    expect(prompt).toContain("(no segments attached to this session)");
    expect(prompt).not.toContain(`E${notAttached.id}`);
  });

  test("an attached segment renders with its id, status, title, and a content/insight preview", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, {
      title: "fencing the claim",
      content: "the working state",
      insight: "a generation check beats a timestamp",
      nowEpoch: NOW - 4_000,
    });
    attachSegmentToSession(db, sessionDbId, segment.id, NOW - 4_000);

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    expect(context.attachedSegments.map((entry) => entry.id)).toEqual([segment.id]);

    const prompt = renderNoteSettlementPrompt(context);
    const attached = prompt.slice(prompt.indexOf("## Attached segments"));
    expect(attached).toContain(`[E${segment.id}] [open] fencing the claim`);
    expect(attached).toContain("content: the working state");
    expect(attached).toContain("insight: a generation check beats a timestamp");
  });
});

/**
 * Ticket 11 (spec A5): a window turn is rendered by RECALL's collapsed view,
 * not by a renderer only this prompt has. The assertion is deliberately an
 * equality against what `buildCollapsedTurnsForSession` + `formatTurnCollapsed`
 * produce for the same row — a private renderer that happened to print similar
 * text would still fail it, which is the whole point.
 */
describe("ticket 11 — window turns go through recall's collapsed view (spec A5)", () => {
  test("the window section contains recall's own rendering of the turn, byte for byte", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1, { type: ["implement"] });
    db.query<unknown, [number]>(
      "UPDATE turns SET title = 'implement+lease: fence the claim', content = 'Fenced it.' WHERE id = ?",
    ).run(turnId);
    const job = claimWindow(sessionDbId, 1, 1);

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderNoteSettlementPrompt(context);
    const window = prompt.slice(prompt.indexOf("## Window turns"));

    const recallView = buildCollapsedTurnsForSession(db, sessionDbId).find(
      (turn) => turn.promptNumber === 1,
    )!;
    const recallRendering = formatTurnCollapsed(recallView, { sessionId: sessionDbId });
    expect(recallRendering).toContain("implement+lease: fence the claim");
    expect(window).toContain(recallRendering);
    expect(context.windowTurns[0]!.collapsedRendering).toBe(recallRendering);

    // The settlement-only facts survive as annotations under that line, and
    // the QUALIFIED address stays in front of the model — recall labels a turn
    // `[S<n>][T<n>]`, and every write tool takes `S<n>/T<n>`.
    expect(window).toContain(`[S${sessionDbId}/T1] kind=`);
    // The private renderer's own duplicate of a count recall already prints.
    expect(window).not.toContain("tools=");
  });

  test("a note only `shadow_notes` carries still reaches the model, through the same renderer", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    // A reconstruction an earlier settlement pass wrote: never promoted onto
    // the turn record, so recall's builder alone would render "Untitled".
    upsertShadowNote(db, {
      turnId,
      title: "fix+lease: reconstructed in hindsight",
      content: "What the earlier pass concluded.",
      insight: "the lease is the fence",
      writerOrigin: "settlement",
      nowEpoch: NOW - 500,
    });
    const job = claimWindow(sessionDbId, 1, 1);

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const window = renderNoteSettlementPrompt(context).slice(
      renderNoteSettlementPrompt(context).indexOf("## Window turns"),
    );

    expect(window).toContain("fix+lease: reconstructed in hindsight");
    expect(window).toContain("What the earlier pass concluded.");
    // `insight` and the note's origin have no slot in recall's view, so they
    // stay annotations — the two facts settlement adds, and only those.
    expect(window).toContain("insight: the lease is the fence");
    expect(window).toContain("(note reconstructed by an earlier settlement pass)");
  });
});
