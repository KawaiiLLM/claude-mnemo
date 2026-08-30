import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  createChildProcessNoteSettlementEdgesQuery,
  createChildProcessNoteSettlementQuery,
  createSettlementChildStdoutScanner,
  decodeSettlementChildEdgesRequest,
  decodeSettlementChildRequest,
  encodeSettlementChildRequest,
  formatSettlementChildEnvelope,
  parseSettlementChildEnvelope,
  resolveSettlementChildCommand,
  resolveSettlementChildScriptPath,
  SETTLEMENT_CHILD_ENVELOPE_PREFIX,
  SETTLEMENT_CHILD_SCRIPT_NAME,
} from "../../src/worker/note-settlement-child";
import { runSettlementChild } from "../../src/worker/note-settlement-child-entry";
import {
  createUnifiedNoteSettlementDispatch,
  type NoteSettlementQueryRequest,
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
 * without a network.
 *
 * PEER ROUND 2 CHANGED WHAT "SCRIPTED" MAY MEAN. Every regression here used
 * to inject a whole `command` — `bun <script>` — so 64 green assertions
 * proved only that A child process is killable, never that THE shipped one
 * is; meanwhile production ran `node bun-runner.js <bundle>` and every signal
 * landed on the wrapper. The seam is now the SCRIPT PATH alone: the real
 * `resolveSettlementChildCommand` still builds the command, so these tests
 * run the same `process.execPath <script>` topology the worker ships, spawned
 * detached into its own process group, killed as a group, holding the same
 * stdin liveness pipe.
 *
 * The one property this file cannot prove — that the WORKER's own death takes
 * the tree with it — needs a worker process of its own and lives in
 * `note-settlement-abort-survival.test.ts`.
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

/**
 * Writes a scripted child and returns the ONLY seam that remains: its path.
 * The command shape around it — `process.execPath`, detached, own group — is
 * the production resolver's, unmocked.
 */
function scriptedChild(name: string, source: string): string {
  const path = join(workspace, `${name}.ts`);
  writeFileSync(path, source, "utf8");
  return path;
}

/**
 * The child's half of the liveness contract: the payload is ONE
 * newline-terminated line and stdin is NOT closed after it, so a child that
 * waited for `end` (as every fixture here used to) would now wait forever.
 */
const READ_PAYLOAD = `
let raw = "";
process.stdin.setEncoding("utf8");
const payload = await new Promise((resolveLine) => {
  process.stdin.on("data", (chunk) => {
    raw += chunk;
    const newline = raw.indexOf("\\n");
    if (newline >= 0) resolveLine(JSON.parse(raw.slice(0, newline)));
  });
});
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

const UNIFIED_REQUEST: NoteSettlementUnifiedQueryRequest = {
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
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
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
      ...UNIFIED_REQUEST,
      maxThinkingTokens: 4096,
      jobId: 7,
      claimGeneration: 3,
      sessionId: 11,
      writableTurnIds: new Set([4, 5, 6]),
      scopeProvenance: {
        window: new Set([4, 5]),
        baseLookback: new Set([6]),
        closureOnly: new Set(),
      },
    };

    const wire = JSON.parse(
      JSON.stringify(encodeSettlementChildRequest(request, "unified")),
    ) as ReturnType<typeof encodeSettlementChildRequest>;
    const decoded = decodeSettlementChildRequest(wire);

    expect(wire.mode).toBe("unified");
    expect([...decoded.writableTurnIds]).toEqual([4, 5, 6]);
    expect([...decoded.scopeProvenance.window]).toEqual([4, 5]);
    expect([...decoded.scopeProvenance.baseLookback]).toEqual([6]);
    expect([...decoded.scopeProvenance.closureOnly]).toEqual([]);
    expect(decoded.maxThinkingTokens).toBe(4096);
    // The signal deliberately does not cross: on the child's side the kill
    // signal IS the abort.
    expect("signal" in decoded).toBe(false);
  });

  /**
   * GATE 6's wire half. The cold-resume request's `scopeProvenance` is
   * OPTIONAL, and its absence is load-bearing — the stage-2 query reads it as
   * "this caller gets the old flat refusal list". A decode that invented a
   * bucket would file every finding under `window`, which is a claim about
   * where errors anchor that nothing checked.
   */
  test("the edges request crosses in its own mode, and an absent provenance stays absent", () => {
    const edgesRequest: NoteSettlementQueryRequest = {
      prompt: "p",
      systemPrompt: "s",
      model: "m",
      jobId: 9,
      claimGeneration: 4,
      stage: "edges",
      sessionId: 3,
      writableTurnIds: new Set([1, 2]),
      contextBuiltAtEpoch: NOW,
      windowStart: 1,
      windowEnd: 2,
    };

    const wire = JSON.parse(
      JSON.stringify(encodeSettlementChildRequest(edgesRequest, "edges")),
    ) as ReturnType<typeof encodeSettlementChildRequest>;

    expect(wire.mode).toBe("edges");
    expect(wire.scopeProvenance).toBeNull();

    const decoded = decodeSettlementChildEdgesRequest(wire);
    expect(decoded.stage).toBe("edges");
    expect([...decoded.writableTurnIds]).toEqual([1, 2]);
    expect("scopeProvenance" in decoded).toBe(false);

    const withProvenance = decodeSettlementChildEdgesRequest(
      encodeSettlementChildRequest(
        { ...edgesRequest, scopeProvenance: UNIFIED_REQUEST.scopeProvenance },
        "edges",
      ),
    );
    expect([...withProvenance.scopeProvenance!.window]).toEqual([1]);
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

  /**
   * GATE 5's validation half. The old check accepted anything carrying an
   * `ok` key, so a half-written line rode through as a SUCCESS whose result
   * fields were simply `undefined` — and the dispatch then reported a settled
   * window from a run that never produced one.
   */
  test("a marked line that is not a well-formed envelope is not an answer", () => {
    const cases = [
      '{"ok":true}',
      '{"ok":true,"result":{}}',
      '{"ok":true,"result":{"text":"t","commitMetrics":null}}', // no `finalized`
      '{"ok":true,"result":{"text":42,"finalized":true,"commitMetrics":null}}',
      '{"ok":true,"result":{"text":"t","finalized":true,"commitMetrics":{"report":1}}}',
      '{"ok":true,"result":{"text":"t","finalized":true,"commitMetrics":{"report":"r","proseWritten":"two"}}}',
      '{"ok":false}',
      '{"ok":"yes"}',
      "not json at all",
    ];
    for (const body of cases) {
      expect(
        parseSettlementChildEnvelope(
          `${SETTLEMENT_CHILD_ENVELOPE_PREFIX}${body}\n`,
        ),
      ).toBeNull();
    }

    // The edges result has no `finalized` — and must still validate.
    expect(
      parseSettlementChildEnvelope(
        `${SETTLEMENT_CHILD_ENVELOPE_PREFIX}{"ok":true,"result":{"text":"t","commitMetrics":null}}\n`,
        "edges",
      ),
    ).not.toBeNull();
  });

  /**
   * GATE 5's memory half. `stdout += chunk` made the worker's footprint a
   * function of how talkative a run's SDK session happened to be.
   */
  test("the stdout scanner keeps the last marked line and discards chatter unbounded", () => {
    const scanner = createSettlementChildStdoutScanner(1024);
    for (let index = 0; index < 500; index += 1) {
      scanner.push(`${"x".repeat(4096)}\n`);
    }
    scanner.push(`${SETTLEMENT_CHILD_ENVELOPE_PREFIX}{"ok":false,"message":"a"}\n`);
    scanner.push(`${SETTLEMENT_CHILD_ENVELOPE_PREFIX}{"ok":false,"message":"b"}\n`);
    scanner.finish();

    expect(scanner.overflowed).toBe(false);
    expect(parseSettlementChildEnvelope(scanner.envelopeLine!)).toEqual({
      ok: false,
      message: "b",
    });
  });

  /**
   * BOTH ARRIVAL SHAPES, because the first cut of this scanner only checked
   * the PARTIAL tail — so whether an oversized envelope was caught depended
   * on whether the kernel happened to split the write. A 200 KB line landing
   * in one chunk sailed through, and the child that produced it (one that by
   * construction refuses to leave) then held the run's promise open forever.
   */
  test("a MARKED line past the cap is a protocol overflow — split across chunks OR whole in one", () => {
    const split = createSettlementChildStdoutScanner(512);
    split.push(`${SETTLEMENT_CHILD_ENVELOPE_PREFIX}${"y".repeat(2000)}`);
    expect(split.overflowed).toBe(true);

    const whole = createSettlementChildStdoutScanner(512);
    whole.push(`${SETTLEMENT_CHILD_ENVELOPE_PREFIX}${"y".repeat(2000)}\n`);
    whole.finish();
    expect(whole.overflowed).toBe(true);
    expect(whole.envelopeLine).toBeNull();
  });

  /**
   * GATE 1. The shipped topology, asserted on the resolver itself: this
   * process's own runtime running the child bundle. `node bun-runner.js
   * <bundle>` put a wrapper PID between the parent and the run, and every
   * signal below landed on the wrapper.
   */
  test("the shipped child runs under this process's own runtime — no wrapper PID in between", () => {
    const { command, args } = resolveSettlementChildCommand({
      CLAUDE_PLUGIN_ROOT: "/opt/plugin",
    });
    expect(command).toBe(process.execPath);
    expect(args).toEqual([`/opt/plugin/scripts/${SETTLEMENT_CHILD_SCRIPT_NAME}`]);
  });

  test("the env override names a SCRIPT, never a command shape", () => {
    expect(
      resolveSettlementChildScriptPath({
        CLAUDE_MNEMO_SETTLEMENT_CHILD: "/tmp/scripted-child.ts",
      }),
    ).toBe("/tmp/scripted-child.ts");
    expect(
      resolveSettlementChildCommand({
        CLAUDE_MNEMO_SETTLEMENT_CHILD: "/tmp/scripted-child.ts",
      }),
    ).toEqual({ command: process.execPath, args: ["/tmp/scripted-child.ts"] });
  });
});

describe("the child entry, in process", () => {
  test("a query that returns becomes an ok envelope; a query that throws becomes its message", async () => {
    const payload = {
      databasePath,
      dataRoot: workspace,
      deadlineMs: 60_000,
      request: encodeSettlementChildRequest(UNIFIED_REQUEST, "unified"),
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

  test("the entry routes an `edges` payload to the cold-resume shape", async () => {
    const seen: string[] = [];
    const envelope = await runSettlementChild(
      {
        databasePath,
        dataRoot: workspace,
        deadlineMs: 60_000,
        request: encodeSettlementChildRequest(
          { ...UNIFIED_REQUEST, stage: "edges" },
          "edges",
        ),
      },
      {
        createQuery: (_db, payload) => {
          seen.push(payload.request.mode);
          return async () => ({ text: "resumed", commitMetrics: null });
        },
      },
    );
    expect(seen).toEqual(["edges"]);
    expect(envelope).toEqual({
      ok: true,
      result: { text: "resumed", commitMetrics: null },
    });
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
        scriptPath: scriptedChild("happy", happyChildSource()),
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
        scriptPath: scriptedChild(
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

  /**
   * P2: the tail is PERSISTED, so it goes through the shared secret
   * sanitizer first. A dying SDK session's stderr is the most likely place in
   * this whole system for an API key to surface — an env echo, a request
   * header, a transport error that quotes its own config.
   */
  test("the logged stderr tail is sanitized — a secret-shaped env value never reaches the worker log", async () => {
    const logs: string[] = [];
    const runQuery = createChildProcessNoteSettlementQuery({
      databasePath,
      dataRoot: workspace,
      logger: {
        warn: (...parts: unknown[]) => logs.push(parts.map(String).join(" ")),
        error: (...parts: unknown[]) => logs.push(parts.map(String).join(" ")),
      },
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-shouldnotappear" },
      scriptPath: scriptedChild(
        "leaky",
        `${READ_PAYLOAD}
process.stderr.write("transport error: x-api-key=" + process.env.ANTHROPIC_API_KEY + "\\n");
process.exit(4);
`,
      ),
    });

    await expect(runQuery(UNIFIED_REQUEST)).rejects.toThrow(
      "without a result envelope",
    );

    const line = logs.find((entry) =>
      entry.includes("exited without a clean result"),
    );
    expect(line).toBeDefined();
    expect(line).not.toContain("sk-ant-shouldnotappear");
    expect(line).toContain("[REDACTED]");
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
        scriptPath: scriptedChild(
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
    await waitFor(() => exits.length > 0, 10_000);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.signal).toBe("SIGKILL");

    expect(released).toBe(1);
  }, 30_000);

  /**
   * GATE 2. The kill must reach the whole TREE, not the PID the parent holds.
   * In production that tree is child + `claude` CLI; here it is a child and a
   * grandchild that BOTH refuse `SIGTERM`, which is the only shape that can
   * distinguish "the group was signalled" from "the group leader happened to
   * die and took nobody with it".
   */
  test("GATE 2: the kill reaches the whole process group — a TERM-refusing grandchild dies with its parent", async () => {
    const pidFile = join(workspace, "tree.json");
    const grandchildPath = scriptedChild(
      "grandchild",
      `process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
    );
    const scriptPath = scriptedChild(
      "tree-parent",
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
// Default stdio/detachment: the grandchild joins THIS process's group, which
// is exactly what the shipped SDK's own \`claude\` CLI child does.
const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildPath)}], {
  stdio: "ignore",
});
writeFileSync(
  ${JSON.stringify(pidFile)},
  JSON.stringify({ child: process.pid, grandchild: grandchild.pid }),
);
${READ_PAYLOAD}
`,
    );

    const runQuery = createChildProcessNoteSettlementQuery({
      databasePath,
      dataRoot: workspace,
      logger: { warn: () => {}, error: () => {} },
      killGraceMs: 300,
      scriptPath,
    });

    const controller = new AbortController();
    const pending = runQuery({ ...UNIFIED_REQUEST, signal: controller.signal });
    pending.catch(() => {});

    expect(await waitFor(() => existsSync(pidFile), 15_000)).toBe(true);
    const pids = JSON.parse(readFileSync(pidFile, "utf8")) as {
      child: number;
      grandchild: number;
    };
    expect(alive(pids.child)).toBe(true);
    expect(alive(pids.grandchild)).toBe(true);

    controller.abort(new Error("loss verdict"));
    await expect(pending).rejects.toThrow("without a result envelope");

    expect(
      await waitFor(
        () => !alive(pids.child) && !alive(pids.grandchild),
        10_000,
      ),
    ).toBe(true);
  }, 45_000);

  /**
   * GATE 4. Success is a CONJUNCTION now. Both halves of the old bug are
   * here: an envelope followed by a nonzero exit, and an envelope followed by
   * a fatal signal. Either used to resolve as a clean, committed run.
   */
  test("GATE 4: an envelope followed by a crash does NOT resolve as success", async () => {
    const runQuery = createChildProcessNoteSettlementQuery({
      databasePath,
      dataRoot: workspace,
      logger: { warn: () => {}, error: () => {} },
      scriptPath: scriptedChild(
        "envelope-then-crash",
        `${READ_PAYLOAD}
