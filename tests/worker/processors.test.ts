import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation, getObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { renderFileTree as renderSharedFileTree } from "../../src/shared/file-tree";
import {
  cleanInput,
  cleanOutput,
  createWorkerProcessors,
} from "../../src/worker/processors";

describe("worker processors", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;
  let observationId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "worker-session",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Auth race",
      content: "Current summary",
      insight: "- current insight",
      nextSteps: "Ship it",
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;

    turnId = db
      .query<{ id: number }, []>(
        `
          INSERT INTO turns (
            session_id,
            prompt_number,
            status,
            user_prompt,
            assistant_response,
            created_at_epoch
          ) VALUES (?, 1, 'active', 'Diagnose auth race', 'Added mutex', 120)
          RETURNING id
        `,
      )
      .get(sessionId)!.id;

    observationId = createObservation(db, {
      turnId,
      toolName: "Read",
      toolInput: '{"file_path":"src/auth.ts"}',
      toolResult: "file contents",
      status: "pending",
      createdAtEpoch: 130,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("cleanInput strips Bash metadata and unwraps the command", () => {
    expect(
      cleanInput(
        "Bash",
        '{"command":"npm test","description":"system note","timeout":120000}',
      ),
    ).toBe("npm test");
  });

  test("cleanInput preserves all keys for non-Bash tools", () => {
    expect(
      cleanInput(
        "Grep",
        '{"pattern":"token","path":"src","output_mode":"content","-n":true}',
      ),
    ).toBe('{"pattern":"token","path":"src","output_mode":"content","-n":true}');
  });

  test("cleanInput returns the raw string when JSON parsing fails", () => {
    expect(cleanInput("Read", '{"file_path":"src/auth.ts"')).toBe(
      '{"file_path":"src/auth.ts"',
    );
  });

  test("cleanOutput extracts nested Read file.content", () => {
    expect(
      cleanOutput(
        "Read",
        '{"type":"text","file":{"filePath":"src/auth.ts","content":"export const auth = true;"}}',
      ),
    ).toBe("export const auth = true;");
  });

  test("cleanOutput falls through to filtered Read output when file.content is missing", () => {
    expect(
      cleanOutput(
        "Read",
        '{"type":"text","error":"ENOENT","file":{"filePath":"src/auth.ts"}}',
      ),
    ).toBe("");
  });

  test("cleanOutput keeps Bash stderr as the primary result when stdout is empty", () => {
    expect(
      cleanOutput(
        "Bash",
        '{"stdout":"","stderr":"Permission denied","interrupted":false}',
      ),
    ).toBe("Permission denied");
  });

  test("cleanOutput keeps Grep allowlist fields", () => {
    expect(
      cleanOutput(
        "Grep",
        '{"filenames":["src/auth.ts"],"content":"token","numFiles":1,"numLines":4,"durationMs":12}',
      ),
    ).toBe('{"filenames":["src/auth.ts"],"content":"token","numFiles":1,"numLines":4}');
  });

  test("cleanOutput keeps Edit allowlist fields", () => {
    expect(
      cleanOutput(
        "Edit",
        '{"filePath":"src/auth.ts","oldString":"foo","newString":"bar","structuredPatch":[]}',
      ),
    ).toBe('{"filePath":"src/auth.ts","oldString":"foo","newString":"bar"}');
  });

  test("cleanOutput passes unknown tool output through unchanged", () => {
    expect(cleanOutput("CustomMcp", '{"foo":"bar","count":1}')).toBe(
      '{"foo":"bar","count":1}',
    );
  });

  test("cleanOutput returns the raw string when JSON parsing fails", () => {
    expect(cleanOutput("Bash", '{"stdout":"ok"')).toBe('{"stdout":"ok"');
  });

  test("renderFileTree groups files under a common root", () => {
    expect(
      renderSharedFileTree([
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/processors.ts",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/server.ts",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/pending-queue.ts",
      ]),
    ).toBe(
      [
        "/Users/zhaoqixuan/Projects/claude-mnemo/src",
        "db/pending-queue.ts",
        "worker/",
        "  processors.ts",
        "  server.ts",
      ].join("\n"),
    );
  });

  test("shared renderFileTree matches the worker import contract", () => {
    const paths = [
      "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/processors.ts",
      "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/server.ts",
    ];
    expect(renderSharedFileTree(paths)).toBe(
      ["/Users/zhaoqixuan/Projects/claude-mnemo/src/worker", "processors.ts", "server.ts"].join("\n"),
    );
  });

  test("renderFileTree keeps the actual longest common directory prefix", () => {
    expect(
      renderSharedFileTree(["/a/b/c.ts", "/a/c/d.ts"]),
    ).toBe(["/a", "b/c.ts", "c/d.ts"].join("\n"));
  });

  test("renderFileTree returns none for an empty list", () => {
    expect(renderSharedFileTree([])).toBe("(none)");
  });

  test("renderFileTree renders single-file directories as dir/file", () => {
    expect(
      renderSharedFileTree([
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/pending-queue.ts",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/server.ts",
      ]),
    ).toBe(
      [
        "/Users/zhaoqixuan/Projects/claude-mnemo/src",
        "db/pending-queue.ts",
        "worker/server.ts",
      ].join("\n"),
    );
  });

  test("renderFileTree deduplicates the root path when it appears in the path list", () => {
    expect(
      renderSharedFileTree([
        "/Users/zhaoqixuan/Projects/claude-mnemo",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/server.ts",
      ]),
    ).toBe(
      ["/Users/zhaoqixuan/Projects/claude-mnemo", "src/worker/server.ts"].join("\n"),
    );
  });

  test("renderFileTree handles cross-project paths without collapsing them incorrectly", () => {
    expect(
      renderSharedFileTree([
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/server.ts",
        "/Users/zhaoqixuan/Projects/another-repo/src/index.ts",
      ]),
    ).toBe(
      [
        "/Users/zhaoqixuan/Projects",
        "another-repo/src/index.ts",
        "claude-mnemo/src/worker/server.ts",
      ].join("\n"),
    );
  });

  test("processObs invokes Mnemosyne for pending observations", async () => {
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processObs(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      observationId,
    );

    expect(pushMessage).toHaveBeenCalledTimes(1);
    const prompt = String(pushMessage.mock.calls[0]?.[0]);
    expect(prompt).toContain(`<obs id="O${observationId}">`);
    expect(prompt).toContain("🔧 Read");
    expect(prompt).toContain("in: src/auth.ts");
    expect(prompt).toContain("out: file contents");
    expect(prompt).toContain("<prior_session>");
    expect(prompt).toContain("title: Auth race");
    expect(prompt).toContain("content: Current summary");
    expect(prompt).toContain("insight: - current insight");
    expect(prompt).toContain("next_steps: Ship it");
    // Rules now live in the system prompt — no per-message instruction block.
    expect(prompt).not.toContain("<instruction>");
  });

  test("processObs omits prior_session when the session has no prior summary", async () => {
    db.query(
      `
        UPDATE sessions
        SET title = NULL,
            content = NULL,
            insight = NULL,
            next_steps = NULL
        WHERE id = ?
      `,
    ).run(sessionId);

    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processObs(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      observationId,
    );

    const prompt = String(pushMessage.mock.calls[0]?.[0]);
    expect(prompt).not.toContain("<prior_session>");
    expect(prompt).not.toContain("<instruction>");
  });

  test("processObs emits a pure <obs> block on the subsequent (initialized) path", async () => {
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processObs(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: true,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      observationId,
    );

    expect(pushMessage).toHaveBeenCalledTimes(1);
    // Strict equality: once the query session is initialized, subsequent obs
    // messages must contain the <obs> block and nothing else — no instruction,
    // no narration, no prefix/suffix. All recurring rules live in the system
    // prompt, so any extra bytes here are duplicated context-bloat.
    const expected = `<obs id="O${observationId}">
  🔧 Read
  in: src/auth.ts
  out: file contents
</obs>`;
    expect(String(pushMessage.mock.calls[0]?.[0])).toBe(expected);
  });

  test("processObs truncates cleaned obs payloads to the 300-char head-tail limit", async () => {
    db.query(
      `
        UPDATE observations
        SET tool_name = 'Bash',
            tool_input = ?,
            tool_result = ?
        WHERE id = ?
      `,
    ).run(
      JSON.stringify({
        command: "npm test",
        description: "system note",
        timeout: 120000,
      }),
      JSON.stringify({
        stdout: `${"a".repeat(220)}${"b".repeat(220)}`,
        stderr: "",
      }),
      observationId,
    );

    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processObs(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: true,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      observationId,
    );

    const prompt = String(pushMessage.mock.calls[0]?.[0]);
    expect(prompt).toContain("in: npm test");
    expect(prompt).toContain("[...160 chars truncated...]");
    expect(prompt).toContain("aaaaaaaaaa");
    expect(prompt).toContain("bbbbbbbbbb");
  });

  test("processObs skips already-finalized observations", async () => {
    db.query("UPDATE observations SET status = 'extracted' WHERE id = ?").run(observationId);
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processObs(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      observationId,
    );

    expect(pushMessage).not.toHaveBeenCalled();
  });

  test("processTurnStop invokes Mnemosyne for active turns", async () => {
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processTurnStop(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      turnId,
    );

    expect(pushMessage).toHaveBeenCalledTimes(1);
    const prompt = String(pushMessage.mock.calls[0]?.[0]);
    expect(prompt).toContain(`<turn id="T${turnId}">`);
    expect(prompt).toContain("Diagnose auth race");
    expect(prompt).toContain("Added mutex");
    expect(prompt).toContain(`<session id="S${sessionId}">`);
    // Identity and extraction rules now live in the system prompt.
    expect(prompt).not.toContain("You are Mnemosyne");
    expect(prompt).not.toContain("<instruction>");
  });

  test("processTurnStop skips turns that are already finalized", async () => {
    db.query("UPDATE turns SET status = 'extracted' WHERE id = ?").run(turnId);
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processTurnStop(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      turnId,
    );

    expect(pushMessage).not.toHaveBeenCalled();
  });

  test("pushSessionSummaryPrompt invokes Mnemosyne with current session state", async () => {
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.pushSessionSummaryPrompt(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      sessionId,
    );

    expect(pushMessage).toHaveBeenCalledTimes(1);
    const prompt = String(pushMessage.mock.calls[0]?.[0]);
    expect(prompt).toContain(`<session id="S${sessionId}">`);
    expect(prompt).toContain("Current summary");
    // Session-summary still carries its length budget inline.
    expect(prompt).toContain("Length budget");
    expect(prompt).toContain("material change");
    expect(prompt).toContain("no tool calls");
    expect(prompt).not.toContain("You are Mnemosyne");
  });

  test("processTurnStop does not mutate the turn before Mnemosyne writes back", async () => {
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processTurnStop(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      turnId,
    );

    expect(getTurnById(db, turnId)?.status).toBe("active");
  });

  test("processTurnStop aggregates file paths from observation tool input", async () => {
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processTurnStop(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      turnId,
    );

    const turn = getTurnById(db, turnId);
    expect(turn?.filesRead).toEqual(["src/auth.ts"]);
    expect(turn?.toolCallCount).toBe(1);
    expect(String(pushMessage.mock.calls[0]?.[0])).toContain("files_read:\n  src/auth.ts");
  });

  test("processBatch injects prior_session on the first batch and records the injected summary epoch", async () => {
    db.query("UPDATE turns SET status = 'extracted' WHERE id = ?").run(turnId);
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);
    const state = {
      sessionDbId: sessionId,
      processingLock: Promise.resolve(),
      pushMessage,
      querySession: null,
      contentSessionId: null,
      project: null,
      initialized: false,
      lastPushAt: 0,
      lastMessageAt: 0,
      lastActivity: 0,
      lastInjectedSummaryEpoch: 0,
    };

    await processors.processBatch(
      state,
      [{ seq: 1, kind: "obs", targetId: observationId, sessionDbId: sessionId, claimedAtEpoch: 1, enqueuedAtEpoch: 1 }],
      {
        turnStopItems: [
          { seq: 2, kind: "turn-stop", targetId: turnId, sessionDbId: sessionId, claimedAtEpoch: 1, enqueuedAtEpoch: 1 },
        ],
      },
    );

    const prompt = String(pushMessage.mock.calls[0]?.[0]);
    expect(prompt).toContain("<prior_session>");
    expect(prompt).not.toContain("<session-updated>");
    expect(state.initialized).toBe(true);
    expect(state.lastInjectedSummaryEpoch).toBe(
      getSession(db, sessionId)?.summaryUpdatedAtEpoch ?? 0,
    );
  });

  test("processBatch skips prior_session when the injected summary epoch is already current", async () => {
    db.query("UPDATE turns SET status = 'extracted' WHERE id = ?").run(turnId);
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);
    const currentSummaryEpoch = getSession(db, sessionId)?.summaryUpdatedAtEpoch ?? 0;

    await processors.processBatch(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: true,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
        lastInjectedSummaryEpoch: currentSummaryEpoch,
      },
      [{ seq: 1, kind: "obs", targetId: observationId, sessionDbId: sessionId, claimedAtEpoch: 1, enqueuedAtEpoch: 1 }],
      {
        turnStopItems: [
          { seq: 2, kind: "turn-stop", targetId: turnId, sessionDbId: sessionId, claimedAtEpoch: 1, enqueuedAtEpoch: 1 },
        ],
      },
    );

    const prompt = String(pushMessage.mock.calls[0]?.[0]);
    expect(prompt).not.toContain("<prior_session>");
    expect(prompt).not.toContain("<session-updated>");
  });

  test("processBatch injects prior_session with session-updated tag when summary epoch advances after initialization", async () => {
    db.query("UPDATE turns SET status = 'extracted' WHERE id = ?").run(turnId);
    db.query(
      "UPDATE sessions SET summary_updated_at_epoch = 500 WHERE id = ?",
    ).run(sessionId);

    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processBatch(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: true,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
        lastInjectedSummaryEpoch: 200,
      },
      [{ seq: 1, kind: "obs", targetId: observationId, sessionDbId: sessionId, claimedAtEpoch: 1, enqueuedAtEpoch: 1 }],
      {
        turnStopItems: [
          { seq: 2, kind: "turn-stop", targetId: turnId, sessionDbId: sessionId, claimedAtEpoch: 1, enqueuedAtEpoch: 1 },
        ],
      },
    );

    const prompt = String(pushMessage.mock.calls[0]?.[0]);
    expect(prompt).toContain("<prior_session>");
    expect(prompt).toContain("<session-updated>");
    expect(prompt).toContain("Session summary was refreshed since your last message.");
  });

  test("processBatch re-reads the session after pushMessage to capture summary updates triggered during the batch", async () => {
    db.query("UPDATE turns SET status = 'extracted' WHERE id = ?").run(turnId);
    const processors = createWorkerProcessors(db);
    const state = {
      sessionDbId: sessionId,
      processingLock: Promise.resolve(),
      pushMessage: mock(async () => {
        db.query(
          `
            UPDATE sessions
            SET summary_updated_at_epoch = 999
            WHERE id = ?
          `,
        ).run(sessionId);
      }),
      querySession: null,
      contentSessionId: null,
      project: null,
      initialized: false,
      lastPushAt: 0,
      lastMessageAt: 0,
      lastActivity: 0,
      lastInjectedSummaryEpoch: 0,
    };

    await processors.processBatch(
      state,
      [{ seq: 1, kind: "obs", targetId: observationId, sessionDbId: sessionId, claimedAtEpoch: 1, enqueuedAtEpoch: 1 }],
      {
        turnStopItems: [
          { seq: 2, kind: "turn-stop", targetId: turnId, sessionDbId: sessionId, claimedAtEpoch: 1, enqueuedAtEpoch: 1 },
        ],
      },
    );

    expect(state.lastInjectedSummaryEpoch).toBe(999);
  });

  test("processBatch auto-skips untouched observation records in completed-turn batches", async () => {
    db.query("UPDATE turns SET status = 'extracted' WHERE id = ?").run(turnId);
    const skippedObservationId = createObservation(db, {
      turnId,
      toolName: "Glob",
      toolInput: '{"path":"src"}',
      toolResult: '{"filenames":["src/auth.ts"]}',
      status: "pending",
      createdAtEpoch: 131,
    }).id;
    const processors = createWorkerProcessors(db);

    await processors.processBatch(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage: mock(async () => {
          // Simulate Mnemosyne extracting only the original observation.
          db.query("UPDATE observations SET status = 'extracted' WHERE id = ?").run(
            observationId,
          );
        }),
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
        lastInjectedSummaryEpoch: 0,
      },
      [
        {
          seq: 1,
          kind: "obs",
          targetId: observationId,
          sessionDbId: sessionId,
          claimedAtEpoch: 1,
          enqueuedAtEpoch: 1,
        },
        {
          seq: 2,
          kind: "obs",
          targetId: skippedObservationId,
          sessionDbId: sessionId,
          claimedAtEpoch: 1,
          enqueuedAtEpoch: 1,
        },
      ],
      {
        turnStopItems: [
          {
            seq: 3,
            kind: "turn-stop",
            targetId: turnId,
            sessionDbId: sessionId,
            claimedAtEpoch: 1,
            enqueuedAtEpoch: 1,
          },
        ],
      },
    );

    expect(getObservation(db, observationId)?.status).toBe("extracted");
    expect(getObservation(db, skippedObservationId)?.status).toBe("skipped");
  });

  test("processBatch does not auto-skip untouched observation records in partial-turn keepalive batches", async () => {
    const keepaliveObservationId = createObservation(db, {
      turnId,
      toolName: "Bash",
      toolInput: '{"command":"npm test","description":"system note","timeout":120000}',
      toolResult: '{"stdout":"","stderr":"still running","interrupted":false}',
      status: "pending",
      createdAtEpoch: 131,
    }).id;
    const processors = createWorkerProcessors(db);

    await processors.processBatch(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage: mock(async () => {}),
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
        lastInjectedSummaryEpoch: 0,
      },
      [
        {
          seq: 1,
          kind: "obs",
          targetId: keepaliveObservationId,
          sessionDbId: sessionId,
          claimedAtEpoch: 1,
          enqueuedAtEpoch: 1,
        },
      ],
      {
        turnStopItems: [],
        partialTurns: [
          {
            turnId,
            totalObsCount: 2,
            contextObservationIds: [observationId, keepaliveObservationId],
          },
        ],
      },
    );

    expect(getObservation(db, keepaliveObservationId)?.status).toBe("pending");
  });
});
