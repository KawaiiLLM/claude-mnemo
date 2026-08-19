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
import { renderRubricAndRosterBlock } from "../../src/hooks/session-composition";
import { MEMORY_RUBRIC_TEXT, renderMemoryRubricBlock } from "../../src/shared/memory-rubric";
import { buildNoteSettlementContext } from "../../src/worker/note-settlement-context";
import { renderNoteSettlementPrompt } from "../../src/worker/note-settlement-prompt";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * TICKET 05 (ownership-and-note-cadence spec, "settlement demolition"): what
 * the settlement prompt has to SAY now that duty 1 (grading), duty 2 (note
 * reconstruction) and `assign` are all gone — only PROPOSALS (floor 1, never
 * required) and RELATIONS remain, plus a bare segment ROSTER
 * (id/title/topic — never a segment's own fields).
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

describe("duty 1 — proposals, never assign, never forced (ticket 05)", () => {
  test("the prompt states propose, the homeless-cluster criterion, and that a single turn may open one", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("PROPOSALS, via the `remember` tool");
    expect(prompt).toContain("action=\"propose\"");
    expect(prompt).toContain("this session's attached");
    expect(prompt).toContain("TEXT-ONLY suggestion");
    expect(prompt).toContain("creates NO segment");
    expect(prompt).toContain("never auto-adopted");
    expect(prompt).toContain("A single");
    expect(prompt).toContain("homeless turn may open its own proposal");
    expect(prompt).toContain("never required — a window may propose nothing");
    // `assign` and the retired arc-partition/body/lifecycle instructions
    // must be gone, not merely contradicted somewhere else in the prompt.
    expect(prompt).not.toContain("action=\"assign\"");
    expect(prompt).not.toContain("A SEGMENT IS ONE ARC");
    expect(prompt).not.toContain("SEGMENT LIFECYCLE");
    expect(prompt).not.toContain("noCandidateReason");
    // Duty 1 (grading) and duty 2 (reconstruction) left the prompt entirely.
    expect(prompt).not.toContain("TURN REVIEW");
    expect(prompt).not.toContain("RECONSTRUCTION");
    expect(prompt).not.toContain("tier:");
    expect(prompt).not.toContain("grade:");
  });
});

describe("commit is never gated on membership (ticket 05/06)", () => {
  test("the prompt states commit finishes the window regardless of whether anything was written", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("Call `commit` once you believe this window is done");
    expect(prompt).toContain("whether\n   or not you wrote anything");
    expect(prompt).toContain("always call it, even after a window where you wrote nothing");
    // The retired re-keyed gate's own wording must not survive.
    expect(prompt).not.toContain("attached segments — you");
    expect(prompt).not.toContain("membership call at all");
  });
});

describe("the segment roster (ticket 05) — id/title/topic only, never a segment's own fields", () => {
  test("an unattached segment does not render, whatever its recency", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const notAttached = createSegment(db, { title: "elsewhere, never attached", nowEpoch: NOW });

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    expect(context.segmentRoster).toEqual([]);

    const prompt = renderNoteSettlementPrompt(context);
    expect(prompt).toContain("(no segments attached to this session)");
    expect(prompt).not.toContain(`E${notAttached.id}`);
  });

  test("an attached segment renders id and title but NOT content/insight", () => {
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
    expect(context.segmentRoster).toEqual([{ id: segment.id, title: "fencing the claim", topic: null }]);

    const prompt = renderNoteSettlementPrompt(context);
    const roster = prompt.slice(prompt.indexOf("## Segment roster"));
    expect(roster).toContain(`[E${segment.id}] fencing the claim`);
    // The old full-field render is gone — content/insight never reach this prompt.
    expect(roster).not.toContain("the working state");
    expect(roster).not.toContain("a generation check beats a timestamp");
    expect(prompt).not.toContain("content: the working state");
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
    const window = prompt.slice(prompt.indexOf("## Turns"));

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
    expect(window).toContain(`[S${sessionDbId}/T1]`);
    // The private renderer's own duplicate of a count recall already prints.
    expect(window).not.toContain("tools=");
    // The retired hole/kind classification (ticket 05) has no fact line any more.
    expect(window).not.toContain("kind=");
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
      renderNoteSettlementPrompt(context).indexOf("## Turns"),
    );

    expect(window).toContain("fix+lease: reconstructed in hindsight");
    expect(window).toContain("What the earlier pass concluded.");
    // `insight` and the note's origin have no slot in recall's view, so they
    // stay annotations — the two facts settlement adds, and only those.
    expect(window).toContain("insight: the lease is the fence");
    expect(window).toContain("(note reconstructed by an earlier settlement pass)");
  });
});

/**
 * Ticket 11 (edge-ownership-impl, "统一 Memory Rubric") — the hash guard
 * this ticket's own checklist names: the settlement prompt and the
 * SessionStart injection (`hooks/session-composition.ts`'s
 * `renderRubricAndRosterBlock`) must render the rubric byte-identical.
 * Exercised HERE, against a real settlement prompt (this file's own
 * fixture), rather than only comparing each side to the shared constant in
 * isolation — a future edit that wrapped one side differently would still
 * fail this specific cross-check.
 */
