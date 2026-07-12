import { describe, expect, test } from "bun:test";
import { stripInvalidCitations } from "../../src/shared/citation-validation";

describe("stripInvalidCitations", () => {
  const locate = (offset: number) => ({ section: "任意节", line: offset + 1 });

  test("strips invalid members without removing valid group members", () => {
    const result = stripInvalidCitations(
      "事实 [S1/T1，T2，S2/T3]",
      new Set(["S1/T1", "S2/T3"]),
      locate,
    );
    expect(result).toEqual({
      text: "事实 [S1/T1，S2/T3]",
      report: {
        version: 2,
        total: 3,
        stripped: 1,
        items: [{ section: "任意节", line: 4, original: "T2" }],
      },
    });
  });

  test("strips an all-invalid group and ignores malformed citation-like text", () => {
    const result = stripInvalidCitations(
      "保留内容 [S9/T9，T10]；畸形 [S1/Tbad] [S1/T1, T2] [[S8/T8]]",
      new Set(),
      locate,
    );
    expect(result.text).toBe("保留内容 ；畸形 [S1/Tbad] [S1/T1, T2] [[S8/T8]]");
    expect(result.report).toEqual({
      version: 2,
      total: 2,
      stripped: 2,
      items: [{ section: "任意节", line: 6, original: "[S9/T9，T10]" }],
    });
  });
});
