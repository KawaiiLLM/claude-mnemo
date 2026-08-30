import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * CLAIM-MONITOR-REPAIR TICKET 02 — the containment, proven where it actually
 * has to hold: across real process boundaries.
 *
 * THE BUG THIS CONTAINS (all of it inside the vendored model client's own
 * bundle, `sdk.mjs`):
 *
 *   1. `Query.readMessages` dispatches every inbound `control_request` — the
 *      channel EVERY MCP tool call and EVERY hook callback arrives on — as a
 *      bare unawaited call, `this.handleControlRequest(message); continue;`.
 *      Nothing holds the returned promise (contrast the line beside it,
 *      `this.initialization.catch(() => {})`, which IS guarded).
 *   2. `Query.handleControlRequest` answers by writing a `control_response`
 *      to the child's stdin — and its own `catch` answers a failure the same
 *      way, a SECOND write.
 *   3. `ProcessTransport.write` THROWS the moment the query's abortController
 *      is aborted (`AbortError("Operation aborted")`) and again once the
 *      child is dead ("Cannot write to terminated process").
 *
 * So killing a live run makes step 2's `try` throw, its `catch` throw again,
 * and step 1's unheld promise reject with no observer — which ends the
 * process. Ticket 01 tried to answer that with a process-level
 * `unhandledRejection` listener in the WORKER; peer review killed it (no
 * query identity exists at that layer, so no allow-list and no time window
 * can prove both coverage and isolation) and the reviewer re-verified the
 * decisive case firsthand: the debris can arrive a macrotask AFTER the loss
 * verdict has already returned, when any window short enough to be safe has
 * closed.
 *
 * TICKET 02'S ANSWER IS ARCHITECTURAL: the run's whole client wrapper lives
 * in a CHILD PROCESS, so its debris can only kill the process that contains
 * that one run. This file is the proof, and it needs real processes twice
 * over — `bun test` intercepts unhandled rejections BELOW the process-listener
 * level (it fails the test immediately), so neither "the worker survived" nor
 * "the worker still crashes on an unrelated bug" is observable from inside a
 * test body.
 */

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const SEED_FIXTURE = `
import { createDatabase } from ${JSON.stringify(join(REPO_ROOT, "src/db/database.ts"))};
import { initializeSchema } from ${JSON.stringify(join(REPO_ROOT, "src/db/schema.ts"))};
import { upsertSession } from ${JSON.stringify(join(REPO_ROOT, "src/db/sessions.ts"))};
import { upsertShadowNote } from ${JSON.stringify(join(REPO_ROOT, "src/db/shadow-notes.ts"))};
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
} from ${JSON.stringify(join(REPO_ROOT, "src/db/note-settlement.ts"))};
import { createUnifiedNoteSettlementDispatch } from ${JSON.stringify(join(REPO_ROOT, "src/worker/note-settlement-dispatch.ts"))};
import { createChildProcessNoteSettlementQuery } from ${JSON.stringify(join(REPO_ROOT, "src/worker/note-settlement-child.ts"))};
import {
  SETTLEMENT_ENABLED_CONFIG,
  SETTLEMENT_ERA_CUTOFF_EPOCH,
} from ${JSON.stringify(join(REPO_ROOT, "tests/support/settlement-config.ts"))};

const NOW = 1_800_000_000;
const DB_PATH = process.argv[2];
const db = createDatabase(DB_PATH);
initializeSchema(db);

function seedWindow(contentSessionId) {
  const sessionId = upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-abort-survival",
    title: "abort survival fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
  for (const promptNumber of [1, 2]) {
    const turnId = db
      .query(
        \`INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           tool_call_count, created_at_epoch
         ) VALUES (?, ?, 'active', ?, ?, 3, ?)
         RETURNING id\`,
      )
      .get(sessionId, promptNumber, "prompt " + promptNumber, "response " + promptNumber, NOW - 1_000 + promptNumber).id;
    upsertShadowNote(db, {
      turnId,
      title: "design+survival: turn " + promptNumber,
      content: "Content " + promptNumber,
      nowEpoch: NOW - 900,
    });
    db.query(
      \`INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status, reason,
         opened_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, 'noted', NULL, ?, ?)\`,
    ).run(turnId, sessionId, promptNumber, NOW - 950, NOW - 950);
  }
  db.query(
    \`INSERT INTO note_debt_cursor (session_id, last_classified_prompt_number, updated_at_epoch)
     VALUES (?, ?, ?)\`,
  ).run(sessionId, 2, NOW);
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId, windowStart: 1, windowEnd: 2, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a job for " + contentSessionId);
  }
  return job;
}
`;

/**
 * THE PEER'S DELAYED-DEBRIS SHAPE (`/tmp/claim-monitor-delayed-debris.ts`),
 * moved to the far side of the boundary: the run's kill produces the same
 * unheld `AbortError` rejection it always did — including one a full
 * macrotask LATER, which is the case that broke every timed shield — only now
 * it is raised inside the child, where it kills nothing but that child.
 */
