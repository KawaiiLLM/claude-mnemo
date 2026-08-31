import { spawn as nodeSpawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import type { NoteSettlementStage } from "../db/note-settlement";
import type { NoteSettlementCommitRecord } from "./note-settlement-direct-write";
import { sanitizeSecretString } from "../shared/error-sanitizer";
import type { SettlementScopeProvenance } from "./note-settlement-context";
import type {
  NoteSettlementDispatchLogger,
  NoteSettlementQuery,
  NoteSettlementQueryRequest,
  NoteSettlementQueryResult,
} from "./note-settlement-dispatch";
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
 *
 * ROUND-2 REPAIRS (peer's seven gates), because each one is a property this
 * file is now the only place to read:
 *
 *   - THE COMMAND IS THE WORKER'S OWN RUNTIME. `process.execPath` on the
 *     child bundle, never `node bun-runner.js <bundle>`. A wrapper meant one
 *     more PID between the parent and the run, and every signal below landed
 *     on the wrapper while the run itself — and the `claude` CLI under it —
 *     kept the pipes open.
 *   - THE SIGNAL IS SENT TO A PROCESS GROUP. The child is spawned `detached`
 *     on POSIX, which makes it a group leader, and the CLI it spawns joins
 *     that group; `kill(-pid)` is therefore the only form that reaches the
 *     whole tree. A bare `child.kill()` reaches exactly one process, and the
 *     one it reaches is never the one holding the model session open.
 *   - STDIN IS THE LIVENESS CHANNEL. The payload rides it, and it is
 *     deliberately NOT closed afterwards: EOF on it means the parent is gone,
 *     and the child answers EOF by killing its own group. `detached` bought
 *     the tree kill at the cost of the kernel's own parent-death cleanup;
 *     this buys it back, and a hard runtime deadline inside the child is the
 *     backstop for the case where even that pipe is lost.
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

/**
 * How long after `SIGKILL` the parent still waits for `close` before it stops
 * waiting at all.
 *
 * `close` is NOT "the child exited" — it is "every stdio stream this process
 * held is finished", and those are different events whenever anything else
 * inherited the pipes. A `claude` CLI grandchild that outlived the group kill
 * (or, measured here on Bun 1.3.11, a runtime that simply declines to emit
 * `close` for a `SIGKILL`ed detached child under load) would otherwise leave
 * this promise pending forever — which is the exact wedge the whole ticket
 * exists to make impossible. So the promise settles on this timer instead,
 * the streams are torn down, and the child handle is `unref`ed so a corpse
 * cannot hold the worker's event loop open either.
 */
export const SETTLEMENT_CHILD_REAP_GRACE_MS = 2_000;

/** How much of a dead child's stderr is worth keeping — the TAIL, where the throw is. */
export const SETTLEMENT_CHILD_STDERR_TAIL_CHARS = 4_000;

/**
 * The parent's HARD CAP on what one stdout line may cost it (peer gate 5).
 * The child's stdout carries a whole SDK session's chatter as well as the
 * envelope, and `stdout += chunk` made the worker's memory a function of how
 * talkative a run happened to be. The scanner below keeps only the current
 * partial line plus the last MARKED line, so steady-state cost is one
 * envelope — and this is the ceiling on that one.
 *
 * 16 MiB, deliberately well clear of the 8 MiB envelope the peer measured
 * being truncated: the cap exists to bound a pathological line, not to
 * second-guess a legitimately large result.
 */
export const SETTLEMENT_CHILD_ENVELOPE_MAX_CHARS = 16 * 1024 * 1024;

/**
 * The child's own dead-man switch (peer gate 3, backstop half). A run that
 * outlives this has stopped being a run — no settlement window has ever
 * plausibly needed half an hour of wall clock — and the child ends its own
 * group rather than waiting for a parent that may itself be gone.
 */
export const SETTLEMENT_CHILD_RUNTIME_DEADLINE_MS = 30 * 60_000;

/** The worker log's own marker for anything this boundary reports. */
export const SETTLEMENT_CHILD_LOG_PREFIX = "[claude-mnemo] note-settlement child";

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/**
 * WHICH RUN THIS IS (peer gate 6). Both settlement entry points cross the
 * same boundary now — the unified topic-and-edges run every fresh claim
 * takes, and the stage-2 `edges` COLD RESUME a crashed claim is reclaimed
 * onto. One entry, one wire, one discriminator: the recovery path is the one
 * that needs the isolation most, and a second bespoke channel for it would be
 * a second set of kill/liveness/envelope semantics to keep honest.
 */
export type SettlementChildMode = "unified" | "edges";

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
 *
 * `scopeProvenance` is nullable because the `edges` request's own field is
 * optional (a pre-provenance caller gets the flat refusal list); `null` is
 * the wire's way of saying "absent" without JSON dropping the key.
 */
export interface SettlementChildRequestWire {
  mode: SettlementChildMode;
  prompt: string;
  systemPrompt: string;
  model: string;
  maxThinkingTokens: number | null;
  jobId: number;
  claimGeneration: number;
  stage: NoteSettlementStage;
  sessionId: number;
  writableTurnIds: number[];
  scopeProvenance: SettlementChildScopeProvenanceWire | null;
  contextBuiltAtEpoch: number;
  windowStart: number;
  windowEnd: number;
}

/**
 * Everything the child needs to rebuild the run: the request above, plus the
 * three things the parent resolved from its own environment — where the
 * database file is (the child opens its OWN handle; SQLite here is already
 * multi-process, the hooks write concurrently), which directory the SDK
 * session runs in, and how long the child may live before it ends itself.
 */
export interface SettlementChildPayload {
  databasePath: string;
  dataRoot: string;
  defaultProject?: string;
  /** Peer gate 3: the child's hard runtime deadline, in milliseconds. */
  deadlineMs: number;
  request: SettlementChildRequestWire;
}

export type SettlementChildEnvelope =
  | { ok: true; result: NoteSettlementUnifiedQueryResult | NoteSettlementQueryResult }
  | { ok: false; message: string };

export function encodeSettlementChildRequest(
  request: NoteSettlementUnifiedQueryRequest | NoteSettlementQueryRequest,
  mode: SettlementChildMode,
): SettlementChildRequestWire {
  return {
    mode,
    prompt: request.prompt,
    systemPrompt: request.systemPrompt,
    model: request.model,
    maxThinkingTokens: request.maxThinkingTokens ?? null,
    jobId: request.jobId,
    claimGeneration: request.claimGeneration,
    stage: request.stage,
    sessionId: request.sessionId,
    writableTurnIds: [...request.writableTurnIds],
    scopeProvenance:
      request.scopeProvenance === undefined
        ? null
        : {
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
  const scopeProvenance: SettlementScopeProvenance =
    wire.scopeProvenance === null
      ? {
          window: new Set(wire.writableTurnIds),
          baseLookback: new Set<number>(),
          closureOnly: new Set<number>(),
        }
      : {
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

/**
 * The `edges` decode. Same fields, one difference that matters: an ABSENT
 * `scopeProvenance` must stay absent rather than being invented, because the
 * stage-2 query reads its optionality as "give this caller the old flat
 * refusal list" — and a synthesized bucket would file every finding under
 * `window`, which is a lie about where it anchors.
 */
export function decodeSettlementChildEdgesRequest(
  wire: SettlementChildRequestWire,
): NoteSettlementQueryRequest {
  const unified = decodeSettlementChildRequest(wire);
  const { scopeProvenance, ...rest } = unified;
  return wire.scopeProvenance === null ? rest : { ...rest, scopeProvenance };
}

export function formatSettlementChildEnvelope(
  envelope: SettlementChildEnvelope,
): string {
  return `${SETTLEMENT_CHILD_ENVELOPE_PREFIX}${JSON.stringify(envelope)}\n`;
}

// ---------------------------------------------------------------------------
// The envelope's schema (peer gate 5)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every numeric field a commit record carries (peer round 3, gate item 3):
 * the full `NoteSettlementCommitCounts` counter set plus `eraGranted`. The
 * `satisfies` clause is the completeness proof — add a counter to the record
 * type without listing it here and this file stops compiling, so the required
 * set can never silently fall behind the shape it validates.
 */
const REQUIRED_COMMIT_METRIC_NUMBER_FIELDS = Object.keys({
  turnsReviewed: true,
  reviewsYieldedToLateNote: true,
  proseWritten: true,
  relationsWritten: true,
  relationsRestated: true,
  relationsRetracted: true,
  sessionNarrativeWritten: true,
  lanesDeclared: true,
  lanesDeleted: true,
  lanesMerged: true,
  lanesJustified: true,
  eraGranted: true,
} satisfies Record<Exclude<keyof NoteSettlementCommitRecord, "report">, true>);

/**
 * A commit record is a bag of counters plus one required string. Validating
 * the counters' TYPES (not their values — this side has no business judging
 * a run's arithmetic) is what stops a half-serialized record from reaching
 * the metrics line as `undefined`s that read like zeroes.
 *
 * EVERY counter is REQUIRED (round 3: `{report:"x"}` used to pass, because
 * the counters were checked only if present — which is exactly the
 * half-serialized record this check exists to stop). Unknown keys stay
 * tolerated for forward compatibility, but if present they must be finite
 * numbers like everything else that is not the report.
 */
function validCommitMetrics(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (!isPlainObject(value)) {
    return false;
  }
  if (typeof value.report !== "string") {
    return false;
  }
  for (const key of REQUIRED_COMMIT_METRIC_NUMBER_FIELDS) {
    const field = value[key];
    if (typeof field !== "number" || !Number.isFinite(field)) {
      return false;
    }
  }
  for (const [key, field] of Object.entries(value)) {
    if (key === "report") {
      continue;
    }
    if (typeof field !== "number" || !Number.isFinite(field)) {
      return false;
    }
  }
  return true;
}

/**
 * REAL VALIDATION, not an `ok` probe (peer gate 5). The old check accepted
 * anything with an `ok` key, so a truncated or half-written result rode
 * through as a success whose fields were simply missing — `text` undefined,
 * `commitMetrics` undefined — and the dispatch then reported a settled window
 * from a run that never produced one. Mode-aware because the two runs differ
 * in exactly one field: only the unified run has a transition to report.
 */
export function validateSettlementChildEnvelope(
  value: unknown,
  mode: SettlementChildMode = "unified",
): SettlementChildEnvelope | null {
  if (!isPlainObject(value)) {
    return null;
  }
  if (value.ok === false) {
    return typeof value.message === "string"
      ? { ok: false, message: value.message }
      : null;
  }
  if (value.ok !== true) {
    return null;
  }
  const result = value.result;
  if (!isPlainObject(result)) {
    return null;
  }
  if (typeof result.text !== "string") {
    return null;
  }
  if (!validCommitMetrics(result.commitMetrics)) {
    return null;
  }
  if (
    result.laneCheckCalled !== undefined &&
    typeof result.laneCheckCalled !== "boolean"
  ) {
    return null;
  }
  if (mode === "unified" && typeof result.finalized !== "boolean") {
    return null;
  }
  return value as SettlementChildEnvelope;
}

/**
 * THE PARENT'S BOUNDED READER. Chatter is discarded as it arrives; only the
 * current partial line and the last MARKED line are ever retained, so the
 * worker's memory does not scale with how much the SDK decided to say.
 *
 * Overflow has two different meanings and they are not the same failure:
 *   - a MARKED line past the cap is a PROTOCOL overflow — the run is trying
 *     to hand back more than the boundary will carry, and the only honest
 *     answer is to kill it and fail the job;
 *   - an unmarked line past the cap is just a very long log line. It is
 *     dropped (and the rest of that line skipped) rather than promoted to a
 *     run failure, because the run itself is not the thing at fault.
 */
export interface SettlementChildStdoutScanner {
  push(chunk: string): void;
  /** Flushes a trailing unterminated line — a child killed mid-write. */
  finish(): void;
  /** The last complete marked line seen, envelope prefix included. */
  readonly envelopeLine: string | null;
  /** A MARKED line exceeded the cap. */
  readonly overflowed: boolean;
}

export function createSettlementChildStdoutScanner(
  maxLineChars: number = SETTLEMENT_CHILD_ENVELOPE_MAX_CHARS,
): SettlementChildStdoutScanner {
  let pending = "";
  let skipping = false;
  let envelopeLine: string | null = null;
  let overflowed = false;

  /**
   * The cap is enforced HERE as well as on the partial tail, and that is not
   * belt-and-braces — it is the only check that fires when a whole oversized
   * line arrives in ONE chunk, which is exactly what a pipe does for a
   * 200 KB write. Guarding only the tail made the overflow verdict depend on
   * how the kernel happened to split the stream: chunked, the run was killed;
   * unsplit, the parent accepted a line it had just declared too large, and —
   * because the child in question is by construction one that refuses to
   * leave — waited on `close` forever.
   */
  const takeLine = (line: string): void => {
    if (!line.startsWith(SETTLEMENT_CHILD_ENVELOPE_PREFIX)) {
      return;
    }
    if (line.length > maxLineChars) {
      overflowed = true;
      return;
    }
    envelopeLine = line;
  };

  const guardPending = (): void => {
    if (pending.length <= maxLineChars) {
      return;
    }
    if (pending.startsWith(SETTLEMENT_CHILD_ENVELOPE_PREFIX)) {
      overflowed = true;
      pending = "";
      skipping = true;
      return;
    }
    // Ordinary chatter. Drop it and ignore the remainder of the line.
    pending = "";
    skipping = true;
  };

  return {
    push(chunk: string): void {
      let rest = chunk;
      for (;;) {
        const newline = rest.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const segment = rest.slice(0, newline);
        rest = rest.slice(newline + 1);
        if (skipping) {
          skipping = false;
          pending = "";
          continue;
        }
        takeLine(pending + segment);
        pending = "";
      }
      if (skipping || rest === "") {
        return;
      }
      pending += rest;
      guardPending();
    },
    finish(): void {
      if (!skipping && pending !== "") {
        takeLine(pending);
      }
      pending = "";
    },
    get envelopeLine(): string | null {
      return envelopeLine;
    },
    get overflowed(): boolean {
      return overflowed;
    },
  };
}

/**
 * The LAST marked line wins: a child that printed an envelope and then said
 * more is still answering; a child that printed nothing marked never answered
 * at all, and `null` is what makes that a run failure rather than a silent
 * success. A marked line that does not VALIDATE is likewise no answer.
 */
export function parseSettlementChildEnvelope(
  stdout: string,
  mode: SettlementChildMode = "unified",
): SettlementChildEnvelope | null {
  const scanner = createSettlementChildStdoutScanner();
  scanner.push(stdout);
  scanner.finish();
  return parseSettlementChildEnvelopeLine(scanner.envelopeLine, mode);
}

export function parseSettlementChildEnvelopeLine(
  line: string | null,
  mode: SettlementChildMode = "unified",
): SettlementChildEnvelope | null {
  if (line === null) {
    return null;
  }
  try {
    return validateSettlementChildEnvelope(
      JSON.parse(line.slice(SETTLEMENT_CHILD_ENVELOPE_PREFIX.length)),
      mode,
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The parent side
// ---------------------------------------------------------------------------

/**
 * Where the shipped child entry lives, derived exactly the way
 * `worker/client.ts` derives the worker's own script paths — the plugin root
 * from `CLAUDE_PLUGIN_ROOT` when Claude Code supplies it, otherwise from this
 * file's own location.
 *
 * `CLAUDE_MNEMO_SETTLEMENT_CHILD` overrides the SCRIPT, and only the script.
 * It used to override the whole command shape, and that is precisely how the
 * shipped topology went untested for a round: every regression injected its
 * own `bun <script>` command, so 64 passing assertions proved that A child
 * process is killable and never that THE child process is.
 */
export function resolveSettlementChildScriptPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.CLAUDE_MNEMO_SETTLEMENT_CHILD;
  if (explicit && explicit.trim() !== "") {
    return explicit;
  }

  const currentDir = dirname(__filename);
  const pluginRoot =
    env.CLAUDE_PLUGIN_ROOT && env.CLAUDE_PLUGIN_ROOT.trim() !== ""
      ? env.CLAUDE_PLUGIN_ROOT
      : currentDir.endsWith("/plugin/scripts") ||
          currentDir.endsWith("\\plugin\\scripts")
        ? resolve(currentDir, "..")
        : resolve(currentDir, "..", "..", "plugin");

  return join(pluginRoot, "scripts", SETTLEMENT_CHILD_SCRIPT_NAME);
}

/**
 * THE SHIPPED COMMAND, and there is exactly one shape of it: this process's
 * own runtime, running the child bundle. The worker is already a Bun process
 * — `bun-runner.js` found Bun on the way in — so `process.execPath` IS Bun,
 * and re-running the discovery through a Node wrapper only bought an extra
 * PID for every signal to land on while the run itself lived one level down.
 *
 * ROUND 3: this is the ONE place in src that composes the command shape, and
 * the production runner below calls it rather than recomposing
 * `process.execPath + script` inline. The test seam rides INSIDE it as the
 * optional `scriptPath` — tests may vary WHICH script runs, never what runs
 * it. (A second `execPath` parameter used to sit here, passed by nobody;
 * deleted, because an unused command seam is exactly the shape the round-1
 * topology hole recurred through.)
 */
export function resolveSettlementChildCommand(
  env: NodeJS.ProcessEnv = process.env,
  scriptPath?: string,
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [scriptPath ?? resolveSettlementChildScriptPath(env)],
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
  /**
   * Test seam: which SCRIPT the real resolver runs. Never the command shape —
   * `process.execPath` is not negotiable, because it is the thing under test.
   */
  scriptPath?: string;
  env?: NodeJS.ProcessEnv;
  /** How long a `SIGTERM`ed child has before `SIGKILL`. */
  killGraceMs?: number;
  /** The child's own hard runtime deadline; crosses on the payload. */
  runtimeDeadlineMs?: number;
  /** Test seam: the parent's per-line stdout cap. */
  maxEnvelopeChars?: number;
  /** Test seam: how long after the forced kill the parent waits for `close`. */
  reapGraceMs?: number;
  /**
   * Test seam for the WIN32 KILL ROUTE ONLY: how the `taskkill` command is
   * executed. The POSIX path is never routed through this — `process.kill`
   * on the group is the production form and stays unmockable here, because
   * a whole-command seam on it is how the round-1 topology hole opened.
   */
  windowsTaskkillImpl?: SettlementChildTaskkillRunner;
  /**
   * Test seam paired with it: which platform's kill DISCIPLINE
   * `signalChildTree` uses. Lets the win32 command construction and its
   * completion wiring run under a POSIX test runner; the runtime behaviour
   * of `taskkill` itself is NOT verifiable off Windows and is not claimed.
   */
  killPlatform?: NodeJS.Platform;
}

interface ChildRunSpec {
  mode: SettlementChildMode;
  jobId: number;
  claimGeneration: number;
  signal?: AbortSignal;
  wire: SettlementChildRequestWire;
}

/**
 * How long the `taskkill` PROCESS itself may run before the runner gives up
 * on it (round 4 P1). `taskkill` is normally near-instant; a bound this wide
 * only ever fires on a wedged one — and a wedged taskkill must not become a
 * permanently pending settlement run, which is exactly what an unbounded
 * await on it was.
 */
export const SETTLEMENT_TASKKILL_TIMEOUT_MS = 10_000;

/** How much of a failed `taskkill`'s stderr is worth keeping — the tail. */
export const SETTLEMENT_TASKKILL_STDERR_TAIL_CHARS = 2_000;

/**
 * What a `taskkill` invocation actually PROVED (round 4 P1). Only exit code 0
 * is a successful tree walk; every other shape — a spawn that failed, a
 * nonzero exit, a run that outlived its own timeout — means the descendant
 * tree was NOT proven cleared, and the caller must say so rather than
 * spending "the command finished" as if it meant "the tree died".
 */
export type SettlementTaskkillResult =
  | { ok: true; exitCode: 0 }
  | {
      ok: false;
      kind: "spawn" | "exit" | "timeout";
      exitCode?: number;
      stderrTail?: string;
    };

/**
 * How a `taskkill` invocation is executed. SETTLES WITH A RESULT, never
 * rejects — the result protocol above is how failure travels, so the
 * escalation chain can both wait for the request AND read what it proved.
 */
export type SettlementChildTaskkillRunner = (
  command: string,
  args: string[],
) => Promise<SettlementTaskkillResult>;

export interface RunBoundedTaskkillOptions {
  /** Test seam: the process factory for the `taskkill` process itself. */
  spawnImpl?: typeof nodeSpawn;
  /** The independent bound on the `taskkill` process's own runtime. */
  timeoutMs?: number;
  /** The env snapshot the stderr sanitizer redacts against. */
  env?: NodeJS.ProcessEnv;
}

/**
 * THE ONE BOUNDED `taskkill` RUNNER (round 4 P1) — shared by the parent's
 * `signalChildTree` and the child's own `killOwnProcessGroup`, so there is
 * exactly one body of code deciding what a tree-walk request proved.
 *
 * Three properties, each the repair of a live failure shape:
 *
 *   - BOUNDED: the taskkill process gets its own timeout, and on timeout it
 *     is killed (a plain `SIGKILL` — taskkill has no descendants worth
 *     walking) and the result STILL settles. A hung taskkill used to leave
 *     the forced-stage promise pending forever, which left the RUN pending
 *     forever.
 *   - RESULTFUL: only `exitCode === 0` is a successful tree walk. A nonzero
 *     exit or failed spawn used to resolve indistinguishably from success,
 *     so the parent declared runs abandoned over unproven-dead descendants.
 *   - SANITIZED: the stderr tail is bounded and routed through the shared
 *     secret sanitizer before it can land in any result or log line.
 */
export function runBoundedTaskkill(
  command: string,
  args: string[],
  options: RunBoundedTaskkillOptions = {},
): Promise<SettlementTaskkillResult> {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? SETTLEMENT_TASKKILL_TIMEOUT_MS;
  const env = options.env ?? process.env;
  return new Promise((resolveResult) => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawnImpl(command, args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolveResult({
        ok: false,
        kind: "spawn",
        stderrTail: sanitizeSecretString(
          error instanceof Error ? error.message : String(error),
          env,
        ),
      });
      return;
    }

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-SETTLEMENT_TASKKILL_STDERR_TAIL_CHARS);
    });

    let settled = false;
    const settle = (result: SettlementTaskkillResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        child.stderr?.destroy();
      } catch {
        // Nothing left to close.
      }
      resolveResult(result);
    };
    const tail = (): { stderrTail?: string } => {
      const trimmed = stderr.trim();
      return trimmed === ""
        ? {}
        : { stderrTail: sanitizeSecretString(trimmed, env) };
    };

    // Deliberately NOT unref'd: this timer is the bound that makes the
    // result a promise the run may safely wait on.
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone; the settle below is the verdict either way.
      }
      settle({ ok: false, kind: "timeout", ...tail() });
    }, timeoutMs);

    child.on("error", (error: Error) => {
      settle({
        ok: false,
        kind: "spawn",
        stderrTail: sanitizeSecretString(error.message, env),
      });
    });
    child.on("close", (code: number | null, signal: string | null) => {
      if (code === 0 && signal === null) {
        settle({ ok: true, exitCode: 0 });
        return;
      }
      settle({
        ok: false,
        kind: "exit",
        ...(code === null ? {} : { exitCode: code }),
        ...tail(),
      });
    });
  });
}

