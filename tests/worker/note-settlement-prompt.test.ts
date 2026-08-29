import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  computeSettlementWritableTurnIds,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { attachSegmentToSession, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { claimWriterId } from "../../src/db/write-gate";
import { upsertShadowNote } from "../../src/db/shadow-notes";
import { renderRubricBlock } from "../../src/hooks/session-composition";
import { DEFAULT_TURN_TOKEN_BUDGET } from "../../src/mcp/format";
import {
  MEMORY_RUBRIC_CONCEPTS_TEXT,
  MEMORY_RUBRIC_MAIN_ACTIONS_TEXT,
  renderMainAgentRubricBlock,
  renderMemoryRubricConceptsBlock,
} from "../../src/shared/memory-rubric";
import { MEMORY_TYPES } from "../../src/shared/type-vocabulary";
import { SETTLEMENT_NOTE_TOOL_DESCRIPTION } from "../../src/worker/note-settlement-sdk-query";
import { SETTLEMENT_LANE_ACTIONS } from "../../src/worker/note-settlement-membership-facade";
import {
  buildNoteSettlementContext,
  resolveSettlementWritableSet,
  type NoteSettlementContext,
} from "../../src/worker/note-settlement-context";
import {
  NOTE_SETTLEMENT_SYSTEM_PROMPT,
  renderNoteSettlementPrompt,
} from "../../src/worker/note-settlement-prompt";
import {
  SETTLEMENT_ALLOWED_TOOLS,
  SETTLEMENT_NOTE_TOOL_DESCRIPTION,
} from "../../src/worker/note-settlement-sdk-query";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * TICKET 05 (ownership-and-note-cadence spec, "settlement demolition"): what
 * the settlement prompt has to SAY now that duty 1 (grading), duty 2 (note
 * reconstruction) and `assign` are all gone — only PROPOSALS (floor 1, never
 * required) and RELATIONS remain, plus a bare segment ROSTER
 * (id/title only, ticket 15 dropped `topic` — never a segment's own fields).
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

/**
 * The dispatch's own render path, verbatim (tag-mandate ticket 06): compute
 * the immutable writable set from the context's base ids, resolve it to
 * addresses, render. Tests go through THIS rather than calling
 * `renderNoteSettlementPrompt` with a hand-built set, so a divergence between
 * the printed declaration and the set the gate enforces would fail here too.
 */
function renderPromptFor(context: NoteSettlementContext, database: Database = db): string {
  const writableTurnIds = computeSettlementWritableTurnIds(
    database,
    context.reviewableTurnIds,
  );
  return renderNoteSettlementPrompt(
    context,
    resolveSettlementWritableSet(database, context, writableTurnIds),
  );
}

/** A rendered prompt over a one-turn window, with whatever segments the test seeded first. */
function renderPrompt(): string {
  const sessionDbId = seedSession();
  seedTurn(sessionDbId, 1);
  const job = claimWindow(sessionDbId, 1, 1);
  const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
  return renderPromptFor(context);
}

/**
 * Lane-model-v12 ticket 15 (spec D3d): the Duties section is a CLOSED list,
 * and no segment verb is on it — the three membership verbs retired with that
 * ticket, so their teaching is gone from the prompt rather than contradicted
 * somewhere else in it: a prompt that still asked for a `propose` would be
 * asking for a schema rejection.
 *
 * TICKET 22 (user ruling 2026-08-26) moved the COUNT from two to three by
 * restoring SESSION FIELDS, the duty ticket 15 deleted while leaving its write
 * surface live. The closed-list property is what this describe pins, not the
 * number: the list is exactly {turn fields, lanes, session fields}, and a
 * segment is still not on it.
 */
describe("tickets 15/22 — the duties are exactly three, and none of them is a segment", () => {
  test("the preamble names the three, and says membership is a tags write rather than a further duty", () => {
    const prompt = renderPrompt();
    const duties = prompt.slice(prompt.indexOf("## Duties"), prompt.indexOf("## Task roster"));

    expect(duties).toContain(
      "Three things, and nothing else: a TURN's own fields — its edges included —",
    );
    expect(duties).toContain("the LANE registry, and this SESSION's own two fields.");
    expect(duties).toContain("task and never attach one.");
    // Exactly three numbered duties, and they are these three.
    expect([...duties.matchAll(/^\d+\. [A-Z]/gm)].map((match) => match[0])).toEqual([
      "1. T",
      "2. L",
      "3. S",
    ]);
    expect(duties).toContain("1. TURN FIELDS (notes, type/tags — membership with them — and edges), via");
    expect(duties).toContain(
      "2. LANES, via the `remember` tool — `create`, `delete`, `merge`,",
    );
    expect(duties).toContain("3. SESSION FIELDS — this session's own `title` and `content`, via the");
  });

  test("the retired verbs and the proposal teaching are GONE from the prompt, not merely contradicted", () => {
    const prompt = renderPrompt();

    expect(prompt).not.toContain('action="propose"');
    expect(prompt).not.toContain('action="reassign"');
    expect(prompt).not.toContain('action="create"');
    expect(prompt).not.toContain('action="assign"');
    expect(prompt).not.toContain("PROPOSALS, via the `remember` tool");
    expect(prompt).not.toContain("TEXT-ONLY suggestion");
    expect(prompt).not.toContain("homeless turn may open its own proposal");
    expect(prompt).not.toContain("attaches it to this session");
    // The pre-ticket-05 wording stays gone too.
    expect(prompt).not.toContain("A SEGMENT IS ONE ARC");
    expect(prompt).not.toContain("SEGMENT LIFECYCLE");
    expect(prompt).not.toContain("TURN REVIEW");
    expect(prompt).not.toContain("RECONSTRUCTION");
  });

  test("duty 2 states each lane verb's own call shape and merge's three refusals", () => {
    const prompt = renderPrompt();
    const duty2 = prompt.slice(prompt.indexOf("2. LANES,"), prompt.indexOf("## Task roster"));

    expect(duty2).toContain("A lane is (task, ONE tag)");
    // [S15069/T1744] The settlement facade takes the PAIR, not the single
    // address the main tool's create uses. The prompt said otherwise for one
    // commit — my own regression while retiring `declare` — and a settlement
    // agent following it would have been refused. Pinned to what the facade
    // actually accepts, and to the sentence that warns the two differ.
    expect(duty2).toContain("`create`: `id` (an open \"E<n>\") + `tag` (one canonical lane tag).");
    expect(duty2).toContain("This surface takes the PAIR, not the single");
    expect(duty2).toContain("Refused while any MEMBER TURN in the");
    expect(duty2).toContain("`merge`: `id` + `tag` (the lane that goes away) + `into` (the lane");
    expect(duty2).toContain("there is no half-merged state to clean up");
    expect(duty2).toContain(
      "Refused when the two are the same lane, when either",
    );
    expect(duty2).toContain("is not declared, or when `into` names a lane in another task.");
  });
});

/**
 * Lane-model-v12 TICKET 22 (user ruling 2026-08-26: "session 结算也可以顺便维护
 * 了"). Ticket 15 deleted the session duty but not the write surface behind it
 * (`evaluateSettlementSessionWrite` still parses `note(session=…)` and writes
 * `["title", "content"]`), leaving a capability nothing instructed. This
 * describe pins the restoration and the ONE thing that must not come back with
 * it.
 */
describe("ticket 22 — settlement maintains this session's own fields again", () => {
  test("duty 3 is the session's title and content, addressed by this session's own S-id", () => {
    const prompt = renderPrompt();
    const duties = prompt.slice(prompt.indexOf("## Duties"), prompt.indexOf("## Task roster"));
    const duty3 = duties.slice(duties.indexOf("3. SESSION FIELDS"));

    // The duty exists, names BOTH fields (the ruling guessed "好像就一个
    // title"; the facade's own `sessionFields` is title + content), and is
    // ordered last.
    expect(duty3).toContain("3. SESSION FIELDS — this session's own `title` and `content`, via the");
    expect(duties.indexOf("2. LANES,")).toBeLessThan(duties.indexOf("3. SESSION FIELDS"));

    // It addresses THIS session, by the same id the prompt's own header
    // declares — a duty naming some other session would be instructing a call
    // the facade refuses ("is not this dispatch's own session").
    const headerSessionId = prompt.match(/^# Settlement window S(\d+)\//m)?.[1];
    expect(headerSessionId).toBeDefined();
    expect(duty3).toContain(`\`note\` tool's \`session\` field (this session, "S${headerSessionId}")`);
    expect(duty3).toContain("instead of `turn`; those two fields only, and no other session's.");

    // The maintenance rules that make the duty followable rather than merely
    // present: what content is for, and when title is touched.
    expect(duty3).toContain("`content` is a CONVERSATIONAL increment");
    expect(duty3).toContain("never task state (that state belongs to the task, not the");
    expect(duty3).toContain("`title` is set only when it is still empty");
    expect(duty3).toContain("narratively new may skip this duty entirely.");

    // The prompt and the tool description state the same two fields — a duty
    // asking for a field the call refuses is the drift this pair prevents.
    expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain(
      "On `session`: `title`/`content` only — type/tags/edges are refused.",
    );
  });

  test("the retired FALSE heading does not come back with the duty", () => {
    const prompt = renderPrompt();

    // Ticket 15 was right about this half: the session summary is NOT one of
    // the five SessionStart blocks (spec D3f leaves roster / segment cards /
    // rubric / persona), so the old parenthetical asserted something untrue
    // about who reads the field. The corrected heading stands.
    expect(prompt).toContain("## Session summary (this session's stored narrative)");
    expect(prompt).not.toContain(
      "## Session summary (the block the main agent is shown at SessionStart)",
    );
    // Absence of the CLAIM, not just of that exact heading string: no wording
    // anywhere in the prompt may tell this pass the summary is injected.
    expect(prompt).not.toContain("shown at SessionStart");
    expect(prompt).not.toContain("the block the main agent is shown");
  });
});

describe("commit is never gated on membership (ticket 05/06)", () => {
  test("the prompt states commit finishes the window regardless of whether anything was written", () => {
    const prompt = renderPrompt();

    // Ticket 15 moved the whole commit contract into the Duties PREAMBLE:
    // `commit` writes nothing, and a list of two writes is the wrong place for
    // it. Nothing about the contract itself changed.
    expect(prompt).toContain(
      "`commit` does not write anything itself — it verifies your job lease is",
    );
    expect(prompt).toContain(
      "needs an empty-handed `commit` to finish cleanly — for an already-settled",
    );
    expect(prompt).toContain("window that is the common case, not an error.");
    expect(prompt).not.toContain("4. COMMIT.");
    // The retired re-keyed gate's own wording must not survive.
    expect(prompt).not.toContain("attached segments — you");
    expect(prompt).not.toContain("membership call at all");
  });
});

describe("the segment roster (ticket 05) — id/title only, never a segment's own fields", () => {
  test("an unattached segment does not render, whatever its recency", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const notAttached = createSegment(db, { title: "elsewhere, never attached", nowEpoch: NOW });

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    expect(context.segmentRoster).toEqual([]);

    const prompt = renderPromptFor(context);
    expect(prompt).toContain("(no tasks attached to this session)");
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
    // Ticket 15 added the segment's own TAG: membership is derived from it, so
    // an agent told to correct membership by writing a word has to be shown
    // the word. Everything else the old roster refused to carry stays refused.
    expect(context.segmentRoster).toEqual([
      { id: segment.id, title: "fencing the claim", tag: null, lanes: [] },
    ]);

    const prompt = renderPromptFor(context);
    const roster = prompt.slice(prompt.indexOf("## Task roster"));
    expect(roster).toContain(`[E${segment.id}] fencing the claim — tag: (unnamed)`);
    // The old full-field render is gone — content/insight never reach this prompt.
    expect(roster).not.toContain("the working state");
    expect(roster).not.toContain("a generation check beats a timestamp");
    expect(prompt).not.toContain("content: the working state");
  });

  /**
   * PEER REVIEW A5 — the roster carries the DECLARED LANE REGISTRY.
   *
   * Two closed vocabularies decide whether a `tags` write is legal, and the
   * settlement prompt used to name only one of them. The registry cannot be
   * recovered from anywhere else this agent can see: lane tags left the segment
   * card in lane-model-v12 ticket 18 for the MAIN agent's SessionStart roster
   * row, and a PROVISIONAL lane — 0 or 1 member, legal by construction — has no
   * edge for the lane checker to surface it through. Without the registry,
   * `remember(declare)`'s own "continue an existing lane first" instruction has
   * no readable input.
   */
  test("a PROVISIONAL lane — declared, zero members, zero edges — reaches the prompt by name", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, {
      title: "the container",
      tags: ["container"],
      nowEpoch: NOW - 4_000,
    });
    attachSegmentToSession(db, sessionDbId, segment.id, NOW - 4_000);
    // Neither lane has a member turn or an edge; both are legal, and the
    // registry is the only thing that knows they exist.
    insertLane(db, segment.id, "write-gate", NOW - 3_000);
    insertLane(db, segment.id, "backfill", NOW - 3_000);

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    // Registry order — alphabetical, a word list to pick from, not a feed.
    expect(context.segmentRoster).toEqual([
      {
        id: segment.id,
        title: "the container",
        tag: "container",
        lanes: ["backfill", "write-gate"],
      },
    ]);

    const prompt = renderPromptFor(context);
    const roster = prompt.slice(prompt.indexOf("## Task roster"));
    expect(roster).toContain(`[E${segment.id}] the container — tag: container`);
    expect(roster).toContain("declared lanes: backfill · write-gate");
  });

  test("a segment with no lane declared says so, rather than dropping the row", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, {
      title: "no lanes here",
      tags: ["lonely"],
      nowEpoch: NOW - 4_000,
    });
    attachSegmentToSession(db, sessionDbId, segment.id, NOW - 4_000);

    const prompt = renderPromptFor(buildNoteSettlementContext(db, job, { nowEpoch: NOW })!);
    expect(prompt.slice(prompt.indexOf("## Task roster"))).toContain(
      "declared lanes: (none declared yet)",
    );
  });
});

