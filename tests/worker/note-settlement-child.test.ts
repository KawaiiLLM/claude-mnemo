import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { upsertShadowNote } from "../../src/db/shadow-notes";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  createChildProcessNoteSettlementQuery,
  decodeSettlementChildRequest,
  encodeSettlementChildRequest,
  formatSettlementChildEnvelope,
  parseSettlementChildEnvelope,
  resolveSettlementChildCommand,
  SETTLEMENT_CHILD_SCRIPT_NAME,
} from "../../src/worker/note-settlement-child";
import { runSettlementChild } from "../../src/worker/note-settlement-child-entry";
import {
  createUnifiedNoteSettlementDispatch,
  type NoteSettlementWindowMetrics,
} from "../../src/worker/note-settlement-dispatch";
import type { NoteSettlementUnifiedQueryRequest } from "../../src/worker/note-settlement-sdk-query";
import {
  SETTLEMENT_ENABLED_CONFIG,
  SETTLEMENT_ERA_CUTOFF_EPOCH,
} from "../support/settlement-config";

/**
 * THE CHILD BOUNDARY (claim-monitor-repair ticket 02), from the parent's
 * side. What crosses it is a JSON request in and one marked JSON envelope
 * out; what does NOT cross it is the model client, its transport, the
 * settlement MCP server, the Stop hook, and — the point of the whole ticket —
 * whatever any of them leaks when a run is killed.
 *
 * The children here are SCRIPTED: real processes running real code over the
 * real pipe, with the model replaced by a script that answers. That is the
 * only way to exercise `SIGTERM`/`SIGKILL`, exit codes and stderr tails
 * without a network. The one property this file cannot prove — that the
 * WORKER survives a child's death — needs a worker process of its own and
 * lives in `note-settlement-abort-survival.test.ts`.
 */

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const NOW = 1_800_000_000;

let workspace: string;
let databasePath: string;
let db: Database;

function seedWindow(contentSessionId: string): NoteSettlementJob {
  const sessionId = upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-settlement-child",
    title: "settlement child fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;

  for (const promptNumber of [1, 2]) {
    const turnId = db
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           tool_call_count, created_at_epoch
         ) VALUES (?, ?, 'active', ?, ?, 3, ?)
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        `prompt ${promptNumber}`,
        `response ${promptNumber}`,
        NOW - 1_000 + promptNumber,
      )!.id;
    upsertShadowNote(db, {
      turnId,
      title: `design+child: turn ${promptNumber}`,
      content: `Content ${promptNumber}`,
      nowEpoch: NOW - 900,
    });
    db.query<unknown, [number, number, number, number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status, reason,
         opened_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, 'noted', NULL, ?, ?)`,
    ).run(turnId, sessionId, promptNumber, NOW - 950, NOW - 950);
  }
  db.query<unknown, [number, number]>(
    `INSERT INTO note_debt_cursor (session_id, last_classified_prompt_number, updated_at_epoch)
     VALUES (?, 2, ?)`,
  ).run(sessionId, NOW);
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId, windowStart: 1, windowEnd: 2, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionId, NOW, NOW * 1000);
  if (!job) {
    throw new Error(`fixture failed to claim a job for ${contentSessionId}`);
  }
  return job;
}

/** Writes a scripted child and returns the `command` seam that runs it. */
function scriptedChild(
  name: string,
  source: string,
): { command: string; args: string[] } {
  const path = join(workspace, `${name}.ts`);
  writeFileSync(path, source, "utf8");
  return { command: "bun", args: ["run", path] };
}

const READ_PAYLOAD = `
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) { raw += chunk; }
const payload = JSON.parse(raw);
`;

const COMMIT_METRICS = {
  turnsReviewed: 2,
  reviewsYieldedToLateNote: 0,
  proseWritten: 2,
  relationsWritten: 1,
  relationsRestated: 0,
  relationsRetracted: 0,
  sessionNarrativeWritten: 1,
  lanesDeclared: 1,
  lanesDeleted: 0,
  lanesMerged: 0,
  lanesJustified: 0,
  report: "the scripted child's friction report",
  eraGranted: 2,
};

/** A child that settles its window for real — its own DB handle on the same file. */
function happyChildSource(delayMs = 0): string {
  return `import { createDatabase } from ${JSON.stringify(join(REPO_ROOT, "src/db/database.ts"))};
