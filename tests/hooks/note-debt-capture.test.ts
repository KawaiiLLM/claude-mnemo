import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getShadowNote, upsertShadowNote } from "../../src/db/shadow-notes";
import { backfillShadowNoteWriterModels } from "../../src/hooks/backfill";
import { createStopHandler } from "../../src/hooks/handlers/stop";
import { parseReplayTranscript } from "../../src/shared/transcript-parser";

/**
 * Writer-model backfill via Stop (spec D4's mechanical provenance).
 *
 * Before note-prompt-clock this file also exercised the note-debt
 * classification walk that used to run inside Stop/PostToolUse. That walk is
 * gone (spec D1): the owed set is a derived query `session-init` computes at
 * prompt time (tests/db/note-debt.test.ts), and Stop/PostToolUse now only run
 * turn settlement (tests/db/turn-settlement.test.ts, ticket 02) before their
 * own capture work. What is left here — recovering which model actually
 * wrote a note from the transcript, since the MCP process that ran the write
 * has no way to know its own model identity — is unrelated to either and
 * still needs Stop's transcript read.
 */
describe("writer_model backfill on Stop", () => {
  let db: Database;
  let sessionId: number;
  let directory: string;

  function addTurn(
    promptNumber: number,
    prompt = `prompt ${promptNumber}`,
    contentPromptId: string | null = null,
  ): number {
    return db
      .query<{ id: number }, [number, number, string, string | null]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, content_prompt_id, created_at_epoch
         ) VALUES (?, ?, 'active', ?, ?, 100)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, prompt, contentPromptId)!.id;
  }

  function writeTranscript(lines: unknown[]): string {
    const path = join(directory, "session.jsonl");
    writeFileSync(
      path,
      lines.map((line) => JSON.stringify(line)).join("\n"),
      "utf8",
    );
    return path;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    directory = mkdtempSync(join(tmpdir(), "claude-mnemo-note-capture-"));
    sessionId = upsertSession(db, {
      contentSessionId: "session-capture",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("writer_model is recovered from message.model at capture time", async () => {
    const about = addTurn(1, "do the work");
    const ride = addTurn(2, "write the note");
    // The MCP process cannot know the model, so the note lands unattributed.
    upsertShadowNote(db, {
      turnId: about,
      title: "measure+capture: writer_model backfill",
      content: "…",
      rideTurnId: ride,
      nowEpoch: 400,
    });
    expect(getShadowNote(db, about)?.writerModel).toBeNull();

    const transcriptPath = writeTranscript([
      { type: "user", role: "user", promptId: "p1", message: { role: "user", content: [{ type: "text", text: "do the work" }] } },
      { type: "assistant", promptId: "p1", message: { role: "assistant", model: "claude-opus-4-5", content: [{ type: "text", text: "done" }] } },
      { type: "user", role: "user", promptId: "p2", message: { role: "user", content: [{ type: "text", text: "write the note" }] } },
      { type: "assistant", promptId: "p2", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "noted" }] } },
    ]);

    await createStopHandler({ db, now: () => 500, workerEnv: {} })({
      eventName: "Stop",
      sessionId: "session-capture",
      cwd: "/tmp/project",
      transcriptPath,
      stopHookActive: false,
      raw: {},
    });

    // The model that WROTE the note (the ride turn's), not the one that did the
    // work the note is about.
    expect(getShadowNote(db, about)?.writerModel).toBe("claude-sonnet-5");
  });

  test("a recorded writer_model is never restated by a later parse", async () => {
    const about = addTurn(1);
    const ride = addTurn(2);
    upsertShadowNote(db, {
      turnId: about,
      title: "measure+capture: attribution is immutable",
      content: "…",
      writerModel: "claude-opus-4-5",
      rideTurnId: ride,
      nowEpoch: 400,
    });

    const transcriptPath = writeTranscript([
      { type: "user", role: "user", promptId: "p1", message: { role: "user", content: [{ type: "text", text: "prompt 1" }] } },
      { type: "assistant", promptId: "p1", message: { role: "assistant", model: "claude-haiku-9", content: [{ type: "text", text: "a" }] } },
      { type: "user", role: "user", promptId: "p2", message: { role: "user", content: [{ type: "text", text: "prompt 2" }] } },
      { type: "assistant", promptId: "p2", message: { role: "assistant", model: "claude-haiku-9", content: [{ type: "text", text: "b" }] } },
    ]);

    await createStopHandler({ db, now: () => 500, workerEnv: {} })({
      eventName: "Stop",
      sessionId: "session-capture",
      cwd: "/tmp/project",
      transcriptPath,
      stopHookActive: false,
      raw: {},
    });

    expect(getShadowNote(db, about)?.writerModel).toBe("claude-opus-4-5");
  });

  test("the parser exposes the model that finished each turn", () => {
    const transcriptPath = writeTranscript([
      { type: "user", role: "user", promptId: "p1", message: { role: "user", content: [{ type: "text", text: "prompt" }] } },
      { type: "assistant", promptId: "p1", message: { role: "assistant", model: "claude-opus-4-5", content: [{ type: "text", text: "first" }] } },
      { type: "assistant", promptId: "p1", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "second" }] } },
    ]);

    const [turn] = parseReplayTranscript(transcriptPath);

    expect(turn?.assistantModel).toBe("claude-sonnet-5");
  });

  /**
   * ticket 10 (`.scratch/main-agent-edges/issues/10-writer-model-empty.md`):
   * a turn created without ever capturing its own `content_prompt_id` (a
   * cross-session-message delivery is the reproducible case in production —
   * `backfillFromTranscript` only ever records `content_prompt_id` for
   * whichever turn is the LATEST pending one at the moment its own Stop cycle
   * runs, so a turn superseded before that moment stays NULL forever) can
   * never be reached by the position-based matcher above: whatever transcript
   * entry happens to sit at that turn's own `prompt_number` almost always
   * carries ITS OWN promptId, which wins the `??` and diverts the match to a
   * completely different, correctly-addressed row before the promptNumber
   * fallback is ever tried for that position. The note rides forever
   * unattributed. `backfillOrphanedRideTurns` recovers it by the one thing a
   * synthetic delivery still shares verbatim with its transcript echo: the
   * stored `user_prompt` text.
   */
  test("an orphaned ride turn (no content_prompt_id, position claimed by someone else) is recovered by text", async () => {
    const about = addTurn(1, "do the work");
    const ride = addTurn(
      2,
      '<cross-session-message from="uds:/tmp/x.sock">\nunique-marker-xyz payload',
    );
    // A turn whose own content_prompt_id legitimately owns "p2" — this is what
    // makes prompt_number 2 unreachable via the fallback: the transcript entry
    // sitting at position 2 resolves to THIS turn by promptId, not by falling
    // through to a positional match against `ride`.
    addTurn(99, "some other prompt entirely", "p2");

    upsertShadowNote(db, {
      turnId: about,
      title: "measure+capture: orphaned ride turn",
      content: "…",
      rideTurnId: ride,
      nowEpoch: 400,
    });
    expect(getShadowNote(db, about)?.writerModel).toBeNull();

    const transcriptPath = writeTranscript([
      {
        type: "user",
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        message: { role: "user", content: [{ type: "text", text: "do the work" }] },
      },
      {
        type: "assistant",
        promptId: "p1",
        message: { role: "assistant", model: "claude-haiku-5", content: [{ type: "text", text: "a" }] },
      },
      {
        type: "user",
        role: "user",
        promptId: "p2",
        permissionMode: "default",
        message: { role: "user", content: [{ type: "text", text: "some other prompt entirely" }] },
      },
      {
        type: "assistant",
        promptId: "p2",
        message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "b" }] },
      },
      {
        type: "user",
        role: "user",
        promptId: "p3",
        permissionMode: "default",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/x.sock">\nunique-marker-xyz payload',
            },
          ],
        },
      },
      {
        type: "assistant",
        promptId: "p3",
        message: { role: "assistant", model: "claude-opus-9", content: [{ type: "text", text: "c" }] },
      },
    ]);

    await createStopHandler({ db, now: () => 500, workerEnv: {} })({
      eventName: "Stop",
      sessionId: "session-capture",
      cwd: "/tmp/project",
      transcriptPath,
      stopHookActive: false,
      raw: {},
    });

    // Recovered from the text-anchored match (position 3), never from the
    // model that happened to land on the stolen position 2.
    expect(getShadowNote(db, about)?.writerModel).toBe("claude-opus-9");
  });

  test("the text-anchored fallback leaves writer_model NULL when no transcript entry carries the payload", () => {
    const about = addTurn(1, "do the work");
    const ride = addTurn(
      2,
      '<cross-session-message from="uds:/tmp/x.sock">\nnever-echoed payload',
    );

    upsertShadowNote(db, {
      turnId: about,
      title: "measure+capture: orphaned ride turn, no echo",
      content: "…",
      rideTurnId: ride,
      nowEpoch: 400,
    });

    // Fed directly to backfillShadowNoteWriterModels — the exact shape
    // parseReplayTranscript would produce, but constructed by hand so this
    // test does not depend on file-backed transcript parsing at all.
    const transcriptTurns = [
      {
        promptNumber: 1,
        promptId: "p1",
        transcriptLineStart: 1,
        userPrompt: "do the work",
        assistantText: "a",
        toolCalls: [],
        isSidechain: false,
        wasInterrupted: false,
        assistantModel: "claude-haiku-5",
      },
    ];

    const filled = backfillShadowNoteWriterModels(db, sessionId, transcriptTurns);

    expect(filled).toBe(0);
    expect(getShadowNote(db, about)?.writerModel).toBeNull();
  });
});