function debrisChildSource(): string {
  return `class AbortError extends Error {}
// Installed BEFORE the request is read: a child still reading stdin has no
// handler yet and would simply die of SIGTERM's default disposition, which
// would prove nothing about what its debris can reach.
process.on("SIGTERM", () => {
  // THE DELAYED shape, and only it: a control-request handler that finishes a
  // full macrotask AFTER the loss verdict was already delivered, when any
  // window short enough to be safe has closed. Steps 2 and 3 — the
  // transport's write throwing, its catch's write throwing again — leave step
  // 1's unheld promise rejecting with nobody watching, which ends this
  // process. That is the point: this process, and no other.
  setTimeout(() => {
    void (async () => { throw new AbortError("Operation aborted"); })();
  }, 20);
});
setInterval(() => {}, 1000);
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) { raw += chunk; }
`;
}

/** A child that settles its window for real, after a delay — the healthy sibling. */
function happyChildSource(delayMs: number): string {
  return `import { createDatabase } from ${JSON.stringify(join(REPO_ROOT, "src/db/database.ts"))};
import { completeNoteSettlementJob } from ${JSON.stringify(join(REPO_ROOT, "src/db/note-settlement.ts"))};
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) { raw += chunk; }
const payload = JSON.parse(raw);
await new Promise((r) => setTimeout(r, ${delayMs}));
const db = createDatabase(payload.databasePath, { busyTimeoutMs: 5000 });
completeNoteSettlementJob(db, payload.request.jobId, 1_800_000_000, payload.request.claimGeneration);
db.close(false);
process.stdout.write(
  "[claude-mnemo] settlement-child-result " +
    JSON.stringify({
      ok: true,
      result: { text: "sibling committed.", finalized: true, commitMetrics: null, laneCheckCalled: true },
    }) + "\\n",
);
process.exit(0);
`;
}

function survivalWorkerSource(debrisPath: string, siblingPath: string): string {
  return `${SEED_FIXTURE}
const target = seedWindow("survival-target");
const sibling = seedWindow("survival-sibling");

const logs = [];
const logger = {
  warn: (...parts) => logs.push(parts.map(String).join(" ")),
  error: (...parts) => logs.push(parts.map(String).join(" ")),
};

const targetDispatch = createUnifiedNoteSettlementDispatch({
  db,
  config: SETTLEMENT_ENABLED_CONFIG,
  now: () => NOW,
  logger,
  claimMonitorIntervalMs: 500,
  runQuery: createChildProcessNoteSettlementQuery({
    databasePath: DB_PATH,
    dataRoot: ${JSON.stringify(REPO_ROOT)},
    logger,
    killGraceMs: 400,
    command: { command: "bun", args: ["run", ${JSON.stringify(debrisPath)}] },
  }),
});

const siblingDispatch = createUnifiedNoteSettlementDispatch({
  db,
  config: SETTLEMENT_ENABLED_CONFIG,
  now: () => NOW,
  logger,
  claimMonitorIntervalMs: 10_000,
  runQuery: createChildProcessNoteSettlementQuery({
    databasePath: DB_PATH,
    dataRoot: ${JSON.stringify(REPO_ROOT)},
    logger,
    command: { command: "bun", args: ["run", ${JSON.stringify(siblingPath)}] },
  }),
});

const targetOutcome = targetDispatch({ job: target });
const siblingOutcome = siblingDispatch({ job: sibling });

// A GENUINE loss on the target: the generation moves under it, so the monitor
// delivers a real kill.
db.query("UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?").run(target.id);

const x = await targetOutcome;
const y = await siblingOutcome;

// Long enough for every delayed rejection inside the (now dead) child to have
// fired, and for its exit to have been reported here.
await new Promise((r) => setTimeout(r, 1200));

process.stdout.write(
  JSON.stringify({
    alive: true,
    xOk: x.ok,
    xReason: x.ok ? null : x.reason,
    yOk: y.ok,
    siblingStatus: getNoteSettlementJob(db, sibling.id).status,
    diagnosis: logs.filter((line) => line.includes("exited without a clean result")),
  }) + "\\n",
);
process.exit(0);
`;
}

/**
 * REGRESSION 3, and the reason no global handler may ever come back: an
 * unhandled `AbortError` that belongs to NOBODY reaches the runtime's own
 * default disposition, unchanged. Same constructor, same message, raised
 * while a settlement dispatch is live — the exact shape the deleted shield
 * DID swallow, and the exact shape it could never have attributed.
 *
 * A MEASURED BUN HAZARD, worth naming because it silently disarms this test:
 * on Bun 1.3.11 an unhandled rejection ends the process (exit 1) — UNLESS the
 * script is suspended in a TOP-LEVEL AWAIT at the time, in which case it is
 * merely printed and the module runs on to its own exit. The worker's shipped
 * bundle has no top-level await, so the production semantics are the crash;
 * this script therefore hands its tail to timers rather than awaiting, so it
 * observes the same disposition the worker does. Both halves are asserted —
 * the nonzero exit AND the stderr print the deleted shield used to suppress.
 */