/**
 * TAG-MANDATE TICKET 06 — the PUSH channel is gone (spec "Settlement
 * surface", ruling [S15069/T1452]). This describe replaces the ticket-11
 * pair that pinned the opposite property (a window turn rendered through
 * recall's collapsed view, byte for byte): the section those tests read from
 * no longer exists.
 *
 * SCOPE NOTE, so the assertions below are read for what they are: the
 * `## Session summary` block is `recallMemory(id="S<n>")`, and a session card
 * carries a PAGE-BUDGETED preview of that session's own turn rows (address,
 * title, metadata, content) underneath the narrative. That preview predates
 * this ticket, is bounded by `pageBudget` rather than by the window, and
 * grants nothing (its `readerId` is null now). So "no turn content reaches
 * the prompt" would be a false assertion; what IS pinned is that the
 * WINDOW rendering — the unbounded per-writable-turn section, with its own
 * `[S<n>/T<n>]` fact line and its settlement-only annotations — is gone.
 */
describe("ticket 06 — the window rendering is gone; the prompt carries no turn content", () => {
  test("no `## Turns` section, no per-turn fact line, and the turn is writable anyway", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1, { type: ["implement"] });
    db.query<unknown, [number]>(
      "UPDATE turns SET title = 'implement+lease: fence the claim', content = 'Fenced it.' WHERE id = ?",
    ).run(turnId);
    const job = claimWindow(sessionDbId, 1, 1);

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);

    expect(prompt).not.toContain("## Turns");
    // The retired heading's own framing, pinned absent so a future edit
    // cannot reintroduce the section under its old caption.
    expect(prompt).not.toContain("rendered identically");
    expect(prompt).not.toContain("equally citable and");
    // The retired renderer's own signature: a per-turn fact line addressed
    // `[S<n>/T<n>]`. Recall's own turn rows label `[T<n>]`, so this bracketed
    // SLASH form existed nowhere else and its absence is exact.
    expect(prompt).not.toContain(`[S${sessionDbId}/T1]`);

    // The turn is still WRITABLE — the set declares it. Rendering and
    // authorization came apart; the declaration is what survives.
    expect(prompt).toContain("WRITABLE SET:");
    expect(prompt).toContain(`S${sessionDbId}/T1`);
    expect(context.reviewableTurnIds.has(turnId)).toBe(true);
  });

  test("a settlement-written shadow note is not pushed either — insight and writer origin included", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    // A reconstruction an earlier settlement pass wrote. The retired
    // rendering carried its title/content plus two annotations recall has no
    // slot for; under pull the agent recalls the turn to see any of it.
    upsertShadowNote(db, {
      turnId,
      title: "fix+lease: reconstructed in hindsight",
      content: "What the earlier pass concluded.",
      insight: "the lease is the fence",
      writerOrigin: "settlement",
      nowEpoch: NOW - 500,
    });
    const job = claimWindow(sessionDbId, 1, 1);

    const prompt = renderPromptFor(
      buildNoteSettlementContext(db, job, { nowEpoch: NOW })!,
    );

    expect(prompt).not.toContain("fix+lease: reconstructed in hindsight");
    expect(prompt).not.toContain("What the earlier pass concluded.");
    expect(prompt).not.toContain("insight: the lease is the fence");
    expect(prompt).not.toContain("(note reconstructed by an earlier settlement pass)");
  });
});

/**
 * TAG-MANDATE TICKET 06 — the IMMUTABLE WRITABLE SET, printed (spec: "the
 * writable set is IMMUTABLE and declared"; ticket's checkbox 1, "prompt
 * carries the writable set verbatim").
 *
 * The load-bearing property is IDENTITY, not formatting: what the prompt
 * declares must be exactly what `computeSettlementWritableTurnIds` produced —
 * the same value the write facade's range check and the commit gate read.
 * These tests therefore compute the set the dispatch's way and assert every
 * member appears, rather than checking that "some addresses are printed".
 */
describe("ticket 06 — the writable set is declared, window first, in addresses", () => {
  test("window and declared-lookback groups are labelled, and every id in the computed set is printed", () => {
    const sessionDbId = seedSession();
    for (let promptNumber = 1; promptNumber <= 6; promptNumber += 1) {
      seedTurn(sessionDbId, promptNumber);
    }
    const job = claimWindow(sessionDbId, 4, 6);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);

    // Ticket 07: Block A's WRITABLE SET is now the LAST thing in the
    // Procedure section (the old trailing "Reconcile what is stored..."
    // paragraph retired), so "## Duties" is the correct end boundary.
    const block = prompt.slice(prompt.indexOf("WRITABLE SET:"), prompt.indexOf("## Duties"));
    expect(block).toContain("window — settle these (3):");
    expect(block).toContain("declared lookback — equally writable (3):");
    // Window first, then the remainder — the order the agent works them.
    expect(block.indexOf("window — settle these")).toBeLessThan(
      block.indexOf("declared lookback"),
    );
    for (const promptNumber of [4, 5, 6]) {
      expect(block).toContain(`S${sessionDbId}/T${promptNumber}`);
    }

    // IDENTITY with the enforced set: same count, same members.
    const writableTurnIds = computeSettlementWritableTurnIds(db, context.reviewableTurnIds);
    const set = resolveSettlementWritableSet(db, context, writableTurnIds);
    expect(set.window.length + set.lookback.length).toBe(writableTurnIds.size);
    for (const address of [...set.window, ...set.lookback]) {
      expect(block).toContain(address);
    }
  });

  test("a deadlock-guard closure id — never in this context's own turns — still prints, in the lookback group", () => {
    const sessionDbId = seedSession();
    const outside = seedTurn(sessionDbId, 1);
    const t9 = seedTurn(sessionDbId, 9);
    // T9 cites T1. T1 is far outside the window's own lookback (a 1-turn
    // window reaches back exactly one turn), so it enters the writable set
    // ONLY through the closure — and repairing T9's edge needs it writable.
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t9 },
          cited: { kind: "turn", id: outside },
          relation: "extends",
          provenance: "asserted",
          ...deriveSideTags([]),
        },
      ],
      NOW,
    );
    const job = claimWindow(sessionDbId, 9, 9);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;

    expect(context.reviewableTurnIds.has(outside)).toBe(false);
    const writableTurnIds = computeSettlementWritableTurnIds(db, context.reviewableTurnIds);
    expect(writableTurnIds.has(outside)).toBe(true);

    const set = resolveSettlementWritableSet(db, context, writableTurnIds);
    expect(set.window).toEqual([`S${sessionDbId}/T9`]);
    expect(set.lookback).toContain(`S${sessionDbId}/T1`);
    expect(renderPromptFor(context)).toContain(`S${sessionDbId}/T1`);
  });
});

/**
 * TAG-MANDATE TICKET 07 — Block A's batched procedure (spec: revision 7 of
 * `.scratch/tag-mandate/issues/06-prompt-text.md`), replacing ticket 06's
 * per-window STEP-0-COVERAGE framing wholesale: the writable set is now
 * worked in chronological ten-turn batches, each running three workstations
 * in order (TURN AUDIT, CONTENT CANDIDATES, BACK-LINK).
 *
 * Every assertion is a substring of the AUTHORED text (Block A), pinned
 * inside the Procedure section rather than anywhere in the prompt: the
 * batch loop is worthless if it drifts out of the place the agent reads
 * before judging.
 */
