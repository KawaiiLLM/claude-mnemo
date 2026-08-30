import { spawn as nodeSpawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import type { NoteSettlementStage } from "../db/note-settlement";
import type { SettlementScopeProvenance } from "./note-settlement-context";
import type { NoteSettlementDispatchLogger } from "./note-settlement-dispatch";
import type {
  NoteSettlementUnifiedQuery,
  NoteSettlementUnifiedQueryRequest,
  NoteSettlementUnifiedQueryResult,
} from "./note-settlement-sdk-query";

/**
 * THE CHILD BOUNDARY (claim-monitor-repair ticket 02). One settlement run is
 * one PROCESS: the model client wrapper — the query, its transport, the
 * settlement MCP server and the Stop hook — runs in a child of the worker,
 * and the only things that cross the boundary are a JSON request in on stdin
 * and a JSON result envelope out on stdout.
 *
 * WHY A PROCESS AND NOT A LISTENER. Ticket 01 shipped a process-level
 * `unhandledRejection` shield against the vendored SDK's bare-promise bug (an
 * inbound control request is dispatched unawaited, so a write that throws
 * under abort rejects with no observer and ends the process). Peer review
 * killed it on three structural grounds, all the same shape: at the
 * `unhandledRejection` layer NO QUERY IDENTITY EXISTS. A listener cannot tell
 * this run's debris from another subsystem's, cannot be released safely when
 * the query it guards never settles, and cannot pick a time window that is
 * simultaneously long enough to cover a late control-request handler and
 * short enough to not swallow a stranger's bug. A process boundary answers
 * all three by construction: the debris of run X can only ever kill run X's
 * own process, because that is the only process it exists in. The worker
 * keeps ZERO global rejection handlers — a genuine unhandled rejection in the
 * WORKER still ends the worker, exactly as before.
 *
 * WHAT THE LOSS VERDICT BECOMES. The claim monitor is unchanged (same arming,
 * same three-way predicate, same interval); only the delivery of its verdict
 * changes. An `AbortController` was a REQUEST the query could ignore; a
 * signal to a child is `SIGTERM`, and a child that ignores it is `SIGKILL`ed
 * after a bounded wait. So the run's promise is guaranteed to settle — child
 * exit is always observable — which is what lets the dispatch stop hoping.
 */

/** The shipped bundle's own name for the child entry (see `scripts/build.js`). */
export const SETTLEMENT_CHILD_SCRIPT_NAME = "settlement-child.cjs";

/**
 * The result envelope's line marker on the child's stdout. A settlement child
 * hosts a whole SDK session, and anything in that stack may print; a single
 * marked line, scanned for from the END, is what makes the envelope findable
 * without owning the child's whole stdout.
 */
export const SETTLEMENT_CHILD_ENVELOPE_PREFIX =
  "[claude-mnemo] settlement-child-result ";

/**
 * How long a `SIGTERM`ed child has to leave on its own before `SIGKILL`. Long
 * enough for a real SDK session to tear its own grandchild (the `claude` CLI)
 * down cleanly, short enough that the drain never waits on a wedged process
 * for a human-noticeable time.
 */
export const SETTLEMENT_CHILD_KILL_GRACE_MS = 10_000;

/** How much of a dead child's stderr is worth keeping — the TAIL, where the throw is. */
export const SETTLEMENT_CHILD_STDERR_TAIL_CHARS = 4_000;

/** The worker log's own marker for anything this boundary reports. */
export const SETTLEMENT_CHILD_LOG_PREFIX = "[claude-mnemo] note-settlement child";

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

export interface SettlementChildScopeProvenanceWire {
  window: number[];
  baseLookback: number[];
  closureOnly: number[];
}

/**
 * The run request, in the only vocabulary a pipe speaks. Two shapes have to
 * change and nothing else does: `Set<number>` becomes an array, and the
 * `AbortSignal` does not cross at all — its job on the other side is done by
 * the signal the parent sends the process.
 */
export interface SettlementChildRequestWire {
  prompt: string;
  systemPrompt: string;
  model: string;
  maxThinkingTokens: number | null;
  jobId: number;
  claimGeneration: number;
  stage: NoteSettlementStage;
  sessionId: number;
  writableTurnIds: number[];
  scopeProvenance: SettlementChildScopeProvenanceWire;
  contextBuiltAtEpoch: number;
  windowStart: number;
  windowEnd: number;
}

/**
 * Everything the child needs to rebuild the run: the request above, plus the
 * two things the parent resolved from its own environment — where the
 * database file is (the child opens its OWN handle; SQLite here is already
 * multi-process, the hooks write concurrently) and which directory the SDK
 * session runs in.
 */
export interface SettlementChildPayload {
  databasePath: string;
  dataRoot: string;
  defaultProject?: string;
  request: SettlementChildRequestWire;
}

export type SettlementChildEnvelope =
  | { ok: true; result: NoteSettlementUnifiedQueryResult }
  | { ok: false; message: string };

export function encodeSettlementChildRequest(
  request: NoteSettlementUnifiedQueryRequest,
): SettlementChildRequestWire {
  return {
    prompt: request.prompt,
    systemPrompt: request.systemPrompt,
    model: request.model,
    maxThinkingTokens: request.maxThinkingTokens ?? null,
    jobId: request.jobId,
    claimGeneration: request.claimGeneration,
    stage: request.stage,
    sessionId: request.sessionId,
    writableTurnIds: [...request.writableTurnIds],
    scopeProvenance: {
      window: [...request.scopeProvenance.window],
      baseLookback: [...request.scopeProvenance.baseLookback],
      closureOnly: [...request.scopeProvenance.closureOnly],
    },
    contextBuiltAtEpoch: request.contextBuiltAtEpoch,
    windowStart: request.windowStart,
    windowEnd: request.windowEnd,
  };
}

export function decodeSettlementChildRequest(
  wire: SettlementChildRequestWire,
): NoteSettlementUnifiedQueryRequest {
  const scopeProvenance: SettlementScopeProvenance = {
    window: new Set(wire.scopeProvenance.window),
    baseLookback: new Set(wire.scopeProvenance.baseLookback),
    closureOnly: new Set(wire.scopeProvenance.closureOnly),
  };
  return {
    prompt: wire.prompt,
    systemPrompt: wire.systemPrompt,
    model: wire.model,
    maxThinkingTokens: wire.maxThinkingTokens,
    jobId: wire.jobId,
    claimGeneration: wire.claimGeneration,
    stage: wire.stage,
    sessionId: wire.sessionId,
    writableTurnIds: new Set(wire.writableTurnIds),
    scopeProvenance,
    contextBuiltAtEpoch: wire.contextBuiltAtEpoch,
    windowStart: wire.windowStart,
    windowEnd: wire.windowEnd,
  };
}

export function formatSettlementChildEnvelope(
  envelope: SettlementChildEnvelope,
): string {
  return `${SETTLEMENT_CHILD_ENVELOPE_PREFIX}${JSON.stringify(envelope)}\n`;
}

/**
 * The LAST marked line wins: a child that printed an envelope and then said
 * more is still answering; a child that printed nothing marked never answered
 * at all, and `null` is what makes that a run failure rather than a silent
 * success.
 */
export function parseSettlementChildEnvelope(
  stdout: string,
): SettlementChildEnvelope | null {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith(SETTLEMENT_CHILD_ENVELOPE_PREFIX)) {
      continue;
    }
    try {
      const parsed = JSON.parse(
        line.slice(SETTLEMENT_CHILD_ENVELOPE_PREFIX.length),
      ) as SettlementChildEnvelope;
      if (typeof parsed === "object" && parsed !== null && "ok" in parsed) {
        return parsed;
      }
    } catch {
      // A truncated or interleaved line is not an answer — keep scanning
      // upward; if nothing parses, the caller reports "no envelope".
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The parent side
// ---------------------------------------------------------------------------

/**
 * Where the shipped child entry lives, derived exactly the way
 * `worker/client.ts` derives the worker's own script paths — the plugin root
 * from `CLAUDE_PLUGIN_ROOT` when Claude Code supplies it, otherwise from this
 * file's own location. The child is started through `bun-runner.js` for the
 * same reason the worker is: Bun may not be on `PATH` on a fresh install.
 */
export function resolveSettlementChildCommand(
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const explicit = env.CLAUDE_MNEMO_SETTLEMENT_CHILD;
  if (explicit && explicit.trim() !== "") {
    return { command: "bun", args: ["run", explicit] };
  }

  const currentDir = dirname(__filename);
  const pluginRoot =
    env.CLAUDE_PLUGIN_ROOT && env.CLAUDE_PLUGIN_ROOT.trim() !== ""
      ? env.CLAUDE_PLUGIN_ROOT
      : currentDir.endsWith("/plugin/scripts") ||
          currentDir.endsWith("\\plugin\\scripts")
        ? resolve(currentDir, "..")
        : resolve(currentDir, "..", "..", "plugin");

  return {
    command: "node",
    args: [
      join(pluginRoot, "scripts", "bun-runner.js"),
      join(pluginRoot, "scripts", SETTLEMENT_CHILD_SCRIPT_NAME),
    ],
  };
}

export interface CreateChildProcessNoteSettlementQueryOptions {
  /**
   * The database FILE the child opens its own handle against — supplied by
   * the assembly site from its already-open primary connection's own
   * `db.filename`, never re-resolved here (the same discipline the console
   * reader's second connection follows). An in-memory database cannot cross
   * a process boundary at all, and saying so at call time is more honest than
   * a child that opens an empty database and settles nothing.
   */
  databasePath: string;
  dataRoot: string;
  defaultProject?: string;
  logger?: NoteSettlementDispatchLogger;
  /** Test seam: the process factory. */
  spawnImpl?: typeof nodeSpawn;
  /** Test seam: what to run instead of the shipped bundle. */
  command?: { command: string; args: string[] };
  env?: NodeJS.ProcessEnv;
  /** How long a `SIGTERM`ed child has before `SIGKILL`. */
  killGraceMs?: number;
}

/**
 * THE DISPATCH'S `runQuery`, as a process. Same seam as the in-process query
 * it replaces — `(request) => Promise<result>` — with three properties the
 * in-process one could not have:
 *
 *   1. it ALWAYS settles. The promise is tied to the child's exit, and a
 *      child always exits (`SIGKILL` is not ignorable), so the dispatch's
 *      await can no longer wedge the drain on a query that decided not to
 *      honor an abort;
 *   2. a crash is a RUN failure, not a worker failure. Whatever the SDK
 *      leaks — the bare control-request rejection above all — kills a process
 *      whose entire contents are this one run;
 *   3. the death is never silent. A non-clean exit puts the exit code, the
 *      signal and a bounded tail of the child's stderr into the worker log,
 *      which is the one thing the shield could never do from inside the
 *      process it was failing to save.
 */
export function createChildProcessNoteSettlementQuery(
  options: CreateChildProcessNoteSettlementQueryOptions,
): NoteSettlementUnifiedQuery {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const logger = options.logger ?? console;
  const killGraceMs = options.killGraceMs ?? SETTLEMENT_CHILD_KILL_GRACE_MS;

  return (request) =>
    new Promise<NoteSettlementUnifiedQueryResult>((resolvePromise, rejectPromise) => {
      if (options.databasePath === "" || options.databasePath === ":memory:") {
        rejectPromise(
          new Error(
            "note settlement child cannot run against an in-memory database — no file for the child to open",
          ),
        );
        return;
      }

      const { command, args } =
        options.command ?? resolveSettlementChildCommand(options.env);

      let child;
      try {
        child = spawnImpl(command, args, {
          cwd: options.dataRoot,
          env: options.env ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        rejectPromise(
          new Error(
            `note settlement child failed to start: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let abortListener: (() => void) | null = null;

      const cleanup = (): void => {
        if (killTimer !== null) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        if (abortListener !== null) {
          request.signal?.removeEventListener("abort", abortListener);
          abortListener = null;
        }
      };

      // THE LOSS VERDICT'S DELIVERY. `SIGTERM` first — the SDK session gets
      // its chance to tear its own `claude` grandchild down — then `SIGKILL`
      // once the grace has passed. `unref` so a killed child's timer can
      // never be the reason the worker's own event loop stays alive.
      const killChild = (): void => {
        if (settled || killTimer !== null) {
          return;
        }
        try {
          child.kill("SIGTERM");
        } catch {
          // Already gone; the exit handler below is what settles this.
        }
        killTimer = setTimeout(() => {
          killTimer = null;
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }, killGraceMs);
        killTimer.unref?.();
      };

      if (request.signal) {
        if (request.signal.aborted) {
          killChild();
        } else {
          abortListener = killChild;
          request.signal.addEventListener("abort", abortListener, { once: true });
        }
      }

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-SETTLEMENT_CHILD_STDERR_TAIL_CHARS);
      });

      const payload: SettlementChildPayload = {
        databasePath: options.databasePath,
        dataRoot: options.dataRoot,
        ...(options.defaultProject === undefined
          ? {}
          : { defaultProject: options.defaultProject }),
        request: encodeSettlementChildRequest(request),
      };
      // A child that died before reading its request turns a stdin write into
      // EPIPE; the exit handler already owns that story, so this only has to
      // not throw out of the constructor.
      child.stdin?.on("error", () => {});
      try {
        child.stdin?.end(`${JSON.stringify(payload)}\n`);
      } catch {
        // Same: the exit is the verdict.
      }

      child.on("error", (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        logger.error(
          `${SETTLEMENT_CHILD_LOG_PREFIX} failed to start`,
          JSON.stringify({ jobId: request.jobId, error: error.message }),
        );
        rejectPromise(
          new Error(`note settlement child failed to start: ${error.message}`),
        );
      });

      child.on("close", (code: number | null, signal: string | null) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();

        const envelope = parseSettlementChildEnvelope(stdout);
        const cleanExit =
          code === 0 && signal === null && envelope !== null && envelope.ok;
        if (!cleanExit) {
          // THE PARENT-SIDE OBSERVABILITY PRINCIPLE (peer's, ticket 02):
          // the silent death of a RUN is no longer possible. Exit code,
          // signal and the stderr tail land in the worker's own log — the
          // worker's stderr is discarded at the plugin spawn layer
          // (`worker/client.ts` spawns it `stdio: "ignore"`), which is why
          // this has to be a log call and not a re-print.
          logger.error(
            `${SETTLEMENT_CHILD_LOG_PREFIX} exited without a clean result`,
            JSON.stringify({
              jobId: request.jobId,
              claimGeneration: request.claimGeneration,
              exitCode: code,
              signal,
              envelope: envelope === null ? "missing" : "failed",
              stderrTail: stderr.slice(-SETTLEMENT_CHILD_STDERR_TAIL_CHARS),
            }),
          );
        }

        if (envelope !== null) {
          if (envelope.ok) {
            resolvePromise(envelope.result);
            return;
          }
          rejectPromise(new Error(envelope.message));
          return;
        }

        const tail = stderr.trim();
        rejectPromise(
          new Error(
            `note settlement child exited ${
              signal === null ? `with code ${code}` : `on ${signal}`
            } without a result envelope${tail === "" ? "" : `: ${tail}`}`,
          ),
        );
      });
    });
}
