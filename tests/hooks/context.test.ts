import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSessionByContentId, upsertSession } from "../../src/db/sessions";
import { createContextHandler, createReadOnlyContextHandler } from "../../src/hooks/handlers/context";
import type { NormalizedHookInput } from "../../src/hooks/types";
import { listPendingQueueItems } from "../../src/db/pending-queue";

/**
 * The bare `context` SessionStart command's own concerns (ticket 10): the
 * writable session-registration side effects (capture trigger, transcript
 * path, stranded-turn recovery, session_run_state marking) that run on every
 * source, and the resume/compact gate over its TEXT body. The body's own
 * content — the segment roster (ticket 10's replacement for the retired
 * per-session state render) — is covered by `session-composition.test.ts`
 * (the pure renderer) and `injection-matrix.test.ts` (the cross-section
 * gating matrix), so this file does not re-assert roster text shape.
 */

function createInput(
  overrides: Partial<NormalizedHookInput> = {},
): NormalizedHookInput {
  return {
    eventName: "SessionStart",
    source: "resume",
    sessionId: "session-context",
    cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

describe("handleContextHook", () => {
  let db: Database;
  let currentSessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    currentSessionId = upsertSession(db, {
      contentSessionId: "session-context",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Anchored session",
      insight: null,
      createdAtEpoch: 300,
      updatedAtEpoch: 305,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("SessionStart captures by content id before a numeric DB row exists", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createContextHandler({
      db,
      workerClientDeps: { fetchImpl },
      workerEnv: { ANTHROPIC_API_KEY: "new-session-key", AWS_PROFILE: "excluded" },
      enableSessionEnvCapture: true,
    });

    const result = await handler(createInput({ sessionId: "brand-new-session" }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(result.continue).toBe(true);
    expect(result.asyncWork).toBeUndefined();
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      action: "capture",
      content_session_id: "brand-new-session",
      env: { ANTHROPIC_API_KEY: "new-session-key" },
    });
  });

  test("startup upserts a minimal current session even when memory rows do not exist", async () => {
    const emptyDb = createDatabase(":memory:");
    initializeSchema(emptyDb);

    const handler = createContextHandler({
      db: emptyDb,
    });

    const result = await handler(
      createInput({ sessionId: "missing-session", source: "startup" }),
    );

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toContain("## Segment roster");
    expect(emptyDb.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM sessions",
    ).get()?.count).toBe(1);

    emptyDb.close();
  });

  test("SessionStart records the transcript path and never moves it after a cd", async () => {
    const freshDb = createDatabase(":memory:");
    initializeSchema(freshDb);
    const handler = createContextHandler({ db: freshDb });
    const started =
      "/Users/me/.claude/projects/-Users-me-alpha/drifting-session.jsonl";

    await handler(
      createInput({
        sessionId: "drifting-session",
        source: "startup",
        cwd: "/Users/me/alpha",
        transcriptPath: started,
      }),
    );

    expect(
      getSessionByContentId(freshDb, "drifting-session")?.transcriptPath,
    ).toBe(started);

    // A resume after the session cd'ed: Claude Code reports the new cwd, and the
    // transcript path it derives from that cwd is a file that does not exist.
    await handler(
      createInput({
        sessionId: "drifting-session",
        source: "resume",
        cwd: "/Users/me/beta",
        transcriptPath:
          "/Users/me/.claude/projects/-Users-me-beta/drifting-session.jsonl",
      }),
    );

    // (SessionStart only registers a missing row, so `project` still reads
    // alpha here — the cwd drift itself lands via UserPromptSubmit.)
    expect(
      getSessionByContentId(freshDb, "drifting-session")?.transcriptPath,
    ).toBe(started);

    freshDb.close();
  });

  test("SessionStart fills the transcript path of a session registered before the column existed", async () => {
    const freshDb = createDatabase(":memory:");
    initializeSchema(freshDb);
    const legacy = upsertSession(freshDb, {
      contentSessionId: "legacy-session",
      project: "/Users/me/alpha",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    expect(legacy.transcriptPath).toBeNull();

    const recorded =
      "/Users/me/.claude/projects/-Users-me-alpha/legacy-session.jsonl";
    await createContextHandler({ db: freshDb })(
      createInput({
        sessionId: "legacy-session",
        source: "resume",
        cwd: "/Users/me/alpha",
        transcriptPath: recorded,
      }),
    );

    expect(getSessionByContentId(freshDb, "legacy-session")?.transcriptPath).toBe(
      recorded,
    );

    freshDb.close();
  });

  test("startup renders the roster — the cold session is the roster's primary audience (review un-gated it)", async () => {
    const singleSessionDb = createDatabase(":memory:");
    initializeSchema(singleSessionDb);

    upsertSession(singleSessionDb, {
      contentSessionId: "single-session",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Single session",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    });

    const handler = createContextHandler({
      db: singleSessionDb,
    });

    const result = await handler(
      createInput({
        sessionId: "single-session",
        source: "startup",
      }),
    );

    expect(result.hookSpecificOutput).toContain("## Segment roster");

    singleSessionDb.close();
  });

  test("startup renders the roster when the current session exists too", async () => {
    const handler = createContextHandler({ db });

    const result = await handler(
      createInput({
        source: "startup",
        sessionId: "session-context",
      }),
    );

    expect(result.hookSpecificOutput).toContain("## Segment roster");
  });

  test("resume source with a stranded active turn enqueues turn-stop and still returns hookSpecificOutput without asyncWork", async () => {
    // Insert a stranded turn: status='active', assistant_response set → qualifies for recovery
    db.query(`
      INSERT INTO turns (
        session_id, prompt_number, status,
        user_prompt, assistant_response,
        title, content, insight,
        files_read, files_modified, tool_call_count,
        created_at_epoch, updated_at_epoch
      ) VALUES (?, 1, 'active', 'How to fix the race?', 'Use a mutex.', NULL, NULL, NULL, '[]', '[]', 1, 301, NULL)
    `).run(currentSessionId);

    const handler = createContextHandler({ db });
    const result = await handler(
      createInput({ source: "resume", sessionId: "session-context" }),
    );

    // Handler must still return a context string (the roster) and NO asyncWork
    expect(result.hookSpecificOutput).toBeDefined();
    expect(typeof result.hookSpecificOutput).toBe("string");
    expect(result.asyncWork).toBeUndefined();

    // Recovery must have enqueued a turn-stop item for this session
    const items = listPendingQueueItems(db, currentSessionId);
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((item) => item.kind === "turn-stop")).toBe(true);
  });

  test("startup source still recovers a stranded active turn while rendering the roster", async () => {
    // Same stranded turn seed
    db.query(`
      INSERT INTO turns (
        session_id, prompt_number, status,
        user_prompt, assistant_response,
        title, content, insight,
        files_read, files_modified, tool_call_count,
        created_at_epoch, updated_at_epoch
      ) VALUES (?, 1, 'active', 'How to fix the race?', 'Use a mutex.', NULL, NULL, NULL, '[]', '[]', 1, 301, NULL)
    `).run(currentSessionId);

    const handler = createContextHandler({ db });
    const result = await handler(
      createInput({ source: "startup", sessionId: "session-context" }),
    );

    expect(result.hookSpecificOutput).toContain("## Segment roster");
    const items = listPendingQueueItems(db, currentSessionId);
    expect(items.filter((item) => item.kind === "turn-stop").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The rubric's OWN hook slot ([S1730/T931]: Claude Code collapses a single
// hook output past ~10K chars to a 2KB persisted preview — two blocks
// sharing one slot would collapse together exactly when the roster fills).
// ---------------------------------------------------------------------------

describe("SessionStart:rubric — the rubric ships through its own slot", () => {
  test("the rubric section renders the full block with no db and no gating", async () => {
    const handler = createReadOnlyContextHandler({}, "rubric");
    const result = await handler(createInput({ sessionId: "any" }));
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toContain("<mnemo-memory-rubric");
    // Lane-model-v12 ticket 12: the slot carries BOTH halves of the split
    // rubric under one tag pair — concepts (shared with settlement) and the
    // main agent's own action principles. The old `## Segments` heading went
    // with the v11 document; these two anchors are one per half, so a slot
    // that silently lost a half fails here rather than at read time.
    expect(result.hookSpecificOutput).toContain("**tags**:归属有两个来源");
    expect(result.hookSpecificOutput).toContain("## 记录 —— 管好每一轮");
  });

  test("the bare context body no longer carries the rubric (split, not concatenated)", async () => {
    const freshDb = createDatabase(":memory:");
    initializeSchema(freshDb);
    const handler = createContextHandler({ db: freshDb });
    const result = await handler(createInput({ sessionId: "split-check" }));
    expect(result.hookSpecificOutput).toContain("## Segment roster");
    expect(result.hookSpecificOutput).not.toContain("mnemo-memory-rubric");
    freshDb.close();
  });
});
