import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MnemoConfig {
  mergeThresholdChars: number;
  maxQueuedBatches: number;
  keepaliveLeadMs: number;
  cacheMode: "5m" | "1h" | "auto";
}

export const DEFAULT_CONFIG: MnemoConfig = {
  mergeThresholdChars: 1000,
  maxQueuedBatches: 3,
  keepaliveLeadMs: 60_000,
  cacheMode: "auto",
};

export function resolveConfigPath(homePath = homedir()): string {
  return join(homePath, ".claude-mnemo", "config.json");
}

export function loadConfig(homePath = homedir()): MnemoConfig {
  const path = resolveConfigPath(homePath);
  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MnemoConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