/**
 * THE WIN32 TREE-TERMINATION COMMAND (peer round 3 P1, user-ruled:
 * S15069/T2193). Windows has no POSIX process groups, so `kill(-pid)` has no
 * equivalent and a bare `child.kill()` reaches exactly one process — the
 * direct Bun child — while the `claude` CLI descendant survives every
 * verdict. `taskkill /T` is the OS's own tree walk: TERM stage asks the tree
 * to close, `/F` at the forced stage terminates it outright.
 *
 * A pure builder, exported so the command CONSTRUCTION is testable on any
 * platform. The runtime behaviour of `taskkill` itself is UNVERIFIED off
 * Windows and no green suite on this machine claims otherwise.
 */
export function buildSettlementChildTaskkillCommand(
  pid: number,
  stage: "term" | "kill",
): { command: string; args: string[] } {
  const args = ["/PID", String(pid), "/T"];
  if (stage === "kill") {
    args.push("/F");
  }
  return { command: "taskkill", args };
}

interface SignalChildTreeOptions {
  logger: NoteSettlementDispatchLogger;
  platform: NodeJS.Platform;
  taskkillImpl: SettlementChildTaskkillRunner;
}

/**
 * Sends `signal` to the child's whole PROCESS TREE: the group on POSIX, a
 * `taskkill /T` walk on Windows. Resolves when the termination REQUEST has
 * completed — instantaneous on POSIX, the `taskkill` runner's own bounded
 * settle on win32 — which is what lets the caller fold that completion into
 * the run's promise instead of racing it. On win32 the runner's RESULT is
 * consumed here: anything but exit 0 is logged as a containment failure
 * (round 4 P1), because a completed kill command is not a cleared tree.
 *
 * POSIX: the negative pid is the entire point. `detached: true` made the
 * child a session/group leader (`setsid`), so the `claude` CLI it spawns is
 * in that group too — and `process.kill(-pid)` is the only call that reaches
 * both. The failure split (round 3 P2a):
 *
 *   - `ESRCH`: the group is already gone. DONE — never fall through to the
 *     bare pid, which the kernel may since have handed to a stranger;
 *   - anything else (`EPERM` above all): the group may still be alive and
 *     this process could not signal it. That is a CONTAINMENT FAILURE — the
 *     group was not proven cleared — so it is logged as one, and the single
 *     direct child gets a best-effort kill, which is less than the guarantee
 *     but more than nothing.
 */
