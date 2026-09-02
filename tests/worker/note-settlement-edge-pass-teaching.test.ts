import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { MAX_TURN_RELATION_DEGREE } from "../../src/db/citations";
import { createDatabase } from "../../src/db/database";
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
  resolveSettlementWritableSet,
} from "../../src/worker/note-settlement-context";
import { renderEdgePassTeaching } from "../../src/worker/note-settlement-edge-pass-teaching";
import { renderNoteSettlementPrompt } from "../../src/worker/note-settlement-prompt";
import {
  SETTLEMENT_BOUNDED_FIELDS,
  SETTLEMENT_READ_FIELD_BUDGETS,
  SETTLEMENT_READ_FIELDS,
  SETTLEMENT_READ_PAGE_BUDGET,
  SETTLEMENT_READ_TURN_BUDGET,
} from "../../src/worker/note-settlement-read-budgets";
import { buildSettlementWorklistRendering } from "../../src/worker/note-settlement-shape-numbers";
import { renderNoteSettlementUnifiedPrompt } from "../../src/worker/note-settlement-unified-prompt";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * MAIN-AGENT-EDGES TICKET 06 (spec D6; read-once D6 as rewritten) — the edge
 * pass's teaching, pinned ONCE, on the block both prompts render.
 *
 * Every `toContain` below is a sentence a mutation of the block drives red;
 * the two host tests at the end prove the block reaches BOTH rendered prompts
 * verbatim and that the retired sentences are absent from the RENDERED text of
 * each — a sentence merely unreachable in the source still ships if it
 * renders. The numbers (field list, budgets, caps) are asserted against the
 * constants the tools enforce, never typed as literals, so a budget moved
 * without a re-measurement reddens here.
 */

const NOW = 1_800_000_000;

describe("the shared edge-pass block — READ ONCE", () => {
  const block = renderEdgePassTeaching();

  test("names the two deltas by authority and as set differences against the first read", () => {
    expect(block).toContain("THE EDGE PASS — DECLARE, FILL, REVIEW.");
    expect(block).toContain("READ ONCE. `finalize`'s result prints two address lists beside the frozen");
    expect(block).toContain("WRITABLE DELTA: turns that entered your");
    expect(block).toContain("yours for RELATIONS ONLY, never a note");
    expect(block).toContain("field. CONTEXT DELTA: every frozen lane member and every turn a writable");
    expect(block).toContain("citer's edge points at that the first read never covered; read-only");
    expect(block).toContain("judgment material, ONE HOP");
    expect(block).toContain("and a relation write on one is refused");
    expect(block).toContain("Both lists are set");
    expect(block).toContain("differences against what was already read, so an address from the first");
    expect(block).toContain("read appears in neither.");
  });

  test("reads the union once, with the first read's own field list and budgets, and then nothing", () => {
    expect(block).toContain("Read the UNION of the two lists ONCE, in as few");
    expect(block).toContain("pages as the envelope allows, as a list of turn addresses with");
    const fields = SETTLEMENT_READ_FIELDS.map((field) => `"${field}"`).join(",");
    const budgets = Object.entries(SETTLEMENT_READ_FIELD_BUDGETS)
      .map(([field, budget]) => `${field}:${budget}`)
      .join(",");
    expect(block).toContain(`\`filter={fields:[${fields}],fieldBudgets:{${budgets}}}\``);
    expect(block).toContain(`\`boundedFields:${JSON.stringify(SETTLEMENT_BOUNDED_FIELDS)}\``);
    expect(block).toContain(`\`turn:${SETTLEMENT_READ_TURN_BUDGET}\``);
    expect(block).toContain(`\`pageBudget:${SETTLEMENT_READ_PAGE_BUDGET}\``);
    expect(block).toContain("the same field list and budgets as the first read");
    expect(block).toContain("After that sweep, READ NOTHING");
    expect(block).toContain("FURTHER: the only later read is the one a refused write names — a turn");
    expect(block).toContain("whose relations changed under you — and it is that turn's `relations`");
    expect(block).toContain("alone.");
  });

  test("draws D0's line: a CUT relations licenses, a DROPPED one is read once more", () => {
    expect(block).toContain("A `relations` reported CUT already licenses an edge write on that");
    expect(block).toContain("turn; only a DROPPED one must be read again before writing there.");
  });
});

