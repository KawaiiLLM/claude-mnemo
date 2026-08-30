import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * PART A2 of claim-monitor-repair ticket 01 — THE CRASH SHAPE, proven where
 * it actually happens: in a whole process of its own.
 *
 * THE MECHANISM this guards (all of it inside the vendored Agent SDK,
 * `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`):
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
 *      is aborted (`AbortError("Operation aborted")`) and again once the child
 *      is dead ("Cannot write to terminated process").
 *
 * So a claim-monitor abort landing while any tool call or Stop hook is
 * mid-flight makes step 2's `try` throw, its `catch` throw again, and step 1's
 * unheld promise reject with no observer. Bun (and Node) end the process on an
 * unhandled rejection; the worker is spawned `stdio: "ignore"`
 * (`src/worker/client.ts`), so the print goes to nowhere. That is the silent
 * death observed twice on 2026-08-30 (jobs 161 and 163), which took every
 * in-flight SIBLING settlement child with it.
 *
 * WHY A SUBPROCESS AND NOT AN IN-PROCESS TEST. `bun test` intercepts unhandled
 * rejections BELOW the `process.on("unhandledRejection")` level: it fails the
 * test immediately and never invokes the listener, so the shield is invisible
 * (and unprovable) from inside a test body. Measured, not assumed — a listener
 * registered inside a `bun test` body never fires for a floating rejection.
 * The only faithful assertion is the one this file makes: run the real
 * dispatch in a real process and check that the process is still alive and
 * exits 0.
 *
 * Without the shield this script exits 1 with no output. That is exactly the
 * production failure.
 */

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

function scriptSource(): string {
  return `
import { createDatabase } from ${JSON.stringify(join(REPO_ROOT, "src/db/database.ts"))};
import { initializeSchema } from ${JSON.stringify(join(REPO_ROOT, "src/db/schema.ts"))};
import { upsertSession } from ${JSON.stringify(join(REPO_ROOT, "src/db/sessions.ts"))};
import { upsertShadowNote } from ${JSON.stringify(join(REPO_ROOT, "src/db/shadow-notes.ts"))};
import {
  claimNextNoteSettlementJob,
  completeNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
} from ${JSON.stringify(join(REPO_ROOT, "src/db/note-settlement.ts"))};
import { createUnifiedNoteSettlementDispatch } from ${JSON.stringify(join(REPO_ROOT, "src/worker/note-settlement-dispatch.ts"))};
import {
  SETTLEMENT_ENABLED_CONFIG,
  SETTLEMENT_ERA_CUTOFF_EPOCH,
} from ${JSON.stringify(join(REPO_ROOT, "tests/support/settlement-config.ts"))};

const NOW = 1_800_000_000;
const db = createDatabase(":memory:");
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

const target = seedWindow("survival-target");
const sibling = seedWindow("survival-sibling");

const warns = [];
const logger = { warn: (message) => warns.push(String(message)), error: (message) => warns.push(String(message)) };

/** The SDK's own class shape: \`class AbortError extends Error {}\`, no \`name\` override. */
class AbortError extends Error {}

let siblingAborted = false;

const targetDispatch = createUnifiedNoteSettlementDispatch({
  db,
  config: SETTLEMENT_ENABLED_CONFIG,
  now: () => NOW,
  logger,
  claimMonitorIntervalMs: 5,
  runQuery: (request) =>
    new Promise((_resolve, reject) => {
      request.signal?.addEventListener(
        "abort",
        () => {
          // STEP 1 + 2 + 3, verbatim: the unheld \`handleControlRequest\`
          // promise rejecting with the transport's AbortError.
          void (async () => {
            throw new AbortError("Operation aborted");
          })();
          void (async () => {
            throw new Error("Cannot write to terminated process");
          })();
          reject(new AbortError("Claude Code process aborted by user"));
        },
        { once: true },
      );
    }),
});

const siblingDispatch = createUnifiedNoteSettlementDispatch({
  db,
  config: SETTLEMENT_ENABLED_CONFIG,
  now: () => NOW,
  logger,
  claimMonitorIntervalMs: 5,
  runQuery: (request) =>
    new Promise((resolve) => {
      request.signal?.addEventListener("abort", () => { siblingAborted = true; }, { once: true });
      // The healthy sibling child: still narrating when the target is killed.
      setTimeout(() => {
        completeNoteSettlementJob(db, request.jobId, NOW, request.claimGeneration);
        resolve({ text: "sibling committed.", finalized: true, commitMetrics: null, laneCheckCalled: true });
      }, 300);
    }),
});

const targetOutcome = targetDispatch({ job: target });
const siblingOutcome = siblingDispatch({ job: sibling });

// A GENUINE loss on the target: the generation moves under it, so the monitor
// aborts for real.
setTimeout(() => {
  db.query("UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?").run(target.id);
}, 40);

const x = await targetOutcome;
const y = await siblingOutcome;

process.stdout.write(
  JSON.stringify({
    alive: true,
    xOk: x.ok,
    xReason: x.ok ? null : x.reason,
    yOk: y.ok,
    siblingAborted,
    siblingStatus: getNoteSettlementJob(db, sibling.id).status,
    swallowed: warns.filter((line) => line.includes("abort debris")),
  }) + "\\n",
);
process.exit(0);
`;
}

describe("PART A2 — the abort aftermath must not kill the worker process", () => {
  test("a genuine claim loss aborts its own query, the SDK-shaped unhandled rejections are swallowed, the process survives, and the sibling dispatch runs to its natural end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-abort-survival-"));
    const scriptPath = join(dir, "abort-survival.ts");
    writeFileSync(scriptPath, scriptSource(), "utf8");

    const child = Bun.spawn(["bun", "run", scriptPath], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    // THE ASSERTION. Before the shield this exited 1 with the rejection on a
    // stderr production discards, and the sibling died with it.
    expect({ exitCode, stderr: stderr.slice(0, 2000) }).toEqual({
      exitCode: 0,
      stderr: "",
    });

    const result = JSON.parse(stdout.trim()) as {
      alive: boolean;
      xOk: boolean;
      xReason: string | null;
      yOk: boolean;
      siblingAborted: boolean;
      siblingStatus: string;
      swallowed: string[];
    };

    expect(result.alive).toBe(true);
    // The target's own abort still happened, exactly as before.
    expect(result.xOk).toBe(false);
    expect(result.xReason).toContain("lost ownership");
    // The debris was seen and named, not merely absent.
    expect(result.swallowed.length).toBeGreaterThanOrEqual(2);
    // The sibling was never touched and reached its own terminal commit.
    expect(result.siblingAborted).toBe(false);
    expect(result.yOk).toBe(true);
    expect(result.siblingStatus).toBe("done");
  }, 30_000);
});
