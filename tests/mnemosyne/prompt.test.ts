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
      content: "Testing extraction context",
      insight: null,
      createdAtEpoch: 100,
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
        session_id, prompt_number, status, user_prompt, assistant_response, title, content, created_at_epoch
      ) VALUES (?, 1, 'pending', ?, 'Added mutex to token refresh', 'Fix auth race', 'Serialized refresh', 120)`,
    ).run(sessionId, "Fix auth bug");
    const turnId = getTurn(db, sessionId, 1)!.id;
    db.query(
      `INSERT INTO observations (
        turn_id,
        type,
        title,
        content,
        insight,
        tags,
        files_read,
        files_modified,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      turnId,
      "bugfix",
      "Mutex added",
      "Refresh is serialized",
      "A shared promise now serializes refresh work.",
      JSON.stringify(["problem-solution"]),
      JSON.stringify(["src/auth.ts"]),
      JSON.stringify(["src/auth.ts", "tests/auth.test.ts"]),
      121,
    );

    const context = recallMemory(db, {
      view: "turns",
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
      view: "turns",
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
  test("documents two-step workflow with batch efficiency", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain("1. READ:");
    expect(prompt).toContain("2. WRITE:");
    expect(prompt).toContain("ALL remember() calls together in one response");
    expect(prompt).toContain("Process ALL identified turns");
    expect(prompt).toContain('status: "undone"');
    expect(prompt).toContain(
      "Do NOT re-process [extracted], [skipped], or [undone] turns",
    );
  });

  test("forbids observer narration with good/bad examples", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain("Do not narrate your own process");
    expect(prompt).toContain("logs, DB rows, request flow, code-path inspection");
    // ✅/❌ contrast
    expect(prompt).toContain("built, fixed, deployed, configured, discovered");
    expect(prompt).toContain("observer narration");
  });

  test("declares constraints and efficiency guidance", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain("Tools: remember, recall, replay. All others denied.");
    expect(prompt).toContain("Non-tool-call output is discarded by the system.");
    expect(prompt).toContain("batch them");
    expect(prompt).toContain("<private>...</private> must not be recorded");
  });

  test("covers experience extraction fields", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain('parent: "S{id}/T{n}"');
    expect(prompt).toContain("type: bugfix | feature | refactor | change | discovery | decision");
    expect(prompt).toContain("title, content, insight, tags, files_read, files_modified");
    expect(prompt).toContain('remember({ id: "S{id}", title, content, insight, next_steps })');
  });

  test("covers memory types and exclusion rules", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain("user:");
    expect(prompt).toContain("feedback:");
    expect(prompt).toContain("project:");
    expect(prompt).toContain("reference:");
    // What NOT to save (from CC)
    expect(prompt).toContain("derivable from the codebase");
    expect(prompt).toContain("git log is authoritative");
    expect(prompt).toContain("the fix is in the code");
    expect(prompt).toContain("CLAUDE.md");
  });

  test("includes compact examples for all categories", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain('remember({ parent: "S1", prompt_number: 2, title: "Fix auth race"');
    expect(prompt).toContain('remember({ parent: "S1/T2", type: "bugfix", title: "Mutex added"');
    expect(prompt).toContain('remember({ id: "S1", title: "Auth race fix"');
    expect(prompt).toContain('remember({ type: "feedback"');
    expect(prompt).toContain('status: "skipped"');
  });

  test("dedup guidance present", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain("recall() to check for duplicates");
    expect(prompt).toContain("fewer, higher-signal observations");
  });

  test("keeps output discipline without duplicate prose-only rule", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain("discarded by the system");
    // No "Never output prose" — replaced by declarative constraint
    expect(prompt).not.toContain("Never output prose");
  });
});
