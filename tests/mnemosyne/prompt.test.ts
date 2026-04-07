import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  buildExtractionContext,
  buildMnemosynePrompt,
} from "../../src/mnemosyne/prompt";

describe("buildExtractionContext", () => {
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

  test("renders pending turns expanded with prompt and response", () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, assistant_response, created_at_epoch
      ) VALUES (?, 1, 'pending', 'Fix the auth bug', 'Added mutex to token refresh', 120)`,
    ).run(sessionId);

    const context = buildExtractionContext(db, sessionId);

    expect(context).toContain(`Session ID: ${sessionId}`);
    expect(context).toContain("[T1]");
    expect(context).toContain("[pending]");
    expect(context).toContain('prompt: "Fix the auth bug"');
    expect(context).toContain('response: "Added mutex to token refresh"');
  });

  test("renders extracted turns collapsed with title and stats", () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, assistant_response, title, description, created_at_epoch
      ) VALUES (?, 1, 'extracted', 'Fix auth', 'Done', 'Fix auth race', 'Serialized refresh', 120)`,
    ).run(sessionId);
    for (let i = 2; i <= 5; i++) {
      db.query(
        `INSERT INTO turns (
          session_id, prompt_number, status, user_prompt, title, created_at_epoch
        ) VALUES (?, ?, 'pending', ?, ?, ?)`,
      ).run(sessionId, i, `Prompt ${i}`, `Turn ${i}`, 120 + i);
    }

    const context = buildExtractionContext(db, sessionId);

    expect(context).toContain("[T1] Fix auth race");
    expect(context).toContain("[extracted]");
    expect(context).toContain("desc: Serialized refresh");
    expect(context).not.toContain('prompt: "Fix auth"');
  });

  test("omits middle turns when exceeding head + tail threshold", () => {
    for (let i = 1; i <= 10; i++) {
      db.query(
        `INSERT INTO turns (
          session_id, prompt_number, status, user_prompt, title, created_at_epoch
        ) VALUES (?, ?, 'extracted', ?, ?, ?)`,
      ).run(sessionId, i, `Prompt ${i}`, `Turn ${i}`, 100 + i);
    }

    const context = buildExtractionContext(db, sessionId);

    expect(context).toContain("[T1]");
    expect(context).toContain("[T2]");
    expect(context).toContain("[T3]");
    expect(context).toContain("... 4 more turns ...");
    expect(context).toContain("[T8]");
    expect(context).toContain("[T9]");
    expect(context).toContain("[T10]");
    expect(context).not.toContain("[T5]");
  });

  test("always expands stale turns even in the middle", () => {
    for (let i = 1; i <= 8; i++) {
      const status = i === 5 ? "stale" : "extracted";
      db.query(
        `INSERT INTO turns (
          session_id, prompt_number, status, user_prompt, assistant_response, title, created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, i, status, `Prompt ${i}`, `Response ${i}`, `Turn ${i}`, 100 + i);
    }

    const context = buildExtractionContext(db, sessionId);

    expect(context).toContain("[T5] Turn 5");
    expect(context).toContain("[stale]");
    expect(context).toContain('prompt: "Prompt 5"');
    expect(context).toContain('response: "Response 5"');
  });

  test("truncates long content with replay hint", () => {
    const longPrompt = "x".repeat(2000);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', ?, 120)`,
    ).run(sessionId, longPrompt);

    const context = buildExtractionContext(db, sessionId);

    expect(context).toContain("[truncated");
    expect(context).toContain("replay(session=");
  });
});

describe("buildMnemosynePrompt", () => {
  test("documents stale re-evaluation and explicit undone handling", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain('call save_turn with status="undone"');
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

    expect(prompt).toContain("narrative: explain what was done, how it works, and why it matters");
    expect(prompt).toContain("Do NOT use the observation type as a concept");
  });

  test("keeps update_session, private-tag exclusion, and tool-call examples", () => {
    const prompt = buildMnemosynePrompt("test context");

    expect(prompt).toContain("Call update_session if the session summary needs updating");
    expect(prompt).toContain(
      "Include next_steps when the session has a clear trajectory or planned follow-up.",
    );
    expect(prompt).toContain("Content inside <private>...</private> tags must NOT be recorded.");
    expect(prompt).toContain('Good example: save_turn({');
    expect(prompt).toContain("Skip example: save_turn({ session_id: 1, prompt_number: 3 })");
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
});
