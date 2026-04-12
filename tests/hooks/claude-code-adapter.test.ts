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
});