import { completeNoteSettlementJob } from ${JSON.stringify(join(REPO_ROOT, "src/db/note-settlement.ts"))};
${READ_PAYLOAD}
await new Promise((r) => setTimeout(r, ${delayMs}));
const db = createDatabase(payload.databasePath, { busyTimeoutMs: 5000 });
completeNoteSettlementJob(db, payload.request.jobId, ${NOW}, payload.request.claimGeneration);
db.close(false);
process.stdout.write(
  "[claude-mnemo] settlement-child-result " +
    JSON.stringify({
      ok: true,
      result: {
        text: "the scripted child settled its window.",
        finalized: true,
        commitMetrics: ${JSON.stringify(COMMIT_METRICS)},
        laneCheckCalled: true,
      },
    }) + "\\n",
);
process.exit(0);
`;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "mnemo-settlement-child-"));
  databasePath = join(workspace, "mnemo.db");
  db = createDatabase(databasePath);
  initializeSchema(db);
});

afterEach(() => {
  db.close(false);
  rmSync(workspace, { recursive: true, force: true });
});

describe("the wire", () => {
  test("a request survives the round trip — sets become arrays and come back sets", () => {
    const request: NoteSettlementUnifiedQueryRequest = {
      prompt: "p",
      systemPrompt: "s",
      model: "m",
      maxThinkingTokens: 4096,
      jobId: 7,
      claimGeneration: 3,
      stage: "topics",
      sessionId: 11,
      writableTurnIds: new Set([4, 5, 6]),
      scopeProvenance: {
        window: new Set([4, 5]),
        baseLookback: new Set([6]),
        closureOnly: new Set(),
      },
      contextBuiltAtEpoch: NOW,
      windowStart: 1,
      windowEnd: 2,
    };

    const decoded = decodeSettlementChildRequest(
      JSON.parse(
        JSON.stringify(encodeSettlementChildRequest(request)),
      ) as ReturnType<typeof encodeSettlementChildRequest>,
    );

    expect([...decoded.writableTurnIds]).toEqual([4, 5, 6]);
    expect([...decoded.scopeProvenance.window]).toEqual([4, 5]);
    expect([...decoded.scopeProvenance.baseLookback]).toEqual([6]);
    expect([...decoded.scopeProvenance.closureOnly]).toEqual([]);
    expect(decoded.maxThinkingTokens).toBe(4096);
    // The signal deliberately does not cross: on the child's side the kill
    // signal IS the abort.
    expect("signal" in decoded).toBe(false);
  });

  test("the envelope is found on the LAST marked line, past anything else the child printed", () => {
    const stdout = [
      "some SDK chatter",
      formatSettlementChildEnvelope({ ok: false, message: "stale" }).trim(),
      "more chatter",
      formatSettlementChildEnvelope({
        ok: true,
        result: {
          text: "done",
          finalized: true,
          commitMetrics: null,
          laneCheckCalled: true,
        },
      }).trim(),
      "trailing narration",
    ].join("\n");

    const envelope = parseSettlementChildEnvelope(stdout);
    expect(envelope?.ok).toBe(true);
    expect(parseSettlementChildEnvelope("nothing marked here")).toBeNull();
  });

  test("the shipped child is reachable by name from the plugin root", () => {
    const { command, args } = resolveSettlementChildCommand({
      CLAUDE_PLUGIN_ROOT: "/opt/plugin",
    });
    expect(command).toBe("node");
    expect(args).toEqual([
      "/opt/plugin/scripts/bun-runner.js",
      `/opt/plugin/scripts/${SETTLEMENT_CHILD_SCRIPT_NAME}`,
    ]);
  });
});

describe("the child entry, in process", () => {
  test("a query that returns becomes an ok envelope; a query that throws becomes its message", async () => {
    const payload = {
      databasePath,
      dataRoot: workspace,
      request: encodeSettlementChildRequest({
        prompt: "p",
        systemPrompt: "s",
        model: "m",
        jobId: 1,
        claimGeneration: 1,
        stage: "topics" as const,
        sessionId: 1,
        writableTurnIds: new Set([1]),
        scopeProvenance: {
          window: new Set([1]),
          baseLookback: new Set(),
          closureOnly: new Set(),
        },
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 2,
      }),
    };

    const ok = await runSettlementChild(payload, {
      createQuery: () => async (request) => {
        // The decoded request really is what the parent sent.
        expect([...request.writableTurnIds]).toEqual([1]);
        return {
          text: "settled",
          finalized: true,
          commitMetrics: null,
          laneCheckCalled: true,
        };
      },
    });
    expect(ok).toEqual({
      ok: true,
      result: {
        text: "settled",
        finalized: true,
        commitMetrics: null,
        laneCheckCalled: true,
      },
    });

    const failed = await runSettlementChild(payload, {
      createQuery: () => async () => {
        throw new Error("the run gave up");
      },
    });
    expect(failed).toEqual({ ok: false, message: "the run gave up" });
  });
});

describe("one run, one child", () => {
  test("HAPPY PATH: a scripted child completes a run — envelope, commit metrics and the completion log line all intact", async () => {
    const job = seedWindow("child-happy");
    const metrics: NoteSettlementWindowMetrics[] = [];
    const logs: string[] = [];

    const dispatch = createUnifiedNoteSettlementDispatch({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      logger: {
        warn: (line: unknown) => logs.push(String(line)),
        error: (line: unknown) => logs.push(String(line)),
        info: (line: unknown) => logs.push(String(line)),
      },
      metrics: (line) => metrics.push(line),
      runQuery: createChildProcessNoteSettlementQuery({
        databasePath,
        dataRoot: workspace,
        command: scriptedChild("happy", happyChildSource()),
      }),
      claimMonitorIntervalMs: 5_000,
    });

    const outcome = await dispatch({ job });

    expect(outcome.ok).toBe(true);
    // The child's OWN handle on the same file moved the row — proof the
    // second writer works, not just that the envelope was believed.
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.committed).toBe(true);
    expect(metrics[0]!.commit?.report).toBe(
      "the scripted child's friction report",
    );
    expect(metrics[0]!.commit?.eraGranted).toBe(2);
    expect(metrics[0]!.laneCheckCalled).toBe(true);
    // Nothing was reported as a non-clean exit.
    expect(logs.filter((line) => line.includes("note-settlement child"))).toEqual(
      [],
    );
  }, 30_000);

  test("a child that dies without an envelope fails the job and puts its exit code and stderr TAIL in the worker log", async () => {
    const job = seedWindow("child-dies");
    const logs: string[] = [];

    const dispatch = createUnifiedNoteSettlementDispatch({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      logger: {
        warn: (...parts: unknown[]) => logs.push(parts.map(String).join(" ")),
        error: (...parts: unknown[]) => logs.push(parts.map(String).join(" ")),
      },
      runQuery: createChildProcessNoteSettlementQuery({
        databasePath,
        dataRoot: workspace,
        logger: {
          warn: (...parts: unknown[]) => logs.push(parts.map(String).join(" ")),
          error: (...parts: unknown[]) => logs.push(parts.map(String).join(" ")),
        },
        command: scriptedChild(
          "dies",
          `${READ_PAYLOAD}
