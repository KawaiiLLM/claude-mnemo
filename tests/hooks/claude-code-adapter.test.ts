import { describe, expect, test } from "bun:test";

import { normalizeClaudeCodeHookInput } from "../../src/hooks/adapters/claude-code";

describe("normalizeClaudeCodeHookInput", () => {
  test("accepts SessionEnd hook events", () => {
    const normalized = normalizeClaudeCodeHookInput({
      event_name: "SessionEnd",
      session_id: "session-end-1",
      cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    });

    expect(normalized.eventName).toBe("SessionEnd");
    expect(normalized.sessionId).toBe("session-end-1");
  });

  test("rejects a PostCompact payload", () => {
    // The event is no longer part of the supported matrix; normalization must
    // reject it rather than fall through to a handler lookup.
    expect(() =>
      normalizeClaudeCodeHookInput({
        hook_event_name: "PostCompact",
        session_id: "post-compact-1",
        cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
      }),
    ).toThrow("Unsupported Claude Code hook event: PostCompact");
  });

  test("normalizes child-agent identity while preserving the raw payload", () => {
    const raw = {
      hook_event_name: "PostToolUse",
      session_id: "root-session",
      agent_id: "child-agent-7",
      agent_type: "researcher",
      tool_name: "WebFetch",
    };

    const normalized = normalizeClaudeCodeHookInput(raw);

    expect(normalized.agentId).toBe("child-agent-7");
    expect(normalized.raw).toBe(raw);
  });

  test("leaves agentId absent for root payloads even when agent_type is present", () => {
    const normalized = normalizeClaudeCodeHookInput({
      hook_event_name: "PostToolUse",
      session_id: "root-session",
      agent_type: "main-session-agent",
      tool_name: "Agent",
    });

    expect(normalized.agentId).toBeUndefined();
  });
});
