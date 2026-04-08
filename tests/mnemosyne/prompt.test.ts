import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { recallMemory } from "../../src/mcp/recall";
import { buildMnemosynePrompt } from "../../src/mnemosyne/prompt";

describe("recall-powered extraction context", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "session-prompt-test",
      project: "/test/project",
      title: "Prompt test session",
      description: "Testing extraction context",
      insight: null,
      startedAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("preserves session headers and expanded turns for Mnemosyne", () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, assistant_response, title, description, created_at_epoch
      ) VALUES (?, 1, 'pending', ?, 'Added mutex to token refresh', 'Fix auth race', 'Serialized refresh', 120)`,
    ).run(sessionId, "Fix auth bug");
    const turnId = getTurn(db, sessionId, 1)!.id;
    db.query(
      `INSERT INTO observations (
        turn_id,
        type,
        title,
        description,
        narrative,
        facts,
        concepts,
        files_read,
        files_modified,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      turnId,
      "bugfix",
      "Mutex added",
      "Refresh is serialized",
      "A shared promise now serializes refresh work.",
      JSON.stringify(["mutex added", "test added"]),
      JSON.stringify(["problem-solution"]),
      JSON.stringify(["src/auth.ts"]),
      JSON.stringify(["src/auth.ts", "tests/auth.test.ts"]),
      121,
    );

    const context = recallMemory(db, {
      scope: "turns",
      session: sessionId,
      depth: "expanded",
    });
    const prompt = buildMnemosynePrompt(context);

    expect(prompt).toContain(`[S${sessionId}] Prompt test session`);
    expect(prompt).toContain("/test/project");
    expect(prompt).toContain("desc: Testing extraction context");
    expect(prompt).toContain("[T1] Fix auth race");
    expect(prompt).toContain("[pending]");
    expect(prompt).toContain('prompt: "');
    expect(prompt).toContain('response: "Added mutex to token refresh"');
    expect(prompt).toContain("[O");
    expect(prompt).toContain("Mutex added");
    expect(prompt).not.toContain("A shared promise now serializes refresh work.");
  });

  test("uses recall truncation and replay hints in the embedded context", () => {
    const longPrompt = "x".repeat(260);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', ?, 120)`,
    ).run(sessionId, longPrompt);
    const context = recallMemory(db, {
      scope: "turns",
      session: sessionId,
      depth: "expanded",
    });

    expect(context).toContain("[T1] Untitled");
    expect(context).toContain("replay(session=");
  });

  test("buildMnemosynePrompt still wraps the provided context", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain("CONVERSATION CONTEXT");
    expect(prompt).toContain("test context");
  });
});

describe("buildMnemosynePrompt", () => {
  test("documents stale re-evaluation and explicit undone handling", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain("Primary write tool is remember");
    expect(prompt).toContain('call remember({ parent: "S{id}", status: "undone" })');
    expect(prompt).toContain("Use save_turn and update_session only for compatibility");
    expect(prompt).toContain(
      "Do NOT re-process [extracted], [skipped], or [undone] turns",
    );
  });

  test("forbids observer-self narration and records durable debugging evidence", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain("Do not describe the observer's own behavior");
    expect(prompt).toContain("logs, queue state, DB rows, routing, request flow, or code-path inspection");
  });

  test("keeps field quality and concept/type separation guidance", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain("content or description: concise outcome, not a restatement of the user prompt");
    expect(prompt).toContain("insight: explain what was done, how it works, and why it matters");
    expect(prompt).toContain("tags: independent, verifiable labels for retrieval");
    expect(prompt).toContain("files_read/files_modified: only files that materially informed or changed the result");
    expect(prompt).not.toContain("narrative:");
    expect(prompt).not.toContain("facts:");
    expect(prompt).not.toContain("concepts (from fixed vocabulary)");
  });

  test("keeps update_session, private-tag exclusion, and tool-call examples", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain('Prefer remember({ id: "S{id}", ... }) when the session summary needs updating.');
    expect(prompt).toContain("Use update_session only as a compatibility fallback for legacy callers.");
    expect(prompt).toContain(
      "Include next_steps when the session has a clear trajectory or planned follow-up.",
    );
    expect(prompt).toContain("Content inside <private>...</private> tags must NOT be recorded.");
    expect(prompt).toContain('Good example: remember({ parent: "S1"');
    expect(prompt).toContain('Good example: remember({ parent: "S1/T2", type: "bugfix", title: "Mutex added", content: "Serialized refresh work", insight: "Concurrent refreshes no longer overlap", tags: ["concurrency", "auth"], files_read: ["src/auth.ts"], files_modified: ["src/auth.ts", "tests/auth.test.ts"] })');
    expect(prompt).not.toContain("observations: [");
    expect(prompt).toContain('Skip example: remember({ parent: "S1", status: "skipped" })');
  });

  test("references recall and replay tools for additional context", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain("Use recall() for context from past sessions");
    expect(prompt).toContain("Use replay(session=<session_id>, turn=<N>)");
  });

  test("keeps output discipline without duplicate prose-only rule", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt.match(/Never output prose/g)?.length).toBe(1);
  });

  test("guides remember as the primary write path", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain('remember({ parent: "S{id}"');
    expect(prompt).toContain('remember({ parent: "S{id}/T{n}"');
    expect(prompt).toContain('remember({ type: "feedback", scope: "global"');
    expect(prompt).toContain('remember({ id: "S1"');
  });
});
