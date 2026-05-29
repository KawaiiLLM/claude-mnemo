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
}

export const DEFAULT_CONFIG: MnemoConfig = {
  mergeThresholdChars: 1000,
  maxQueuedBatches: 3,
  keepaliveLeadMs: 60_000,
  cacheMode: "auto",
  maxMiniTurnChars: 24_000,
  maxFlushAttempts: 3,
};

// Floor for maxMiniTurnChars: guarantees a final slice's fixed overhead
// (prompt + prior_turn + response + capped file trees ~5800) plus at least one
// truncated obs (~720) always fits, so "rendered <= budget" holds by
// construction (D10).
const MIN_MINI_TURN_CHARS = 8192;
const MIN_FLUSH_ATTEMPTS = 1;

export function resolveConfigPath(homePath = homedir()): string {
  return join(homePath, ".claude-mnemo", "config.json");
}

function clampConfig(config: MnemoConfig): MnemoConfig {
  return {
    ...config,
    maxMiniTurnChars: Math.max(config.maxMiniTurnChars, MIN_MINI_TURN_CHARS),
    maxFlushAttempts: Math.max(config.maxFlushAttempts, MIN_FLUSH_ATTEMPTS),
  };
}

export function loadConfig(homePath = homedir()): MnemoConfig {
  const path = resolveConfigPath(homePath);
  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MnemoConfig>;
    return clampConfig({
      ...DEFAULT_CONFIG,
      ...raw,
    });
  } catch {
    return DEFAULT_CONFIG;
  }
}
