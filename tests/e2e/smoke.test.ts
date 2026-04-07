import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSession, getSessionByContentId } from "../../src/db/sessions";
import { getPendingTurns, getTurn } from "../../src/db/turns";
import { createSessionInitHandler } from "../../src/hooks/handlers/session-init";
import { createStopHandler } from "../../src/hooks/handlers/stop";
import { recallMemory } from "../../src/mcp/recall";
import { replayMemory } from "../../src/mcp/replay";
import { saveTurnTool } from "../../src/mcp/save-turn";
import { updateSessionTool } from "../../src/mcp/update-session";

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

    const transcript = writeTranscript([
      {
        role: "user",
        content: [{ type: "text", text: "Diagnose the auth race" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } },
          { type: "text", text: "The refresh path races under parallel load." },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", content: "auth.ts contents" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Fix it and add tests" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "src/auth.ts" } },
          { type: "text", text: "Added a mutex and regression coverage." },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", content: "edit applied" }],
      },
    ]);

    transcriptDirectory = transcript.directory;
    transcriptPath = transcript.path;
  });

  afterEach(() => {
    db.close();
    rmSync(transcriptDirectory, { recursive: true, force: true });
  });

  test("walks the full memory lifecycle", async () => {
    const forkMnemosyne = async ({
      prompt,
    }: {
      prompt: string;
      cwd?: string;
    }) => {
      const match = prompt.match(/Session ID: (\d+)/);
      if (!match) return;
      const session = getSession(db, Number(match[1]))!;

      for (const turn of getPendingTurns(db, session.id).filter((candidate) => candidate.assistantResponse)) {
        saveTurnTool(db, {
          session_id: session.id,
          prompt_number: turn.promptNumber,
          user_prompt: turn.userPrompt ?? undefined,
          assistant_response: turn.assistantResponse ?? undefined,
          title: turn.promptNumber === 1 ? "Diagnose auth" : "Fix auth race",
          description:
            turn.promptNumber === 1
              ? "Captured the race condition in auth refresh"
              : "Implemented mutex and regression coverage",
          insight:
            turn.promptNumber === 1
              ? "- refresh races under parallel load"
              : "- mutex stabilizes refresh flow",
          files_read: ["src/auth.ts"],
          files_modified:
            turn.promptNumber === 1 ? [] : ["src/auth.ts", "tests/auth.test.ts"],
          created_at_epoch: turn.createdAtEpoch,
          updated_at_epoch: turn.updatedAtEpoch ?? turn.createdAtEpoch + 1,
          observations: [
            {
              type: turn.promptNumber === 1 ? "discovery" : "bugfix",
              title: turn.promptNumber === 1 ? "Race confirmed" : "Mutex added",
              description:
                turn.promptNumber === 1
                  ? "Parallel refresh collides"
                  : "Refresh is serialized",
              narrative:
                turn.promptNumber === 1
                  ? "Concurrent 401 handling reproduced the auth race."
                  : "A shared promise now serializes refresh work.",
              facts:
                turn.promptNumber === 1
                  ? ["race reproduced"]
                  : ["mutex added", "test added"],
              concepts:
                turn.promptNumber === 1 ? ["gotcha"] : ["problem-solution"],
              files_read: ["src/auth.ts"],
              files_modified:
                turn.promptNumber === 1 ? [] : ["src/auth.ts", "tests/auth.test.ts"],
            },
          ],
        });
      }

      updateSessionTool(db, {
        session_id: session.id,
        title: "Auth race fix",
        description: "Diagnosed and fixed the refresh race",
        insight: "- durable memory extracted",
      });
    };

    const sessionInitHandler = createSessionInitHandler({
      db,
      forkMnemosyne,
      now: (() => {
        let time = 100;
        return () => ++time;
      })(),
    });
    const stopHandler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: () => true },
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
    expect(getTurn(db, sessionAfterFirstPrompt.id, 1)?.status).toBe("pending");

    await sessionInitHandler({
      eventName: "UserPromptSubmit",
      sessionId: "session-e2e",
      cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
      prompt: "Fix it and add tests",
      transcriptPath,
      stopHookActive: false,
      raw: {},
    });

    const session = getSessionByContentId(db, "session-e2e")!;
    expect(getTurn(db, session.id, 1)?.status).toBe("pending");
    expect(getTurn(db, session.id, 2)?.status).toBe("pending");

    await stopHandler({
      eventName: "Stop",
      sessionId: "session-e2e",
      cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
      transcriptPath,
      lastAssistantMessage: "Added a mutex and regression coverage.",
      stopHookActive: false,
      raw: {},
    });

    expect(getTurn(db, session.id, 1)?.status).toBe("extracted");
    expect(getTurn(db, session.id, 2)?.status).toBe("extracted");
    expect(getSessionByContentId(db, "session-e2e")?.completedAtEpoch).toBe(300);

    const recallSessions = recallMemory(db, { scope: "sessions" });
    const recallSessionTree = recallMemory(db, {
      scope: "turns",
      session: session.id,
      depth: "expanded",
    });
    const recallTurn = recallMemory(db, {
      scope: "observations",
      session: session.id,
      turn: 2,
      depth: "expanded",
    });
    const replayTurn = replayMemory(db, {
      session: session.id,
      turn: 2,
      transcriptPath,
    });

    expect(recallSessions).toContain("[S1] Auth race fix");
    expect(recallSessionTree).toContain("[T1] Diagnose auth");
    expect(recallSessionTree).toContain("[T2] Fix auth race");
    expect(recallTurn).toContain("[O2] 🔴 Mutex added");
    expect(replayTurn).toContain('prompt: "Fix it and add tests"');
    expect(replayTurn).toContain("[Tool 1] Edit");
  });
});