process.stderr.write("a very long prelude\\n".repeat(400));
process.stderr.write("the last thing it ever said\\n");
process.exit(3);
`,
        ),
      }),
      claimMonitorIntervalMs: 5_000,
    });

    const outcome = await dispatch({ job });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.reason).toContain(
      "note settlement call failed",
    );
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");

    const line = logs.find((entry) =>
      entry.includes("exited without a clean result"),
    );
    expect(line).toBeDefined();
    expect(line).toContain('"exitCode":3');
    expect(line).toContain('"envelope":"missing"');
    // The TAIL is what is kept when the budget bites — the throw is at the end.
    expect(line).toContain("the last thing it ever said");
  }, 30_000);

  test("REGRESSION 2: a child that ignores SIGTERM is SIGKILLed inside the bounded wait, the dispatch settles, and the busy token is released exactly once", async () => {
    const job = seedWindow("child-ignores-sigterm");
    let released = 0;
    const exits: Array<{ code: number | null; signal: string | null }> = [];

    const dispatch = createUnifiedNoteSettlementDispatch({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      logger: { warn: () => {}, error: () => {} },
      acquireBusyToken: () => ({
        release: () => {
          released += 1;
        },
      }),
      runQuery: createChildProcessNoteSettlementQuery({
        databasePath,
        dataRoot: workspace,
        logger: { warn: () => {}, error: () => {} },
        killGraceMs: 300,
        command: scriptedChild(
          "stubborn",
          // The wedge this ticket's kill exists for: SIGTERM is caught and
          // refused, and the process holds the event loop open forever. The
          // handler is installed BEFORE the request is read — a child still
          // reading stdin has no handler yet and would die of the default
          // SIGTERM disposition, which would prove nothing about the fallback.
          `process.on("SIGTERM", () => { process.stderr.write("refusing SIGTERM\\n"); });