describe("the shared edge-pass block — DECLARE", () => {
  const block = renderEdgePassTeaching();

  test("states the resolution model and what E6 and E4 are under it", () => {
    expect(block).toContain("DECLARE. A lane side is RESOLVED when read, not stored: declared where a");
    expect(block).toContain("declaration exists, else DERIVED from the endpoint's single lane, else");
    expect(block).toContain("none. A side is STORED only where its endpoint sits in SEVERAL lanes");
    expect(block).toContain("whose side is blank on such an endpoint is E6 until you declare it, and a");
    expect(block).toContain("stored side no longer among its endpoint's lanes is E4 until you re-set or");
    expect(block).toContain("clear it. A blank side on an endpoint in ONE lane or in NO lane is never a");
    expect(block).toContain("finding, and declaring one is refused as derivable.");
  });

  test("teaches the `declare` entry, both sides named, three-state patch, class as precondition", () => {
    expect(block).toContain("`declare` entry on the CITING turn: `{ \"turn\": \"S15069/T7\", \"tailTag\":");
    expect(block).toContain("\"a\" }` or `{ \"turn\": \"S15069/T7\", \"headTag\": \"b\" }` — `tailTag` the lane");
    expect(block).toContain("THIS turn's claim belongs to, `headTag` the lane in which the cited");
    expect(block).toContain("principal result is used; omit a side to leave it alone, send `null` to");
    expect(block).toContain("clear it, and send `class` when you want the call refused if the pair's");
    expect(block).toContain("class has moved since you read it.");
    expect(block).toContain("A declaration is the ONE way a stored");
    expect(block).toContain("side moves: an edge entry carrying side tags onto a pair that already has");
    expect(block).toContain("a row changes no side, and the receipt says so.");
  });

  test("multi-lane citing turns: one placement per pair, decided once over the whole worklist", () => {
    expect(block).toContain("A citing turn in two");
    expect(block).toContain("worklist lanes is visited twice; decide `(tailTag, headTag)` for each of");
    expect(block).toContain("its pairs ONCE, over the whole worklist, before you write — one pair, one");
    expect(block).toContain("row, each side named only where it needs naming — and a second visit");
    expect(block).toContain("never re-places what the first decided.");
  });
});

describe("the shared edge-pass block — FILL", () => {
  const block = renderEdgePassTeaching();

  test("the main agent's edges are already there; fill only the misses, in the bare form", () => {
    expect(block).toContain("FILL. Each turn's writer already recorded the edges it knew about, as");
    expect(block).toContain("bare addresses with no lane side. Add only what hindsight shows it");
    expect(block).toContain("missed, in the same form: a bare address under correct/verify/use");
    expect(block).toContain("`correct` carries its coverage bit");
    expect(block).toContain("\"S15069/T7\", \"coverage\": \"full\" }` or `\"partial\"`, refused without");
    expect(block).toContain("it, and refused on `verify`/`use`), judged by the Memory Rubric's");
    expect(block).toContain("**三个关系类** entry above");
  });

  test("one edge per pair, the caps from the gate's own constant, the stronger class in place", () => {
    expect(block).toContain("one edge per pair at the most specific class, at");
    expect(block).toContain(
      `most ${MAX_TURN_RELATION_DEGREE} outgoing per citing turn and ${MAX_TURN_RELATION_DEGREE} incoming per cited turn,`,
    );
    expect(block).toContain("a stronger class replacing a weaker one in place.");
    expect(block).toContain("Where the new edge's");
    expect(block).toContain("endpoint sits in several lanes, the same call carries its `declare` entry.");
  });

  test("keeps the two measured traps and the read boundary", () => {
    expect(block).toContain("Adjacency, a shared topic and preserving a lane's shape are never use");
    expect(block).toContain("evidence; a blocker satisfied by doing the work is completion (use), not");
    expect(block).toContain("a correction of the blocking judgment.");
    expect(block).toContain("Both endpoints must be in what you");
    expect(block).toContain("have read: a cited turn you never read stays uncited.");
  });
});

describe("the shared edge-pass block — REVIEW", () => {
  const block = renderEdgePassTeaching();

  test("retraction addresses the pair with the mirror's class as precondition", () => {
    expect(block).toContain("REVIEW. Retract a wrong edge with `retractCorrect`/`retractVerify`/");
    expect(block).toContain("`retractUse` and the bare address: the PAIR is the address, and the");
    expect(block).toContain("mirror's own class is the precondition — a pair that now carries a");
    expect(block).toContain("different class refuses, naming the class it carries, so a stale read");
    expect(block).toContain("never deletes a claim it did not see.");
  });

  test("lane_check: E6 and E4 are yours and repaired by declare or retraction, never a tags write", () => {
    expect(block).toContain("Then `lane_check`: E6 and E4");
    expect(block).toContain("anchored on a citer in your writable set are yours and block `commit`;");
    expect(block).toContain("each is repaired by a `declare` entry or a retraction, never by a tags");
    expect(block).toContain("write.");
  });

  test("the two handover debts, over finalize's lists and nothing wider", () => {
    expect(block).toContain("Then the two handover debts, over the lists `finalize` printed and");
    expect(block).toContain("nothing wider:");
    expect(block).toContain("DEBT DISCHARGE. Each entry of the writable delta is a citing turn whose");
    expect(block).toContain("edge stage 1 left owing a lane side");
    expect(block).toContain("Your authority over that citing turn is RELATIONS ONLY");
    expect(block).toContain("moves are exactly: declare the side, or retract the row. Every listed");
    expect(block).toContain("debt is discharged before you commit.");
    expect(block).toContain("HOMELESS RETRACTION, with cause. A turn in the homeless list has no");
    expect(block).toContain("legal task container, so no lane can ever attribute a side of its");
    expect(block).toContain("edges. Retract those rows. The retraction records itself — the deleted");
    expect(block).toContain("row's full identity and the group that caused it are written with the");
    expect(block).toContain("deletion. Never open a task or mint a lane to give such a turn a home;");
  });

  test("the block itself carries none of the retired sentences", () => {
    for (const retired of [
      "the bare citation",
      "comes back",
      "WARNING only",
      "DRAFT RECONCILIATION",
      "batches of ten",
      "before any edge write",
      "recall that lane's members",
      "PLACE EVERY EDGE AT WRITE",
      "{turn, tailTag, headTag}",
      "does NOT survive `commit`",
    ]) {
      expect({ retired, present: block.includes(retired) }).toEqual({ retired, present: false });
    }
  });
});

