import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MnemoConfig {
  /** Optional prior-persona material supplied to diary generation. */
  priorPersonaPath: string;
  mergeThresholdChars: number;
  maxQueuedBatches: number;
  keepaliveLeadMs: number;
  cacheMode: "5m" | "1h" | "auto";
  /** Max rendered size of a single streamed mini-turn message (D2/D10). */
  maxMiniTurnChars: number;
  /** Attempts before a flush unit is dropped and flagged delivery-dropped (D8/D10). */
  maxFlushAttempts: number;
  /**
   * Fraction of the memory agent's context window at/above which a
   * worker-driven /compact is allowed. Below it, compact is skipped so a
   * small agent session is never needlessly compressed. The effective gate is
   * min(window * ratio, AGENT_COMPACT_MAX_TOKENS): an absolute 100K ceiling caps
   * the trigger even under the 1M window, so this ratio only governs when the
   * window is set below 200K (see server.ts).
   */
  compactContextRatio: number;
}

export const DEFAULT_CONFIG: MnemoConfig = {
  priorPersonaPath: "~/.claude/CLAUDE.md",
  mergeThresholdChars: 1000,
  maxQueuedBatches: 3,
  keepaliveLeadMs: 60_000,
  cacheMode: "auto",
  maxMiniTurnChars: 24_000,
  maxFlushAttempts: 3,
  compactContextRatio: 0.5,
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

function clampConfig(config: MnemoConfig): MnemoConfig {
  return {
    ...config,
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
    compactContextRatio: clampNumber(
      config.compactContextRatio,
      MIN_COMPACT_CONTEXT_RATIO,
      MAX_COMPACT_CONTEXT_RATIO,
      DEFAULT_CONFIG.compactContextRatio,
    ),
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
