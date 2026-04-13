import { describe, expect, test } from "bun:test";

import { encodeProjectPath, resolveTranscriptPath } from "../../src/shared/paths";

describe("resolveTranscriptPath", () => {
  test("uses Claude's project directory naming format for absolute paths", () => {
    expect(
      resolveTranscriptPath(
        "/Users/zhaoqixuan/Projects/claude-mnemo",
        "session-123",
      ),
    ).toBe(
      "/Users/zhaoqixuan/.claude/projects/-Users-zhaoqixuan-Projects-claude-mnemo/session-123.jsonl",
    );
  });

  test("dot-prefixed directories produce double dash matching SDK encoding", () => {
    expect(
      encodeProjectPath("/Users/zhaoqixuan/.claude-mnemo"),
    ).toBe("-Users-zhaoqixuan--claude-mnemo");

    expect(
      resolveTranscriptPath(
        "/Users/zhaoqixuan/.claude-mnemo",
        "resume-target",
      ),
    ).toBe(
      "/Users/zhaoqixuan/.claude/projects/-Users-zhaoqixuan--claude-mnemo/resume-target.jsonl",
    );
  });
});