/**
 * THE TWO HOSTS. Rendered through each dispatch's own render path — never a
 * hand-built writable set — so the block's presence is a fact about what a
 * run reads, and the retired sentences' absence is checked on the rendered
 * text of BOTH prompts.
 */
describe("both settlement prompts render the shared block verbatim, and neither renders a retired sentence", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });
  afterEach(() => db.close());

  function seedSession(): number {
    return upsertSession(db, {
      contentSessionId: "edge-pass-teaching",
      project: "/tmp/project-edge-pass-teaching",
      title: "edge pass teaching fixture",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 10_000,
      updatedAtEpoch: NOW - 10_000,
      completedAtEpoch: null,
    }).id;
  }

  function seedTurn(sessionDbId: number, promptNumber: number): void {
    db.query<unknown, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, ?, 'active', ?, ?, 2, ?)`,
    ).run(sessionDbId, promptNumber, `prompt ${promptNumber}`, `response ${promptNumber}`, NOW - 1_000 + promptNumber);
  }

  function claimWindow(sessionDbId: number): NoteSettlementJob {
    enqueueNoteSettlementWindows(
      db,
      [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 1, triggerType: "consecutive" }],
      NOW,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    );
    const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
    if (!job) {
      throw new Error("fixture failed to claim a settlement job");
    }
    return job;
  }

  function renderBoth(): { unified: string; resume: string } {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const writableTurnIds = computeSettlementWritableTurnIds(db, context.reviewableTurnIds);
    const writableSet = resolveSettlementWritableSet(db, context, writableTurnIds);
    return {
      unified: renderNoteSettlementUnifiedPrompt(context, writableSet),
      resume: renderNoteSettlementPrompt(
        context,
        writableSet,
        buildSettlementWorklistRendering(db, job.id),
      ),
    };
  }

  test("the block is in both rendered prompts, once each", () => {
    const { unified, resume } = renderBoth();
    const block = renderEdgePassTeaching();
    expect(unified.split(block).length - 1).toBe(1);
    expect(resume.split(block).length - 1).toBe(1);
  });

  /**
   * The RETIRED sentences, checked on the rendered text of both hosts. Each
   * line names the ticket that retired it:
   *   - "the bare citation comes back": ticket 03 deleted the restoration
   *     (this ticket's own escape, F1);
   *   - "reported as a WARNING only": no such lint exists in `src/` (03's
   *     call-site sweep);
   *   - the rest: read-once D6 / main-agent-edges D6 (this ticket).
   */
  test("no retired sentence renders in either prompt", () => {
    const { unified, resume } = renderBoth();
    for (const [name, text] of [
      ["unified", unified],
      ["resume", resume],
    ] as const) {
      for (const retired of [
        "the bare citation",
        "bare citation comes back",
        "reported as a WARNING only",
        "WARNING only and never",
        "batches of ten",
        "BATCH STEP",
        "before any edge write",
        "Before any edge write",
        "recall that lane's",
        "recall the citing turn",
        "read the citing turn's own edges with an EXPLICIT",
        "DRAFT RECONCILIATION",
        "pre-existing bare drafts",
        "PLACE EVERY EDGE AT WRITE",
        "A bare address writes a DRAFT",
        "does NOT survive `commit`",
        "{turn, tailTag, headTag}",
        '"tailTag": "a", "headTag": "b"',
        "DISPOSE every ledger candidate",
        "JUDGE AND WRITE",
        "CHECK AND REPAIR",
        "re-placing the edge",
      ]) {
        expect({ name, retired, present: text.includes(retired) }).toEqual({
          name,
          retired,
          present: false,
        });
      }
    }
  });
});
