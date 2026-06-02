import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation, getObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  enqueueQueueItem,
  getPendingQueueCount,
  type PendingQueueItem,
} from "../../src/db/pending-queue";
import {
  buildObsBlock,
  createWorkerProcessors,
  renderMiniTurn,
  STREAMING_SLICE_OVERHEAD,
  FINAL_SLICE_OVERHEAD,
  TOOL_NAME_CAP,
} from "../../src/worker/processors";
import { MIN_MINI_TURN_CHARS } from "../../src/shared/config";

// Pin the budget tests to the actual configurable floor: the invariant must
// hold at the tightest config a user can set.
const MAX_MINI_TURN_CHARS = MIN_MINI_TURN_CHARS;

describe("mini-turn rendering primitives", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;
  let processors: ReturnType<typeof createWorkerProcessors>;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "mini-turn-session",
      project: "/proj",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    turnId = db
      .query<{ id: number }, []>(
        `
          INSERT INTO turns (session_id, prompt_number, status, user_prompt, assistant_response, created_at_epoch)
          VALUES (?, 7, 'active', 'Run /goal migration', 'Migrated everything', 10)
          RETURNING id
        `,
      )
      .get(sessionId)!.id;
    processors = createWorkerProcessors(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedObs(count: number, sizeHint = 600): PendingQueueItem[] {
    const items: PendingQueueItem[] = [];
    for (let index = 0; index < count; index += 1) {
      const observationId = createObservation(db, {
        turnId,
        toolName: "Bash",
        toolInput: JSON.stringify({ command: `echo ${index}` }),
        toolResult: JSON.stringify({ stdout: "x".repeat(sizeHint) }),
        status: "pending",
        createdAtEpoch: 100 + index,
      }).id;
      items.push(
        enqueueQueueItem(db, {
          kind: "obs",
          targetId: observationId,
          sessionDbId: sessionId,
          enqueuedAtEpoch: 100 + index,
        }),
      );
    }
    return items;
  }

  function seedTurnStop(): PendingQueueItem {
    return enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: turnId,
      sessionDbId: sessionId,
      enqueuedAtEpoch: 200,
    });
  }

  test("streaming slice renders slice= and no tail", () => {
    const obs = seedObs(2);
    const payload = processors.buildMiniTurn(turnId, obs, {
      role: "streaming",
      partIndex: 2,
      needsPriorTurn: true,
      turnStopItem: null,
    })!;

    const rendered = renderMiniTurn(payload, null);
    expect(rendered).toContain(`<turn id="T${turnId}" slice="2">`);
    expect(rendered).not.toContain('final="true"');
    expect(rendered).not.toContain("response:");
    expect(rendered).not.toContain("files_read:");
    expect(rendered).not.toContain("tool_call_count:");
    expect(rendered).toContain("<source_prompt");
    expect(rendered).toContain("DATA to summarize");
    expect(rendered).toContain("Run /goal migration");
    expect(rendered).toContain("</source_prompt>");
    expect(rendered).not.toContain("prompt: Run /goal migration");
  });

  test("final slice renders slice= final= and the full tail", () => {
    const obs = seedObs(1);
    const turnStop = seedTurnStop();
    const payload = processors.buildMiniTurn(turnId, obs, {
      role: "final",
      partIndex: 5,
      needsPriorTurn: true,
      turnStopItem: turnStop,
    })!;

    const rendered = renderMiniTurn(payload, null);
    expect(rendered).toContain(`<turn id="T${turnId}" slice="5" final="true">`);
    expect(rendered).toContain("response: Migrated everything");
    expect(rendered).toContain("files_read:");
    expect(rendered).toContain("tool_call_count:");
  });

  test("short turn renders no slice/final attrs but keeps the tail", () => {
    const obs = seedObs(1);
    const turnStop = seedTurnStop();
    const payload = processors.buildMiniTurn(turnId, obs, {
      role: "short",
      partIndex: 1,
      needsPriorTurn: false,
      turnStopItem: turnStop,
    })!;

    const rendered = renderMiniTurn(payload, null);
    expect(rendered).toContain(`<turn id="T${turnId}">`);
    expect(rendered).not.toContain("slice=");
    expect(rendered).not.toContain('final="true"');
    expect(rendered).toContain("response: Migrated everything");
    expect(rendered).toContain("tool_call_count:");
    expect(rendered).not.toContain("<prior_turn");
  });

  test("needsPriorTurn injects a <prior_turn> block; otherwise none", () => {
    const obs = seedObs(1);
    const payload = processors.buildMiniTurn(turnId, obs, {
      role: "streaming",
      partIndex: 3,
      needsPriorTurn: true,
      turnStopItem: null,
    })!;

    const withPrior = renderMiniTurn(payload, {
      title: "Prior title",
      content: "Prior content",
      insight: "- prior insight",
    });
    expect(withPrior).toContain(`<prior_turn id="T${turnId}">`);
    expect(withPrior).toContain("title: Prior title");
    expect(withPrior).toContain("content: Prior content");

    expect(renderMiniTurn(payload, null)).not.toContain("<prior_turn");
  });

  test("peelMiniTurnObs takes a budget-bounded prefix; chunk+rest partitions input", () => {
    const obs = seedObs(20, 600);
    const budget = MAX_MINI_TURN_CHARS - STREAMING_SLICE_OVERHEAD;
    const { chunk, rest } = processors.peelMiniTurnObs(obs, budget);

    expect(chunk.length).toBeGreaterThan(0);
    expect(rest.length).toBeGreaterThan(0);
    expect(chunk.length + rest.length).toBe(obs.length);
    // order preserved + no overlap
    expect([...chunk, ...rest].map((item) => item.seq)).toEqual(
      obs.map((item) => item.seq),
    );
  });

  test("peelMiniTurnObs always takes at least one obs", () => {
    const obs = seedObs(3, 600);
    const { chunk } = processors.peelMiniTurnObs(obs, 1);
    expect(chunk.length).toBe(1);
  });

  test("budget invariant: a peeled streaming slice renders <= maxMiniTurnChars", () => {
    const obs = seedObs(40, 700);
    const budget = MAX_MINI_TURN_CHARS - STREAMING_SLICE_OVERHEAD;
    const { chunk } = processors.peelMiniTurnObs(obs, budget);
    const payload = processors.buildMiniTurn(turnId, chunk, {
      role: "streaming",
      partIndex: 1,
      needsPriorTurn: true,
      turnStopItem: null,
    })!;
    const rendered = renderMiniTurn(payload, {
      title: "T".repeat(400),
      content: "C".repeat(2000),
      insight: "I".repeat(2000),
    });
    expect(rendered.length).toBeLessThanOrEqual(MAX_MINI_TURN_CHARS);
  });

  test("budget invariant: final slice caps a huge file tree and stays in budget", () => {
    // Many Read/Write tools => hundreds of aggregated files.
    for (let index = 0; index < 400; index += 1) {
      createObservation(db, {
        turnId,
        toolName: "Read",
        toolInput: JSON.stringify({
          file_path: `/proj/src/area${index % 7}/file${index}.ts`,
        }),
        toolResult: "ok",
        status: "skipped",
        createdAtEpoch: 1000 + index,
      });
    }
    const obs = seedObs(1, 600);
    const budget = MAX_MINI_TURN_CHARS - FINAL_SLICE_OVERHEAD;
    const { chunk } = processors.peelMiniTurnObs(obs, budget);
    const payload = processors.buildMiniTurn(turnId, chunk, {
      role: "final",
      partIndex: 9,
      needsPriorTurn: true,
      turnStopItem: seedTurnStop(),
    })!;
    const rendered = renderMiniTurn(payload, {
      title: "t",
      content: "c",
      insight: "i",
    });
    expect(rendered).toContain("more files)");
    expect(rendered.length).toBeLessThanOrEqual(MAX_MINI_TURN_CHARS);
  });

  test("buildObsBlock caps an over-long MCP tool name (D3)", () => {
    const longName = `mcp__${"x".repeat(80)}`;
    const block = buildObsBlock(123, longName, '{"a":1}', '{"stdout":"ok"}');
    const nameLine = block
      .split("\n")
      .find((line) => line.includes("🔧"))!
      .replace("  🔧 ", "");
    expect(nameLine.length).toBeLessThanOrEqual(TOOL_NAME_CAP);
    expect(nameLine.endsWith("…")).toBe(true);
  });

  test("worst-case obs blockSize fits the floored final budget (D3 invariant)", () => {
    // Adversarial single obs: over-long MCP name (capped), in/out filled past
    // their caps, and a 10-digit O id. blockSize must stay under the smallest
    // final-slice budget a user can configure, so peel always takes >= 1 obs.
    const block = buildObsBlock(
      9_999_999_999,
      `mcp__${"x".repeat(80)}`,
      JSON.stringify({ command: "z".repeat(2000) }),
      JSON.stringify([{ type: "text", text: "y".repeat(10_000) }]),
    );
    const blockSize = block.length + block.split("\n").length * 4;
    const flooredFinalBudget = MIN_MINI_TURN_CHARS - FINAL_SLICE_OVERHEAD;
    expect(blockSize).toBeLessThanOrEqual(flooredFinalBudget);
  });

  test("applyMiniTurnSideEffects skips this slice's obs and deletes its queue rows", () => {
    const obs = seedObs(2);
    const turnStop = seedTurnStop();
    const payload = processors.buildMiniTurn(turnId, obs, {
      role: "final",
      partIndex: 1,
      needsPriorTurn: false,
      turnStopItem: turnStop,
    })!;

    expect(getPendingQueueCount(db)).toBe(3); // 2 obs + 1 turn-stop
    processors.applyMiniTurnSideEffects(payload);

    for (const item of obs) {
      expect(getObservation(db, item.targetId)?.status).toBe("skipped");
    }
    expect(getPendingQueueCount(db)).toBe(0);
  });

  test("applyMiniTurnSideEffects leaves the turn-stop row when the slice has none", () => {
    const obs = seedObs(1);
    seedTurnStop();
    const payload = processors.buildMiniTurn(turnId, obs, {
      role: "streaming",
      partIndex: 1,
      needsPriorTurn: false,
      turnStopItem: null,
    })!;

    expect(getPendingQueueCount(db)).toBe(2); // 1 obs + 1 turn-stop
    processors.applyMiniTurnSideEffects(payload);
    // obs row gone, turn-stop row remains
    expect(getPendingQueueCount(db)).toBe(1);
  });
});