export function signalChildTree(
  child: { pid?: number; kill(signal: NodeJS.Signals): boolean },
  signal: NodeJS.Signals,
  options: SignalChildTreeOptions,
): Promise<void> {
  const pid = child.pid;
  if (options.platform === "win32") {
    if (typeof pid === "number" && pid > 0) {
      const { command, args } = buildSettlementChildTaskkillCommand(
        pid,
        signal === "SIGKILL" ? "kill" : "term",
      );
      // ROUND 4 P1: the RESULT is consumed, not discarded. A completed kill
      // COMMAND is never logged as a cleared TREE — only exit 0 proved the
      // walk, and every other shape is a containment failure by name.
      return options.taskkillImpl(command, args).then((result) => {
        if (result.ok) {
          return;
        }
        options.logger.warn(
          `${SETTLEMENT_CHILD_LOG_PREFIX} taskkill did not prove the tree cleared — containment failure, the descendant tree was not proven cleared`,
          JSON.stringify({
            pid,
            signal,
            kind: result.kind,
            exitCode: result.exitCode ?? null,
            stderrTail: result.stderrTail ?? null,
          }),
        );
        // Best effort, and honestly less than the guarantee: one process,
        // not the tree.
        try {
          child.kill(signal);
        } catch {
          // Already gone; the exit handler is what settles the run either way.
        }
      });
    }
    // No pid to walk a tree from — the spawn itself failed. Best effort.
    try {
      child.kill(signal);
    } catch {
      // Already gone; the exit handler is what settles the run either way.
    }
    return Promise.resolve();
  }
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, signal);
      return Promise.resolve();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // The whole group is already gone. Do NOT signal the bare pid: it
        // may have been reused, and a stray signal to a stranger is worse
        // than trusting the exit handler that is already armed.
        return Promise.resolve();
      }
      options.logger.warn(
        `${SETTLEMENT_CHILD_LOG_PREFIX} could not signal the child's process group — containment failure, the group was not proven cleared`,
        JSON.stringify({ pid, signal, code: code ?? null }),
      );
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone; the exit handler is what settles the run either way.
  }
  return Promise.resolve();
}

