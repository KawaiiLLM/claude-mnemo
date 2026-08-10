import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { normalizeEraCutoffEpoch } from "../segment-era";

export interface MnemoConfig {
  /** Hard worker-exit cap after the final content session closes. */
  hardExitTimeoutMs: number;
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
// Dream retries are event-driven; this is only a small floor that prevents two
// closely spaced turn-stop drains from launching full dream runs back-to-back.
export const DREAM_RETRY_BACKOFF_MS = 10_000;
// Local wall-clock hour that serves as BOTH the dream trigger hour and the
// content-day boundary: a turn before this hour belongs to the previous day's
// diary (late-night work rolls back), and day D's dream fires at D+1 this hour.
// One knob keeps "content day closes exactly when its dream triggers" true.
export const DEFAULT_DREAM_AGENT_HOUR = 4;
export const DEFAULT_HARD_EXIT_TIMEOUT_MS = 70_000;

export const DEFAULT_CONFIG: MnemoConfig = {
  hardExitTimeoutMs: DEFAULT_HARD_EXIT_TIMEOUT_MS,
  // On by default because it is a kill switch, not the cutover switch: with no
  // era cutoff configured this changes nothing at all.
  settlementEnabled: true,
  eraCutoffEpoch: null,
  dreamAgentEnabled: false,
  dreamAgentModel: DEFAULT_DREAM_AGENT_MODEL,
  dreamAgentTimeoutMs: DEFAULT_DREAM_AGENT_TIMEOUT_MS,
  dreamAgentIdleWatchdogMs: DEFAULT_DREAM_AGENT_IDLE_WATCHDOG_MS,
  dreamAgentHour: DEFAULT_DREAM_AGENT_HOUR,
  dreamAgentTimeZone: DEFAULT_DREAM_AGENT_TIME_ZONE,
  dreamAgentBacklogLimit: 1,
};

export function resolveConfigPath(homePath = homedir()): string {
  return join(homePath, ".claude-mnemo", "config.json");
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
  logger: ConfigWarningLogger,
): MnemoConfig {
  return {
    hardExitTimeoutMs: clampInteger(
      config.hardExitTimeoutMs,
      1_000,
      300_000,
      DEFAULT_CONFIG.hardExitTimeoutMs,
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
    return clampConfig({
      ...DEFAULT_CONFIG,
      ...raw,
    }, configuredDreamModel, configuredDreamTimeZone, logger);
  } catch {
    return DEFAULT_CONFIG;
  }
}