describe("ticket 07 — Block A teaches the batched workstations, and timeline licenses nothing", () => {
  function procedureText(prompt: string): string {
    return prompt.slice(prompt.indexOf("## Procedure"), prompt.indexOf("## Duties"));
  }

  test("the scope sentence states immutability and the gate's refusal", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("Your scope is the WRITABLE SET printed below");
    expect(procedure).toContain("It is immutable — reading never widens it, and every");
    expect(procedure).toContain("write must land inside it; the gate refuses the rest and names why.");
  });

  test("batches are ten chronological turns, and batch/window/lookback labels are never topology", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("Work the WHOLE writable set in chronological batches of ten turns (the");
    expect(procedure).toContain("last batch may be smaller). Batches bound working memory, nothing else:");
    expect(procedure).toContain("window and lookback labels and batch boundaries are never thread, lane,");
    expect(procedure).toContain("phase or convergence boundaries. Do not call `lane_check` during the");
    expect(procedure).toContain("batch loop.");
  });

  test("reading is the write license throughout, and timeline licenses nothing", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("Reading is your write license throughout: a whole-field");
    expect(procedure).toContain("`write` over another writer's text requires your own untruncated read of");
    expect(procedure).toContain("that field, and `timeline` licenses nothing.");
  });

  // T1466 (finding P1-4)'s own root cause carries forward: explicit `fields`
  // REPLACE recall's defaults, so BATCH STEP 1's field list and the sentence
  // naming what must have been seen are pinned together.
  test("BATCH STEP 1 names the recall call's fields, the re-read rule, and the note-less-turn read", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("BATCH STEP 1 — TURN AUDIT. Recall every turn of this batch with");
    expect(procedure).toContain(
      '`filter={fields:["title","metadata","content","insight","relations"]}`;',
    );
    expect(procedure).toContain("re-read any truncated field with a bigger `turn` budget, and read a turn");
    expect(procedure).toContain("carrying no note with `prompt` and `response` added — the raw exchange is");
    expect(procedure).toContain("what you judge it by, and a field never delivered licenses nothing.");
  });

  test("BATCH STEP 1 audits every turn independently against note, type and membership criteria", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("EVERY turn independently, whether or not anything flags it: does the note");
    expect(procedure).toContain("misread its turn; does the type honor the Ruling supplement (a user");
    expect(procedure).toContain("ruling or veto that landed here adds `design` or `correction`, and");
    // Ticket 15 hand-amended this one clause: `reassign` retired, and
    // membership is a `tags` write. The criterion itself is unchanged.
    expect(procedure).toContain("`discuss` cannot remain); does the task tag in its `tags` match content");
    expect(procedure).toContain("against the roster (unowned is legal by itself — write a task tag only");
    expect(procedure).toContain("when one destination is obvious from content, never from adjacency, a");
    expect(procedure).toContain("shared project noun or a checker warning). Turn-local corrections —");
    expect(procedure).toContain("notes, type, tags — may land now.");
    expect(procedure).not.toContain("reassign");
  });

  test("BATCH STEP 2 records claim-level candidates only, writing no relation yet", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("BATCH STEP 2 — CONTENT CANDIDATES. Without consulting the stored edge");
    expect(procedure).toContain("words, identify the claim-level links wholly visible in this batch. Add");
    expect(procedure).toContain("each to a private open-thread ledger: at least two turn addresses, the");
    expect(procedure).toContain("claim link, a phase hypothesis, its current frontier. Shared topic,");
    expect(procedure).toContain("adjacency and state-only turns are never candidates; there is no target");
    expect(procedure).toContain("count, and an empty batch ledger is valid. Record candidates only —");
    expect(procedure).toContain("write no relation, no lane tag, no `indexes` yet.");
  });

  test("BATCH STEP 3 back-links against the ledger's own frontiers, never every earlier turn", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("BATCH STEP 3 — BACK-LINK. Compare this batch against the ledger's open");
    expect(procedure).toContain("frontiers, the batch's own explicit predecessor language, and any prior");
    expect(procedure).toContain("terminus this content explicitly continues or corrects — never against");
    expect(procedure).toContain("every earlier turn. Follow predecessor language across window, lookback");
    expect(procedure).toContain("and batch boundaries; when it points outside the writable set, read that");
    expect(procedure).toContain("endpoint for judgment even though it stays unwritable. A membership");
    expect(procedure).toContain("break never proves a content thread absent. Targeted re-reads collect");
    expect(procedure).toContain("any historical relations or full tag sets the final write gate will");
    expect(procedure).toContain("require — the ledger itself licenses nothing. Update the ledger; do not");
    expect(procedure).toContain("finalize the graph.");
  });

  // ABSENCE pin (ticket 07, retired teaching #1): the old per-window
  // STEP-0-COVERAGE framing and its trailing "Reconcile what is stored..."
  // SUPPLY/CORRECT/RETRACT paragraph are both gone, replaced whole by the
  // batched workstations above — pinned so a future merge cannot resurrect
  // either half independently.
  test("the retired STEP 0 framing and the 'Reconcile what is stored' opener are both gone", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).not.toContain("STEP 0 — COVERAGE");
    expect(procedure).not.toContain("page through EVERY turn of the");
    expect(procedure).not.toContain('recall(id="S<s>/T<a>..T<b>"');
    expect(procedure).not.toContain("Turns outside the set may be read freely");
    expect(procedure).not.toContain("Reconcile what is stored");
    expect(procedure).not.toContain("SUPPLY what is missing");
    expect(procedure).not.toContain("CORRECT what is wrong");
    expect(procedure).not.toContain("RETRACT what is false");
  });
});

/**
 * TAG-MANDATE TICKET 06, amended by LANE-DECLARATION TICKET 08 — the edges
 * bullet (authored Block B, hand-amended by ticket 08's own header comment
 * in note-settlement-prompt.ts) is the prompt's half of "every teaching
 * surface speaks the current lane model". Pinned inside duty 2, where the
 * agent reads them, rather than anywhere in the prompt.
 *
 * The tag MANDATE this describe used to pin ("extends/narrows accept ONLY
 * the tagged form") is GONE — ticket 08 retired it here to match the
 * rubric's own retirement of the same idea (memory-rubric.test.ts, "the
 * five retired v10 lane ideas"). See note-settlement-prompt.ts's own
 * "LANE-DECLARATION TICKET 08'S AMENDMENT" comment for the full list of
 * what changed and the known transient inconsistency with the live write
 * gate (lane-declaration ticket 02, not yet built as of this commit).
 */
describe("ticket 06 — the edges bullet teaches the entry forms and the lane procedure", () => {
  function edgesBullet(prompt: string): string {
    return prompt.slice(
      prompt.indexOf("   - edges: `note`'s"),
      prompt.indexOf("   - `type` and `tags` are the two fields"),
    );
  }

  // [S15069/T1721] REPAIR. This test used to pin `{turn, tags:["lane-tag"]}` —
  // v11's merged tag SET — which lane-model-v12 replaced with the two-sided
  // form over a year of releases ago in prompt-time terms, and which the
  // settlement note schema has refused ever since. The prompt kept teaching it
  // because this test kept it green: a verbatim-string pin protects the STRING,
  // not the CONTRACT, and it was pointed at a shape the tool cannot accept.
  //
  // The repair is not a new string. It is the test below it — the prompt is now
  // checked AGAINST the tool description that defines the shape, so the two
  // cannot drift apart again without one of them reddening.
  test("the two entry forms are the ones the tool actually accepts, with the draft rule", () => {
    const bullet = edgesBullet(renderPrompt());

    expect(bullet).toContain('An entry is a bare address ("S15069/T7") — a DRAFT');
    expect(bullet).toContain('`{ "turn": "S15069/T7", "tailTag": "a", "headTag": "b" }`');
    expect(bullet).toContain("`tailTag` names the lane THIS turn writes");
    expect(bullet).toContain("`headTag` the lane the cited turn sits in");
    // A draft is writable but not committable — the half of the rule whose
    // absence let a run finish its whole pass before commit told it otherwise.
    expect(bullet).toContain("does NOT survive `commit`");
    expect(bullet).toContain("error E6");
    // Each side answers to ITS OWN endpoint: identity is (segment, tag), so the
    // v11 reading — one tag set that both endpoints must carry — is gone.
    expect(bullet).toContain("checked against ITS OWN endpoint");
    expect(bullet).toContain("tags — write the member turns' tags first, then the edge.");

    // The retired v11 shape must not come back.
    expect(bullet).not.toContain('"tags": ["lane-tag"]');
    expect(bullet).not.toContain("UNTAGGED edge acting on the cited turn itself");
  });

  // The drift guard the verbatim pin above could not be: both texts are
  // rendered from source, and the SHAPE WORDS the tool contract uses must
  // appear in the prompt that teaches it. A future edit to either side that
  // renames a side field reddens here instead of shipping a prompt that
  // teaches an unwritable call.
  test("the prompt's edge shape agrees with the settlement tool's own contract", () => {
    const bullet = edgesBullet(renderPrompt());
    for (const word of ["tailTag", "headTag", "E6"]) {
      expect({ word, inContract: SETTLEMENT_NOTE_TOOL_DESCRIPTION.includes(word) }).toEqual({
        word,
        inContract: true,
      });
      expect({ word, inPrompt: bullet.includes(word) }).toEqual({ word, inPrompt: true });
    }
    // And the retired one appears in NEITHER.
    expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).not.toContain('"tags": ["lane-tag"]');
  });

  // Lane-declaration ticket 08: FORM LANES no longer discriminates an exact
  // tag set or resolves a branch — a lane is DECLARED, `(segment, ONE tag)` —
  // and a decision→delivery arc may now be ONE lane via a tagged cross-phase
  // edge instead of always splitting into two hinged by an untagged one.
  test("FORM LANES teaches declaration over discrimination, and a lane is no longer phase-local", () => {
    const bullet = edgesBullet(renderPrompt());

    expect(bullet).toContain("continue a fragment onto an");
    expect(bullet).toContain("EXISTING declared tag (check the task's own card, `recall`, for");
    expect(bullet).toContain("its declared lanes); `create` a fresh one only when none fits.");
    expect(bullet).toContain("`(task, ONE tag)` — no set to discriminate.");
    expect(bullet).toContain("A lane is not");
    expect(bullet).toContain("phase-local: a decision→delivery arc may be ONE lane, continued");
    // Lane-model v12 ticket 02: the continuation is ANY tagged edge. The old
    // sentence named the three "cross-phase words" as the ones that could
    // carry it — a word class that no longer exists, one of them (`refutes`)
    // no longer a word at all.
    expect(bullet).toContain("across that boundary by any TAGGED edge.");
    expect(bullet).not.toContain("cross-phase `grounds`");
    expect(bullet).not.toContain("refutes");
    expect(bullet).not.toContain("no phase to fix");
    expect(bullet).not.toContain("discriminating exact tag set");
    expect(bullet).not.toContain("proper-superset branch");
    expect(bullet).not.toContain("hinged by untagged cross-phase");
  });

  // lane-model-v12 ticket 04 deleted the lane-shape error class (E5), so
  // CHECK AND REPAIR no longer states a one-source/one-sink law at all. Its
  // two earlier readings — "a fork opens a BRANCH (a proper-superset tag set
  // rooted at the parent node)" and then "a fork is a shape error (E5)" —
  // are both retired; a fresh declared tag survives only as advice.
  test("CHECK AND REPAIR states no lane-shape law — a fork is neither a branch nor an error", () => {
    const bullet = edgesBullet(renderPrompt());

    expect(bullet).toContain("A lane's shape is no longer policed");
    expect(bullet).toContain("usually clearer under a fresh, independently declared tag.");
    expect(bullet).not.toContain("opens a BRANCH");
    expect(bullet).not.toContain("proper-superset tag set rooted at the parent node");
    expect(bullet).not.toContain("(E5)");
    expect(bullet).not.toContain("one source, one sink");
  });

  // T1466 (RB hand-off): the relations gate is enforced in `db/write-gate.ts`
  // (`checkRelationsGate`) and refuses an edge write from a run that never
  // read the citing turn's current relation set. Ticket 07: the read now
  // comes from BATCH STEP 1's own audit rather than a "Step 0" label, and a
  // stale one (a turn audited in an earlier batch, edited since) is re-read,
  // never guessed.
  test("an edge write is taught to need the citing turn's current relations read", () => {
    const bullet = edgesBullet(renderPrompt());

    expect(bullet).toContain("An edge write");
    expect(bullet).toContain("also needs your own current read of the citing turn's RELATIONS — the");
    expect(bullet).toContain("batch audits earn it, your own writes keep it current, and a");
    expect(bullet).toContain("stale one is re-read, never guessed.");
  });

  // Ticket 07: the old seven-step PER-THREAD procedure is gone, replaced by
  // a five-step procedure that runs ONCE, after the last batch, over the
  // ledger BATCH STEP 2/3 built.
  test("the five relation steps are present and ordered, ending in check-and-repair", () => {
    const bullet = edgesBullet(renderPrompt());

    const steps = [
      "1. DISPOSE every ledger candidate:",
      "2. FORM LANES across all batches:",
      "3. JUDGE AND WRITE.",
      "4. DECLARE CONVERGENCE, of a TURN and not of a lane.",
      "5. CHECK AND REPAIR.",
    ];
    let cursor = -1;
    for (const step of steps) {
      const at = bullet.indexOf(step);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }

    expect(bullet).toContain("All relation writes happen HERE, after the last batch, in five steps:");
    // DISPOSE: uncertainty never reads as CONVERGED — the trial's own root
    // cause for premature closure. The word was OPEN until lane state retired;
    // it now says STILL RUNNING, because OPEN named a lane state that no
    // longer exists and would have kept teaching one.
    expect(bullet).toContain("Uncertainty is STILL RUNNING, never");
    expect(bullet).toContain("CONVERGED.");
    // ... and the bullet says out loud that these three are dispositions of the
    // candidate, not a state the lane carries.
    expect(bullet).toContain("a state the lane carries");
    expect(bullet).not.toContain("Uncertainty is OPEN");
    // JUDGE AND WRITE: the stored word is evidence of nothing; the claim
    // test re-runs fresh every time.
    expect(bullet).toContain("ignore the stored relation word and run the claim test as if no");
    expect(bullet).toContain("edge existed — the old word is evidence of nothing.");
    // DECLARE CONVERGENCE (rewritten by lane-state-retirement ticket 01): the
    // question is asked of a TURN, work merely stopping is still not evidence,
    // and the granularity rule is stated as a WARNING and never a refusal.
    expect(bullet).toContain("4. DECLARE CONVERGENCE, of a TURN and not of a lane.");
    expect(bullet).toContain("Work merely stopping, or a batch ending, is");
    expect(bullet).toContain("never convergence evidence — producing the declaration is your");
    expect(bullet).toContain("node means the phase was cut too fine; `lane_check` says so as a");
    expect(bullet).toContain("WARNING, and no write refuses on it,");
    // The lane-state clause is gone in BOTH its halves.
    expect(bullet).not.toContain("leaving a lane honestly OPEN is normal life");
    expect(bullet).not.toContain("never closure evidence");
    // CHECK AND REPAIR is the whole reason a settlement window meets E1 at
    // all — repairs repeat step 3, never a fresh work plan.
    expect(bullet).toContain("ERRORS are a repair queue for the graph you already");
    expect(bullet).toContain("judged, never the work plan; every repair repeats step 3.");
  });

  // T1466 (finding P2-5): the routing for a turn that TESTED the cited claim
  // carries forward into JUDGE AND WRITE (step 3 of the new five) — a
  // verification must never fall back to `extends`, the nearest neighbour a
  // model reaches for.
  test("JUDGE AND WRITE routes a supporting check to verifies and a contrary one to override, never extends", () => {
    const bullet = edgesBullet(renderPrompt());

    expect(bullet).toContain("a check THIS turn produced that SUPPORTS the");
    expect(bullet).toContain("cited conclusion is verifies, never extends — one that goes against");
    expect(bullet).toContain("it is override;");
    // Lane-model v12 ticket 02: the fork the old line offered ("verifies or
    // refutes") is gone with the word, so the routing has to name where a
    // contrary result goes or a run reaches for `extends` again.
    expect(bullet).not.toContain("refutes");
  });
});

