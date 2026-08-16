import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import { createContextHandler } from "../../src/hooks/handlers/context";
import { renderMainAgentSessionInjection } from "../../src/hooks/session-injection";
import type { NormalizedHookInput } from "../../src/hooks/types";
import { buildNoteSettlementContext } from "../../src/worker/note-settlement-context";
import { renderNoteSettlementPrompt } from "../../src/worker/note-settlement-prompt";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Ticket 11 (spec A4): the main agent's injection has ONE assembly, and both
 * surfaces that show it call that assembly.
 *
 * The guard is deliberately an equality against the shared entry point's own
 * output rather than a list of fields: a re-forked settlement-side renderer
 * that reproduced most of the block would still fail here, and so would the
 * exact divergence this ticket found — the settlement side used to hand-build
 * the field list, still passing the `current` field ticket 04 deleted and
 * never passing the `insight` ticket 04 added.
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
  const sessionDbId = upsertSession(db, {
    contentSessionId: "session-shared-injection",
    project: "/tmp/project-shared-injection",
    title: "the shared injection fixture",
    content: "Settlement writes stage; commit is the only writer.",
    insight: "- a lost stage receipt is not a lost commit receipt",
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
  db.query<unknown, [number]>(
    `UPDATE sessions
     SET next_steps = 'ship ticket 11',
         decision = '- staged writes replay inside commit [T3]',
         done = '- the completion gate moved into commit',
         "reference" = '- .scratch/settlement-agentic/spec.md'
     WHERE id = ?`,
  ).run(sessionDbId);
  return sessionDbId;
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

function hookInput(
  overrides: Partial<NormalizedHookInput> = {},
): NormalizedHookInput {
  return {
    eventName: "SessionStart",
    source: "resume",
    sessionId: "session-shared-injection",
    cwd: "/tmp/project-shared-injection",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

describe("ticket 11 — one entry point, two surfaces (spec A4)", () => {
  test("the SessionStart hook and the settlement prompt both carry the shared block, byte for byte", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId);

    const shared = renderMainAgentSessionInjection(db, {
      session: getSession(db, sessionDbId)!,
    });

    const sessionStart =
      (await createContextHandler({ db })(hookInput())).hookSpecificOutput ?? "";
    const settlementPrompt = renderNoteSettlementPrompt(
      buildNoteSettlementContext(db, job, { nowEpoch: NOW })!,
    );

    expect(shared).toContain("## Current Session");
    expect(sessionStart).toContain(shared);
    expect(settlementPrompt).toContain(shared);
  });

  test("every injected field reaches BOTH surfaces — including the one they had diverged on", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId);

    const sessionStart =
      (await createContextHandler({ db })(hookInput())).hookSpecificOutput ?? "";
    const settlementPrompt = renderNoteSettlementPrompt(
      buildNoteSettlementContext(db, job, { nowEpoch: NOW })!,
    );

    for (const surface of [sessionStart, settlementPrompt]) {
      expect(surface).toContain(`[S${sessionDbId}] the shared injection fixture`);
      expect(surface).toContain(
        "content: Settlement writes stage; commit is the only writer.",
      );
      expect(surface).toContain("next: ship ticket 11");
      expect(surface).toContain("- staged writes replay inside commit [T3]");
      // `insight` is the field the settlement copy never passed: ticket 04
      // promoted it to a first-class injected field and only one of the two
      // assemblies was updated.
      expect(surface).toContain("- a lost stage receipt is not a lost commit receipt");
      expect(surface).toContain("- the completion gate moved into commit");
      expect(surface).toContain("- .scratch/settlement-agentic/spec.md");
    }
  });

  test("the corpus header is the parameter, not a second implementation", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId);

    const sessionStart =
      (await createContextHandler({ db })(hookInput())).hookSpecificOutput ?? "";
    const settlementPrompt = renderNoteSettlementPrompt(
      buildNoteSettlementContext(db, job, { nowEpoch: NOW })!,
    );

    // SessionStart opens with it...
    expect(sessionStart.split("\n")[0]).toBe(
      `claude-mnemo: 1 sessions, 0 observations | current: S${sessionDbId}`,
    );
    expect(sessionStart).toContain(
      "Axes: recall (content) · timeline (temporal) · mnemo-replay (raw)",
    );
    // ...and the settlement agent, which has recall and timeline and no
    // skills at all, is not told about a replay skill it cannot invoke.
    expect(settlementPrompt).not.toContain("mnemo-replay (raw)");

    // Asking for the header is one boolean on the shared call, and produces
    // exactly what SessionStart shows.
    expect(
      renderMainAgentSessionInjection(db, {
        session: getSession(db, sessionDbId)!,
        currentSessionId: sessionDbId,
        includeCorpusHeader: true,
      }),
    ).toBe(sessionStart);
  });

  test("a session with no turns still gets the header, and no empty state heading", () => {
    const sessionDbId = seedSession();

    const output = renderMainAgentSessionInjection(db, {
      session: null,
      currentSessionId: sessionDbId,
      includeCorpusHeader: true,
    });

    expect(output).toContain(`current: S${sessionDbId}`);
    expect(output).not.toContain("## Current Session");
  });
});
