import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { normalizeEraCutoffEpoch } from "../segment-era";

export interface MnemoConfig {
  /**
   * The worker's one idleness clock (USER RULING S15069/T2083, staged-
   * settlement spec Rev 5 "One idleness clock"). `busy` = any active HTTP
   * request OR any tracked drain/settlement/dream work genuinely live; a
   * busy worker never exits, however long the work runs. A full quiet
   * stretch of this length from the moment the LAST busy token released
   * triggers a bounded shutdown (graceful cleanup with a forced-exit
   * fallback). The worker never asks whether any content session is still
   * registered — RETIRED: the 70-second "all registered sessions closed"
   * hard-exit and the separate 30-minute idle-HTTP-only shutdown; both
   * clocks fold into this one.
   */
  workerIdleShutdownMs: number;
  /**
   * Kill switch for P2 note settlement (spec D9, ticket 14). It is NOT what
   * turns settlement on — `eraCutoffEpoch` is. Settling a legacy turn is
   * meaningless (its record was written by the extraction agent, not by the turn
   * itself), so a null cutoff leaves settlement inert whatever this says. What
   * this flag buys is the other direction: stopping settlement while the era
   * stays up, without touching anything the note write path does.
   *
   * False = no job row is written, nothing is claimed, nothing is dispatched,
   * and the note-debt ledger is never transitioned by this path.
   */
  settlementEnabled: boolean;
  /**
   * P2 era boundary (spec D11/D12), and the single cutover switch. A turn
   * created at or after this epoch has the main agent's note as its official
   * record, renders through the segment spine, and is settled; everything
   * earlier keeps the legacy arrangement, in the same session view. `null` — the
   * product default — means every turn is legacy, so both the segment read path
   * and settlement are inert until an operator sets an epoch. Setting it back to
   * null is the rollback.
   */
  eraCutoffEpoch: number | null;
  /**
   * Master switch for the whole nightly dream chain. When false, no entry point
   * (end-event backlog reconcile, queue drain and its retries, manual
   * `POST /dream`) enqueues or runs dream work. Reading the last generated
   * diary/persona documents is unaffected — injection keeps serving them.
   */
  dreamAgentEnabled: boolean;
  /** Model used by the merged nightly dream agent. */
  dreamAgentModel: DreamAgentModel;
  /** Same as `noteSettlementMaxThinkingTokens`, for the nightly dream agent's SDK query. */
  dreamAgentMaxThinkingTokens: number | null;
  /** Total wall-clock timeout for one merged nightly dream-agent request. */
  dreamAgentTimeoutMs: number;
  /** Idle watchdog: abort a dream request after this long with no streamed activity. */
  dreamAgentIdleWatchdogMs: number;
  /** Local wall-clock hour after which SessionStart may enqueue dream work. */
  dreamAgentHour: number;
  /** IANA timezone used for dream calendar dates and the trigger hour. */
  dreamAgentTimeZone: string;
  /**
   * How many of the most-recent due days one reconcile auto-enqueues; older due
   * days are demoted to terminal (manual-only). Default 1 = just the latest.
   */
  dreamAgentBacklogLimit: number;
  /** Model for P2 note settlement's single stateless call (spec D9, 裁决 10). */
  noteSettlementModel: DreamAgentModel;
  /**
   * Thinking-token budget for the settlement agent's SDK query (ruling
   * S15069/T1433-T1435). A positive integer is passed through as the
   * Claude Agent SDK's own `maxThinkingTokens` query option (verified
   * against the installed SDK's `Options.maxThinkingTokens` — same
   * spelling). `null` — the default — omits the option entirely, so an
   * unconfigured install gets the model's own default and changes nothing.
   * (Package name deliberately not spelled out here: a static reachability
   * check treats any literal mention of it in a file reachable from
   * `worker/server.ts` as an SDK import — see
   * tests/worker/server.note-settlement-triggers.test.ts's
   * `sdkImportsReachableFromWorkerCore`.)
   */
  noteSettlementMaxThinkingTokens: number | null;
  /**
   * Decided turns that must accumulate before turn-stop planning cuts a window
   * (db/note-settlement.ts's `NOTE_SETTLEMENT_WINDOW_THRESHOLD_TURNS` re-export
   * carries the sizing reasoning; this is the config seam over the same
   * number, ticket 02). Default 50 (`DEFAULT_NOTE_SETTLEMENT_THRESHOLD_TURNS`
   * below) — retired history: an earlier fixed threshold was 25, hence the
   * "consecutive 阈值 25→50" phrasing in edge-mechanism-revision spec D6.
   */
  noteSettlementThresholdTurns: number;
  /**
   * Per-run cap on one window's turn count. Coherence-checked against
   * `noteSettlementThresholdTurns` after clamping: a cap below the threshold is
   * incoherent (a window could never reach it), so it is raised to match.
   */
  noteSettlementCapTurns: number;
  /**
   * Hard ceiling on one manual `/settle` backfill window (db/note-settlement.ts).
   * A wider request is refused outright, never silently clamped.
   */
  noteSettlementBackfillMaxTurns: number;
}

