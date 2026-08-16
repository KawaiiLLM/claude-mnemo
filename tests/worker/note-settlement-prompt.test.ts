import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  createSegment,
  upsertTopic,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import {
  buildNoteSettlementContext,
  NOTE_SETTLEMENT_RECENT_SEGMENTS,
} from "../../src/worker/note-settlement-context";
import { renderNoteSettlementPrompt } from "../../src/worker/note-settlement-prompt";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Ticket 14 (spec K): what the settlement prompt has to SAY about a segment,
 * and what the context has to put in front of it.
 *
 * Every assertion here is a sentence the ticket names as a deliverable, so it
 * is pinned as a substring of the rendered prompt: the prompt IS the mechanism
 * for K2/K4/K5/K6, and a guard that only checked "some segment text exists"
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

describe("the partition is the arc, stated in the rubric's own vocabulary (spec K2)", () => {
  test("a Grade 4 opens a segment, the next closes it, a Grade 3 attaches to its nearest preceding Grade 4", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("A SEGMENT IS ONE ARC");
    // The rubric's own words for the boundary — duty 3 borrows the grade
    // vocabulary rather than inventing a second name for the same partition.
    expect(prompt).toContain(
      "OPENS a segment, the NEXT Grade 4 closes it, and a Grade 3 belongs to",
    );
    expect(prompt).toContain("the segment its nearest preceding Grade 4 opened");
    expect(prompt).toContain("a Grade 4 (a task origin or re-foundation)");
    // And the arc is not window-scoped, which is what K4 turns on.
    expect(prompt).toContain("an arc may run on past this window's end");
  });
});

describe("the segment body carries the impression, not a retelling (spec K5/K6)", () => {
  test("the no-retelling rule reaches the prompt in a checkable form", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain(
      "anything readable from the member turns does not belong in the segment.",
    );
    expect(prompt).toContain(
      "Before you keep a sentence, ask whether a reader of the members would",
    );
  });

  test("insight is asked for with the segment's own semantics — including the routes ruled out", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("`insight`: the most reusable thing this arc now knows");
    expect(prompt).toContain("routes ruled out and why they were ruled out");
    // The inversion against the turn contract is stated, not assumed.
    expect(prompt).toContain("empty by default; a segment's is the point of the row");
  });

  test("members are exhaustive attention allocation; body citations are the load-bearing few", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("MEMBERS ARE EXHAUSTIVE, CITATIONS ARE THE LOAD-BEARING FEW.");
    expect(prompt).toContain(
      "is attention allocation: every window turn is a member of some segment,",
    );
    expect(prompt).toContain("conclusion, never every member");
  });
});

describe("lifecycle: an open segment is working state, a delivered one an impression (spec K4)", () => {
  test("both roles are named, and a live task's segment is not closed at window end", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("OPEN is the task's WORKING STATE");
    expect(prompt).toContain("DELIVERED is the task's IMPRESSION");
    expect(prompt).toContain(
      "A SEGMENT WHOSE TASK IS STILL LIVE IS NOT CLOSED AT WINDOW END.",
    );
    expect(prompt).toContain("window ending is not the task ending");
  });
});

describe("type and tags are derived, and the prompt says so rather than asking (spec K5a)", () => {
  test("the prompt tells the model the tool takes neither, and why the note calls come first", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("You do NOT state a segment's type or tags");
    expect(prompt).toContain("a call that names one is refused");
    expect(prompt).toContain("tags are the members' tags ordered by how");
    // The retired instruction must be gone, not merely contradicted somewhere
    // else in the same prompt.
    expect(prompt).not.toContain("SEGMENT TYPE AND TAG");
    expect(prompt).not.toContain("the `segment` tool's type/tags fields");
  });
});

describe("the anti-fragmentation surface the D9 gate always assumed (spec K3, ticket 14)", () => {
  test("the context carries the 50 most recently active segments, newest first, whatever their status", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    // 60 segments, oldest first, so the cut has to drop the OLDEST ten.
    const ids: number[] = [];
    for (let index = 0; index < 60; index += 1) {
      ids.push(
        createSegment(db, {
          title: `chapter ${index}`,
          status: index % 2 === 0 ? "open" : "delivered",
          nowEpoch: NOW - 10_000 + index,
        }).id,
      );
    }

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    expect(NOTE_SETTLEMENT_RECENT_SEGMENTS).toBe(50);
    expect(context.recentSegments).toHaveLength(50);
    expect(context.recentSegments[0]!.segment.id).toBe(ids[59]);
    expect(context.recentSegments.map((entry) => entry.segment.id)).not.toContain(ids[0]);
    // Not open-only: a delivered segment is the evidence a name is established.
    expect(
      context.recentSegments.some((entry) => entry.segment.status === "delivered"),
    ).toBe(true);

    const prompt = renderNoteSettlementPrompt(context);
    // index 59 was seeded `delivered`, index 58 `open` — both statuses reach
    // the rendering, marked, and the reader can tell them apart.
    expect(prompt).toContain(`[E${ids[59]}] [delivered]`);
    expect(prompt).toContain(`[E${ids[58]}] [open]`);
  });

  test("the topic registry renders ordered by how many segments carry each name", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    // The established name sorts LAST alphabetically, so a registry that fell
    // back to name order would put the one-off first and fail this test.
    const established = upsertTopic(db, {
      name: "observation-pipeline",
      aliases: ["observations"],
      nowEpoch: NOW - 5_000,
    });
    const oneOff = upsertTopic(db, { name: "cache-quota", nowEpoch: NOW - 5_000 });
    for (let index = 0; index < 3; index += 1) {
      createSegment(db, {
        title: `pipeline chapter ${index}`,
        topicId: established.id,
        nowEpoch: NOW - 4_000 + index,
      });
    }
    createSegment(db, {
      title: "quota chapter",
      topicId: oneOff.id,
      nowEpoch: NOW - 3_000,
    });

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    expect(context.topicRegistry.map((entry) => entry.topic.name)).toEqual([
      "observation-pipeline",
      "cache-quota",
    ]);
    expect(context.topicRegistry[0]!.segmentCount).toBe(3);

    const prompt = renderNoteSettlementPrompt(context);
    const registry = prompt.slice(prompt.indexOf("## Topic registry"));
    expect(registry).toContain(
      "- observation-pipeline — 3 segments (aliases: observations)",
    );
    expect(registry).toContain("- cache-quota — 1 segment");
    expect(registry.indexOf("observation-pipeline")).toBeLessThan(
      registry.indexOf("cache-quota"),
    );
  });

  test("a rendered segment row carries its topic name and its derived facets", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1, { type: ["design"], tags: ["lease"] });
    const t2 = seedTurn(sessionDbId, 2, { type: ["implement"], tags: ["lease"] });
    const job = claimWindow(sessionDbId, 1, 2);
    const topic = upsertTopic(db, { name: "lease-fencing", nowEpoch: NOW - 5_000 });
    const segment = createSegment(db, {
      title: "fencing the claim",
      topicId: topic.id,
      content: "the working state",
      insight: "a generation check beats a timestamp",
      nowEpoch: NOW - 4_000,
    });
    addSegmentMembers(db, segment.id, [t1, t2], NOW - 4_000);

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderNoteSettlementPrompt(context);

    expect(prompt).toContain(`[E${segment.id}] [open] rev=1 topic=lease-fencing`);
    expect(prompt).toContain("type=design,implement tags=lease");
    expect(prompt).toContain("  content: the working state");
    expect(prompt).toContain("  insight: a generation check beats a timestamp");
  });
});
