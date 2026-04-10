import type { HookEventName, NormalizedHookInput } from "../types";

function getString(
  raw: Record<string, unknown>,
  candidates: string[],
): string | undefined {
  for (const candidate of candidates) {
    const value = raw[candidate];

    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return undefined;
}

function getBoolean(
  raw: Record<string, unknown>,
  candidates: string[],
): boolean {
  for (const candidate of candidates) {
    const value = raw[candidate];

    if (typeof value === "boolean") {
      return value;
    }
  }

  return false;
}

function getUnknown(
  raw: Record<string, unknown>,
  candidates: string[],
): unknown {
  for (const candidate of candidates) {
    if (candidate in raw) {
      return raw[candidate];
    }
  }

  return undefined;
}

function resolveEventName(raw: Record<string, unknown>): HookEventName {
  const eventName = getString(raw, [
    "hook_event_name",
    "event_name",
    "eventName",
    "hookEventName",
    "event",
  ]);

  switch (eventName) {
    case "PostToolUse":
    case "SessionStart":
    case "PreCompact":
    case "UserPromptSubmit":
    case "Stop":
      return eventName;
    default:
      throw new Error(`Unsupported Claude Code hook event: ${eventName ?? "unknown"}`);
  }
}

export function normalizeClaudeCodeHookInput(
  raw: Record<string, unknown>,
): NormalizedHookInput {
  return {
    eventName: resolveEventName(raw),
    source: getString(raw, ["source"]),
    trigger: getString(raw, ["trigger"]),
    sessionId: getString(raw, ["session_id", "sessionId"]),
    cwd: getString(raw, ["cwd", "workspace_path", "workspacePath"]),
    prompt: getString(raw, ["prompt", "user_prompt", "userPrompt"]),
    toolName: getString(raw, ["tool_name", "toolName"]),
    toolInput: getUnknown(raw, ["tool_input", "toolInput"]),
    toolResponse: getUnknown(raw, ["tool_response", "toolResponse"]),
    transcriptPath: getString(raw, ["transcript_path", "transcriptPath"]),
    lastAssistantMessage: getString(raw, [
      "last_assistant_message",
      "lastAssistantMessage",
    ]),
    stopHookActive: getBoolean(raw, ["stop_hook_active", "stopHookActive"]),
    raw,
  };
}