setInterval(() => {}, 1000);
${READ_PAYLOAD}
`,
        ),
        spawnImpl: ((
          command: string,
          args: string[],
          spawnOptions: Parameters<typeof spawn>[2],
        ) => {
          const child = spawn(command, args, spawnOptions);
          child.on("close", (code, signal) => {
            exits.push({ code, signal });
          });
          return child;
        }) as unknown as typeof spawn,
      }),
      // Long enough for the child to boot and install its refusal, short
      // enough that the loss verdict still lands while it is wedged.
      claimMonitorIntervalMs: 400,
    });

    const outcomePromise = dispatch({ job });
    // A GENUINE loss — the generation moves under the run.
    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
    ).run(job.id);

    // THE DRAIN-SAFETY PROPERTY: the dispatch settles on its own, without
    // anything having to give up on it.
    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.reason).toContain("lost ownership");

    // And the child really was killed — inside the bounded wait, by SIGKILL,
    // because it refused SIGTERM.
    const deadline = Date.now() + 10_000;
    while (exits.length === 0 && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    expect(exits).toHaveLength(1);
    expect(exits[0]!.signal).toBe("SIGKILL");

    expect(released).toBe(1);
  }, 30_000);

  test("SIBLING ISOLATION: a killed run's child dies alone — the other run's child reaches its own terminal commit", async () => {
    const target = seedWindow("child-target");
    const sibling = seedWindow("child-sibling");

    const targetDispatch = createUnifiedNoteSettlementDispatch({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      logger: { warn: () => {}, error: () => {} },
      runQuery: createChildProcessNoteSettlementQuery({
        databasePath,
        dataRoot: workspace,
        logger: { warn: () => {}, error: () => {} },
        killGraceMs: 300,
        command: scriptedChild(
          "target-stubborn",
          `process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
${READ_PAYLOAD}
`,
        ),
      }),
      claimMonitorIntervalMs: 400,
    });

    const siblingDispatch = createUnifiedNoteSettlementDispatch({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      logger: { warn: () => {}, error: () => {} },
      runQuery: createChildProcessNoteSettlementQuery({
        databasePath,
        dataRoot: workspace,
        command: scriptedChild("sibling-happy", happyChildSource(900)),
      }),
      claimMonitorIntervalMs: 5_000,
    });

    const targetOutcome = targetDispatch({ job: target });
    const siblingOutcome = siblingDispatch({ job: sibling });

    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
    ).run(target.id);

    const x = await targetOutcome;
    expect(x.ok).toBe(false);

    const y = await siblingOutcome;
    expect(y.ok).toBe(true);
    expect(getNoteSettlementJob(db, sibling.id)!.status).toBe("done");
  }, 40_000);

  test("an in-memory database is refused at call time, not silently settled against an empty file", async () => {
    const runQuery = createChildProcessNoteSettlementQuery({
      databasePath: ":memory:",
      dataRoot: workspace,
      logger: { warn: () => {}, error: () => {} },
    });

    await expect(
      runQuery({
        prompt: "p",
        systemPrompt: "s",
        model: "m",
        jobId: 1,
        claimGeneration: 1,
        stage: "topics",
        sessionId: 1,
        writableTurnIds: new Set([1]),
        scopeProvenance: {
          window: new Set([1]),
          baseLookback: new Set(),
          closureOnly: new Set(),
        },
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 2,
      } satisfies NoteSettlementUnifiedQueryRequest),
    ).rejects.toThrow("in-memory database");
  });
});
