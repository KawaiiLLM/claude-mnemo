import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import { createContextHandler } from "../../src/hooks/handlers/context";
import { renderMainAgentSessionInjection } from "../../src/hooks/session-injection";
import type { NormalizedHookInput } from "../../src/hooks/types";

/**
 * `renderMainAgentSessionInjection` (spec A4, ticket 11) is the settlement
 * subagent's sole remaining caller as of ticket 10: SessionStart's bare
 * `context` command rendered this same block through ticket 11's "one entry
 * point, two surfaces" symmetry, but ADR-0006/ticket 10 retired that
 * surface's use of it entirely — the session's seven semantic fields are
 * gone (title survives), so SessionStart's body is now the segment roster
 * (`session-composition.test.ts`), not this function's output. This file
 * therefore tests `renderMainAgentSessionInjection` as a pure function
 * (still exercised by settlement — see `tests/worker/note-settlement-
 * prompt.test.ts` for that surface's own coverage) and pins the negative:
 * SessionStart no longer calls it at all.
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

describe("renderMainAgentSessionInjection (pure function, settlement's own surface)", () => {
  test("global-view narrows to title/content/insight, dropping the recent-events group settlement never reads", () => {
    const sessionDbId = seedSession();
    const session = getSession(db, sessionDbId)!;

    const full = renderMainAgentSessionInjection(db, { session });
    const globalView = renderMainAgentSessionInjection(db, {
      session,
      fields: "global-view",
    });

    expect(full).toContain("content: Settlement writes stage; commit is the only writer.");
    expect(full).toContain("next: ship ticket 11");
    expect(globalView).toContain("content: Settlement writes stage; commit is the only writer.");
    expect(globalView).toContain("- a lost stage receipt is not a lost commit receipt");
    // The reader split (ticket 04/spec A4): global-view drops next_steps/decision/done/reference.
    expect(globalView).not.toContain("next: ship ticket 11");
    expect(globalView).not.toContain("staged writes replay inside commit");
    expect(globalView).not.toBe(full);
  });

  test("the corpus header is a parameter of the same function, not a second implementation", () => {
    const sessionDbId = seedSession();

    const withHeader = renderMainAgentSessionInjection(db, {
      session: getSession(db, sessionDbId)!,
      currentSessionId: sessionDbId,
      includeCorpusHeader: true,
    });

    expect(withHeader.split("\n")[0]).toBe(
      `claude-mnemo: 1 sessions, 0 observations | current: S${sessionDbId}`,
    );
    expect(withHeader).toContain(
      "Axes: recall (content) · timeline (temporal) · mnemo-replay (raw)",
    );
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

describe("SessionStart no longer renders the per-session state block (ticket 10 regression pin)", () => {
  test("the bare context command's body is the segment roster, never the old corpus-header/state block", async () => {
    seedSession();

    const sessionStart =
      (await createContextHandler({ db })(hookInput())).hookSpecificOutput ?? "";

    expect(sessionStart).toContain("## Segment roster");
    expect(sessionStart).not.toContain("## Current Session");
    expect(sessionStart).not.toContain("claude-mnemo: 1 sessions");
    expect(sessionStart).not.toContain(
      "Axes: recall (content) · timeline (temporal) · mnemo-replay (raw)",
    );
  });
});