/**
 * SETTLEMENT-ERGONOMICS TICKET 02 (spec D2, `.scratch/settlement-ergonomics/`
 * — not the lane-declaration ticket of the same number): a real settlement
 * run (job 98, S15069/T901-1000) failed a dozen edge writes with "the
 * relations of S15069/T9xx were not delivered to this run" even though the
 * prompt already stated the read requirement as prose (the edges bullet's
 * own "An edge write also needs your own current read of the citing turn's
 * RELATIONS" sentence, pinned above). The fix is a copyable CALL SEQUENCE,
 * seated right before the edges bullet begins, and it has to dodge two traps
 * an example can fall into on its own: teaching a read whose default budget
 * truncates a high in-degree turn's relations (a truncated field earns no
 * complete-read grant, so the write right after it would be refused by the
 * same gate the sequence exists to satisfy), and offering the fan-out lane
 * route (`timeline(id="E<n>/L*")`), which accepts no budget parameter at all
 * and is itself a candidate to blow the tool-result cap.
 */
describe("ticket 02 (settlement-ergonomics D2) — the edge write call sequence", () => {
  function callSequenceText(prompt: string): string {
    const start = prompt.indexOf("   - before any edge write, run this call sequence");
    const end = prompt.indexOf("   - edges: `note`'s", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return prompt.slice(start, end);
  }

  test("gives a complete, addressed recall call for the citing turn's relations, with an EXPLICIT turn budget well above the default", () => {
    const sequence = callSequenceText(renderPrompt());

    expect(sequence).toContain(
      '`recall(id="S15069/T7", filter={fields:["relations"]},',
    );
    expect(sequence).toContain("turn=2000)`");
    expect(sequence).toContain("EXPLICIT, large `turn`");

    // The number itself must actually be large relative to the default per-
    // item budget — a literal-string pin alone would stay green even if the
    // prose forgot to say WHY 2000 was chosen, but this ties the two
    // together: whatever number is printed, it must clear the truncation
    // threshold by a wide margin.
    const budgetMatch = sequence.match(/turn=(\d+)\)/);
    expect(budgetMatch).not.toBeNull();
    expect(Number(budgetMatch![1])).toBeGreaterThan(DEFAULT_TURN_TOKEN_BUDGET * 5);
  });

  test("states the truncation trap and its recovery: raise the budget and re-read", () => {
    const sequence = callSequenceText(renderPrompt());

    expect(sequence).toContain("renders a high in-degree turn's relations");
    expect(sequence).toContain("TRUNCATED, and a truncated field earns no complete-read grant");
    expect(sequence).toContain("refused by the SAME gate");
    expect(sequence).toContain("truncated, raise the budget and re-read");
  });

  test("teaches only the single-lane timeline form; the fan-out E<n>/L* route never appears anywhere in the prompt", () => {
    const prompt = renderPrompt();
    const sequence = callSequenceText(prompt);

    expect(sequence).toContain('`timeline(id="E<n>/L<k>")`');
    expect(sequence).toContain("ONE lane, singular");

    // Not merely absent from this bullet — absent from the WHOLE rendered
    // prompt, since the failure mode is an example the model could copy from
    // anywhere in the text.
    expect(prompt).not.toContain("E<n>/L*");
    expect(prompt).not.toContain("/L*");
  });
});

/**
 * TAG-MANDATE TICKET 07 — the COMMIT CONTRACT (authored Block C, revision 7),
 * appended to duty 4. It is the one fact a caller must hold at the moment of
 * calling `commit`, and it is stated in two places on purpose (here and the
 * tool's own description, `note-settlement-sdk-query.ts`) — the description
 * is what survives into every retry, the prompt is what is read before the
 * first try.
 */
describe("ticket 07 — Block C: the commit paragraph carries the gate contract", () => {
  test("refusal condition, the free retry, out-of-scope errors, and one successful commit", () => {
    const prompt = renderPrompt();
    // Ticket 15: Block C moved from the numbered COMMIT duty into the Duties
    // preamble, bytes unchanged — `commit` writes nothing, so it states its
    // terminal contract where the two write duties are introduced.
    const preamble = prompt.slice(prompt.indexOf("## Duties"), prompt.indexOf("The lease is checked"));

    expect(preamble).toContain("`commit` is REFUSED while any ERROR `lane_check` reports anchors inside");
    expect(preamble).toContain("your writable set — the refusal lists exactly the rows to repair, and a");
    expect(preamble).toContain("refusal costs no attempt. Errors anchored outside your set belong to");
    expect(preamble).toContain("other windows and never block you. The job ends only through ONE");
    expect(preamble).toContain("SUCCESSFUL commit: a refusal is repaired and retried, and certainty that");
    expect(preamble).toContain("nothing changed still requires an empty-handed successful commit.");
  });

  // ABSENCE pin (ticket 07, retired teaching #2): the old "call lane_check
  // early" advice is gone from the commit paragraph — Block A now forbids
  // calling it during the batch loop, and Block B's own step 5 (CHECK AND
  // REPAIR) is where it belongs instead.
  test("the retired 'call lane_check early' sentence is gone", () => {
    const prompt = renderPrompt();
    const preamble = prompt.slice(prompt.indexOf("## Duties"), prompt.indexOf("The lease is checked"));

    expect(preamble).not.toContain("Call `lane_check` early");
    expect(preamble).not.toContain("its WARNINGS inform judgment and never block.");
  });
});

/**
 * TAG-MANDATE TICKET 07 — the Duties preamble's own commit phrase (revision
 * 7's integration note, not one of Blocks A-D but authored the same way): a
 * gate REFUSAL is still a `commit` call, so "exactly one `commit`" let a run
 * read its own refusal as the one commit it was allowed and stop there.
 */
describe("ticket 07 — the Duties preamble states one SUCCESSFUL commit, and a refusal is not it", () => {
  test("the preamble carries the amended phrase, and the retired phrasing is gone", () => {
    const prompt = renderPrompt();
    const duties = prompt.slice(prompt.indexOf("## Duties"), prompt.indexOf("The lease is checked"));

    expect(duties).toContain("by one SUCCESSFUL `commit`; a refusal is not that commit, once you");
    expect(duties).toContain("believe there is nothing further to add.");
    expect(duties).not.toContain("exactly one `commit`");
  });
});

/**
 * Ticket 11 (edge-ownership-impl, "统一 Memory Rubric"), re-aimed by
 * lane-model-v12 ticket 12: the two consumers must share the CONCEPTS half
 * byte-for-byte, and must NOT share the rest. The main agent's slot carries
 * concepts + its own action principles in one block; the settlement prompt
 * carries concepts alone and states its own actions in `## Duties`. Exercised
 * HERE, against a real settlement prompt (this file's own fixture), rather
 * than only comparing each side to the shared constant in isolation — a future
 * edit that wrapped one side differently would still fail this cross-check.
 */
describe("ticket 12 — the CONCEPTS half renders byte-identical in both consumers, and only that half", () => {
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
    const prompt = renderPromptFor(context, db);

    const sessionStartBlock = renderRubricBlock();

    // The settlement prompt carries the concepts-only block whole…
    expect(prompt).toContain(renderMemoryRubricConceptsBlock());
    // …and the SessionStart slot is exactly the two-half block.
    expect(sessionStartBlock).toBe(renderMainAgentRubricBlock());

    // Byte-for-byte on the SHARED half: extract each consumer's own copy of
    // the concepts text and compare those, not the wrappers — the wrappers
    // legitimately differ now (`actions="…"` rides only on the main agent's).
    const promptRubric = prompt.slice(
      prompt.indexOf("<mnemo-memory-rubric"),
      prompt.indexOf("</mnemo-memory-rubric>") + "</mnemo-memory-rubric>".length,
    );
    expect(promptRubric).toContain(MEMORY_RUBRIC_CONCEPTS_TEXT);
    expect(sessionStartBlock).toContain(MEMORY_RUBRIC_CONCEPTS_TEXT);

    // The half that must NOT cross: the main agent's action principles are
    // imperatives about keeping per-turn notes, which is not this pass's job.
    expect(prompt).not.toContain(MEMORY_RUBRIC_MAIN_ACTIONS_TEXT);
    expect(prompt).not.toContain("## 记录 —— 管好每一轮");
    expect(promptRubric).not.toContain("actions=");

    db.close();
  });

  /**
   * Ticket 15 retired the session duty and MOVED Block D1's honesty rule out
   * of it, into the Output tail — its rule is about the narration this run
   * produces, not about the session field. Ticket 22 restored the duty (as
   * SESSION FIELDS, pinned by its own describe below) and deliberately did NOT
   * take D1 back with it: a reporting rule inside a write duty is where it was
   * misfiled in the first place.
   *
   * So what this test pins is the SEPARATION — D1 lives in the Output tail,
   * after `## Output` and before the closing paragraph — plus the retired
   * wording that must not return with the duty (`SESSION NARRATIVE` as a duty
   * heading, and the "no append" framing the shared mode vocabulary replaced).
   */
  test("Block D1's honesty rule stays in the Output tail, not inside the restored session duty", () => {
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
    const prompt = renderPromptFor(context, db);

    expect(prompt).not.toContain("SESSION NARRATIVE");

    // The shared mode vocabulary is still taught — duty 1's prose fields and
    // duty 3's session fields use exactly the same two words.
    expect(prompt).toContain('mode.<field>: "write"');
    expect(prompt).toContain('{ mode: "edit", oldString, newString }');
    expect(prompt.toLowerCase()).not.toContain("no append");

    // Block D1, verbatim, now in the Output tail.
    expect(prompt).toContain(
      "Narrate only writes that actually landed in this run: never infer counts",
    );
    expect(prompt).toContain("or claim a range fully conforming from `lane_check` — use successful");
    expect(prompt).toContain("tool receipts, or omit the claim.");
    expect(prompt.indexOf("## Output")).toBeLessThan(
      prompt.indexOf("Narrate only writes that actually landed"),
    );
    expect(prompt.indexOf("Narrate only writes that actually landed")).toBeLessThan(
      prompt.indexOf("Make your `remember`/`note` tool calls as you decide them"),
    );

    db.close();
  });
});

