import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MnemoConfig {
  mergeThresholdChars: number;
  maxQueuedBatches: number;
  keepaliveLeadMs: number;
  cacheMode: "5m" | "1h" | "auto";
  /** Max rendered size of a single streamed mini-turn message (D2/D10). */
  maxMiniTurnChars: number;
  /** Attempts before a flush unit is dropped and flagged delivery-dropped (D8/D10). */
  maxFlushAttempts: number;
  /** Wall-clock budget for a SessionEnd drain + flush before it is aborted. */
  sessionEndTailTimeoutMs: number;
  /** Hard worker-exit cap after the final content session closes. */
  hardExitTimeoutMs: number;
  /** Abort an in-flight extraction after this long with no agent activity. */
  stallThresholdMs: number;
  /**
   * Fraction of the memory agent's context window at/above which a
   * worker-driven /compact is allowed. Below it, compact is skipped so a
   * small agent session is never needlessly compressed. The effective gate is
   * min(window * ratio, AGENT_COMPACT_MAX_TOKENS): an absolute 100K ceiling caps
   * the trigger even under the 1M window, so this ratio only governs when the
   * window is set below 200K (see server.ts).
   */
  compactContextRatio: number;
  /** Model used by the merged nightly dream agent. */
  dreamAgentModel: DreamAgentModel;
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
// Local wall-clock hour that serves as BOTH the dream trigger hour and the
// content-day boundary: a turn before this hour belongs to the previous day's
// diary (late-night work rolls back), and day D's dream fires at D+1 this hour.
// One knob keeps "content day closes exactly when its dream triggers" true.
export const DEFAULT_DREAM_AGENT_HOUR = 4;
export const DEFAULT_SESSION_END_TAIL_TIMEOUT_MS = 60_000;
export const DEFAULT_HARD_EXIT_TIMEOUT_MS = 70_000;
export const DEFAULT_STALL_THRESHOLD_MS = 60_000;

export const DEFAULT_CONFIG: MnemoConfig = {
  mergeThresholdChars: 1000,
  maxQueuedBatches: 3,
  keepaliveLeadMs: 60_000,
  cacheMode: "auto",
  maxMiniTurnChars: 24_000,
  maxFlushAttempts: 3,
  sessionEndTailTimeoutMs: DEFAULT_SESSION_END_TAIL_TIMEOUT_MS,
  hardExitTimeoutMs: DEFAULT_HARD_EXIT_TIMEOUT_MS,
  stallThresholdMs: DEFAULT_STALL_THRESHOLD_MS,
  compactContextRatio: 0.5,
  dreamAgentModel: DEFAULT_DREAM_AGENT_MODEL,
  dreamAgentTimeoutMs: DEFAULT_DREAM_AGENT_TIMEOUT_MS,
  dreamAgentIdleWatchdogMs: DEFAULT_DREAM_AGENT_IDLE_WATCHDOG_MS,
  dreamAgentHour: DEFAULT_DREAM_AGENT_HOUR,
  dreamAgentTimeZone: DEFAULT_DREAM_AGENT_TIME_ZONE,
  dreamAgentBacklogLimit: 1,
};

// Floor for maxMiniTurnChars: guarantees a final slice's fixed overhead
// (prompt + prior_turn + response(3000) + capped file trees ~8200) plus at
// least one truncated obs (~1178: capped tool name + in:200/out:800 + 9-line
// indent) always fits, so "rendered <= budget" holds by construction (D10).
// Raised 8192->9216 (wider obs budget), then ->10240 to keep the floor as
// RESPONSE_CAP grew 2000->3000 (floored final budget 10240-8212=2028 >= 1178).
export const MIN_MINI_TURN_CHARS = 10240;
const MIN_FLUSH_ATTEMPTS = 1;
// Keep the compact gate in a sane band: never below 10% (compacting an almost
// empty session) nor above 95% (never compacting before the SDK auto-compacts).
const MIN_COMPACT_CONTEXT_RATIO = 0.1;
const MAX_COMPACT_CONTEXT_RATIO = 0.95;

export function resolveConfigPath(homePath = homedir()): string {
  return join(homePath, ".claude-mnemo", "config.json");
}

// Coerce + clamp one numeric knob. A hand-written config can carry a string or
// junk; without an isFinite guard `Math.max("bad", n)` yields NaN, which then
// silently disables every downstream comparison (e.g. the compact gate). Fall
// back to the default when the value is not a finite number.
function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

interface ConfigWarningLogger {
  warn(message: string): void;
}

function resolveDreamAgentModel(
  value: unknown,
  logger: ConfigWarningLogger,
): DreamAgentModel {
  if (
    typeof value === "string" &&
    (KNOWN_DREAM_AGENT_MODELS as readonly string[]).includes(value)
  ) {
    return value as DreamAgentModel;
  }

  logger.warn(
    `[claude-mnemo] Invalid dreamAgentModel ${JSON.stringify(value)}; using ${DEFAULT_DREAM_AGENT_MODEL}.`,
  );
  return DEFAULT_DREAM_AGENT_MODEL;
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
  logger: ConfigWarningLogger,
): MnemoConfig {
  return {
    mergeThresholdChars: config.mergeThresholdChars,
    maxQueuedBatches: config.maxQueuedBatches,
    keepaliveLeadMs: config.keepaliveLeadMs,
    cacheMode: config.cacheMode,
    maxMiniTurnChars: clampNumber(
      config.maxMiniTurnChars,
      MIN_MINI_TURN_CHARS,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_CONFIG.maxMiniTurnChars,
    ),
    maxFlushAttempts: clampNumber(
      config.maxFlushAttempts,
      MIN_FLUSH_ATTEMPTS,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_CONFIG.maxFlushAttempts,
    ),
    sessionEndTailTimeoutMs: clampInteger(
      config.sessionEndTailTimeoutMs,
      1_000,
      300_000,
      DEFAULT_CONFIG.sessionEndTailTimeoutMs,
    ),
    hardExitTimeoutMs: clampInteger(
      config.hardExitTimeoutMs,
      1_000,
      300_000,
      DEFAULT_CONFIG.hardExitTimeoutMs,
    ),
    stallThresholdMs: clampInteger(
      config.stallThresholdMs,
      1_000,
      300_000,
      DEFAULT_CONFIG.stallThresholdMs,
    ),
    compactContextRatio: clampNumber(
      config.compactContextRatio,
      MIN_COMPACT_CONTEXT_RATIO,
      MAX_COMPACT_CONTEXT_RATIO,
      DEFAULT_CONFIG.compactContextRatio,
    ),
    dreamAgentModel: resolveDreamAgentModel(rawDreamAgentModel, logger),
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
  };
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
    return clampConfig({
      ...DEFAULT_CONFIG,
      ...raw,
    }, configuredDreamModel, configuredDreamTimeZone, logger);
  } catch {
    return DEFAULT_CONFIG;
  }
}