export const KNOWN_DREAM_AGENT_MODELS = [
  "opus",
  "sonnet",
  "haiku",
  "claude-opus-4-8",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

export type DreamAgentModel = (typeof KNOWN_DREAM_AGENT_MODELS)[number];

export const DEFAULT_DREAM_AGENT_MODEL: DreamAgentModel = "opus";
export const DEFAULT_DREAM_AGENT_TIME_ZONE = "Asia/Shanghai";
// A real Sonnet 5 dream run exceeded the old ten-minute ceiling after doing
// several recall/Grep pulls and committing all nightly documents. Thirty
// minutes leaves 3x measured headroom while retaining a finite fail-safe.
export const DEFAULT_DREAM_AGENT_TIMEOUT_MS = 30 * 60 * 1_000;
// opus produces long silent reasoning bursts between tool calls (a 286s gap was
// observed), which the old hard-wired 120s idle watchdog killed before commit.
// Ten minutes clears the observed gap while staying under the request timeout.
export const DEFAULT_DREAM_AGENT_IDLE_WATCHDOG_MS = 10 * 60 * 1_000;
// Dream retries are event-driven; this is only a small floor that prevents two
// closely spaced turn-stop drains from launching full dream runs back-to-back.
export const DREAM_RETRY_BACKOFF_MS = 10_000;
// Local wall-clock hour that serves as BOTH the dream trigger hour and the
// content-day boundary: a turn before this hour belongs to the previous day's
// diary (late-night work rolls back), and day D's dream fires at D+1 this hour.
// One knob keeps "content day closes exactly when its dream triggers" true.
export const DEFAULT_DREAM_AGENT_HOUR = 4;
// One idleness clock (USER RULING S15069/T2083): a full quiet hour from the
// last busy-token release triggers the bounded shutdown. Replaces the retired
// 70-second all-sessions-closed hard-exit AND the retired 30-minute
// idle-HTTP-only shutdown — both clocks fold into this single one.
export const DEFAULT_WORKER_IDLE_SHUTDOWN_MS = 60 * 60 * 1_000;

// Settlement's own three thresholds (ticket 02, [S15069/T1017]): one home per
// number, re-exported from db/note-settlement.ts and worker/note-settlement-
// dispatch.ts so every existing import path stays valid.
export const DEFAULT_NOTE_SETTLEMENT_MODEL: DreamAgentModel = "claude-sonnet-5";
// Edge-mechanism-revision D6 (ticket 04): 25 -> 50. Settlement is a hindsight
// pass over arcs, and an arc rarely fits in 25 turns — the window has to be at
// least as wide as the thing it is asked to connect. This is the ONLY
// settlement trigger with a threshold at all; compact/residual/sessionend/
// backfill stay event-driven, unchanged.
export const DEFAULT_NOTE_SETTLEMENT_THRESHOLD_TURNS = 50;
export const DEFAULT_NOTE_SETTLEMENT_CAP_TURNS = 50;
export const DEFAULT_NOTE_SETTLEMENT_BACKFILL_MAX_TURNS = 100;

export const DEFAULT_CONFIG: MnemoConfig = {
  workerIdleShutdownMs: DEFAULT_WORKER_IDLE_SHUTDOWN_MS,
  // On by default because it is a kill switch, not the cutover switch: with no
  // era cutoff configured this changes nothing at all.
  settlementEnabled: true,
  eraCutoffEpoch: null,
  dreamAgentEnabled: false,
  dreamAgentModel: DEFAULT_DREAM_AGENT_MODEL,
  dreamAgentMaxThinkingTokens: null,
  dreamAgentTimeoutMs: DEFAULT_DREAM_AGENT_TIMEOUT_MS,
  dreamAgentIdleWatchdogMs: DEFAULT_DREAM_AGENT_IDLE_WATCHDOG_MS,
  dreamAgentHour: DEFAULT_DREAM_AGENT_HOUR,
  dreamAgentTimeZone: DEFAULT_DREAM_AGENT_TIME_ZONE,
  dreamAgentBacklogLimit: 1,
  noteSettlementModel: DEFAULT_NOTE_SETTLEMENT_MODEL,
  noteSettlementMaxThinkingTokens: null,
  noteSettlementThresholdTurns: DEFAULT_NOTE_SETTLEMENT_THRESHOLD_TURNS,
  noteSettlementCapTurns: DEFAULT_NOTE_SETTLEMENT_CAP_TURNS,
  noteSettlementBackfillMaxTurns: DEFAULT_NOTE_SETTLEMENT_BACKFILL_MAX_TURNS,
};

export function resolveConfigPath(homePath = homedir()): string {
  return join(homePath, ".claude-mnemo", "config.json");
}

interface ConfigWarningLogger {
  warn(message: string): void;
}

/**
 * Shared by both model fields (ticket 02): `dreamAgentModel` and
 * `noteSettlementModel` draw from the same `KNOWN_DREAM_AGENT_MODELS`
 * vocabulary, so one resolver — named by the field it is resolving, for a
 * warning that points at the right key — replaces the two that would
 * otherwise drift apart.
 */
function resolveAgentModel(
  fieldName: string,
  value: unknown,
  fallback: DreamAgentModel,
  logger: ConfigWarningLogger,
): DreamAgentModel {
  if (
    typeof value === "string" &&
    (KNOWN_DREAM_AGENT_MODELS as readonly string[]).includes(value)
  ) {
    return value as DreamAgentModel;
  }

  logger.warn(
    `[claude-mnemo] Invalid ${fieldName} ${JSON.stringify(value)}; using ${fallback}.`,
  );
  return fallback;
}

/**
 * Shared by both thinking-budget fields (ticket 01): `dreamAgentMaxThinkingTokens`
 * and `noteSettlementMaxThinkingTokens` are positive-integer-or-null with the
 * SAME "absent or null omits the SDK option" semantics, so one resolver
 * replaces the two that would otherwise drift apart. Unlike `resolveAgentModel`,
 * an absent or explicit `null` value is not itself invalid — it is the
 * documented default — so only a value that is present and wrong (non-integer,
 * zero, negative, a string, ...) warns.
 */
function resolveMaxThinkingTokens(
  fieldName: string,
  value: unknown,
  logger: ConfigWarningLogger,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  logger.warn(
    `[claude-mnemo] Invalid ${fieldName} ${JSON.stringify(value)}; using null.`,
  );
  return null;
}

function resolveDreamAgentTimeZone(
  value: unknown,
  logger: ConfigWarningLogger,
): string {
  if (typeof value === "string") {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
      return value;
    } catch {
      // Fall through to the stable product default and warn below.
    }
  }

  logger.warn(
    `[claude-mnemo] Invalid dreamAgentTimeZone ${JSON.stringify(value)}; using ${DEFAULT_DREAM_AGENT_TIME_ZONE}.`,
  );
  return DEFAULT_DREAM_AGENT_TIME_ZONE;
}

