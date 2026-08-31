import type { Database } from "bun:sqlite";

import { createDatabase } from "../db/database";

import {
  buildSettlementChildTaskkillCommand,
  decodeSettlementChildEdgesRequest,
  decodeSettlementChildRequest,
  formatSettlementChildEnvelope,
  runBoundedTaskkill,
  SETTLEMENT_CHILD_RUNTIME_DEADLINE_MS,
  SETTLEMENT_CHILD_SCRIPT_NAME,
  type SettlementChildEnvelope,
  type SettlementChildPayload,
  type SettlementChildTaskkillRunner,
} from "./note-settlement-child";
import {
  createNoteSettlementSdkQuery,
  createUnifiedNoteSettlementSdkQuery,
  type NoteSettlementUnifiedQueryRequest,
} from "./note-settlement-sdk-query";

/**
 * THE CHILD SIDE of claim-monitor-repair ticket 02's process boundary — the
 * entry point of one settlement run's own process.
 *
 * Everything the worker must not host lives on this side of the pipe: the
 * model client, its transport, the settlement MCP server and the Stop hook,
 * all of it assembled exactly as it was when it ran in the worker. What
 * changed is only WHERE it runs, and therefore what its failures can reach —
 * an unobserved rejection out of the vendored client's control-request
 * channel now ends a process that contains one run and nothing else.
 *
 * BOTH settlement runs come through here (peer round 2, gate 6): the unified
 * topic-and-edges run of a fresh claim, and the stage-2 `edges` COLD RESUME
 * of a reclaimed one. The payload's `mode` is the only thing that differs,
 * and it picks which query builder assembles the session — one entry, one
 * kill discipline, one liveness contract, rather than a second bespoke
 * channel for the rarer and more dangerous path.
 *
 * IT INSTALLS NO PROCESS-LEVEL REJECTION HANDLER, deliberately. Dying on
 * debris is the contract: the parent reads the exit code and the stderr tail
 * and fails exactly this job. A handler here would put back the very
 * attribution problem the boundary exists to remove.
 *
 * ITS OWN DATABASE HANDLE. The child opens the file itself — SQLite here is
 * already multi-process (hooks write while the worker does), so this adds a
 * writer to a set that already exists rather than a new kind of concurrency.
 * The busy timeout is named below for the same reason the hook path names
 * its own: a settlement run is a long, patient writer, not a latency-bound
 * hook, so it waits out a lock rather than failing fast on one.
 */
export const SETTLEMENT_CHILD_DB_BUSY_TIMEOUT_MS = 5_000;

/**
 * How long the envelope's own flush may take before the child gives up
 * waiting and leaves anyway. The wait itself is the point (peer gate 5: a
 * bare `write(); exit(0)` truncated an 8 MiB envelope to 64 KiB under
 * backpressure); this bound only exists so a parent that stopped reading
 * cannot turn "answer the run" into "never exit".
 */
export const SETTLEMENT_CHILD_STDOUT_DRAIN_TIMEOUT_MS = 30_000;

/** Whatever an `ok: true` envelope carries — either run's result shape. */
export type SettlementChildQueryResult = Extract<
  SettlementChildEnvelope,
  { ok: true }
>["result"];

/**
 * The slice of `process.stdin` the parent-death watch actually reads —
 * injectable (round 3, gate item 4) because the one state this watch must
 * not miss, "the EOF already happened", cannot be replayed on the real
 * stream from inside a test.
 */
export interface SettlementChildLivenessStream {
  readableEnded?: boolean;
  destroyed?: boolean;
  on(event: "end" | "close", listener: () => void): unknown;
  removeListener(event: "end" | "close", listener: () => void): unknown;
}

export interface SettlementChildDeps {
  openDatabase?: (databasePath: string) => Database;
  createQuery?: (
    db: Database,
    payload: SettlementChildPayload,
  ) => (
    request: NoteSettlementUnifiedQueryRequest,
  ) => Promise<SettlementChildQueryResult>;
  readStdin?: () => Promise<string>;
  writeStdout?: (text: string) => void | Promise<void>;
  exit?: (code: number) => void;
  /** Test seam for the liveness/deadline half — see `installParentDeathWatch`. */
  onParentGone?: () => void;
  /** Test seam: the liveness stream the death watch observes (default `process.stdin`). */
  livenessStream?: SettlementChildLivenessStream;
}

function defaultOpenDatabase(databasePath: string): Database {
  return createDatabase(databasePath, {
    busyTimeoutMs: SETTLEMENT_CHILD_DB_BUSY_TIMEOUT_MS,
  });
}

/**
 * One run, one envelope. A thrown query becomes `ok: false` with its own
 * message rather than an exit code, because a failure the run REACHED is a
 * diagnosis the parent can compose with; only a failure that kills the
 * process before this point is left to the exit code and the stderr tail.
 */