describe("ticket 11 — the Memory Rubric renders byte-identical in both consumers", () => {
  test("the settlement prompt embeds the exact same rubric block SessionStart injects", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionDbId = upsertSession(db, {
      contentSessionId: "rubric-hash-session",
      project: "/tmp/project-rubric-hash",
      title: "rubric hash fixture",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 10_000,
      updatedAtEpoch: NOW - 10_000,
      completedAtEpoch: null,
    }).id;
    db.query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, 1, 'active', ?, ?, 1, ?) RETURNING id`,
    ).get(sessionDbId, "prompt 1", "response 1", NOW - 1_000);

    enqueueNoteSettlementWindows(
      db,
      [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 1, triggerType: "consecutive" }],
      NOW,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    );
    const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000)!;
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderNoteSettlementPrompt(context);

    const sessionStartBlock = renderRubricAndRosterBlock(db, {});
    const rubricOnly = renderMemoryRubricBlock();

    // The settlement prompt carries the SAME rendered rubric block…
    expect(prompt).toContain(rubricOnly);
    // …and so does the SessionStart injection (the roster follows it there
    // instead of the settlement duties, but the rubric substring itself is
    // identical).
    expect(sessionStartBlock).toContain(rubricOnly);
    // Byte-for-byte: extract each consumer's own copy and compare.
    const promptRubric = prompt.slice(
      prompt.indexOf("<mnemo-memory-rubric"),
      prompt.indexOf("</mnemo-memory-rubric>") + "</mnemo-memory-rubric>".length,
    );
    const sessionStartRubric = sessionStartBlock.slice(
      sessionStartBlock.indexOf("<mnemo-memory-rubric"),
      sessionStartBlock.indexOf("</mnemo-memory-rubric>") + "</mnemo-memory-rubric>".length,
    );
    expect(promptRubric).toBe(sessionStartRubric);
    expect(promptRubric).toBe(rubricOnly);
    expect(promptRubric).toContain(MEMORY_RUBRIC_TEXT);

    db.close();
  });

  test("duty 3 (SESSION NARRATIVE, ticket 09) instructs the session-addressed note call, distinct from duty 4 (COMMIT)", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const seededSessionId = upsertSession(db, {
      contentSessionId: "duty-3-session",
      project: "/tmp/project-duty-3",
      title: "duty 3 fixture",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 10_000,
      updatedAtEpoch: NOW - 10_000,
      completedAtEpoch: null,
    }).id;
    db.query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, 1, 'active', ?, ?, 1, ?) RETURNING id`,
    ).get(seededSessionId, "prompt 1", "response 1", NOW - 1_000);
    enqueueNoteSettlementWindows(
      db,
      [{ sessionId: seededSessionId, windowStart: 1, windowEnd: 1, triggerType: "consecutive" }],
      NOW,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    );
    const job = claimNextNoteSettlementJob(db, seededSessionId, NOW, NOW * 1000)!;
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderNoteSettlementPrompt(context);

    expect(prompt).toContain("SESSION NARRATIVE");
    expect(prompt).toContain(`"S${seededSessionId}"`);
    expect(prompt).toContain("never task");
    expect(prompt).toContain("still empty");
    expect(prompt.indexOf("SESSION NARRATIVE")).toBeLessThan(prompt.indexOf("4. COMMIT"));

    db.close();
  });
});

/**
 * Ticket 04 ([S15069/T963]): lookback = window size, and the prompt renders
 * ONE unified "## Turns" section rather than the old two-section split.
 */
describe("ticket 04 — lookback scales with the window, one unified turn section", () => {
  test("a 25-turn window renders 25 preceding turns plus its own 25, 50 in total, under one heading", () => {
    const sessionDbId = seedSession();
    // 75 turns total: 1-50 lookback material, 51-75 the window itself. A
    // 25-turn window's default lookback is exactly its own size (25), so it
    // should reach back to prompt 26, not further (turns 1-25 stay out of
    // reach) and not less (turn 50 must be included).
    for (let promptNumber = 1; promptNumber <= 75; promptNumber += 1) {
      seedTurn(sessionDbId, promptNumber);
    }
    const job = claimWindow(sessionDbId, 51, 75);

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    expect(context.windowTurns).toHaveLength(25);
    expect(context.priorTurns).toHaveLength(25);
    expect(context.priorTurns[0]!.promptNumber).toBe(26);
    expect(context.priorTurns.at(-1)!.promptNumber).toBe(50);
    expect(context.windowTurns[0]!.promptNumber).toBe(51);
    expect(context.windowTurns.at(-1)!.promptNumber).toBe(75);
    // reviewableTurnIds is exactly the 50 rendered turns — no more, no less.
    expect(context.reviewableTurnIds.size).toBe(50);

    const prompt = renderNoteSettlementPrompt(context);
    // One heading, not two: the old "Preceding turns"/"Window turns" split
    // is gone.
    expect(prompt).toContain("## Turns");
    expect(prompt).not.toContain("Preceding turns");
    expect(prompt).not.toContain("Window turns (settle exactly these)");
    const turnsSection = prompt.slice(prompt.indexOf("## Turns"));
    for (let promptNumber = 26; promptNumber <= 75; promptNumber += 1) {
      expect(turnsSection).toContain(`[S${sessionDbId}/T${promptNumber}]`);
    }
    expect(turnsSection).not.toContain(`[S${sessionDbId}/T25]`);
  });
});