// A hand-written config can carry "true" or 1; only a real boolean flips a
// switch, so junk keeps the safer default rather than becoming truthy.
function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

function clampConfig(
  config: MnemoConfig,
  rawDreamAgentModel: unknown,
  rawDreamAgentTimeZone: unknown,
  rawNoteSettlementModel: unknown,
  logger: ConfigWarningLogger,
): MnemoConfig {
  // Clamped independently, then reconciled: a cap clamped below an
  // independently-clamped threshold is incoherent (a window could never reach
  // its own cap), so the cap is raised to match rather than left to silently
  // under-cut the threshold it is supposed to bound.
  const noteSettlementThresholdTurns = clampInteger(
    config.noteSettlementThresholdTurns,
    1,
    500,
    DEFAULT_CONFIG.noteSettlementThresholdTurns,
  );
  let noteSettlementCapTurns = clampInteger(
    config.noteSettlementCapTurns,
    1,
    500,
    DEFAULT_CONFIG.noteSettlementCapTurns,
  );
  if (noteSettlementCapTurns < noteSettlementThresholdTurns) {
    logger.warn(
      `[claude-mnemo] noteSettlementCapTurns (${noteSettlementCapTurns}) is below noteSettlementThresholdTurns (${noteSettlementThresholdTurns}); raising the cap to match.`,
    );
    noteSettlementCapTurns = noteSettlementThresholdTurns;
  }

  return {
    workerIdleShutdownMs: clampInteger(
      config.workerIdleShutdownMs,
      60_000,
      86_400_000,
      DEFAULT_CONFIG.workerIdleShutdownMs,
    ),
    settlementEnabled: resolveBoolean(
      config.settlementEnabled,
      DEFAULT_CONFIG.settlementEnabled,
    ),
    // Anything that is not a positive whole epoch reads as "no era yet" rather
    // than as an epoch of 0, which would put every turn on the new path.
    eraCutoffEpoch: normalizeEraCutoffEpoch(config.eraCutoffEpoch),
    dreamAgentEnabled: resolveBoolean(
      config.dreamAgentEnabled,
      DEFAULT_CONFIG.dreamAgentEnabled,
    ),
    dreamAgentModel: resolveAgentModel(
      "dreamAgentModel",
      rawDreamAgentModel,
      DEFAULT_DREAM_AGENT_MODEL,
      logger,
    ),
    dreamAgentMaxThinkingTokens: resolveMaxThinkingTokens(
      "dreamAgentMaxThinkingTokens",
      config.dreamAgentMaxThinkingTokens,
      logger,
    ),
    dreamAgentTimeoutMs: clampInteger(
      config.dreamAgentTimeoutMs,
      60_000,
      86_400_000,
      DEFAULT_CONFIG.dreamAgentTimeoutMs,
    ),
    dreamAgentIdleWatchdogMs: clampInteger(
      config.dreamAgentIdleWatchdogMs,
      30_000,
      3_600_000,
      DEFAULT_CONFIG.dreamAgentIdleWatchdogMs,
    ),
    dreamAgentHour: clampInteger(
      config.dreamAgentHour,
      0,
      23,
      DEFAULT_CONFIG.dreamAgentHour,
    ),
    dreamAgentTimeZone: resolveDreamAgentTimeZone(
      rawDreamAgentTimeZone,
      logger,
    ),
    dreamAgentBacklogLimit: clampInteger(
      config.dreamAgentBacklogLimit,
      1,
      366,
      DEFAULT_CONFIG.dreamAgentBacklogLimit,
    ),
    noteSettlementModel: resolveAgentModel(
      "noteSettlementModel",
      rawNoteSettlementModel,
      DEFAULT_NOTE_SETTLEMENT_MODEL,
      logger,
    ),
    noteSettlementMaxThinkingTokens: resolveMaxThinkingTokens(
      "noteSettlementMaxThinkingTokens",
      config.noteSettlementMaxThinkingTokens,
      logger,
    ),
    noteSettlementThresholdTurns,
    noteSettlementCapTurns,
    noteSettlementBackfillMaxTurns: clampInteger(
      config.noteSettlementBackfillMaxTurns,
      1,
      10_000,
      DEFAULT_CONFIG.noteSettlementBackfillMaxTurns,
    ),
  };
}