function unrelatedAbortWorkerSource(siblingPath: string): string {
  return `${SEED_FIXTURE}
const job = seedWindow("unrelated-abort");
const dispatch = createUnifiedNoteSettlementDispatch({
  db,
  config: SETTLEMENT_ENABLED_CONFIG,
  now: () => NOW,
  logger: { warn: () => {}, error: () => {} },
  claimMonitorIntervalMs: 10_000,
  runQuery: createChildProcessNoteSettlementQuery({
    databasePath: DB_PATH,
    dataRoot: ${JSON.stringify(REPO_ROOT)},
    logger: { warn: () => {}, error: () => {} },
    command: { command: "bun", args: ["run", ${JSON.stringify(siblingPath)}] },
  }),
});

class AbortError extends Error {}
// No top-level await past this point — see the hazard note above.
dispatch({ job }).then((verdict) => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ ok: verdict.ok }) + "\\n");
    process.exit(0);
  }, 1200);
});
// Somebody else's bug, in the worker itself, with a settlement run live.
setTimeout(() => {
  void (async () => { throw new AbortError("Operation aborted"); })();
}, 300);
setInterval(() => {}, 1000);
`;
}

function writeScripts(): {
  dir: string;
  debrisPath: string;
  siblingPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "mnemo-abort-survival-"));
  const debrisPath = join(dir, "child-debris.ts");
  const siblingPath = join(dir, "child-sibling.ts");
  writeFileSync(debrisPath, debrisChildSource(), "utf8");
  writeFileSync(siblingPath, happyChildSource(700), "utf8");
  return { dir, debrisPath, siblingPath };
}

async function runWorkerScript(
  dir: string,
  name: string,
  source: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const scriptPath = join(dir, name);
  writeFileSync(scriptPath, source, "utf8");
  const child = Bun.spawn(["bun", "run", scriptPath, join(dir, `${name}.db`)], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("TICKET 02 — a run's debris kills its own process and nothing else", () => {
  test("REGRESSION 1: delayed control-request debris inside the child kills at most the child — the worker survives, the job fails with a logged diagnosis, and the sibling run reaches its own terminal commit", async () => {
    const { dir, debrisPath, siblingPath } = writeScripts();
    const { exitCode, stdout, stderr } = await runWorkerScript(
      dir,
      "worker-survival.ts",
      survivalWorkerSource(debrisPath, siblingPath),
    );

    // THE ASSERTION. With the run in-process this exited 1, printing to a
    // stderr production discards, and took the sibling with it.
    expect({ exitCode, stderr: stderr.slice(0, 2000) }).toEqual({
      exitCode: 0,
      stderr: "",
    });

    const result = JSON.parse(stdout.trim()) as {
      alive: boolean;
      xOk: boolean;
      xReason: string | null;
      yOk: boolean;
      siblingStatus: string;
      diagnosis: string[];
    };

    expect(result.alive).toBe(true);
    // The target's own loss verdict still lands, exactly as before.
    expect(result.xOk).toBe(false);
    expect(result.xReason).toContain("lost ownership");
    // The child's death was SEEN and named — no silent death of a run.
    expect(result.diagnosis.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnosis[0]).toContain('"jobId"');
    // The debris itself is IN the worker log now, carried across as the dead
    // child's stderr tail — the run's death is diagnosable rather than silent.
    expect(result.diagnosis[0]).toContain("Operation aborted");
    // And the child that refused to leave was killed outright.
    expect(result.diagnosis[0]).toContain('"signal":"SIGKILL"');
    // The sibling was never touched and reached its own terminal commit.
    expect(result.yOk).toBe(true);
    expect(result.siblingStatus).toBe("done");
  }, 60_000);

  test("REGRESSION 3: an unrelated AbortError in the WORKER still ends the worker — crash-on-genuine-bug semantics are untouched, because no global handler exists anywhere", async () => {
    const { dir, siblingPath } = writeScripts();
    const { exitCode, stdout, stderr } = await runWorkerScript(
      dir,
      "worker-unrelated-abort.ts",
      unrelatedAbortWorkerSource(siblingPath),
    );

    // THE CRASH. Under ticket 01's shield this same rejection was swallowed
    // (allow-listed by constructor and message) and the process ran on.
    expect(exitCode).not.toBe(0);
    // UNSWALLOWED: the shield's other effect was an EMPTY stderr here.
    expect(stderr).toContain("Operation aborted");
    // The worker died before its own dispatch could report anything — the
    // stranger's bug was never converted into this run's verdict.
    expect(stdout.trim()).toBe("");
  }, 60_000);
});
