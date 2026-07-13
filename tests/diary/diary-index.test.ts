import { describe, expect, test } from "bun:test";

import { sortDiaryIndexRecentFirst } from "../../src/diary/diary-index";

describe("sortDiaryIndexRecentFirst", () => {
  test("sorts only top-level index entries while preserving preamble and fenced examples", () => {
    const document = [
      "preamble",
      "- 2098-01-01: preamble example",
      "# Diary Index",
      "",
      "```text",
      "- 2099-01-01: fenced example",
      "```",
      "- 2026-07-08: older",
      "  - 2097-01-01: nested example",
      "- 2026-07-10: newest",
      "- 2026-07-09: middle",
      "",
    ].join("\n");

    expect(sortDiaryIndexRecentFirst(document)).toBe([
      "preamble",
      "- 2098-01-01: preamble example",
      "# Diary Index",
      "",
      "```text",
      "- 2099-01-01: fenced example",
      "```",
      "- 2026-07-10: newest",
      "- 2026-07-09: middle",
      "- 2026-07-08: older",
      "  - 2097-01-01: nested example",
      "",
    ].join("\n"));
  });
});