/**
 * The P2 era boundary as configured, for the callers that hold no config of
 * their own — tool handlers, hook handlers, settlement entry points. It never
 * throws: a config that cannot be read must not cost a tool call or an
 * injection, and `null` is the legacy path, which is always safe.
 *
 * One copy on purpose. It had grown five identical private ones, and five
 * places to forget the try/catch is how a config read ends up failing a hook.
 */
export function resolveConfiguredEraCutoff(): number | null {
  try {
    return loadConfig().eraCutoffEpoch;
  } catch {
    return null;
  }
}

export function loadConfig(
  homePath = homedir(),
  logger: ConfigWarningLogger = { warn: (message) => console.warn(message) },
): MnemoConfig {
  const path = resolveConfigPath(homePath);
  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MnemoConfig>;
    const configuredDreamModel = Object.prototype.hasOwnProperty.call(
      raw,
      "dreamAgentModel",
    )
      ? raw.dreamAgentModel
      : DEFAULT_DREAM_AGENT_MODEL;
    const configuredDreamTimeZone = Object.prototype.hasOwnProperty.call(
      raw,
      "dreamAgentTimeZone",
    )
      ? raw.dreamAgentTimeZone
      : DEFAULT_DREAM_AGENT_TIME_ZONE;
    const configuredNoteSettlementModel = Object.prototype.hasOwnProperty.call(
      raw,
      "noteSettlementModel",
    )
      ? raw.noteSettlementModel
      : DEFAULT_NOTE_SETTLEMENT_MODEL;
    return clampConfig({
      ...DEFAULT_CONFIG,
      ...raw,
    }, configuredDreamModel, configuredDreamTimeZone, configuredNoteSettlementModel, logger);
  } catch {
    return DEFAULT_CONFIG;
  }
}