/**
 * Ticket 04 ([S15069/T963]): lookback = window size. Tag-mandate ticket 06
 * kept the SIZING rule and retired the rendering it used to feed — so the
 * same fixture now proves the scope reaches T26-T75 by reading the DECLARED
 * writable set rather than a rendered turn section.
 */
describe("ticket 04 — lookback scales with the window; ticket 06 declares it instead of rendering it", () => {
  test("a 25-turn window declares 25 preceding turns plus its own 25, 50 in total", () => {
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
    // reviewableTurnIds is exactly the 50 in-scope turns — no more, no less.
    expect(context.reviewableTurnIds.size).toBe(50);

    const prompt = renderPromptFor(context);
    // The two retired section captions, and the unified one that replaced
    // them, are all gone: there is no turn section at all any more.
    expect(prompt).not.toContain("## Turns");
    expect(prompt).not.toContain("Preceding turns");
    expect(prompt).not.toContain("Window turns (settle exactly these)");

    const block = prompt.slice(
      prompt.indexOf("WRITABLE SET:"),
      prompt.indexOf("## Duties"),
    );
    expect(block).toContain("window — settle these (25):");
    expect(block).toContain("declared lookback — equally writable (25):");
    for (let promptNumber = 26; promptNumber <= 75; promptNumber += 1) {
      expect(block).toContain(`S${sessionDbId}/T${promptNumber}`);
    }
    // T25 is out of reach — and the check has to be anchored, since
    // "S1/T25" is a prefix of "S1/T250" and of nothing else here.
    expect(block).not.toMatch(new RegExp(`S${sessionDbId}/T25(?![0-9])`));
  });
});

/**
 * Ticket 04 (edge-mechanism-revision D7): the settlement-specific half of the
 * prompt. Four things the shared rubric cannot say, plus the two retirements
 * whose WORDING must not outlive them.
 */
describe("ticket 04 — the settlement prompt's own four sections (D7)", () => {
  test("task framing, authority, procedure and commit are all present, in that order", () => {
    const prompt = renderPrompt();

    // Hindsight task frame: check OR rebuild; a backfill window rebuilds from
    // zero (the acceptance criterion's own words).
    expect(prompt).toContain("HINDSIGHT pass over this window");
    expect(prompt).toContain("Check or rebuild the notes");
    expect(prompt).toContain("rebuild FROM ZERO");
    // Authority statement.
    expect(prompt).toContain("## Your authority");
    expect(prompt).toContain("main agent's own write surface");
    // Procedure (ticket 07): the batched workstations replaced the old
    // supply/correct/retract triad — see the Block A describe below for the
    // full pin set.
    expect(prompt).toContain("## Procedure");
    expect(prompt).toContain("Work the WHOLE writable set in chronological batches of ten turns");
    expect(prompt).toContain("BATCH STEP 1 — TURN AUDIT");
    expect(prompt).toContain("BATCH STEP 2 — CONTENT CANDIDATES");
    expect(prompt).toContain("BATCH STEP 3 — BACK-LINK");
    // Commit as the terminal check, last.
    expect(prompt.indexOf("## Your task")).toBeLessThan(prompt.indexOf("## Your authority"));
    expect(prompt.indexOf("## Your authority")).toBeLessThan(prompt.indexOf("## Procedure"));
    // Ticket 15: `commit`'s contract sits in the Duties preamble now, which is
    // still after the procedure — the ORDER this test pins is unchanged.
    expect(prompt.indexOf("## Procedure")).toBeLessThan(prompt.indexOf("## Duties"));
    expect(prompt.indexOf("## Duties")).toBeLessThan(prompt.indexOf("2. LANES,"));
  });

  test("the shared concepts block is still what the prompt teaches judgment from", () => {
    const prompt = renderPrompt();

    // The shared half, byte-identical with the SessionStart injection's
    // (pinned in full by the describe above this one).
    expect(prompt).toContain(renderMemoryRubricConceptsBlock());
    expect(prompt).toContain('concepts="');
  });
});

/**
 * Ticket 01 (semantic-conformance spec, ruling [S15069/T1396]): the
 * RECONCILIATION duty's preamble states the two-branch split — MISSING or
 * NON-CONFORMING annotations are re-annotated from scratch, exactly as a
 * first writer would judge them today; CONFORMING annotations keep the
 * existing check/correct/supplement discipline. Job 76 left 82/96
 * legacy-typed turns untouched because the old prompt read them as
 * keepable standing content once a window was "already written" — every
 * assertion below is pinned as a substring INSIDE duty 2 itself (not
 * merely present somewhere in the prompt), because the ticket's own
 * deliverable is duty 2's framing, not a free-floating sentence.
 */
describe("ticket 01 — RECONCILIATION states re-annotate-non-conforming / check-correct-supplement-conforming", () => {
  function duty2Text(prompt: string): string {
    // Ticket 15 renamed this duty (RECONCILIATION -> TURN FIELDS) and made it
    // duty 1; its two-branch conformance framing is untouched.
    return prompt.slice(
      prompt.indexOf("1. TURN FIELDS"),
      prompt.indexOf("   - notes: `note` with `turn` plus `title`"),
    );
  }

  test("the MISSING/NON-CONFORMING branch: re-annotate from scratch, as a first writer would, not a correction", () => {
    const prompt = renderPrompt();
    const duty2 = duty2Text(prompt);

    expect(duty2).toContain("MISSING");
    expect(duty2).toContain("NON-CONFORMING");
    expect(duty2).toContain("RE-ANNOTATED FROM SCRATCH");
    expect(duty2).toContain("as a first writer would today");
    expect(duty2).toContain("the old word being retired IS the nonconformity");
    expect(duty2).toContain("not a mistake to");
  });

  test("the CONFORMING branch keeps the existing check/correct/supplement discipline", () => {
    const prompt = renderPrompt();
    const duty2 = duty2Text(prompt);

    expect(duty2).toContain("CONFORMING");
    expect(duty2).toContain("keeps the ordinary discipline");
    expect(duty2).toContain(
      "correct the explicit, supplement what is missing, leave doubt alone",
    );
  });

  test("the closed vocabulary is NAMED as the conformance test for `type`, not restated", () => {
    const prompt = renderPrompt();
    const duty2 = duty2Text(prompt);

    expect(duty2).toContain("conformance means every word is a member of the closed vocabulary");
    // Pointer discipline: duty 2's OWN prose never repeats the word list or
    // its definitions — those stay the Rubric's one copy. (The words do
    // appear elsewhere in the full prompt, inside the injected Rubric
    // block itself — this checks duty 2's own added prose only.)
    for (const word of MEMORY_TYPES) {
      expect(duty2).not.toContain(`"${word}"`);
    }
  });

  test("the split is uniform across window kinds — no backfill/check special-casing", () => {
    const prompt = renderPrompt();
    const duty2 = duty2Text(prompt);

    expect(duty2).toContain("follows the SAME rule on every window, backfill or check");
    // The pre-era gate (`allow_pre_era`) and its wording live entirely in
    // the worker's job-claiming path (db/note-settlement.ts, server.ts),
    // never in this prompt — nothing here special-cases it, so there is
    // nothing to name or exclude.
    expect(prompt).not.toContain("pre-era");
    expect(prompt).not.toContain("allow_pre_era");
  });
});

/**
 * ticket 07 (spec "settlement agent — batched procedure"): `lane_check`
 * moves OUT of the Procedure section entirely — Block A now forbids calling
 * it during the batch loop, and it is instead the last of Block B's five
 * relation steps (CHECK AND REPAIR, pinned by the edges-bullet describe
 * above). rubric-v10 ticket 06's old advisory sentence (a Procedure-area
 * call the agent might make once, after its own first pass) retires with
 * the per-window shape it belonged to.
 */
describe("ticket 07 — lane_check is forbidden inside the batch loop; the check lands in Block B instead", () => {
  test("the procedure forbids calling lane_check during the batch loop", () => {
    const prompt = renderPrompt();
    const procedure = prompt.slice(prompt.indexOf("## Procedure"), prompt.indexOf("## Duties"));

    expect(procedure).toContain("Do not call `lane_check` during the");
    expect(procedure).toContain("batch loop.");
  });

  // ABSENCE pin: the retired per-window advisory sentence and the retired
  // supply/correct/propose routing phrase it used must not survive.
  test("the retired per-window lane_check advisory sentence is gone", () => {
    const prompt = renderPrompt();
    const procedure = prompt.slice(prompt.indexOf("## Procedure"), prompt.indexOf("## Duties"));

    expect(procedure).not.toContain("this window's own scope and route");
    expect(procedure).not.toContain("supply/correct/propose");
    expect(procedure).not.toContain("never a write obligation on its own");
  });

  test("no pre-existence fence and no differential wording survives anywhere", () => {
    const prompt = renderPrompt();

    // The retired C7 fence.
    expect(prompt).not.toContain("must already be a pair that existed");
    expect(prompt).not.toContain("before this run started");
    expect(prompt).not.toContain("not eligible for a relation");
    // The retired "settlement is the surface that lacks things" framing.
    expect(prompt.toLowerCase()).not.toContain("no append");
    expect(prompt).not.toContain("no longer settlement's to write");
    expect(prompt).not.toContain("the main agent is the note's sole writer");
    expect(prompt).not.toContain("RE-CHECK, not a first write");
  });

  // Tag-mandate ticket 06: the retraction mirrors are no longer ENUMERATED
  // (`retractOverride/retractNarrows/…`, derived from `EDGE_RELATIONS`). The
  // authored edges bullet states them as a PATTERN plus the one fact the
  // enumeration never carried — that they still accept bare addresses, which
  // is what keeps a legacy untagged row deletable at all once the assertion
  // side went tagged-only. Both halves pinned.
  test("the prompt teaches the retraction mirrors", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("The\n     `retract<Relation>` mirrors delete one row each and still accept bare");
    expect(prompt).toContain("addresses (legacy rows stay deletable)");
    // Ticket 15: the membership `create` verb this test used to pin alongside
    // them retired, and the roster advice it carried went with it.
    expect(prompt).not.toContain('`action="create"`');
    expect(prompt).not.toContain("joining an existing segment beats opening");
  });

  // Indexes-rescope ticket 04: the edge vocabulary this prompt states named
  // `indexes`, and the rejection examples beside it named a check that law 2
  // retired (an out-of-branch collects target no longer fails anything). Both
  // halves are still pinned — the word must appear, and no retired word may
  // survive in the prose around it, where it would teach settlement to avoid
  // legal calls. Ticket 06 note: the word list is authored prose now rather
  // than a render of `EDGE_RELATIONS`, so this test is the guard that a
  // vocabulary change actually reached the bullet.
  test("the prompt speaks indexes and states no retired rejection", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("indexes");
    // The authored bullet's own field list, exact — a relation dropped from
    // it (or a retired one re-added) fails here.
    expect(prompt).toContain(
      "`note`'s override/narrows/extends/consume/indexes/grounds/\n     verifies fields",
    );
    expect(prompt).not.toContain("collects");
    expect(prompt).not.toContain("out-of-branch");
  });

  // The prompt sends settlement to the rubric BY SECTION NAME, and those names
  // are prose on this side and a heading on the other — nothing linked them.
  // The v6 full-English ruling renamed the headings while this prompt kept
  // pointing at 关系/归属, so for three releases it named sections the rubric no
  // longer had: a reader following the pointer finds nothing and falls back to
  // instinct, which is the silent half of a teaching bug. Every section this
  // prompt names must exist as a real heading.
  // Lane-model-v12 ticket 12 changed the shape a pointer has to take. v12's
  // concepts text has NO `## ` headings at all — it is a list of bolded
  // ENTRIES (`**type**`, `**tags**`, `**段**`) — so the old "the Rubric's
  // Segments section" form would resolve to nothing on every reading, which is
  // exactly the silent teaching bug this test was written for. The pointer form
  // is now "the Memory Rubric's **<entry>** entry", and the label set comes
  // from the concepts text itself.
  test("every rubric entry the prompt points at is a real entry in the concepts half", () => {
    const prompt = renderPrompt();
    const entries = new Set(
      [...MEMORY_RUBRIC_CONCEPTS_TEXT.matchAll(/\*\*([^*\n]+)\*\*/g)].map((match) => match[1]!),
    );
    expect(entries.size).toBeGreaterThan(0);

    const referenced = [...prompt.matchAll(/\*\*([^*\n]+)\*\* entr(?:y|ies)/g)].map(
      (match) => match[1]!,
    );
    expect(referenced.length).toBeGreaterThan(0);

    for (const name of referenced) {
      expect([...entries], `the prompt points at a rubric entry that does not exist: ${name}`)
        .toContain(name);
    }

    // And the retired pointer FORM must not come back: a `## `-heading pointer
    // cannot resolve against a document with no headings.
    expect(prompt).not.toMatch(/Memory Rubric'?s(?: own)? \S+ (?:section|checklist)/);
  });
});