process.stdout.write(
  "[claude-mnemo] settlement-child-result " +
    JSON.stringify({ ok: true, result: { text: "t", finalized: true, commitMetrics: null, laneCheckCalled: true } }) +
    "\\n",
);
process.exit(1);
`,
      ),
    });

    await expect(runQuery(UNIFIED_REQUEST)).rejects.toThrow(
      "after its result envelope",
    );
  }, 30_000);

  test("GATE 4: an envelope followed by a fatal signal does NOT resolve as success", async () => {
    const logs: string[] = [];
    const runQuery = createChildProcessNoteSettlementQuery({
      databasePath,
      dataRoot: workspace,
      logger: {
        warn: (...parts: unknown[]) => logs.push(parts.map(String).join(" ")),
        error: (...parts: unknown[]) => logs.push(parts.map(String).join(" ")),
      },
      scriptPath: scriptedChild(
        "envelope-then-signal",
        `${READ_PAYLOAD}
process.stdout.write(
  "[claude-mnemo] settlement-child-result " +
    JSON.stringify({ ok: true, result: { text: "t", finalized: true, commitMetrics: null, laneCheckCalled: true } }) +
    "\\n",
);
setTimeout(() => { process.kill(process.pid, "SIGABRT"); }, 100);
setInterval(() => {}, 1000);
`,
      ),
    });

    await expect(runQuery(UNIFIED_REQUEST)).rejects.toThrow(
      "after its result envelope",
    );
    expect(
      logs.find((line) => line.includes("exited without a clean result")),
    ).toContain('"envelope":"discarded"');
  }, 30_000);

  /**
   * GATE 5. `writeStdout(env); exit(0)` truncated an 8 MiB envelope to
   * 64 KiB under pipe backpressure — the parent then saw an unparseable line
   * and reported "no envelope" for a run that had in fact answered. The child
   * side of this test uses the REAL `writeStdoutAndDrain`.
   */
  test("GATE 5: an 8 MiB envelope crosses whole", async () => {
    const runQuery = createChildProcessNoteSettlementQuery({
      databasePath,
      dataRoot: workspace,
      logger: { warn: () => {}, error: () => {} },
      scriptPath: scriptedChild(
        "huge-envelope",
        `import { writeStdoutAndDrain } from ${JSON.stringify(join(REPO_ROOT, "src/worker/note-settlement-child-entry.ts"))};
