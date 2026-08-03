export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "SessionStart"
  | "SessionEnd"
  | "PreCompact"
  | "UserPromptSubmit"
  | "Stop";

export interface NormalizedHookInput {
  eventName: HookEventName;
  source?: string;
  trigger?: string;
  sessionId?: string;
  agentId?: string;
  cwd?: string;
  prompt?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  transcriptPath?: string;
  lastAssistantMessage?: string;
  stopHookActive: boolean;
  raw: Record<string, unknown>;
}

export interface HookResult {
  continue: boolean;
  suppressOutput?: boolean;
  hookSpecificOutput?: string;
  exitCode?: number;
  asyncWork?: () => Promise<void>;
}

export interface HookHandler {
  (input: NormalizedHookInput): Promise<HookResult> | HookResult;
}
