import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getObservation } from "../../src/db/observations";
import { getSessionByContentId } from "../../src/db/sessions";
import { getTurn, getTurnById } from "../../src/db/turns";
import { createPostToolUseHandler } from "../../src/hooks/handlers/post-tool-use";
import { createSessionInitHandler } from "../../src/hooks/handlers/session-init";
import { createStopHandler } from "../../src/hooks/handlers/stop";
import { recallMemory } from "../../src/mcp/recall";
import { noteTool } from "../../src/mcp/note";

function writeTranscript(lines: unknown[]): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-e2e-"));
  const path = join(directory, "session.jsonl");

  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );

  return { directory, path };
}

describe("claude-mnemo smoke test", () => {
  let db: Database;
  let transcriptDirectory: string;
  let transcriptPath: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    const transcript = writeTranscript([]);

    transcriptDirectory = transcript.directory;
    transcriptPath = transcript.path;
  });

  afterEach(() => {
    db.close();
    rmSync(transcriptDirectory, { recursive: true, force: true });
  });

  test("walks the queue-backed memory lifecycle", async () => {
    const sessionInitHandler = createSessionInitHandler({
      db,
      now: (() => {
        let time = 100;
        return () => ++time;
      })(),
    });
    const postToolUseHandler = createPostToolUseHandler({
      db,
      now: () => 250,
    });
    const stopHandler = createStopHandler({
      db,
      workerClientDeps: {
        fetchImpl: async () => new Response(null, { status: 200 }),
      },
      now: () => 300,
    });

    await sessionInitHandler({
      eventName: "UserPromptSubmit",
      sessionId: "session-e2e",
      cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
      prompt: "Diagnose the auth race",
      transcriptPath,
      stopHookActive: false,
      raw: {},
    });

    const sessionAfterFirstPrompt = getSessionByContentId(db, "session-e2e")!;
    expect(getTurn(db, sessionAfterFirstPrompt.id, 1)?.status).toBe("active");

    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "Diagnose the auth race" }],
      })}\n${JSON.stringify({
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } },
          { type: "text", text: "The refresh path races under parallel load." },
        ],
      })}\n${JSON.stringify({
        role: "user",
        content: [{ type: "tool_result", content: "auth.ts contents" }],
      })}\n`,
      "utf8",
    );

    await sessionInitHandler({
      eventName: "UserPromptSubmit",
      sessionId: "session-e2e",
      cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
      prompt: "Fix it and add tests",
      transcriptPath,
      stopHookActive: false,
      raw: {},
    });

    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "Fix it and add tests" }],
      })}\n${JSON.stringify({
        role: "assistant",
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "src/auth.ts" } },
          { type: "text", text: "Added a mutex and regression coverage." },
        ],
      })}\n${JSON.stringify({
        role: "user",
        content: [{ type: "tool_result", content: "edit applied" }],
      })}`,
      "utf8",
    );

    const session = getSessionByContentId(db, "session-e2e")!;
    expect(getTurn(db, session.id, 1)?.status).toBe("active");
    expect(getTurn(db, session.id, 2)?.status).toBe("active");

    await postToolUseHandler({
      eventName: "PostToolUse",
      sessionId: "session-e2e",
      cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
      toolName: "Read",
      toolInput: { file_path: "src/auth.ts" },
      toolResponse: "auth.ts contents",
      stopHookActive: false,
      raw: {},
    });

    await postToolUseHandler({
      eventName: "PostToolUse",
      sessionId: "session-e2e",
      cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
      toolName: "Edit",
      toolInput: { file_path: "src/auth.ts" },
      toolResponse: "edit applied",
      stopHookActive: false,
      raw: {},
    });

    const stopResult = await stopHandler({
      eventName: "Stop",
      sessionId: "session-e2e",
      cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
      transcriptPath,
      lastAssistantMessage: "Added a mutex and regression coverage.",
      stopHookActive: false,
      raw: {},
    });

    expect(stopResult.continue).toBe(true);
    expect(stopResult.exitCode).toBe(0);
    expect(typeof stopResult.asyncWork).toBe("function");
    await stopResult.asyncWork?.();
    // Stop is the completion event, and completion settles the turn (ticket 15).
    // No era configured, so an un-noted turn nobody will ever write is `failed`.
    expect(getTurn(db, session.id, 1)?.status).toBe("failed");
    expect(getTurn(db, session.id, 2)?.status).toBe("failed");
    expect(getSessionByContentId(db, "session-e2e")?.completedAtEpoch).toBe(300);

    const firstTurnId = getTurn(db, session.id, 1)!.id;
    const secondTurnId = getTurn(db, session.id, 2)!.id;

    // eraCutoffEpoch: 1 puts every turn (real epochs from Date.now()) on the
    // current, promoted path — the shape production writes through today.
    noteTool(
      db,
      {
        turn: `S${session.id}/T1`,
        title: "Diagnose auth",
        content: "Captured the race condition in auth refresh",
        insight: "- refresh races under parallel load",
        type: ["research"],
        grade: 2,
        tags: ["gotcha"],
      },
      { eraCutoffEpoch: 1 },
    );
    // Observation writing is not part of the merged write tool (ticket 03: one
    // tool writes turns and sessions) — the two observations this scenario
    // wants findable via recall get their title/status set directly, the way
    // any fixture sets up state a tool call does not itself produce.
    db.query(
      "UPDATE observations SET title = ?, content = ?, status = 'extracted' WHERE id = 1",
    ).run("Race confirmed", "Parallel refresh collides");
    noteTool(
      db,
      {
        turn: `S${session.id}/T2`,
        title: "Fix auth race",
        content: "Implemented mutex and regression coverage",
        insight: "- mutex stabilizes refresh flow",
        type: ["fix"],
        grade: 2,
        tags: ["problem-solution"],
      },
      { eraCutoffEpoch: 1 },
    );
    db.query(
      "UPDATE observations SET title = ?, content = ?, status = 'extracted' WHERE id = 2",
    ).run("Mutex added", "Refresh is serialized");
    noteTool(db, {
      session: `S${session.id}`,
      title: "Auth race fix",
      content: "Diagnosed and fixed the refresh race",
      decision: "Chose a mutex over a retry queue [T2]",
      done: "Serialized refresh with a mutex [T2]",
      // ticket 04 (spec D2): `current` is deleted. Sending it here refused the
      // WHOLE call, which is the intended behaviour and is why this fixture
      // had to change — the seven fields are title/content/insight and
      // next_steps/decision/done/reference.
      insight: "A refresh race hides behind a retry queue",
      next_steps: "Backport to the release branch",
    });

    expect(getTurnById(db, firstTurnId)?.status).toBe("extracted");
    expect(getTurnById(db, secondTurnId)?.status).toBe("extracted");
    expect(getObservation(db, 1)?.status).toBe("extracted");
    expect(getObservation(db, 2)?.status).toBe("extracted");

    const recallSessions = recallMemory(db, {});
    const recallSessionTree = recallMemory(db, {
      id: `S${session.id}/T*`,
      depth: "expanded",
    });
    const recallTurn = recallMemory(db, {
      id: `S${session.id}/T2/O*`,
      depth: "expanded",
    });
    expect(recallSessions).toContain("[S1] Auth race fix");
    expect(recallSessionTree).toContain("[S1][T1:L1] Diagnose auth");
    expect(recallSessionTree).toContain("[S1][T2:L4] Fix auth race");
    expect(recallTurn).toContain("[O2] Mutex added");
    expect(recallSessionTree).toContain("- [S1] Auth race fix");
  });
});