// ---------------------------------------------------------------------------
// The stitch (read-write-contract, ticket 07's deferred half): the session
// summary renders through the UNIFIED renderer at sole-writer budgets, and
// that render is itself the read grant the narrative write consumes.
// ---------------------------------------------------------------------------

describe("stitch — the session summary is the unified renderer's full-document view", () => {
  test("a >2000-token narrative renders whole, and the render grants the session to the claim writer", () => {
    const longContent = Array.from({ length: 2_500 }, (_, i) => `sentence${i}`).join(" ");
    const sessionDbId = upsertSession(db, {
      contentSessionId: "settlement-stitch-session",
      project: "/tmp/project-settlement-stitch",
      title: "stitch fixture",
      content: longContent,
      insight: null,
      createdAtEpoch: NOW - 10_000,
      updatedAtEpoch: NOW - 10_000,
      completedAtEpoch: null,
    }).id;
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;

    // Whole document, no elision marker, no recall pointer the settlement
    // agent could not follow anyway.
    expect(context.sessionStateRendering).toContain("sentence2499");
    expect(context.sessionStateRendering).not.toContain("state truncated");

    const grant = db
      .query<{ count: number }, [string, number]>(
        "SELECT COUNT(*) AS count FROM write_gate_reads WHERE writer = ? AND entity_type = 'session' AND entity_id = ?",
      )
      .get(claimWriterId(job.id, job.claimGeneration, job.stage), sessionDbId);
    expect(grant?.count).toBe(1);
  });
});

/**
 * ticket 07, Block D2: the output tail's old no-op exemption clause
 * ("(or if you are certain there is nothing to do)") retires — a REFUSED
 * `commit` is still a commit call, so that wording let a run treat its own
 * refusal as the exit. The replacement restates Block C's own rule at the
 * output boundary: certainty that nothing changed still requires an
 * empty-handed successful commit.
 */
describe("ticket 07 — Block D2 replaces the output tail's no-op exemption clause", () => {
  function outputText(prompt: string): string {
    return prompt.slice(prompt.indexOf("## Output"));
  }

  test("commit succeeds unconditionally before the short-reply rule, and certainty still requires a commit", () => {
    const output = outputText(renderPrompt());

    expect(output).toContain("After `commit` succeeds, ");
    expect(output).toContain("a short final reply is enough — no JSON, no schema. Certainty that ");
    expect(output).toContain("nothing changed still requires an empty-handed successful commit.");
  });

  // ABSENCE pin (ticket 07, retired teaching #3): the no-op commit
  // exemption clause is gone, so a future merge cannot resurrect the
  // reading that let a run skip `commit` entirely.
  test("the retired no-op commit exemption clause is gone", () => {
    const output = outputText(renderPrompt());

    expect(output).not.toContain("or if you are certain there is nothing to do");
  });
});

