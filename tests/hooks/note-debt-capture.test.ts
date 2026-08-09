import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { getNoteDebt, listNoteDebt } from "../../src/db/note-debt";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getShadowNote, upsertShadowNote } from "../../src/db/shadow-notes";
import { createPostToolUseHandler } from "../../src/hooks/handlers/post-tool-use";
import { createStopHandler } from "../../src/hooks/handlers/stop";
import { parseReplayTranscript } from "../../src/shared/transcript-parser";
import type { NormalizedHookInput } from "../../src/hooks/types";

/**
 * The asynchronous half of the pair: the entries that maintain the ledger.
 * Their contract is the mirror image of the reminder entry's — they write, and
 * they never answer with `additionalContext`.
 */
describe("note debt on the asynchronous capture entries", () => {
  let db: Database;
  let sessionId: number;
  let directory: string;

  /**
   * A turn whose Stop the hook captured — the queued `turn-stop` is that record
   * — while extraction has not yet run, so the row is still `active`. The sweep
   * classifies from that queued item, not from the turn's status, which is what
   * keeps the ledger off the extraction pipeline's latency.
   */
  function addTurn(promptNumber: number, prompt = `prompt ${promptNumber}`): number {
    const turnId = db
      .query<{ id: number }, [number, number, string]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, created_at_epoch
         ) VALUES (?, ?, 'active', ?, 100)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, prompt)!.id;
    db.query<unknown, [number, number]>(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('turn-stop', ?, ?, 100)`,
    ).run(turnId, sessionId);
    return turnId;
  }

  function addObservation(turnId: number, toolName: string): void {
    db.query(
      `INSERT INTO observations (
         turn_id, tool_name, excluded_from_extraction, created_at_epoch
       ) VALUES (?, ?, 0, 100)`,
    ).run(turnId, toolName);
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

  test("Stop classifies the turn that just ended and answers with no context", async () => {
    const working = addTurn(1);
    addObservation(working, "Edit");

    const result = await createStopHandler({
      db,
      now: () => 500,
      workerClientDeps: { fetchImpl: (async () => new Response(null)) as typeof fetch },
      workerEnv: {},
    })({
      eventName: "Stop",
      sessionId: "session-capture",
      cwd: "/tmp/project",
      stopHookActive: false,
      raw: {},
    });

    expect(getNoteDebt(db, working)).toMatchObject({
      status: "pending",
      promptNumber: 1,
    });
    // The capture entries wake the worker; carrying context here would silently
    // cost the wake, since the runner emits one or the other.
    expect(result.hookSpecificOutput).toBeUndefined();
    expect(typeof result.asyncWork).toBe("function");
  });

  test("Stop leaves a pure question-and-answer turn out of the ledger", async () => {
    const chat = addTurn(1);

    await createStopHandler({ db, now: () => 500, workerEnv: {} })({
      eventName: "Stop",
      sessionId: "session-capture",
      cwd: "/tmp/project",
      stopHookActive: false,
      raw: {},
    });

    expect(getNoteDebt(db, chat)).toBeNull();
    expect(listNoteDebt(db, sessionId)).toEqual([]);
  });

  // The Stop handler is not the only way into the ledger: whenever its own
  // reconcile did not classify a turn — an interrupt, a crash between the queue
  // write and the reconcile, a restart — the next tool result sweeps it up.
  // What the sweep will NOT do is classify a turn whose Stop was never captured
  // at all: that turn is stranded, its batch is not closed, and the liveness
  // repair owns it (see note-debt.test.ts).
  test("a tool result sweeps turns the Stop event did not classify", async () => {
    const interrupted = addTurn(1);
    addObservation(interrupted, "Bash");
    addTurn(2);

    const input: NormalizedHookInput = {
      eventName: "PostToolUse",
      sessionId: "session-capture",
      cwd: "/tmp/project",
      toolName: "Read",
      toolInput: { file_path: "src/auth.ts" },
      toolResponse: "line 1",
      stopHookActive: false,
      raw: {},
    };
    const result = await createPostToolUseHandler({ db, now: () => 500 })(input);

    expect(getNoteDebt(db, interrupted)?.status).toBe("pending");
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  test("the sweep reaches every unclassified turn, not just the previous one", async () => {
    // A turn the Stop event left unclassified is followed here by three pure
    // question-and-answer turns, which produce no tool result of their own and
    // so cannot trigger a sweep. The classification cursor is what
    // makes the eventual sweep whole: it walks every prompt number above the
    // cursor, so the working turn is still classified four turns later.
    const working = addTurn(1);
    addObservation(working, "Bash");
    const chatA = addTurn(2);
    const chatB = addTurn(3);
    const chatC = addTurn(4);
    addTurn(5);

    await createPostToolUseHandler({ db, now: () => 500 })({
      eventName: "PostToolUse",
      sessionId: "session-capture",
      cwd: "/tmp/project",
      toolName: "Read",
      toolResponse: "line 1",
      stopHookActive: false,
      raw: {},
    });

    expect(getNoteDebt(db, working)?.status).toBe("pending");
    // The intervening chat turns did no tool work, so they owe nothing and the
    // ledger stays proportional to real debt.
    for (const chat of [chatA, chatB, chatC]) {
      expect(getNoteDebt(db, chat)).toBeNull();
    }
  });

  test("a note call closes its debt on the same tool result", async () => {
    const working = addTurn(1);
    addObservation(working, "Edit");
    addTurn(2);
    await createPostToolUseHandler({ db, now: () => 500 })({
      eventName: "PostToolUse",
      sessionId: "session-capture",
      cwd: "/tmp/project",
      toolName: "Read",
      toolResponse: "line 1",
      stopHookActive: false,
      raw: {},
    });
    upsertShadowNote(db, {
      turnId: working,
      title: "implement+ledger: closes on note",
      content: "…",
      nowEpoch: 500,
    });

    await createPostToolUseHandler({ db, now: () => 600 })({
      eventName: "PostToolUse",
      sessionId: "session-capture",
      cwd: "/tmp/project",
      toolName: "mcp__mnemo__note",
      toolInput: { turn: `S${sessionId}/T1` },
      toolResponse: `Noted S${sessionId}/T1.`,
      stopHookActive: false,
      raw: {},
    });

    expect(getNoteDebt(db, working)).toMatchObject({
      status: "noted",
      closedAtEpoch: 600,
    });
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
});
