import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
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
  buildSettlementChildTaskkillCommand,
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
  runBoundedTaskkill,
  signalChildTree,
  SETTLEMENT_CHILD_ENVELOPE_PREFIX,
  SETTLEMENT_CHILD_SCRIPT_NAME,
  type SettlementChildPayload,
  type SettlementTaskkillResult,
} from "../../src/worker/note-settlement-child";
import {
  installParentDeathWatch,
  killOwnProcessGroup,
  runSettlementChild,
} from "../../src/worker/note-settlement-child-entry";
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
      // ROUND 3, ITEM 3: a report with NO counters used to pass — the exact
      // half-serialized record the check exists to stop. Every counter plus
      // `eraGranted` is required now.
      '{"ok":true,"result":{"text":"t","finalized":true,"commitMetrics":{"report":"x"}}}',
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

    // And the FULL record — every counter, `eraGranted`, `report` — passes.
    // Types only: the validator has no opinion about the arithmetic.
    expect(
      parseSettlementChildEnvelope(
        `${SETTLEMENT_CHILD_ENVELOPE_PREFIX}${JSON.stringify({
          ok: true,
          result: {
            text: "t",
            finalized: true,
            commitMetrics: COMMIT_METRICS,
            laneCheckCalled: true,
          },
        })}\n`,
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

  /**
   * ROUND 3, ITEM 2: the test seam rides INSIDE the one resolver — an
   * injected script still launches under this process's own runtime, because
   * the command half is not a parameter at all any more.
   */
  test("the scriptPath override varies the SCRIPT inside the one resolver — the command stays this runtime", () => {
    expect(
      resolveSettlementChildCommand(
        { CLAUDE_PLUGIN_ROOT: "/opt/plugin" },
        "/tmp/injected-script.ts",
      ),
    ).toEqual({ command: process.execPath, args: ["/tmp/injected-script.ts"] });
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

    // P2c: the failure says termination was REQUESTED — a clean self-exit
    // can win that race, so "the child was killed" would assert a winner the
    // parent never observed.
    await expect(runQuery(UNIFIED_REQUEST)).rejects.toThrow(
      "termination was requested",
    );
    const line = logs.find((entry) =>
      entry.includes("exited without a clean result"),
    );
    expect(line).toContain('"envelope":"oversized"');
    expect(line).toContain('"terminationRequested":true');
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

/**
 * ROUND 3 P1 (user-ruled, S15069/T2193): Windows tree termination via
 * `taskkill`. What is testable on this machine is the command CONSTRUCTION
 * and the completion WIRING — the spawn args of both stages and the promise
 * chain that folds them into the run. The runtime behaviour of `taskkill`
 * itself is UNVERIFIED-ON-WIN32: no assertion here claims a Windows tree
 * actually died, and a green run of this file must never be read as that.
 *
 * The seam (`windowsTaskkillImpl` + `killPlatform`) exists ONLY for the
 * win32 route; the POSIX group kill stays unmockable, because a
 * whole-command seam on the production path is how the round-1 topology
 * hole opened.
 */
describe("the win32 kill route (construction + wiring; runtime UNVERIFIED on win32)", () => {
  test("taskkill command construction: /PID <pid> /T for the term stage, /F appended for the forced stage", () => {
    expect(buildSettlementChildTaskkillCommand(123, "term")).toEqual({
      command: "taskkill",
      args: ["/PID", "123", "/T"],
    });
    expect(buildSettlementChildTaskkillCommand(123, "kill")).toEqual({
      command: "taskkill",
      args: ["/PID", "123", "/T", "/F"],
    });
  });

  test("both stages run taskkill on the child's own pid; the run stays pending until the runner settles, and the runner always settles (own timeout)", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const warnings: string[] = [];
    let spawned: ChildProcess | null = null;

    // The FORCED stage runs the REAL bounded runner over a spawn that never
    // emits anything — the runner's OWN timeout is what settles it (round 4
    // P1). The round-3 property is preserved and sharpened: the run is
    // pending until the runner settles, and the runner always settles.
    const neverEmittingSpawn = (() => {
      const fake = {
        stderr: undefined,
        on: () => fake,
        kill: () => true,
      };
      return (() => fake) as unknown as typeof spawn;
    })();

    const runQuery = createChildProcessNoteSettlementQuery({
      databasePath,
      dataRoot: workspace,
      logger: {
        warn: (...parts: unknown[]) => warnings.push(parts.map(String).join(" ")),
        error: () => {},
      },
      killGraceMs: 150,
      reapGraceMs: 100,
      killPlatform: "win32",
      windowsTaskkillImpl: (command, args) => {
        calls.push({ command, args });
        if (calls.length === 1) {
          // The TERM stage completes at once, successfully.
          return Promise.resolve({ ok: true, exitCode: 0 });
        }
        // The FORCED stage wedges: only the runner's own bound can end it.
        return runBoundedTaskkill(command, args, {
          spawnImpl: neverEmittingSpawn,
          timeoutMs: 600,
        });
      },
      spawnImpl: ((
        command: string,
        args: string[],
        spawnOptions: Parameters<typeof spawn>[2],
      ) => {
        spawned = spawn(command, args, spawnOptions);
        return spawned;
      }) as unknown as typeof spawn,
      scriptPath: scriptedChild(
        "win32-route",
        // Ignores SIGTERM and idles: under the mocked taskkill NOTHING can
        // kill it, so only the completion wiring can settle the run.
        `process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
${READ_PAYLOAD}
`,
      ),
    });

    const controller = new AbortController();
    const pending = runQuery({ ...UNIFIED_REQUEST, signal: controller.signal });
    let state: "pending" | "settled" = "pending";
    pending.then(
      () => {
        state = "settled";
      },
      () => {
        state = "settled";
      },
    );

    try {
      controller.abort(new Error("loss verdict"));

      expect(await waitFor(() => calls.length >= 2, 10_000)).toBe(true);
      const pid = spawned!.pid!;
      expect(calls[0]).toEqual({
        command: "taskkill",
        args: ["/PID", String(pid), "/T"],
      });
      expect(calls[1]).toEqual({
        command: "taskkill",
        args: ["/PID", String(pid), "/T", "/F"],
      });

      // COMPLETION WIRING: the reap grace (100ms) has long passed, but the
      // forced-stage runner (600ms bound) has not settled — so the run must
      // NOT have been declared abandoned, and nothing else can settle it
      // (the child is alive and answering nothing).
      await new Promise((r) => setTimeout(r, 400));
      expect(state).toBe("pending");

      // No manual release: the runner's OWN timeout fires at 600ms, the
      // containment failure is logged with its cause, the reap clock starts
      // in the `finally`, and the run fails within the fixed bound. Which
      // rejection wins is a race this rig cannot pin: the best-effort
      // `child.kill()` after the failed taskkill lands on a REAL (POSIX)
      // child here, so `close` may beat the reap clock — both are the same
      // bounded failure.
      await expect(pending).rejects.toThrow(
        /did not report an exit before the reap deadline|without a result envelope/,
      );
      expect(
        warnings.some(
          (line) =>
            line.includes("containment failure") && line.includes('"timeout"'),
        ),
      ).toBe(true);
    } finally {
      // The mocked taskkill killed nothing: sweep the real (POSIX-detached)
      // child so it cannot outlive the test.
      const pid = spawned === null ? undefined : (spawned as ChildProcess).pid;
      if (typeof pid === "number" && pid > 0) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Group already gone.
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process already gone.
        }
      }
    }
  }, 30_000);

  test("the child's own win32 route: taskkill on its OWN pid, /F for the kill form, and the exit backstop waits for it", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exits: number[] = [];
    let release!: (result: SettlementTaskkillResult) => void;
    const gate = new Promise<SettlementTaskkillResult>((r) => {
      release = r;
    });

    killOwnProcessGroup("SIGKILL", {
      platform: "win32",
      taskkillImpl: (command, args) => {
        calls.push({ command, args });
        return gate;
      },
      exit: (code) => {
        exits.push(code);
      },
    });

    expect(calls).toEqual([
      {
        command: "taskkill",
        args: ["/PID", String(process.pid), "/T", "/F"],
      },
    ]);
    // The exit is the BACKSTOP: it must not fire while the tree walk is
    // still in flight (a `process.exit` mid-walk is the stranded-descendants
    // bug in a new coat).
    expect(exits).toEqual([]);
    release({ ok: true, exitCode: 0 });
    await gate;
    await new Promise((r) => setTimeout(r, 0));
    expect(exits).toEqual([1]);

    // The TERM form of the same route carries no /F.
    killOwnProcessGroup("SIGTERM", {
      platform: "win32",
      taskkillImpl: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve({ ok: true, exitCode: 0 });
      },
      exit: () => {},
    });
    expect(calls[1]).toEqual({
      command: "taskkill",
      args: ["/PID", String(process.pid), "/T"],
    });
  });

  test("the child's own taskkill FAILURE still reaches exit(1), with a containment-failure line on stderr", async () => {
    const exits: number[] = [];
    const stderrLines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      killOwnProcessGroup("SIGKILL", {
        platform: "win32",
        taskkillImpl: async () => ({
          ok: false,
          kind: "exit",
          exitCode: 1,
          stderrTail: "access denied",
        }),
        exit: (code) => {
          exits.push(code);
        },
      });
      expect(await waitFor(() => exits.length > 0, 5_000)).toBe(true);
    } finally {
      process.stderr.write = realWrite;
    }

    expect(exits).toEqual([1]);
    expect(
      stderrLines.some(
        (line) =>
          line.includes("taskkill did not prove the tree cleared") &&
          line.includes("containment failure") &&
          line.includes("exit 1"),
      ),
    ).toBe(true);
  });

  /**
   * ROUND 4 P1 — the SHARED bounded runner itself, under test at the spawn
   * level. Three failure shapes, all settling with a cause-distinguishing
   * RESULT within a fixed bound; only exit 0 is a successful tree walk.
   */
  describe("runBoundedTaskkill (the one runner both sides share)", () => {
    test("a clean exit 0 is the only success", async () => {
      const result = await runBoundedTaskkill(process.execPath, [
        "-e",
        "process.exit(0)",
      ]);
      expect(result).toEqual({ ok: true, exitCode: 0 });
    });

    test("a nonzero exit carries its code and a SANITIZED stderr tail", async () => {
      const stub = scriptedChild(
        "taskkill-exit-1",
        `process.stderr.write("ERROR: token hunter2secretvalue was refused\\n");
process.exit(1);
`,
      );
      const result = await runBoundedTaskkill(process.execPath, [stub], {
        env: { FAKE_API_KEY: "hunter2secretvalue" },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("exit");
        expect(result.exitCode).toBe(1);
        expect(result.stderrTail).toContain("[REDACTED]");
        expect(result.stderrTail).not.toContain("hunter2secretvalue");
      }
    });

    test("a spawn failure settles as kind spawn, bounded", async () => {
      const result = await runBoundedTaskkill(
        join(workspace, "no-such-taskkill-binary"),
        ["/PID", "1", "/T"],
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("spawn");
      }
    });

    test("a taskkill that never completes is killed by the runner's OWN timeout and settles as kind timeout", async () => {
      const killed: string[] = [];
      const fake = {
        stderr: undefined,
        on: () => fake,
        kill: (signal: string) => {
          killed.push(signal);
          return true;
        },
      };
      const started = Date.now();
      const result = await runBoundedTaskkill("taskkill", ["/PID", "1", "/T"], {
        spawnImpl: (() => fake) as unknown as typeof spawn,
        timeoutMs: 200,
      });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result).toEqual({ ok: false, kind: "timeout" });
      // Killing the wedged taskkill PROCESS (no descendants worth walking).
      expect(killed).toEqual(["SIGKILL"]);
    });
  });

  /**
   * The parent's consumption of the runner's verdict, at the
   * `signalChildTree` level: an unproven tree walk of ANY kind is a
   * containment-failure log plus a best-effort single kill — never a
   * silently "completed" termination request.
   */
  describe("signalChildTree consumes the taskkill result (win32 discipline)", () => {
    function harness(result: SettlementTaskkillResult) {
      const warnings: string[] = [];
      const kills: NodeJS.Signals[] = [];
      const run = signalChildTree(
        {
          pid: 4242,
          kill: (signal: NodeJS.Signals) => {
            kills.push(signal);
            return true;
          },
        },
        "SIGKILL",
        {
          logger: {
            warn: (...parts: unknown[]) =>
              warnings.push(parts.map(String).join(" ")),
            error: () => {},
          },
          platform: "win32",
          taskkillImpl: async () => result,
        },
      );
      return { run, warnings, kills };
    }

    test("exit 0 is a cleared request: no log, no fallback kill", async () => {
      const { run, warnings, kills } = harness({ ok: true, exitCode: 0 });
      await run;
      expect(warnings).toEqual([]);
      expect(kills).toEqual([]);
    });

    test("a nonzero exit logs the containment failure with kind/exitCode/stderrTail, then best-effort kills", async () => {
      const { run, warnings, kills } = harness({
        ok: false,
        kind: "exit",
        exitCode: 128,
        stderrTail: "the tree walk was refused",
      });
      await run;
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("did not prove the tree cleared");
      expect(warnings[0]).toContain('"kind":"exit"');
      expect(warnings[0]).toContain('"exitCode":128');
      expect(warnings[0]).toContain("the tree walk was refused");
      expect(kills).toEqual(["SIGKILL"]);
    });

    test("a failed spawn is the same containment failure, distinguished by kind", async () => {
      const { run, warnings, kills } = harness({ ok: false, kind: "spawn" });
      await run;
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('"kind":"spawn"');
      expect(kills).toEqual(["SIGKILL"]);
    });
  });

  /**
   * ROUND 4 P2 — the PID-reuse window. `exit` fires before `close` whenever
   * a descendant holds the inherited pipes; from that moment the numeric pid
   * may be the kernel's to reuse, so the DELAYED forced-stage taskkill must
   * not fire at it. The TERM stage that went out while the root lived is
   * fine; the second strike is the hazard.
   */
  test("ROUND 5 P1: a loss verdict that arrives AFTER the root exited sends NO taskkill at all — the stale pid is never struck once", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const warnings: string[] = [];
    let spawned: ChildProcess | null = null;

    const runQuery = createChildProcessNoteSettlementQuery({
      databasePath,
      dataRoot: workspace,
      logger: {
        warn: (...parts: unknown[]) =>
          warnings.push(parts.map(String).join(" ")),
        error: () => {},
      },
      killGraceMs: 150,
      reapGraceMs: 100,
      killPlatform: "win32",
      windowsTaskkillImpl: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve({ ok: true, exitCode: 0 });
      },
      spawnImpl: ((
        command: string,
        args: string[],
        spawnOptions: Parameters<typeof spawn>[2],
      ) => {
        spawned = spawn(command, args, spawnOptions);
        return spawned;
      }) as unknown as typeof spawn,
      scriptPath: scriptedChild(
        "pid-reuse-root-exit",
        // The root reads its payload, hands its stdout pipe to a grandchild
        // that idles forever, and EXITS: the parent sees `exit` while
        // `close` is withheld by the pipe the grandchild holds.
        `${READ_PAYLOAD}
import { spawn as grandSpawn } from "node:child_process";
grandSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: ["ignore", "inherit", "ignore"],
});
process.exit(0);
`,
      ),
    });

    const controller = new AbortController();
    const pending = runQuery({ ...UNIFIED_REQUEST, signal: controller.signal });

    try {
      // Wait until the ROOT is provably gone (its `exit` has a reason to
      // have fired) while the run is still pending on the withheld `close`.
      expect(
        await waitFor(
          () => spawned !== null && spawned.pid !== undefined && !alive(spawned.pid),
          10_000,
        ),
      ).toBe(true);

      controller.abort(new Error("loss verdict"));

      await expect(pending).rejects.toThrow(
        "did not report an exit before the reap deadline",
      );

      // ROUND 5 P1: the verdict found `rootExited` already true, so not even
      // the INITIAL `/T` went out at the numeric pid the kernel may have
      // reused. Round 4 guarded only the delayed forced strike; the peer's
      // point was that the guard's argument never mentioned a stage.
      expect(calls.length).toBe(0);
      expect(
        warnings.some(
          (line) =>
            line.includes("root already exited") &&
            line.includes("possible pid reuse") &&
            line.includes("the initial taskkill was not sent"),
        ),
      ).toBe(true);
    } finally {
      // The mocked taskkill killed nothing and the root is gone: sweep the
      // grandchild via the root's (POSIX) process group.
      const pid = spawned === null ? undefined : (spawned as ChildProcess).pid;
      if (typeof pid === "number" && pid > 0) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Group already gone.
        }
      }
    }
  }, 30_000);

  /**
   * The OTHER ordering, which is what round 4's guard actually covered: the
   * verdict lands while the root is demonstrably alive (TERM legitimately
   * goes out), the root dies during the kill grace, and the delayed forced
   * strike is the one that must refuse.
   */
  test("TERM sent while the root lived; the root dies in the grace; the forced strike refuses the now-stale pid", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const warnings: string[] = [];
    let spawned: ChildProcess | null = null;
    const readyFile = join(workspace, "root-alive-ready");

    const runQuery = createChildProcessNoteSettlementQuery({
      databasePath,
      dataRoot: workspace,
      logger: {
        warn: (...parts: unknown[]) =>
          warnings.push(parts.map(String).join(" ")),
        error: () => {},
      },
      killGraceMs: 2_500,
      reapGraceMs: 100,
      killPlatform: "win32",
      windowsTaskkillImpl: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve({ ok: true, exitCode: 0 });
      },
      spawnImpl: ((
        command: string,
        args: string[],
        spawnOptions: Parameters<typeof spawn>[2],
      ) => {
        spawned = spawn(command, args, spawnOptions);
        return spawned;
      }) as unknown as typeof spawn,
      scriptPath: scriptedChild(
        "pid-reuse-root-alive-then-dies",
        // The root signals readiness, hands its stdout pipe to an idling
        // grandchild, LIVES long enough for the TERM verdict to find it
        // alive, then exits inside the kill grace — `exit` fires while
        // `close` stays withheld by the grandchild's pipe.
        `${READ_PAYLOAD}
import { spawn as grandSpawn } from "node:child_process";
import { writeFileSync } from "node:fs";
grandSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: ["ignore", "inherit", "ignore"],
});
writeFileSync(${JSON.stringify(readyFile)}, "up");
setTimeout(() => process.exit(0), 1_500);
`,
      ),
    });

    const controller = new AbortController();
    const pending = runQuery({ ...UNIFIED_REQUEST, signal: controller.signal });

    try {
      expect(await waitFor(() => existsSync(readyFile), 10_000)).toBe(true);
      // The root is alive RIGHT NOW; the verdict must catch it alive so the
      // TERM stage legitimately fires.
      expect(spawned).not.toBeNull();
      expect(alive(spawned!.pid!)).toBe(true);

      controller.abort(new Error("loss verdict"));

      await expect(pending).rejects.toThrow(
        "did not report an exit before the reap deadline",
      );

      // Exactly ONE strike: the TERM that found the root alive. The forced
      // `/T /F` never chased the pid past the root's death.
      expect(calls.length).toBe(1);
      expect(calls[0]!.args).toEqual(["/PID", String(spawned!.pid), "/T"]);
      expect(
        warnings.some(
          (line) =>
            line.includes("root already exited") &&
            line.includes("the forced-stage taskkill was not sent"),
        ),
      ).toBe(true);
    } finally {
      const pid = spawned === null ? undefined : (spawned as ChildProcess).pid;
      if (typeof pid === "number" && pid > 0) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Group already gone.
        }
      }
    }
  }, 30_000);

  /**
   * ROUND 5 P2 — the re-entry gate. `killTimer` empties itself the moment
   * the forced stage begins, so a SECOND verdict (a deadline firing after an
   * abort, an overflow after a deadline) used to walk straight back into
   * `killChild()` and start a duplicate TERM/forced chain while the first
   * chain's forced runner was still in flight. `terminationStarted` is the
   * gate; this pins the count.
   */
  test("a second verdict during an in-flight forced runner does not start a duplicate TERM/forced chain", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    let releaseForced: (() => void) | null = null;
    let spawned: ChildProcess | null = null;
    const readyFile = join(workspace, "reentry-ready");

    const runQuery = createChildProcessNoteSettlementQuery({
      databasePath,
      dataRoot: workspace,
      logger: { warn: () => {}, error: () => {} },
      killGraceMs: 400,
      reapGraceMs: 100,
      // The deadline timer is the SECOND verdict: it fires killChild at
      // deadline + grace = 800ms from spawn, squarely inside the first
      // chain's forced-runner window (forced starts ~abort+400ms and its
      // promise is held open below until the test releases it).
      runtimeDeadlineMs: 400,
      killPlatform: "win32",
      windowsTaskkillImpl: (command, args) => {
        calls.push({ command, args });
        if (args.includes("/F")) {
          return new Promise((resolveHeld) => {
            releaseForced = () =>
              resolveHeld({ ok: true, exitCode: 0 } as const);
          });
        }
        return Promise.resolve({ ok: true, exitCode: 0 });
      },
      spawnImpl: ((
        command: string,
        args: string[],
        spawnOptions: Parameters<typeof spawn>[2],
      ) => {
        spawned = spawn(command, args, spawnOptions);
        return spawned;
      }) as unknown as typeof spawn,
      scriptPath: scriptedChild(
        "reentry-idle-root",
        // A root that just idles: alive through every stage so no rootExited
        // refusal muddies the count.
        `${READ_PAYLOAD}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(readyFile)}, "up");
setInterval(() => {}, 1000);
`,
      ),
    });

    const controller = new AbortController();
    const pending = runQuery({ ...UNIFIED_REQUEST, signal: controller.signal });

    try {
      expect(await waitFor(() => existsSync(readyFile), 10_000)).toBe(true);
      controller.abort(new Error("first verdict"));

      // Let the deadline verdict fire while the forced runner is held open.
      await new Promise((r) => setTimeout(r, 1_200));
      expect(releaseForced).not.toBeNull();
      releaseForced!();

      await expect(pending).rejects.toThrow(
        "did not report an exit before the reap deadline",
      );

      // One TERM, one forced — the second verdict re-entered nothing.
      expect(calls.length).toBe(2);
      expect(calls[0]!.args).toEqual(["/PID", String(spawned!.pid), "/T"]);
      expect(calls[1]!.args).toEqual([
        "/PID",
        String(spawned!.pid),
        "/T",
        "/F",
      ]);
    } finally {
      const pid = spawned === null ? undefined : (spawned as ChildProcess).pid;
      if (typeof pid === "number" && pid > 0) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Group already gone.
        }
      }
    }
  }, 30_000);
});