/**
 * THE ONE RUNNER both public seams share. Everything peer round 2 asked for
 * lives here once — the real resolver, the detached spawn, the group kill,
 * the liveness pipe, the bounded reader, the strict success predicate — so
 * the cold-resume path cannot drift away from the unified path's guarantees
 * by being wired somewhere else.
 */
function runSettlementChildProcess(
  options: CreateChildProcessNoteSettlementQueryOptions,
  spec: ChildRunSpec,
): Promise<NoteSettlementUnifiedQueryResult & NoteSettlementQueryResult> {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const logger = options.logger ?? console;
  const killGraceMs = options.killGraceMs ?? SETTLEMENT_CHILD_KILL_GRACE_MS;
  const reapGraceMs = options.reapGraceMs ?? SETTLEMENT_CHILD_REAP_GRACE_MS;
  const deadlineMs =
    options.runtimeDeadlineMs ?? SETTLEMENT_CHILD_RUNTIME_DEADLINE_MS;
  const env = options.env ?? process.env;
  const signalOptions: SignalChildTreeOptions = {
    logger,
    platform: options.killPlatform ?? process.platform,
    taskkillImpl:
      options.windowsTaskkillImpl ??
      ((command, args) => runBoundedTaskkill(command, args, { env })),
  };

  return new Promise((resolvePromise, rejectPromise) => {
    if (options.databasePath === "" || options.databasePath === ":memory:") {
      rejectPromise(
        new Error(
          "note settlement child cannot run against an in-memory database — no file for the child to open",
        ),
      );
      return;
    }

    // THE ONE COMPOSER (round 3, item 2): the production spawn goes through
    // the same resolver the release guard asserts on. Tests inject the
    // SCRIPT; the command shape is not theirs to vary.
    const { command, args } = resolveSettlementChildCommand(
      env,
      options.scriptPath,
    );

    let child;
    try {
      child = spawnImpl(command, args, {
        cwd: options.dataRoot,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // PEER GATE 2. On POSIX this makes the child a process-group leader,
        // which is what gives `signalChildTree` a group to signal. On Windows
        // it would mean "survive the parent's console", which is the opposite
        // of what is wanted, so it is POSIX-only and explicitly branched.
        detached: process.platform !== "win32",
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

    const scanner = createSettlementChildStdoutScanner(
      options.maxEnvelopeChars ?? SETTLEMENT_CHILD_ENVELOPE_MAX_CHARS,
    );
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let reapTimer: ReturnType<typeof setTimeout> | null = null;
    let terminationStarted = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let abortListener: (() => void) | null = null;
    let overflowKilled = false;
    /**
     * ROUND 4 P2 (PID-reuse window): whether the ROOT process has exited.
     * `exit` fires before `close` whenever descendants still hold the pipes —
     * and from that moment the child's numeric pid is the kernel's to hand to
     * a stranger, so the delayed forced `taskkill /T /F` must never fire at
     * it again.
     */
    let rootExited = false;

    const cleanup = (): void => {
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (reapTimer !== null) {
        clearTimeout(reapTimer);
        reapTimer = null;
      }
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      if (abortListener !== null) {
        spec.signal?.removeEventListener("abort", abortListener);
        abortListener = null;
      }
      // Release every handle this run held on the child. The child is dead or
      // dying by every path that reaches here, and a retained pipe — stdin
      // above all, which is deliberately left open as the liveness channel —
      // would keep the worker's own event loop referencing a corpse.
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        try {
          stream?.destroy();
        } catch {
          // Nothing left to close.
        }
      }
      try {
        child.unref?.();
      } catch {
        // Already reaped.
      }
    };

    /**
     * THE LAST RESORT: settle without `close`. Reached only when a child has
     * been `SIGKILL`ed and the runtime still has not reported the streams
     * finished — see `SETTLEMENT_CHILD_REAP_GRACE_MS`. The run FAILS (a
     * process this uncooperative has told us nothing trustworthy), and the
     * dispatch gets its verdict, which is the property that matters: the
     * drain never waits on a corpse.
     */
    const settleUnreaped = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      logger.error(
        `${SETTLEMENT_CHILD_LOG_PREFIX} did not report an exit before the reap deadline`,
        JSON.stringify({
          jobId: spec.jobId,
          claimGeneration: spec.claimGeneration,
          pid: child.pid ?? null,
          stderrTail: sanitizeSecretString(stderr, env),
        }),
      );
      rejectPromise(
        new Error(
          "note settlement child did not report an exit before the reap deadline — the run was abandoned",
        ),
      );
    };

    // THE LOSS VERDICT'S DELIVERY. The TERM stage to the whole TREE first —
    // the SDK session gets its chance to tear its own `claude` grandchild
    // down — then the forced stage once the grace has passed.
    //
    // These timers are deliberately NOT `unref`ed. Round 1 unref'd the
    // escalation, which reads as prudence and is the opposite: it says "skip
    // the SIGKILL if nothing else happens to be keeping the loop awake",
    // and the SIGKILL is the one step that makes a wedged run terminable.
    // They cannot outlive the run instead, because every settle path clears
    // them, and every path settles.
    //
    // COMPLETION IS FOLDED INTO THE RUN'S PROMISE (round 3 P1): on win32 a
    // termination is a `taskkill` PROCESS, not an instantaneous syscall, so
    // the reap clock — the one path that can settle this run without a
    // `close` — does not start until the forced-stage request has actually
    // completed. Racing it would let the run be declared abandoned while its
    // own kill was still in flight.
    //
    // ROUND 4 P1: the reap clock starts in a `finally` — success, failure or
    // the runner's own timeout, the forced stage now ALWAYS hands off to the
    // reap clock, so the parent promise is bounded even when taskkill wedges.
    // The runner itself settles by contract, and this is the belt on that.
    const startReapClock = (): void => {
      if (settled || reapTimer !== null) {
        return;
      }
      reapTimer = setTimeout(settleUnreaped, reapGraceMs);
    };
    /**
     * Refuses a taskkill strike at a pid whose root is already known dead
     * (win32 only — a POSIX group id has no equivalent
     * reuse-through-`close` window). ROUND 5 P1 widened this from the
     * delayed forced strike to BOTH stages: the guard's whole argument is
     * "the code holds `rootExited === true` and must not aim at a numeric
     * pid the kernel may have reused" — and that argument never mentioned
     * which stage was firing. A loss verdict that arrives after the root
     * died (SDK debris kills the root, a descendant holds the pipes, the
     * monitor ticks) used to send the initial `/T` at the stale pid.
     */
    const refusedAsStalePid = (stage: "initial" | "forced-stage"): boolean => {
      if (!rootExited || signalOptions.platform !== "win32") {
        return false;
      }
      logger.warn(
        `${SETTLEMENT_CHILD_LOG_PREFIX} root already exited; descendant tree not provable-clearable by PID-root taskkill; possible pid reuse — containment failure, the ${stage} taskkill was not sent`,
        JSON.stringify({
          jobId: spec.jobId,
          claimGeneration: spec.claimGeneration,
          pid: child.pid ?? null,
        }),
      );
      startReapClock();
      return true;
    };
    const killChild = (): void => {
      // `terminationStarted`, not `killTimer !== null`: the timer empties
      // itself when the forced stage begins, so a second verdict (overflow
      // after a deadline, deadline after an abort) used to re-enter here and
      // start a duplicate TERM/forced chain while the first was in flight
      // (round 5 P2).
      if (settled || terminationStarted) {
        return;
      }
      terminationStarted = true;
      if (refusedAsStalePid("initial")) {
        return;
      }
      void signalChildTree(child, "SIGTERM", signalOptions).catch(() => {
        // `signalChildTree` settles by contract; this only insulates the
        // fire-and-forget TERM from an injected runner that breaks it.
      });
      killTimer = setTimeout(() => {
        killTimer = null;
        // Checked again, not redundantly: the root may die BETWEEN the TERM
        // that legitimately went out and this delayed strike.
        if (refusedAsStalePid("forced-stage")) {
          return;
        }
        void signalChildTree(child, "SIGKILL", signalOptions)
          .catch(() => {
            // `signalChildTree` settles by contract; this only insulates the
            // `finally` handoff from an injected runner that breaks it.
          })
          .finally(startReapClock);
      }, killGraceMs);
    };

    if (spec.signal) {
      if (spec.signal.aborted) {
        killChild();
      } else {
        abortListener = killChild;
        spec.signal.addEventListener("abort", abortListener, { once: true });
      }
    }

    // THE PARENT'S OWN COPY OF THE DEADLINE. The child is told how long it
    // may live and ends its own group when that runs out (gate 3) — but a
    // parent that only TRUSTS that has made its own termination guarantee
    // conditional on the health of the process it is guarding against. So
    // the same bound is enforced from this side too, one kill grace later so
    // the child's own, better-informed exit always gets to go first.
    deadlineTimer = setTimeout(killChild, deadlineMs + killGraceMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      scanner.push(chunk);
      if (scanner.overflowed && !overflowKilled) {
        overflowKilled = true;
        killChild();
      }
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
      deadlineMs,
      request: spec.wire,
    };
    // A child that died before reading its request turns a stdin write into
    // EPIPE; the exit handler already owns that story, so this only has to
    // not throw out of the constructor.
    child.stdin?.on("error", () => {});
    try {
      // PEER GATE 3: written, NOT ended. This pipe is the liveness channel —
      // one newline-terminated payload line, then it stays open for the
      // child's whole life, and EOF on it is how the child learns the worker
      // died. Closing it here would fire that EOF immediately.
      child.stdin?.write(`${JSON.stringify(payload)}\n`);
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
        JSON.stringify({ jobId: spec.jobId, error: error.message }),
      );
      rejectPromise(
        new Error(`note settlement child failed to start: ${error.message}`),
      );
    });

    // ROUND 4 P2: `exit` is the ROOT's death, `close` is the STREAMS'. They
    // differ exactly when a descendant holds the inherited pipes — the window
    // in which the child's numeric pid can be reused. Recording the root's
    // exit is what lets the delayed forced-stage taskkill above refuse to
    // fire at a stale pid.
    child.on("exit", () => {
      rootExited = true;
    });

    child.on("close", (code: number | null, signal: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      scanner.finish();
      const envelope = parseSettlementChildEnvelopeLine(
        scanner.envelopeLine,
        spec.mode,
      );
      // PEER GATE 4: SUCCESS IS A CONJUNCTION. A parsed envelope used to be
      // enough on its own, so a child that answered and then crashed — or
      // was SIGKILLed mid-teardown after its own claim had already been
      // reclaimed — resolved as a clean run. The exit itself is now part of
      // the verdict, and an envelope from a non-clean exit is demoted to
      // diagnostics.
      const cleanExit = code === 0 && signal === null;
      const ok = cleanExit && envelope !== null && envelope.ok;

      if (!ok) {
        // THE PARENT-SIDE OBSERVABILITY PRINCIPLE (peer's, ticket 02):
        // the silent death of a RUN is no longer possible. Exit code,
        // signal and the stderr tail land in the worker's own log — the
        // worker's stderr is discarded at the plugin spawn layer
        // (`worker/client.ts` spawns it `stdio: "ignore"`), which is why
        // this has to be a log call and not a re-print.
        //
        // P2: the tail goes through the SHARED secret sanitizer before it is
        // persisted. A dying SDK session's stderr can carry an API key out of
        // an env echo or a request header, and this log line outlives the run.
        logger.error(
          `${SETTLEMENT_CHILD_LOG_PREFIX} exited without a clean result`,
          JSON.stringify({
            jobId: spec.jobId,
            claimGeneration: spec.claimGeneration,
            exitCode: code,
            signal,
            // P2c: a REQUEST, not an assertion of what ended the child — a
            // clean self-exit can win the race against the kill, and the
            // observed exitCode/signal beside this is the only honest record
            // of what actually did.
            ...(overflowKilled ? { terminationRequested: true } : {}),
            envelope:
              envelope === null
                ? scanner.overflowed
                  ? "oversized"
                  : "missing"
                : envelope.ok
                  ? "discarded"
                  : "failed",
            stderrTail: sanitizeSecretString(
              stderr.slice(-SETTLEMENT_CHILD_STDERR_TAIL_CHARS),
              env,
            ),
          }),
        );
      }

      if (ok && envelope !== null && envelope.ok) {
        resolvePromise(
          envelope.result as NoteSettlementUnifiedQueryResult &
            NoteSettlementQueryResult,
        );
        return;
      }

      if (cleanExit && envelope !== null && !envelope.ok) {
        rejectPromise(new Error(envelope.message));
        return;
      }

      const exitStory =
        signal === null ? `with code ${code}` : `on ${signal}`;
      const tail = sanitizeSecretString(stderr.trim(), env);
      if (scanner.overflowed) {
        // P2c: termination was REQUESTED — whether the kill or the child's
        // own exit ended it is exactly what `exitStory` reports, and this
        // message must not assert the race's winner.
        rejectPromise(
          new Error(
            `note settlement child result envelope exceeded ${
              options.maxEnvelopeChars ?? SETTLEMENT_CHILD_ENVELOPE_MAX_CHARS
            } characters — termination was requested (exited ${exitStory})`,
          ),
        );
        return;
      }
      if (envelope !== null) {
        // An envelope DID arrive, and the exit refuted it.
        rejectPromise(
          new Error(
            `note settlement child exited ${exitStory} after its result envelope — the envelope is not trusted${
              envelope.ok ? "" : `: ${envelope.message}`
            }`,
          ),
        );
        return;
      }
      rejectPromise(
        new Error(
          `note settlement child exited ${exitStory} without a result envelope${
            tail === "" ? "" : `: ${tail}`
          }`,
        ),
      );
    });
  });
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
  return (request) =>
    runSettlementChildProcess(options, {
      mode: "unified",
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      wire: encodeSettlementChildRequest(request, "unified"),
    });
}

/**
 * THE COLD-RESUME `runQuery` (peer gate 6). Stage 2 is reached only by
 * reclaiming a job whose previous claim died between the transition and the
 * terminal commit — which is to say the path taken by a run that has ALREADY
 * demonstrated it can end a process badly. It ran in the worker until now;
 * the peer's judgement, adopted here, is that the recovery path is the one
 * that needs the boundary most, not the one that can wait for a follow-up.
 */
export function createChildProcessNoteSettlementEdgesQuery(
  options: CreateChildProcessNoteSettlementQueryOptions,
): NoteSettlementQuery {
  return (request) =>
    runSettlementChildProcess(options, {
      mode: "edges",
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      wire: encodeSettlementChildRequest(request, "edges"),
    });
}