export async function runSettlementChild(
  payload: SettlementChildPayload,
  deps: SettlementChildDeps = {},
): Promise<SettlementChildEnvelope> {
  const openDatabase = deps.openDatabase ?? defaultOpenDatabase;

  let db: Database;
  try {
    db = openDatabase(payload.databasePath);
  } catch (error) {
    return {
      ok: false,
      message: `note settlement child could not open ${payload.databasePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  try {
    const options = {
      db,
      dataRoot: payload.dataRoot,
      ...(payload.defaultProject === undefined
        ? {}
        : { defaultProject: payload.defaultProject }),
    };
    if (deps.createQuery) {
      const runQuery = deps.createQuery(db, payload);
      const result = await runQuery(
        (payload.request.mode === "edges"
          ? decodeSettlementChildEdgesRequest(payload.request)
          : decodeSettlementChildRequest(
              payload.request,
            )) as NoteSettlementUnifiedQueryRequest,
      );
      return { ok: true, result };
    }
    if (payload.request.mode === "edges") {
      const runEdges = createNoteSettlementSdkQuery(options);
      const result = await runEdges(
        decodeSettlementChildEdgesRequest(payload.request),
      );
      return { ok: true, result };
    }
    const runUnified = createUnifiedNoteSettlementSdkQuery(options);
    const result = await runUnified(
      decodeSettlementChildRequest(payload.request),
    );
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      db.close(false);
    } catch {
      // A close that fails changes nothing about the envelope already decided.
    }
  }
}

/**
 * THE PARENT-DEATH WATCH (peer gate 3). The payload arrives as ONE
 * newline-terminated line and the parent then leaves the pipe open for the
 * rest of the run — so EOF on stdin cannot mean "the request is over", and
 * means the only other thing it can: the worker is gone.
 *
 * That case is not hypothetical and was not previously bounded. `detached`
 * (gate 2) buys the process group the kill needs, and pays for it by opting
 * out of the kernel's own parent-death handling: a child that refuses
 * `SIGTERM`, plus the `claude` CLI under it, would otherwise outlive a worker
 * that died inside the kill grace and hold their pipes open forever.
 */
export function readPayloadLine(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffered = "";
    let done = false;
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string): void => {
      if (done) {
        return;
      }
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        return;
      }
      done = true;
      process.stdin.removeListener("data", onData);
      // Keep the pipe FLOWING and keep the `end` listener: from here on it is
      // the liveness channel, not the request channel.
      process.stdin.resume();
      resolvePromise(buffered.slice(0, newline));
    };
    process.stdin.on("data", onData);
    process.stdin.on("error", (error) => {
      if (!done) {
        done = true;
        rejectPromise(error);
      }
    });
    process.stdin.on("end", () => {
      if (!done) {
        done = true;
        // EOF before a complete line: the parent died mid-handshake, or sent
        // nothing at all. Either way there is no run to do.
        rejectPromise(new Error("stdin closed before a complete request line"));
      }
    });
  });
}

/** The seams `killOwnProcessGroup` needs to be testable off its own platform. */
export interface KillOwnProcessGroupDeps {
  /** Test seam: which platform's discipline to use (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** Test seam for the WIN32 route only: how `taskkill` is executed. */
  taskkillImpl?: SettlementChildTaskkillRunner;
  /** Test seam: stands in for `process.exit(1)`. */
  exit?: (code: number) => void;
}

/**
 * Ends this process's whole tree, which on the shipped topology is exactly
 * this child plus the `claude` CLI it spawned.
 *
 * POSIX: the negative pid is what makes that one call instead of a tree
 * walk; the fallback covers a child that was NOT spawned detached (a direct
 * `bun run` of this entry), where no group with this pid exists.
 *
 * WIN32 (round 3 P1, user-ruled): there is no group to signal, and a bare
 * `process.exit(1)` — the previous behaviour — stranded every descendant,
 * the CLI above all. So the child runs the same tree walk the parent's
 * forced stage runs, `taskkill /PID <own pid> /T /F`, on ITSELF, and only
 * exits once that request has SETTLED (the exit is a backstop: a `/F` walk
 * that worked never lets this process reach it). The runner is the SHARED
 * bounded one (round 4 P1 — one body of code, not a second unbounded copy),
 * so `exit(1)` is reached in every shape, within the runner's own bound; a
 * result that is not exit 0 writes a containment-failure line to stderr
 * first, because a completed kill command is not a cleared tree. Command
 * construction and the result protocol are tested; the runtime behaviour is
 * UNVERIFIED off Windows.
 */
export function killOwnProcessGroup(
  signal: NodeJS.Signals = "SIGKILL",
  deps: KillOwnProcessGroupDeps = {},
): void {
  const platform = deps.platform ?? process.platform;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  if (platform !== "win32") {
    try {
      // The shipped child is spawned `detached`, so it IS the group leader
      // and this reaches the `claude` CLI under it as well as this process.
      process.kill(-process.pid, signal);
      return;
    } catch {
      // No group with this pid — a direct `bun run` of this entry. End just
      // this process instead.
    }
    exit(1);
    return;
  }
  const taskkill = deps.taskkillImpl ?? runBoundedTaskkill;
  const { command, args } = buildSettlementChildTaskkillCommand(
    process.pid,
    signal === "SIGTERM" ? "term" : "kill",
  );
  void taskkill(command, args).then((result) => {
    if (!result.ok) {
      process.stderr.write(
        `[claude-mnemo] settlement child: taskkill did not prove the tree cleared — containment failure (${result.kind}${
          result.exitCode === undefined ? "" : `, exit ${result.exitCode}`
        })\n`,
      );
    }
    exit(1);
  });
}

export interface ParentDeathWatch {
  clear(): void;
}

export function installParentDeathWatch(
  payload: SettlementChildPayload,
  deps: SettlementChildDeps = {},
): ParentDeathWatch {
  const die = deps.onParentGone ?? (() => killOwnProcessGroup());
  const stdin: SettlementChildLivenessStream =
    deps.livenessStream ?? process.stdin;
  let fired = false;

  const onEnd = (): void => {
    if (fired) {
      return;
    }
    fired = true;
    process.stderr.write(
      "[claude-mnemo] settlement child: parent closed the liveness pipe — ending this process group\n",
    );
    die();
  };
  stdin.on("end", onEnd);
  stdin.on("close", onEnd);

  // GATE-3 MECHANICAL COMPLETENESS (round 3, item 4). `end` is an EVENT, and
  // an event that fired between the payload's resolve and this install is
  // simply gone — the stream is already ended or destroyed, no listener will
  // ever hear it, and the watch would arm dead. So the state is checked once,
  // after the listeners exist, and the death path fires off a microtask —
  // asynchronously, like the event it stands in for, so no caller observes a
  // watch that dies before `install` has even returned.
  if (stdin.readableEnded === true || stdin.destroyed === true) {
    queueMicrotask(onEnd);
  }

  // THE BACKSTOP. If even the pipe is lost — an inherited fd, a platform that
  // never reports EOF — a run still cannot outlive its own deadline.
  const deadlineMs =
    typeof payload.deadlineMs === "number" && payload.deadlineMs > 0
      ? payload.deadlineMs
      : SETTLEMENT_CHILD_RUNTIME_DEADLINE_MS;
  const deadline = setTimeout(() => {
    if (fired) {
      return;
    }
    fired = true;
    process.stderr.write(
      `[claude-mnemo] settlement child: runtime deadline of ${deadlineMs}ms reached — ending this process group\n`,
    );
    die();
  }, deadlineMs);

  return {
    clear(): void {
      clearTimeout(deadline);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
    },
  };
}

/**
 * PEER GATE 5: the envelope is FLUSHED, not merely handed to the stream. A
 * `write(); exit(0)` pair drops whatever the OS pipe could not take in one
 * go — measured at 64 KiB of an 8 MiB envelope — and the parent then read a
 * truncated line, failed to parse it, and reported a run that had in fact
 * succeeded as one that never answered.
 */
export function writeStdoutAndDrain(
  text: string,
  timeoutMs: number = SETTLEMENT_CHILD_STDOUT_DRAIN_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    try {
      process.stdout.write(text, () => finish());
    } catch {
      finish();
    }
  });
}

/**
 * The process's whole life: read one JSON payload LINE off stdin, arm the
 * parent-death watch, run it, print one marked envelope line, wait for that
 * line to actually leave, then go. The explicit exit is not optional — a
 * finished SDK session can leave handles the event loop would otherwise wait
 * on forever, and a child that will not exit is exactly the wedge the parent
 * would then have to `SIGKILL`.
 */
export async function main(deps: SettlementChildDeps = {}): Promise<void> {
  const readStdin = deps.readStdin ?? readPayloadLine;
  const writeStdout = deps.writeStdout ?? writeStdoutAndDrain;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  let envelope: SettlementChildEnvelope;
  let watch: ParentDeathWatch | null = null;
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw) as SettlementChildPayload;
    watch = installParentDeathWatch(payload, deps);
    envelope = await runSettlementChild(payload, deps);
  } catch (error) {
    envelope = {
      ok: false,
      message: `note settlement child could not read its request: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // Cleared BEFORE the flush: the run is over, and a deadline that fired
  // while the answer was still draining would kill the process holding it.
  watch?.clear();
  await writeStdout(formatSettlementChildEnvelope(envelope));
  exit(0);
}

/**
 * Run only when this module IS the program — the shipped bundle, or the
 * source file under `bun run`. A test that imports it for
 * `runSettlementChild` must not start reading the test runner's stdin.
 */
const invokedDirectly = ((): boolean => {
  const entry = process.argv[1] ?? "";
  return (
    entry.endsWith(SETTLEMENT_CHILD_SCRIPT_NAME) ||
    entry.endsWith("note-settlement-child-entry.ts")
  );
})();

if (invokedDirectly) {
  void main();
}