/**
 * ROUND 3 P2a: the POSIX failure split. Only the ESRCH half is provable with
 * real processes — EPERM needs a live group this test may not signal, which
 * no unprivileged suite can own — so EPERM's logging path is exercised by
 * inspection and typecheck only, and this comment says so rather than
 * pretending otherwise.
 */
describe("signalChildTree on POSIX", () => {
  test("ESRCH means the group is GONE — the bare pid is never signalled, because the kernel may have reused it", async () => {
    // A real detached child that has fully exited: its pid names no process
    // and no group, so the group kill fails with ESRCH exactly as it would
    // after a clean teardown in production.
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"], {
      detached: true,
      stdio: "ignore",
    });
    const deadPid = dead.pid!;
    await new Promise((r) => dead.on("close", r));
    expect(await waitFor(() => !alive(deadPid), 5_000)).toBe(true);

    const fallbackKills: NodeJS.Signals[] = [];
    const warnings: string[] = [];
    await signalChildTree(
      {
        pid: deadPid,
        kill: (signal) => {
          fallbackKills.push(signal);
          return true;
        },
      },
      "SIGTERM",
      {
        logger: {
          warn: (...parts: unknown[]) =>
            warnings.push(parts.map(String).join(" ")),
          error: () => {},
        },
        platform: process.platform,
        taskkillImpl: async () => ({ ok: true, exitCode: 0 }) as const,
      },
    );

    // Neither the reused-pid hazard nor a containment warning: the group is
    // simply gone, and gone is DONE.
    expect(fallbackKills).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

/**
 * ROUND 3, ITEM 4 — the stdin already-ended race, tested on an injected
 * stream seam (`livenessStream`). Stated honestly: the REAL race — an EOF
 * landing in the gap between the payload's resolve and the listener install
 * — cannot be forced on the real `process.stdin` from inside a test, so what
 * is proven here is the mechanical check on the stream's state, not a replay
 * of the race itself.
 */
describe("the parent-death watch against an already-ended stream", () => {
  function fakeLivenessStream(state: {
    readableEnded?: boolean;
    destroyed?: boolean;
  }) {
    const listeners: Record<"end" | "close", Array<() => void>> = {
      end: [],
      close: [],
    };
    return {
      readableEnded: state.readableEnded ?? false,
      destroyed: state.destroyed ?? false,
      listeners,
      on(event: "end" | "close", listener: () => void) {
        listeners[event].push(listener);
        return this;
      },
      removeListener(event: "end" | "close", listener: () => void) {
        listeners[event] = listeners[event].filter((l) => l !== listener);
        return this;
      },
    };
  }

  function watchPayload(): SettlementChildPayload {
    return {
      databasePath,
      dataRoot: workspace,
      deadlineMs: 60_000,
      request: encodeSettlementChildRequest(UNIFIED_REQUEST, "unified"),
    };
  }

  test("a stream that already ENDED before install still fires the death path — once, asynchronously", async () => {
    const fired: number[] = [];
    const stream = fakeLivenessStream({ readableEnded: true });
    const watch = installParentDeathWatch(watchPayload(), {
      onParentGone: () => fired.push(1),
      livenessStream: stream,
    });

    // Asynchronous like the event it stands in for: nothing fires inside
    // the install call itself.
    expect(fired).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(fired).toEqual([1]);

    // A late real event cannot double-fire it.
    for (const listener of [...stream.listeners.end]) {
      listener();
    }
    expect(fired).toEqual([1]);
    watch.clear();
  });

  test("a stream already DESTROYED fires it too; a healthy stream does not — its listeners stay armed for the real event", async () => {
    const fired: number[] = [];

    const destroyed = fakeLivenessStream({ destroyed: true });
    const watchDestroyed = installParentDeathWatch(watchPayload(), {
      onParentGone: () => fired.push(1),
      livenessStream: destroyed,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(fired).toEqual([1]);
    watchDestroyed.clear();

    const healthy = fakeLivenessStream({});
    const watchHealthy = installParentDeathWatch(watchPayload(), {
      onParentGone: () => fired.push(2),
      livenessStream: healthy,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(fired).toEqual([1]);
    // The ordinary event path is untouched: EOF later still kills.
    healthy.listeners.end[0]!();
    expect(fired).toEqual([1, 2]);
    watchHealthy.clear();
    // And clear() really disarms: no listeners left behind.
    expect(healthy.listeners.end).toEqual([]);
    expect(healthy.listeners.close).toEqual([]);
  });
});
