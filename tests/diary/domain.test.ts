import { describe, expect, test } from "bun:test";

import {
  computeDiaryWatermark,
  encodeSource,
  estimateDiaryTokens,
  stripDiaryPrivateContent,
  truncateDiaryResponse,
} from "../../src/diary/domain";

describe("dream diary domain helpers", () => {
  test("estimates CJK-aware token weight", () => {
    expect(estimateDiaryTokens("中文AB")).toBe(5);
  });

  test("computes a deterministic, order-independent material watermark", () => {
    const material = [
      {
        turnId: 2,
        status: "extracted",
        userPrompt: "second",
        assistantResponse: "response",
        title: "title",
        content: "content",
        insight: "insight",
      },
      {
        turnId: 1,
        status: "skipped",
        userPrompt: "first",
        assistantResponse: null,
        title: null,
        content: null,
        insight: null,
      },
    ];
    expect(computeDiaryWatermark(material)).toBe(
      computeDiaryWatermark([...material].reverse()),
    );
    expect(computeDiaryWatermark([])).toBe("empty");
  });

  test("bounds response contribution to 2000 Unicode code points", () => {
    expect(truncateDiaryResponse("😀".repeat(2_001))).toHaveLength(4_000);
  });

  test("removes private blocks and rejects malformed private markup", () => {
    expect(stripDiaryPrivateContent("before<private>secret</private>after"))
      .toBe("beforeafter");
    expect(stripDiaryPrivateContent("before<private>secret"))
      .toBe("[redacted: malformed private content]");
  });

  test("escapes markup-sensitive source characters", () => {
    expect(encodeSource("<x>&")).toBe('"\\u003cx\\u003e\\u0026"');
  });
});
