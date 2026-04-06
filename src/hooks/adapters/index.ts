import type { NormalizedHookInput } from "../types";
import { normalizeClaudeCodeHookInput } from "./claude-code";

export type HookPlatform = "claude-code";

export function normalizeHookInput(
  raw: Record<string, unknown>,
  platform: HookPlatform = "claude-code",
): NormalizedHookInput {
  switch (platform) {
    case "claude-code":
      return normalizeClaudeCodeHookInput(raw);
    default:
      throw new Error(`Unsupported hook platform: ${platform satisfies never}`);
  }
}
