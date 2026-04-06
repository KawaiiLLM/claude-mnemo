import { describe, expect, test } from "bun:test";

import { resolveTranscriptPath } from "../../src/shared/paths";

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
});