describe("ticket 06/07 — the authored text integrates VERBATIM, every word (acceptance guard)", () => {
  // The blocks in .scratch/tag-mandate/issues/06-prompt-text.md are the main
  // agent's personally authored settlement teaching (ruling T1452: never
  // delegated, never paraphrased). The sampled-substring pins above cannot
  // catch a one-word drift between pins — this guard word-normalizes both
  // sides and requires each block to appear as ONE contiguous word sequence
  // in the rendered prompt. Same .scratch-fixture precedent as the
  // rubric-v10 golden.
  const words = (text: string): string => text.split(/\s+/).filter(Boolean).join(" ");

  function readAuthoredSections(): string[] {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const authored = readFileSync(
      new URL("../../.scratch/tag-mandate/issues/06-prompt-text.md", import.meta.url),
      "utf8",
    );
    return authored.split(/^## Block /m).slice(1);
  }

  test("revision 7 authors exactly four blocks (A, B, C, D)", () => {
    expect(readAuthoredSections().length).toBe(4);
  });

  // Lane-declaration ticket 08 hand-amended three spans inside Block B (see
  // note-settlement-prompt.ts's own "LANE-DECLARATION TICKET 08'S AMENDMENT"
  // comment), so Block B is EXCLUDED here — indices 0 and 2 only (A and C),
  // which stay untouched, byte-for-byte, from the tag-mandate archive. Block
  // B gets its own test below, which applies the SAME three amendments to
  // the archived text before checking for a contiguous match, so a future
  // edit to either side (the archive or the prompt) that lets them drift
  // apart in an UNAMENDED span still fails here.
  test("block C appears as a contiguous word sequence", () => {
    const section = readAuthoredSections()[2]!;
    const body = section.slice(section.indexOf("\n") + 1).trim();
    expect(body.length).toBeGreaterThan(0);
    expect(words(renderPrompt()).includes(words(body))).toBe(true);
  });

  // Block A, WITH lane-model-v12 ticket 15's ONE amendment applied to the
  // archived text before comparison — the same narrowed-guard shape block B
  // has carried since lane-declaration ticket 08. BATCH STEP 1's membership
  // clause named `reassign`, a verb ticket 15 retired; the criterion it states
  // is unchanged, only the move it names. A drift anywhere else in block A
  // still fails here.
  test("block A appears as a contiguous word sequence once ticket 15's amendment is applied", () => {
    const section = readAuthoredSections()[0]!;
    const body = words(
      section
        .slice(section.indexOf("\n") + 1)
        .replace(/WRITABLE SET:\s*\{WRITABLE_SET\}\s*$/m, "")
        .trim(),
    );

    const amended = body.replace(
      words(
        "does membership match content against the roster (homeless is legal " +
          "by itself — reassign only when one destination is obvious from " +
          "content, never from adjacency, a shared project noun or a checker " +
          "warning). Turn-local corrections — notes, type, tags, membership — " +
          "may land now.",
      ),
      words(
        "does the task tag in its `tags` match content against the roster " +
          "(unowned is legal by itself — write a task tag only when one " +
          "destination is obvious from content, never from adjacency, a shared " +
          "project noun or a checker warning). Turn-local corrections — notes, " +
          "type, tags — may land now.",
      ),
    );
    // The guard against a mistyped `.replace()`: an unmatched needle would
    // leave `amended` equal to `body` and silently re-check the RETIRED text.
    expect(amended).not.toBe(body);
    expect(words(renderPrompt()).includes(amended)).toBe(true);
  });

  // Block B, WITH lane-declaration ticket 08's three amendments applied to
  // the archived text before comparison — the same guard shape as above,
  // narrowed to admit exactly the known, named amendments and nothing else.
  // A drift anywhere else in Block B (a hand-edit that missed the header
  // comment, or a future edit to the archive) still fails this test.
  //
  // Word-normalized BEFORE the three `.replace()` calls (not after, unlike
  // the plain block-A/C check above): the archived file's own indentation
  // (2 spaces on the bullet, 5 on numbered sub-items) makes an exact
  // multi-line literal match brittle, and `words()` is idempotent, so
  // normalizing first costs nothing and removes that fragility entirely.
  test("block B appears as a contiguous word sequence once every recorded amendment is applied", () => {
    const section = readAuthoredSections()[1]!;
    const body = words(section.slice(section.indexOf("\n") + 1).trim());

    const amended = body
      // Lane-model v12 ticket 02, amendment A: the field list loses the
      // merged eighth word.
      .replace(
        words("verifies/refutes fields. An entry is a bare address"),
        words("verifies fields. An entry is a bare address"),
      )
      // Lane-model v12 ticket 02, amendment B: step 3's word discriminator.
      // `refutes` is gone, so a check that came out AGAINST the cited claim
      // needs somewhere to go or a run reaches for `extends` — the failure
      // T1466 measured. The "same phase" and "from another phase" qualifiers
      // go with the phase axis.
      .replace(
        words(
          "narrows; replaced outright = override; merely used, same phase = " +
            "consume; a check THIS turn produced, for or against the cited " +
            "conclusion, is verifies or refutes, never extends; an evidence " +
            "product cited from another phase takes `grounds`. Shared topic,",
        ),
        words(
          "narrows; replaced, withdrawn or disproved outright = override; " +
            "merely used = consume; a check THIS turn produced that SUPPORTS the " +
            "cited conclusion is verifies, never extends — one that goes against " +
            "it is override; work this turn stands or falls with takes " +
            "`grounds`. Shared topic,",
        ),
      )
      // [S15069/T1721] amendment: THE ENTRY FORMS THEMSELVES.
      //
      // The archived text below is v11's — a bare address meaning "untagged,
      // acting on the cited turn" and a tagged entry carrying a merged tag SET.
      // lane-model-v12 replaced both with a draft and a TWO-SIDED placement,
      // and the settlement note schema has accepted only those since. This
      // guard is why the prompt kept teaching the retired pair for so long:
      // it holds its own copy of the authored text and asserts the prompt
      // still contains it, so correcting the prompt reddened the guard and
      // leaving it wrong kept everything green. A verbatim archive protects
      // the STRING; only an amendment recorded here can move the contract.
      .replace(
        words(
          "verifies fields. An entry is a bare address (\"S15069/T7\") — an " +
            "UNTAGGED edge acting on the cited turn itself — or a tagged entry " +
            "`{ \"turn\": \"S15069/T7\", \"tags\": [\"lane-tag\"] }` acting on the named " +
            "LANE. extends/narrows accept ONLY the tagged form: continuation names " +
            "its line. An edge's tags must already sit on BOTH endpoint turns' own",
        ),
        words(
          "verifies fields. An entry is a bare address (\"S15069/T7\") — a DRAFT, " +
            "both sides UNSETTLED — or a TWO-SIDED entry " +
            "`{ \"turn\": \"S15069/T7\", \"tailTag\": \"a\", \"headTag\": \"b\" }`, which " +
            "places each END in a lane: `tailTag` names the lane THIS turn writes " +
            "FROM, `headTag` the lane the cited turn sits in. The same word on both " +
            "sides is ONE lane spanning the edge; two different words are a legal " +
            "CROSSING; the same word in two different tasks is a crossing too, " +
            "since a lane's identity is (task, tag). A draft is ACCEPTED when you " +
            "write it but does NOT survive `commit` — every edge in your writable " +
            "set with an empty side is error E6, and commit refuses while one " +
            "remains. Place both sides before you finish, or retract the row. Each " +
            "PLACED side is checked against ITS OWN endpoint: the lane must already " +
            "be DECLARED in the task THAT endpoint belongs to, and the tag must " +
            "already sit on that endpoint turn's own",
        ),
      )
      .replace(
        words(
          "2. FORM LANES across all batches: merge fragments, choose the smallest " +
            "discriminating exact tag set and one phase, resolve continuation " +
            "versus proper-superset branch, and identify each lane's source, " +
            "frontier and surviving core. Never the segment's own tags. A batch " +
            "boundary contributes no topology — it is never a source, sink, " +
            "branch point or convergence signal. A decision→delivery arc is TWO " +
            "lanes, hinged by untagged cross-phase `grounds`.",
        ),
        words(
          "2. FORM LANES across all batches: continue a fragment onto an " +
            "EXISTING declared tag (check the task's own card, `recall`, for " +
            // [S15069/T1738]: `declare` -> `create` here, inside ticket 08's own
            // REPLACEMENT text rather than as a fourth amendment — the same
            // sentence changing twice reads better as one current value than as
            // a chain. The ARCHIVE side above is untouched, so the guard's
            // needle still matches and `amended !== body` still has teeth.
            "its declared lanes); `create` a fresh one only when none fits. Identity is " +
            "`(task, ONE tag)` — no set to discriminate. " +
            "Identify each lane's source, frontier and surviving core. Never " +
            "the task's own tags. A batch boundary contributes no topology — " +
            "it is never a source, sink or convergence signal. A lane is not " +
            "phase-local: a decision→delivery arc may be ONE lane, continued " +
            "across that boundary by any TAGGED edge.",
        ),
      )
      .replace(
        words(
          "write. Keep each lane one source, one sink: diamonds that re-merge " +
            "are fine; a fork the lane never re-joins opens a BRANCH — a " +
            "proper-superset tag set rooted at the parent node.",
        ),
        words(
          "write. A lane's shape is no longer policed: a fork the lane never " +
            "re-joins is not an error, though an independent line of work is " +
            "usually clearer under a fresh, independently declared tag.",
        ),
      )
      // lane-state-retirement ticket 01 amendment: STEP 4 ITSELF.
      //
      // The archived step asked a question about a LANE — is this lane
      // finished, and is it honest to leave it OPEN — which a bounded window
      // cannot answer; answering it honestly meant declining, which is why
      // `index` was used ONCE in 819 edges. It now asks the question the
      // window CAN answer, about a TURN, and carries the granularity rule the
      // rubric gained in the same batch.
      .replace(
        words(
          "4. DECLARE CONVERGENCE. Only a candidate disposed CONVERGED writes a " +
            "TAGGED `indexes`, from its actual last node to the surviving core. " +
            "Work merely stopping, a batch ending, or an existing declaration is " +
            "never closure evidence — producing the declaration is your job, and " +
            "leaving a lane honestly OPEN is normal life.",
        ),
        words(
          "4. DECLARE CONVERGENCE, of a TURN and not of a lane. Ask: did this " +
            "turn close out a stretch of work — a design settled, an " +
            "implementation landed, a batch verified, a version shipped? If it " +
            "did, it writes an `indexes` citing the nodes that genuinely " +
            "produced that ONE result. A lane may converge more than once — " +
            "each finished stretch earns its own declaration, and an earlier " +
            "one neither blocks nor substitutes for a later one. " +
            "CITE THE BATCH — one `/to-spec` run, one release. A single cited " +
            "node means the phase was cut too fine; `lane_check` says so as a " +
            "WARNING, and no write refuses on it, so finish the batch rather " +
            "than trimming it. Work merely stopping, or a batch ending, is " +
            "never convergence evidence — producing the declaration is your " +
            "job, and having nothing to declare this round is normal life.",
        ),
      )
      // lane-state-retirement follow-up amendment: STEP 1'S TRIAGE WORD.
      //
      // Ticket 01 rewrote step 4 and left step 1 alone, so the triage still
      // read NOT A LANE / OPEN / CONVERGED — and OPEN was a lane state that
      // ticket 01 had just deleted. A word that names a retired concept keeps
      // teaching it however carefully the rest of the prompt avoids it, so the
      // word moves to one that describes the CANDIDATE, and the bullet now
      // says out loud that these three are dispositions rather than a state
      // the lane carries.
      .replace(
        words(
          "1. DISPOSE every ledger candidate: NOT A LANE, OPEN, or CONVERGED — " +
            "exactly one each. Uncertainty is OPEN, never CONVERGED. NOT A LANE",
        ),
        words(
          "1. DISPOSE every ledger candidate: NOT A LANE, STILL RUNNING, or " +
            "CONVERGED — exactly one each. Uncertainty is STILL RUNNING, never " +
            "CONVERGED. These three describe THIS CANDIDATE at this moment, not " +
            "a state the lane carries: a lane has none, so a CONVERGED " +
            "disposition closes nothing and a later member contradicts nothing. " +
            "NOT A LANE",
        ),
      )
      // Severed-lane-teaching ticket 01 (user ruling 2026-08-27): step 5
      // (CHECK AND REPAIR) gains one instruction, appended after its
      // existing close — the earlier "Keep each lane..." amendment above
      // already rewrote that close, so this needle matches the OUTPUT of
      // that amendment, not the raw archive.
      .replace(
        words(
          "write. A lane's shape is no longer policed: a fork the lane never " +
            "re-joins is not an error, though an independent line of work is " +
            "usually clearer under a fresh, independently declared tag.",
        ),
        words(
          "write. A lane's shape is no longer policed: a fork the lane never " +
            "re-joins is not an error, though an independent line of work is " +
            "usually clearer under a fresh, independently declared tag. A lane " +
            "this window wrote a member or edge into owes more than a read of " +
            "the WARNING: when Report 2 shows it SEVERED within the scope " +
            "view, read the disconnected pieces' candidate turns to their " +
            "full text — the same untruncated read any edge write already " +
            "requires — and either write the stitching edge a genuine " +
            "use-relation supports (adjacency is not use, and a chronology " +
            "bridge invented to silence the warning is worse than the " +
            "warning) or name, in your final reply, the components and why " +
            "they stand apart. A lane this window never touched owes nothing " +
            "here.",
        ),
      )
      // Severed-lane ticket 02 amendment: the teaching-only sentence above
      // UPGRADES to the mandatory-disposition mechanism (stitch
      // self-evidences, or `remember(justify, …)` bound to a read receipt +
      // full-content grant), and phase-connectivity ticket 01 appends its
      // own report-only teaching immediately after — see
      // note-settlement-prompt.ts's own file-header comments for both.
      .replace(
        words(
          "A lane this window wrote a member or edge into owes more than a " +
            "read of the WARNING: when Report 2 shows it SEVERED within the " +
            "scope view, read the disconnected pieces' candidate turns to " +
            "their full text — the same untruncated read any edge write " +
            "already requires — and either write the stitching edge a " +
            "genuine use-relation supports (adjacency is not use, and a " +
            "chronology bridge invented to silence the warning is worse than " +
            "the warning) or name, in your final reply, the components and " +
            "why they stand apart. A lane this window never touched owes " +
            "nothing here.",
        ),
        words(
          "A lane this window wrote a member or edge into owes more than a " +
            "read of the WARNING: when Report 2 shows it SEVERED within the " +
            "scope view, EDGE FIRST — read the disconnected pieces' candidate " +
            "turns to their full text (page through the lane with " +
            "`recall(id=\"E<n>/#<tag>\")` until every page is covered — a " +
            "partial read does not qualify) and write the stitching edge a " +
            "genuine use-relation supports; adjacency is not use, and a " +
            "chronology bridge invented to silence the warning is worse than " +
            "the warning. A GENUINE STITCH SELF-EVIDENCES — once written, the " +
            "next `lane_check` no longer reports that fracture, and nothing " +
            "further is owed for it. If no stitch is genuine, call " +
            "`remember(justify, id, tag, representative, otherRepresentative, " +
            "reason)` naming BOTH components' current representative turns " +
            "(lane_check's SEVERED report names them) and why none of the " +
            "seven relation words applies — refused unless you have fully " +
            "recalled the lane AND hold a full-content grant on " +
            "`otherRepresentative`, which is what makes \"you read it first\" " +
            "checkable rather than merely asked for. `commit` REFUSES while " +
            "any fracture this window touched carries neither a stitch nor a " +
            "justify; a lane this window never touched owes nothing here, and " +
            "a topology change (your own later stitch, a further split) " +
            "invalidates an old justify automatically. " +
            "A landing turn (implement/fix/refactor) should be traceable, by " +
            "a directed walk along its own out-edges (any of the seven " +
            "words, an unbounded hop count, crossing lanes and tasks freely), to a basis " +
            "node (design/correction/measure/research/review) — its execution " +
            "basis. EDGE FIRST: prefer writing the edge that already exists in " +
            "the work over retyping the turn. Only retype a landing turn to " +
            "ADD a basis word when its OWN content genuinely set or revised a " +
            "commitment or carries the finding — the ACCURATE word (a " +
            "measurement adds \"measure\", an investigation \"research\", a " +
            "review finding \"review\"), never a default \"design\"/ " +
            "\"correction\" for convenience. A compound retype requires " +
            "`typeReason` on the `note` call — the accurate basis and why — " +
            "and is recorded; a landing turn with genuinely no external " +
            "upstream is itself the compound, at zero hops.",
        ),
      );

    // The guard against a mistyped `.replace()`: if any needle above failed
    // to match the archive, `amended` would still equal `body`, and this
    // test would silently degrade into re-checking the RETIRED text.
    expect(amended).not.toBe(body);

    const prompt = words(renderPrompt());
    expect(prompt.includes(amended)).toBe(true);
  });

  // Block D packages TWO separate insertion points (D1 into duty 3, D2
  // replacing the output tail) under one heading, so — unlike A/B/C — its
  // own body is never one contiguous span in the rendered prompt. Each
  // sentence is extracted and checked as its own contiguous word sequence
  // instead; the "D1, appended to..." / "D2, replacing..." labels are
  // integration notes, never prompt text, so they are excluded on purpose.
  test("block D's two sentences (D1, D2) each appear as contiguous word sequences", () => {
    const dSection = readAuthoredSections()[3]!;
    const d1Match = dSection.match(
      /D1, appended to the session-narrative duty:\n\n([\s\S]*?)\n\nD2,/,
    );
    const d2Match = dSection.match(
      /D2, replacing the output tail's exemption clause:\n\n([\s\S]*)$/,
    );
    expect(d1Match).not.toBeNull();
    expect(d2Match).not.toBeNull();

    const prompt = words(renderPrompt());
    expect(prompt.includes(words(d1Match![1]!.trim()))).toBe(true);
    expect(prompt.includes(words(d2Match![1]!.trim()))).toBe(true);
  });
});

/**
 * Ticket 01, light-review-repairs (peer P1-1): the system half's "Work
 * entirely through the ... tools" sentence used to name only
 * remember/note/commit — three of the six tools the child process is actually
 * registered with (`SETTLEMENT_ALLOWED_TOOLS`, note-settlement-sdk-query.ts).
 * Since system instructions win over the user half, a compliant agent could
 * refuse the very `recall` (Block A, every batch) and `lane_check` (Block B
 * step 5) calls the user half now mandates.
 *
 * The guard: mechanically extract every backtick-quoted, single-word token
 * from the RENDERED USER HALF that is also a real registered tool name (the
 * same `SETTLEMENT_ALLOWED_TOOLS` list, not a hand-copied one), then assert
 * each one is a member of the system sentence's own slash-separated
 * allowlist. This is what makes the two contracts unable to drift apart
 * silently again: widen what the user half instructs calling without
 * widening the system sentence, and this test goes red.
 */
describe("ticket 01 (peer P1-1) — cross-contract superset guard: system sentence permits every tool the user half instructs calling", () => {
  const KNOWN_TOOL_NAMES = new Set(
    SETTLEMENT_ALLOWED_TOOLS.map((name) => name.replace("mcp__mnemo__", "")),
  );

  /** Every backtick-quoted single word that is also a real registered tool name. */
  function extractInstructedToolNames(text: string): Set<string> {
    const found = new Set<string>();
    for (const match of text.matchAll(/`([a-zA-Z_]+)`/g)) {
      if (KNOWN_TOOL_NAMES.has(match[1]!)) {
        found.add(match[1]!);
      }
    }
    return found;
  }

  test("the extraction itself still finds every registered tool (guards the guard against silently degrading)", () => {
    const calledTools = extractInstructedToolNames(renderPrompt());
    expect(calledTools).toEqual(KNOWN_TOOL_NAMES);
  });

  test("every tool the user half instructs calling, by name, is in the system sentence's allowlist", () => {
    const calledTools = extractInstructedToolNames(renderPrompt());
    expect(calledTools.size).toBeGreaterThan(0);

    const allowlistMatch = NOTE_SETTLEMENT_SYSTEM_PROMPT.match(
      /Work entirely through the ([a-zA-Z_/]+) tools/,
    );
    expect(allowlistMatch).not.toBeNull();
    const allowlistedTools = new Set(allowlistMatch![1]!.split("/"));

    // Superset, not equality: a tool the system half permits but the user
    // half happens not to name in this fixture is not a contract violation.
    for (const tool of calledTools) {
      expect(allowlistedTools.has(tool)).toBe(true);
    }
  });

  test("the system sentence's allowlist is exactly the six registered tools", () => {
    const allowlistMatch = NOTE_SETTLEMENT_SYSTEM_PROMPT.match(
      /Work entirely through the ([a-zA-Z_/]+) tools/,
    );
    expect(allowlistMatch).not.toBeNull();
    const allowlistedTools = new Set(allowlistMatch![1]!.split("/"));
    expect(allowlistedTools).toEqual(KNOWN_TOOL_NAMES);
  });
});

// ---------------------------------------------------------------------------
// Lane-model-v12 ticket 12 — the SETTLEMENT ACTIONS half.
//
// The third artifact of the rubric split. It is not a file and not an exported
// constant: it lives inside this prompt's own `## Duties` checklist, seated in
// the duty that acts on it. Source:
// `.scratch/lane-model-v12/rubric-v12-settlement.md`.
//
// The ticket's own checkbox is "一条测试断言它只出现在结算侧" — so every pin
// below is a PAIR: present here, absent from the SessionStart injection the
// main agent gets. The main agent declares no lanes, counts no cross-lane
// coupling and judges no minimal connectivity, so a copy reaching it would be
// instructions addressed to someone else.
// ---------------------------------------------------------------------------

describe("ticket 12 — the settlement action half is in the duties, and only on this side", () => {
  const SETTLEMENT_ONLY = [
    // The lane DECLARATION CRITERIA — the test behind the concepts half's two
    // bare words 可分离/可持续, with the counter-examples that make it usable.
    "判据 —— 一条被声明的泳道应当满足两条,都在声明当时前瞻地判断:",
    "较少需要用关系表达它与外部节点的关系",
    "之后预期还可能继续该子任务",
    "不满足判据的工作不是「应该无归属」,而是应该归属到一条合格的泳道。",
    "「周期较长」不是判据。",
    // The two PRINCIPLES, reviewed against in step 5.
    "原则(判断性,不强制;index 不参与计算):",
    "- 连通性:一条泳道的任意两个成员,应该通过两侧 tag 同为该泳道",
    "- 最小连通:任意两个节点之间(不止泳道内部)的路径应该尽量少,",
    // The three-group COUPLING count, and its explicit refusal to invent a
    // threshold — the input to "should these two lanes have been one".
    "耦合:跨泳道的边按三组分别计数,不产出机器判决 ——",
    "把三个数摆出来由",
    "人判断,不要发明一个门限。",
    // The undeclare cleanup rule the source states as a settlement act.
    "必须同时把它成员节点自身 tags 里的这个 tag 一并清掉",
  ];

  test("every settlement-only rule is in the prompt", () => {
    const prompt = renderPrompt();
    for (const rule of SETTLEMENT_ONLY) {
      expect(prompt, `settlement prompt should state: ${rule}`).toContain(rule);
    }
  });

  test("no settlement-only rule reaches the main agent's injection", () => {
    const injected = renderRubricBlock();
    for (const rule of SETTLEMENT_ONLY) {
      expect(injected, `SessionStart must not carry: ${rule}`).not.toContain(rule);
    }
  });

  test("the settlement half sits INSIDE the Duties checklist, not as a fourth section", () => {
    const prompt = renderPrompt();
    const duties = prompt.slice(prompt.indexOf("## Duties"), prompt.indexOf("## Task roster"));
    for (const rule of SETTLEMENT_ONLY) {
      expect(duties, `should be inside ## Duties: ${rule}`).toContain(rule);
    }
    // The criteria belong to the LANE duty and the principles to the relation
    // finalization pass — each rule next to the call it governs, which is the
    // whole reason this half is not a separate injected block.
    expect(duties.indexOf("原则(判断性,不强制;index 不参与计算):")).toBeLessThan(
      duties.indexOf("2. LANES,"),
    );
    expect(duties.indexOf("2. LANES,")).toBeLessThan(
      duties.indexOf("判据 —— 一条被声明的泳道应当满足两条"),
    );
  });

  // The source file's 写入规则 section is deliberately NOT copied in: this
  // prompt and the relation describes already state all three of its rules, and
  // a second copy is the drift shape the single-home discipline exists to
  // prevent. Pinned as an absence so a later "completeness" pass does not
  // re-add it without noticing there was already a home.
  test("the source's 写入规则 section is not duplicated into the prompt", () => {
    const prompt = renderPrompt();
    expect(prompt).not.toContain("身份是 `(任务, tag)`,不是裸 tag");
    expect(prompt).not.toContain("泳道 tag 与任务自身的策展 tag 不得同名");
    // …because the same facts are already here, in English, on the call shapes.
    expect(prompt).toContain("A lane is (task, ONE tag)");
    expect(prompt).toContain("for a tag already among that task's");
  });
});

// ---------------------------------------------------------------------------
// Lane-model-v12 ticket 21 — the settlement half of ONE membership policy, and
// the memory policy ticket 12 left behind.
//
// The ruling (user, 2026-08-26) is about the MAIN agent: no fitting segment or
// lane tag, ask with AskUserQuestion, never mint silently. This pass is
// HEADLESS, so its half of the same rule is the other one — leave the field
// empty and leave the opening of a container to the side that can ask.
//
// What is deliberately NOT changed by that: duty 2 still declares lanes. The
// two acts share a verb and are not the same act — a lane declared because the
// content shows a separable, sustainable sub-task (the 判据 in duty 2) is
// hindsight this pass alone has and a standing user ruling ([S15069/T1547],
// "lanes are settlement's outright") assigns it here; a lane minted because a
// turn found no tag to carry is the thing this ruling forbids. Every pin below
// is on the second, and the first is pinned as a SURVIVAL so a later reading of
// "settlement must not mint" cannot quietly take duty 2 with it.
// ---------------------------------------------------------------------------

describe("ticket 21 — settlement leaves it empty; it cannot ask, so it never creates", () => {
  function duty1Membership(prompt: string): string {
    const start = prompt.indexOf("   - membership lives in `tags`, and nowhere else.");
    const end = prompt.indexOf("   - edges:", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return prompt.slice(start, end);
  }

  test("the membership bullet says LEAVE EMPTY, not go create", () => {
    const membership = duty1Membership(renderPrompt());
    expect(membership).toContain("Both tiers are one vocabulary and one rule");
    expect(membership).toContain("leave the field empty when neither tier has one");
    expect(membership).toContain("empty is the");
    expect(membership).toContain("ordinary outcome, not a failure");
    expect(membership).toContain("Never open a task or declare a");
    expect(membership).toContain("lane merely to give a turn a home");
    expect(membership).toContain("You cannot ask the user");
    expect(membership).toContain("the main agent's act with");
  });

  test("the ask itself never reaches this headless surface", () => {
    const prompt = renderPrompt();
    expect(prompt).not.toContain("AskUserQuestion");
    // Nor the main agent's own imperative, which arrives only inside the
    // ACTION half — a half this prompt does not render.
    expect(prompt).not.toContain("不要静默新建");
    expect(prompt).not.toContain(MEMORY_RUBRIC_MAIN_ACTIONS_TEXT);
  });

  test("duty 2 keeps the registry verbs, but a declaration answers to the criteria", () => {
    const prompt = renderPrompt();
    const duty2 = prompt.slice(prompt.indexOf("2. LANES,"), prompt.indexOf("## Task roster"));
    // The capability SURVIVES — this ticket narrows the reason, not the verb.
    expect(duty2).toContain("`create`, `delete`, `merge`");
    expect(duty2).toContain("判据 —— 一条被声明的泳道应当满足两条");
    // …and the reason is now stated, because the verb alone cannot tell the
    // two acts apart.
    expect(duty2).toContain(
      "A declaration answers to the criteria below and to the content that met",
    );
    expect(duty2).toContain("never to a turn that found no tag");
    expect(duty2).toContain("left");
    expect(duty2).toContain("unowned, not given a freshly minted word to carry");
  });

  // Ticket 12 sent the rubric's whole ACTION half to the main agent and left
  // this pass calling `recall`/`timeline` with no read policy at all. The peer
  // (B4) flagged the reason it cannot simply be copied: "only read when memory
  // could change the present judgment" is selective, and this pass is REQUIRED
  // to review its whole writable set. So the prompt states the BOUNDARY.
  test("the memory policy is present and draws the selective/mandatory boundary", () => {
    const prompt = renderPrompt();
    expect(prompt).toContain("## Memory policy");

    const policy = prompt.slice(
      prompt.indexOf("## Memory policy"),
      prompt.indexOf("## Procedure"),
    );
    // Selective — and explicitly about ranging OUTSIDE the window.
    expect(policy).toContain("Reading MEMORY is SELECTIVE");
    expect(policy).toContain("could");
    expect(policy).toContain("change a judgment you are about to make");
    // Mandatory — and explicitly exempted from the selective rule.
    expect(policy).toContain("Reviewing THIS WINDOW'S WRITABLE SET is not that");
    expect(policy).toContain("the selective rule");
    expect(policy).toContain("never applies to it");
    expect(policy).toContain(
      "every address printed below is audited, whether or",
    );
    expect(policy).toContain("cover it, and it is exhaustive");
    // The materialization rule, transferred in substance.
    expect(policy).toContain("comes from your own `recall` of that turn, never from a summary");
  });

  test("the policy sits between the authority statement and the procedure", () => {
    const prompt = renderPrompt();
    expect(prompt.indexOf("## Your authority")).toBeLessThan(
      prompt.indexOf("## Memory policy"),
    );
    expect(prompt.indexOf("## Memory policy")).toBeLessThan(prompt.indexOf("## Procedure"));
  });

  // The main agent's generalized heuristic must NOT be what landed here: a
  // reader who meets it inside a prompt whose whole scope statement is "work
  // the WHOLE writable set" has two rules and no boundary between them.
  test("the main agent's unqualified selective sentence is not copied in", () => {
    const prompt = renderPrompt();
    expect(prompt).not.toContain("只在记忆可能改变当前判断时才去读");
    expect(prompt).not.toContain("材料化的时刻必须回原文");
  });
});

describe("the rendered prompt's lane-action inventory", () => {
  // The third teacher of settlement's `action` enum (peer review
  // [S15069/T1772]): the tuple, the tool description and THIS prompt were
  // three independent literals, and that is how `remember(declare)` outlived
  // the verb it named. The other two are equated in
  // tests/shared/tag-mandate-teaching-surfaces; the prompt needs a seeded
  // database to render, so its half is pinned here, where one already exists.
  test("names every live action and no retired one", () => {
    const prompt = renderPrompt();
    for (const action of SETTLEMENT_LANE_ACTIONS) {
      expect(prompt).toContain(`\`${action}\``);
    }
    for (const retired of ["declare", "undeclare", "propose", "reassign", "assign"]) {
      expect(prompt).not.toContain(`\`${retired}\``);
    }
  });
});