import { formatSettlementChildEnvelope } from ${JSON.stringify(join(REPO_ROOT, "src/worker/note-settlement-child.ts"))};
${READ_PAYLOAD}
await writeStdoutAndDrain(
  formatSettlementChildEnvelope({
    ok: true,
    result: { text: "z".repeat(8 * 1024 * 1024), finalized: true, commitMetrics: null, laneCheckCalled: true },
  }),
);
process.exit(0);
`,
      ),
    });

    const result = await runQuery(UNIFIED_REQUEST);
    expect(result.text.length).toBe(8 * 1024 * 1024);
  }, 60_000);

  test("GATE 5: a marked line past the parent's cap kills the child and fails the run", async () => {
    const logs: string[] = [];
    const runQuery = createChildProcessNoteSettlementQuery({
      databasePath,
      dataRoot: workspace,
      logger: {
        warn: (...parts: unknown[]) => logs.push(parts.map(String).join(" ")),
        error: (...parts: unknown[]) => logs.push(parts.map(String).join(" ")),
      },
      killGraceMs: 300,
      maxEnvelopeChars: 4096,
      scriptPath: scriptedChild(
        "oversize-envelope",
        `${READ_PAYLOAD}
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
process.stdout.write(
  "[claude-mnemo] settlement-child-result " + "q".repeat(200000) + "\\n",
);
`,
      ),
    });

    await expect(runQuery(UNIFIED_REQUEST)).rejects.toThrow(
      "result envelope exceeded",
    );
    expect(
      logs.find((line) => line.includes("exited without a clean result")),
    ).toContain('"envelope":"oversized"');
  }, 30_000);

  /**
   * GATE 6, end to end: the cold-resume seam really does cross the same pipe,
   * with `mode: "edges"` on the wire and an edges-shaped result coming back.
   */
  test("GATE 6: the cold-resume query runs in a child of its own", async () => {
    const runQuery = createChildProcessNoteSettlementEdgesQuery({
      databasePath,
      dataRoot: workspace,
      logger: { warn: () => {}, error: () => {} },
      scriptPath: scriptedChild(
        "edges-child",
        `${READ_PAYLOAD}
if (payload.request.mode !== "edges") {
  process.stderr.write("wrong mode: " + payload.request.mode + "\\n");
  process.exit(9);
}
process.stdout.write(
  "[claude-mnemo] settlement-child-result " +
    JSON.stringify({ ok: true, result: { text: "resumed the edge pass", commitMetrics: null } }) +
    "\\n",
);
process.exit(0);
`,
      ),
    });

    const result = await runQuery({
      prompt: "p",
      systemPrompt: "s",
      model: "m",
      jobId: 5,
      claimGeneration: 2,
      stage: "edges",
      sessionId: 1,
      writableTurnIds: new Set([1]),
      contextBuiltAtEpoch: NOW,
      windowStart: 1,
      windowEnd: 2,
    });

    expect(result.text).toBe("resumed the edge pass");
    expect(result.commitMetrics).toBeNull();
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
        scriptPath: scriptedChild(
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
        scriptPath: scriptedChild("sibling-happy", happyChildSource(900)),
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

    await expect(runQuery(UNIFIED_REQUEST)).rejects.toThrow(
      "in-memory database",
    );
  });
});
