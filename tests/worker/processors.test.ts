import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation, getObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { renderFileTree as renderSharedFileTree } from "../../src/shared/file-tree";
import {
  buildBatchPrompt,
  buildTurnSignificanceCalibration,
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

  test("cleanOutput extracts text from an MCP content array (D1)", () => {
    expect(
      cleanOutput(
        "mcp__playwright__browser_snapshot",
        '[{"type":"text","text":"line one"},{"type":"text","text":"line two"}]',
      ),
    ).toBe("line one\nline two");
  });

  test("cleanOutput skips empty/non-text blocks in an MCP content array", () => {
    expect(
      cleanOutput(
        "mcp__playwright__x",
        '[{"type":"image","data":"AAAA"},{"type":"text","text":""},{"type":"text","text":"only this"}]',
      ),
    ).toBe("only this");
  });

  test("cleanOutput falls back to raw JSON for an MCP array with no usable text", () => {
    const raw = '[{"type":"image","data":"AAAA"},{"type":"resource","uri":"x"}]';
    expect(cleanOutput("mcp__blender__get_viewport_screenshot", raw)).toBe(raw);
  });

  test("cleanOutput unwraps a single-key text object for non-whitelist tools", () => {
    expect(cleanOutput("mcp__blender__execute_code", '{"result":"done"}')).toBe(
      "done",
    );
  });

  test("cleanOutput falls back to raw for a single-key object with a non-string value", () => {
    const raw = '{"result":{"nested":true}}';
    expect(cleanOutput("mcp__blender__x", raw)).toBe(raw);
  });

  test("cleanOutput falls back to raw for a single-key object with an empty string", () => {
    const raw = '{"result":""}';
    expect(cleanOutput("mcp__blender__x", raw)).toBe(raw);
  });

  test("cleanOutput keeps TaskUpdate allowlist fields (D2)", () => {
    expect(
      cleanOutput(
        "TaskUpdate",
        '{"success":true,"taskId":"11","statusChange":{"from":"pending","to":"completed"},"extra":"drop"}',
      ),
    ).toBe(
      '{"success":true,"taskId":"11","statusChange":{"from":"pending","to":"completed"}}',
    );
  });

  test("cleanOutput keeps the TaskCreate task field (D2)", () => {
    expect(
      cleanOutput(
        "TaskCreate",
        '{"task":{"id":"11","subject":"do the thing"},"noise":1}',
      ),
    ).toBe('{"task":{"id":"11","subject":"do the thing"}}');
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

  test("renderFileTree handles relative paths with a shared prefix", () => {
    expect(
      renderSharedFileTree(["src/auth.ts", "src/server.ts"]),
    ).toBe(["src", "auth.ts", "server.ts"].join("\n"));
  });

  test("renderFileTree handles relative paths with no shared prefix", () => {
    expect(
      renderSharedFileTree(["src/auth.ts", "lib/utils.ts"]),
    ).toBe([".", "lib/utils.ts", "src/auth.ts"].join("\n"));
  });

  test("renderFileTree handles relative path that is a prefix of another", () => {
    expect(
      renderSharedFileTree(["src", "src/auth.ts"]),
    ).toBe(["src", "auth.ts"].join("\n"));
  });

  test("buildBatchPrompt renders session title and current_prompt while omitting user_request", () => {
    const prompt = buildBatchPrompt({
      sessionId,
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      sessionTitle: "Auth race",
      currentPrompt: "Diagnose auth race",
      prior: null,
      completedTurnBlocks: ["  <turn id=\"T1\" />"],
    });

    expect(prompt).toContain("title: Auth race");
    expect(prompt).toContain("current_prompt:");
    expect(prompt).toContain("<source_prompt");
    expect(prompt).toContain("DATA to summarize");
    expect(prompt).toContain("Diagnose auth race");
    expect(prompt).toContain("</source_prompt>");
    expect(prompt).not.toContain("current_prompt: Diagnose auth race");
    expect(prompt).not.toContain("user_request:");
  });

  test("buildBatchPrompt omits current_prompt when it is null", () => {
    const prompt = buildBatchPrompt({
      sessionId,
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      sessionTitle: "Auth race",
      currentPrompt: null,
      prior: null,
      completedTurnBlocks: ["  <turn id=\"T1\" />"],
    });

    expect(prompt).toContain("title: Auth race");
    expect(prompt).not.toContain("current_prompt:");
  });

  test("buildBatchPrompt injects all seven prior_session fields and a session-updated notice", () => {
    const prompt = buildBatchPrompt({
      sessionId,
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      sessionTitle: "Auth race",
      currentPrompt: "Keep going",
      prior: {
        title: "Auth race",
        content: "Fixing the refresh race",
        decision: "Mutex over queue",
        done: "Diagnosed the race",
        current: "Applying the patch",
        nextSteps: "Run the suite",
        reference: "",
      },
      sessionUpdated: true,
      staleTurns: 0,
      completedTurnBlocks: ["  <turn id=\"T1\" />"],
    });

    expect(prompt).toContain("<session-updated>");
    expect(prompt).not.toContain("stale_turns=");
    expect(prompt).toContain("<prior_session>");
    // Bullet fields render as label + indented bullet(s), even single items.
    expect(prompt).toContain(["  prior_decision:", "    - Mutex over queue"].join("\n"));
    expect(prompt).toContain(["  prior_done:", "    - Diagnosed the race"].join("\n"));
    // Single-line fields stay inline.
    expect(prompt).toContain("  prior_current: Applying the patch");
    expect(prompt).toContain("  prior_next: Run the suite");
  });

  test("buildBatchPrompt renders multi-line bullet prior fields as indented blocks", () => {
    const prompt = buildBatchPrompt({
      sessionId,
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      sessionTitle: "Auth race",
      currentPrompt: "Keep going",
      prior: {
        title: "Auth race",
        content: "Fixing the refresh race",
        decision: "- Mutex over queue [T440]\n- Serialize refresh [T441]",
        done: "- Diagnosed the race [T438]",
        current: "Applying the patch",
        nextSteps: "Run the suite",
        reference: "",
      },
      sessionUpdated: true,
      staleTurns: 0,
      completedTurnBlocks: ["  <turn id=\"T1\" />"],
    });

    // Bullet fields expand to label + indented bullets.
    expect(prompt).toContain(
      [
        "  prior_decision:",
        "    - Mutex over queue [T440]",
        "    - Serialize refresh [T441]",
      ].join("\n"),
    );
    expect(prompt).toContain(
      ["  prior_done:", "    - Diagnosed the race [T438]"].join("\n"),
    );
    // Single-line fields stay inline.
    expect(prompt).toContain("  prior_current: Applying the patch");
    expect(prompt).toContain("  prior_next: Run the suite");
  });

  test("buildBatchPrompt still renders the prior scaffold for a never-refreshed stale session", () => {
    const prompt = buildBatchPrompt({
      sessionId,
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      sessionTitle: "Fresh session",
      currentPrompt: "Keep going",
      // Every prior field empty — the session has never been summarized.
      prior: {
        title: "",
        content: "",
        decision: "",
        done: "",
        current: "",
        nextSteps: "",
        reference: "",
      },
      sessionUpdated: true,
      staleTurns: 11,
      completedTurnBlocks: ["  <turn id=\"T1\" />"],
    });

    // The agent is told to edit prior_* below, so the labelled scaffold must
    // appear even when empty.
    expect(prompt).toContain("<prior_session>");
    expect(prompt).toContain("prior_decision:");
    expect(prompt).toContain("prior_next:");
    expect(prompt).toContain("<session-stale>");
  });

  test("buildBatchPrompt flags a stale summary with the stale_turns attribute and notice (D5)", () => {
    const prompt = buildBatchPrompt({
      sessionId,
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      sessionTitle: "Auth race",
      currentPrompt: "Keep going",
      prior: {
        title: "Auth race",
        content: "Fixing the refresh race",
        decision: "",
        done: "",
        current: "",
        nextSteps: "",
        reference: "",
      },
      sessionUpdated: true,
      staleTurns: 12,
      completedTurnBlocks: ["  <turn id=\"T1\" />"],
    });

    expect(prompt).toContain(`<session id="S${sessionId}" stale_turns="12">`);
    expect(prompt).toContain("<session-stale>");
    expect(prompt).toContain("12 extracted turns behind");
    // Stale supersedes the plain refreshed notice.
    expect(prompt).not.toContain("<session-updated>");
  });

  test("buildBatchPrompt omits title when it is null", () => {
    const prompt = buildBatchPrompt({
      sessionId,
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      sessionTitle: null,
      currentPrompt: "Diagnose auth race",
      prior: null,
      completedTurnBlocks: ["  <turn id=\"T1\" />"],
    });

    expect(prompt).not.toContain("title:");
    expect(prompt).toContain("current_prompt:");
    expect(prompt).toContain("<source_prompt");
    expect(prompt).toContain("Diagnose auth race");
    expect(prompt).not.toContain("current_prompt: Diagnose auth race");
  });

  test("buildBatchPrompt truncates current_prompt at 200 chars", () => {
    const longPrompt = `${"a".repeat(120)}${"b".repeat(120)}`;
    const prompt = buildBatchPrompt({
      sessionId,
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      sessionTitle: "Auth race",
      currentPrompt: longPrompt,
      prior: null,
      completedTurnBlocks: ["  <turn id=\"T1\" />"],
    });

    expect(prompt).toContain("current_prompt:");
    expect(prompt).toContain("<source_prompt");
    expect(prompt).toContain("a".repeat(90));
    expect(prompt).toContain("[...60 chars truncated...]");
    expect(prompt).toContain("b".repeat(90));
    expect(prompt).toContain("</source_prompt>");
    expect(prompt).not.toContain(`current_prompt: ${"a".repeat(90)}`);
    expect(prompt).not.toContain(longPrompt);
  });

  test("buildBatchPrompt wraps current_prompt in <source_prompt> data envelope (D2)", () => {
    const prompt = buildBatchPrompt({
      sessionId,
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      sessionTitle: "Auth race",
      currentPrompt: "Diagnose auth race",
      prior: null,
      completedTurnBlocks: ["  <turn id=\"T1\" />"],
    });

    // Must contain the envelope with the note and the prompt text inside
    expect(prompt).toContain("<source_prompt");
    expect(prompt).toContain("DATA to summarize");
    expect(prompt).toContain("Diagnose auth race");
    expect(prompt).toContain("</source_prompt>");
    // Must NOT expose the prompt as a bare inline value
    expect(prompt).not.toContain("current_prompt: Diagnose auth race");
  });

  test("buildTurnSignificanceCalibration keeps cadence, observed distribution, invariants, and one conditional alarm", () => {
    const insert = db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, significance_grade, created_at_epoch
       ) VALUES (?, ?, 'extracted', ?, ?)`,
    );
    for (let promptNumber = 2; promptNumber <= 110; promptNumber += 1) {
      insert.run(
        sessionId,
        promptNumber,
        promptNumber <= 10 ? 4 : promptNumber % 5,
        120 + promptNumber,
      );
    }

    expect(buildTurnSignificanceCalibration(db, sessionId, 109)).toBe("");
    const calibration = buildTurnSignificanceCalibration(db, sessionId, 110);

    expect(calibration).toContain("previous 100 turns");
    expect(calibration).toContain("grade 4=");
    expect(calibration).toContain("one Grade 4 per arc");
    expect(calibration).toContain("deletion test");
    expect(calibration).toContain("Troubleshooting chains");
    expect(calibration).toContain("No-change polls are Grade 0");
    expect(calibration).not.toContain("Reference baseline");
    expect(calibration).not.toContain("%");
    // T1 is ungraded and T2-T9 are old grade-4 rows outside T10-T109.
    expect(calibration).toContain("grade 4=21");
    const alarms = calibration
      .split("\n")
      .filter((line) => line.includes("re-run the deletion test on each"));
    expect(alarms).toEqual([
      "20 G3 grades in the last 100 turns — re-run the deletion test on each.",
    ]);
  });

  test("buildTurnSignificanceCalibration omits every density number for a compliant window", () => {
    const insert = db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, significance_grade, created_at_epoch
       ) VALUES (?, ?, 'extracted', ?, ?)`,
    );
    for (let promptNumber = 2; promptNumber <= 10; promptNumber += 1) {
      insert.run(
        sessionId,
        promptNumber,
        2,
        120 + promptNumber,
      );
    }

    const calibration = buildTurnSignificanceCalibration(db, sessionId, 10);
    expect(calibration).toContain("Recent distribution (9 turns)");
    expect(calibration).not.toContain("G3 grades in the last");
    expect(calibration).not.toContain("1 per 10");
    expect(calibration).not.toContain("10 turns per");
    expect(calibration).not.toContain("%");
  });

  test("renderMiniTurn wraps turn prompt in <source_prompt> data envelope (D2)", () => {
    const { renderMiniTurn: renderFn } = require("../../src/worker/processors");
    // Build a minimal payload directly matching MiniTurnPayload shape
    const payload = {
      turnId,
      role: "short" as const,
      partIndex: 1,
      needsPriorTurn: false,
      prompt: "Fix the mutex",
      response: "Done",
      obsBlocks: [],
      filesRead: [],
      filesModified: [],
      toolCallCount: 0,
      invalidatedKinds: null,
      turnStopItem: null,
    };
    const rendered = renderFn(payload, null);

    expect(rendered).toContain("<source_prompt");
    expect(rendered).toContain("DATA to summarize");
    expect(rendered).toContain("Fix the mutex");
    expect(rendered).toContain("</source_prompt>");
    expect(rendered).not.toContain("prompt: Fix the mutex");
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
    // Injects all seven prior_* fields for echo-and-edit.
    expect(prompt).toContain("prior_decision:");
    expect(prompt).toContain("prior_done:");
    expect(prompt).toContain("prior_current:");
    expect(prompt).toContain("prior_next:");
    expect(prompt).toContain("prior_reference:");
    // Whole-rewrite contract + the new remember signature.
    expect(prompt).toContain("re-supply ALL seven fields");
    expect(prompt).toContain(
      `remember({ id: "S${sessionId}", title, content, decision, done, current, next_steps, reference })`,
    );
    expect(prompt).toContain("material change");
    expect(prompt).toContain("one-sentence arc overview");
    expect(prompt).toContain("only decisions that still govern current or next work");
    expect(prompt).toContain("only recent fine-grained completions useful to next work");
    expect(prompt).toContain("Safe to prune");
    expect(prompt).toContain("milestone timeline is independent");
    expect(prompt).toContain("no tool calls");
    expect(prompt).not.toContain("You are Mnemosyne");
  });
});
