import { describe, expect, test } from "bun:test";
import {
  compileDiaryDocument,
  computeDiaryWatermark,
  diaryDayOf,
  encodeSource,
  estimateDiaryTokens,
  findDiaryCitationGroups,
  parseDiaryEnvelope,
  stripDiaryPrivateContent,
  stripIndexHookDatePrefix,
  validateDiaryCitations,
  validateDiaryDocument,
} from "../../src/diary/domain";

const envelope = (body: string, hook = "agent hook") => [
  "===DIARY_V2_BEGIN===",
  body,
  "===DIARY_V2_END===",
  "===INDEX_HOOK_V1===",
  hook,
].join("\n");

const threeSections = (work: string[], people: string[] = [], reflection: string[] = []) => [
  "## 工作", ...work, "## 人物", ...people, "## 反思", ...reflection,
].join("\n");

describe("basic diary helpers", () => {
  test("uses UTC+8, safely encodes sources, and estimates tokens", () => {
    expect(diaryDayOf(1_783_699_199)).toBe("2026-07-10");
    expect(diaryDayOf(1_783_699_200)).toBe("2026-07-11");
    const source = "</source_prompt><tag> & \\\"quote\\\" \\\\ slash\n中文🙂";
    const encoded = encodeSource(source);
    expect(encoded).not.toContain("<");
    expect(JSON.parse(encoded)).toBe(source);
    expect(estimateDiaryTokens("中文AB")).toBe(5);
  });

  test("watermark depends only on turn material", () => {
    const material = [{
      turnId: 1, status: "extracted", userPrompt: "p", assistantResponse: "r",
      title: null, content: null, insight: null,
    }];
    expect(computeDiaryWatermark(material)).toBe(computeDiaryWatermark(material));
  });
});

describe("stripDiaryPrivateContent", () => {
  test("removes valid blocks and fails closed for unmatched and over 100 tags", () => {
    const redacted = "[redacted: malformed private content]";
    expect(stripDiaryPrivateContent("a<private>secret</private>b")).toBe("ab");
    expect(stripDiaryPrivateContent("a<private>secret")).toBe(redacted);
    expect(stripDiaryPrivateContent("secret</private>b")).toBe(redacted);
    expect(stripDiaryPrivateContent("<private>x</private>".repeat(101))).toBe(redacted);
  });
});

describe("parseDiaryEnvelope v2", () => {
  test("accepts the fixed three-section grammar and V2 sentinels", () => {
    const body = threeSections([
      "**mnemo**",
      "- 完成解析 [S1/T1]",
      "延续说明",
    ], ["", "- 记住偏好 [S1/T1]"], ["- 我修正了判断 [S1/T1]"]);
    expect(parseDiaryEnvelope(envelope(body))).toEqual({ body, indexHook: "agent hook" });
  });

  test("rejects V1, wrong sections, nested bullets, and stray pre-bullet text", () => {
    const valid = threeSections(["- 工作 [S1/T1]"]);
    const cases = [
      envelope(valid).replaceAll("DIARY_V2", "DIARY_V1"),
      envelope(valid.replace("## 人物", "## 人物信号")),
      envelope(threeSections(["  - nested [S1/T1]"])),
      envelope(threeSections([], ["人物前言", "- 人物 [S1/T1]"])),
    ];
    for (const raw of cases) expect(() => parseDiaryEnvelope(raw)).toThrow();
  });

  test("enforces project guide full-line syntax, work-only placement, and immediate bullet", () => {
    const cases = [
      threeSections(["**project** suffix", "- 工作 [S1/T1]"]),
      threeSections([], ["**project**", "- 人物 [S1/T1]"]),
      threeSections(["**project**"]),
      threeSections(["**project**", "", "- 工作 [S1/T1]"]),
    ];
    for (const body of cases) expect(() => parseDiaryEnvelope(envelope(body))).toThrow();
  });
});

describe("frontmatter format v2", () => {
  test("serializer emits canonical JSON integer format 2", () => {
    const body = threeSections(["- 工作 [S1/T1]"]);
    const text = new TextDecoder().decode(compileDiaryDocument({
      date: "2026-07-10", sessions: ["S2", "S1", "S2"],
      projects: ["/z", "/a", "/z"], watermark: "abc", indexHook: "hook", body,
    }));
    expect(text).toContain("---\nformat: 2\n");
    expect(text).toContain('sessions: ["S1","S2"]');
    expect(validateDiaryDocument(text)).toEqual({ ok: true, format: 2 });
  });

  test("missing, duplicate, v1, string, and other formats return typed failures", () => {
    const formats = ["", "format: 2\nformat: 2", "format: 1", 'format: "2"', "format: 3"];
    for (const format of formats) {
      expect(validateDiaryDocument(`---\n${format}\n---\n`)).toEqual({
        ok: false, code: "invalid_format",
      });
    }
  });
});

describe("citation group grammar", () => {
  test("ignores date brackets and finds only groups beginning with S<n>/T<n>", () => {
    expect(findDiaryCitationGroups("[2026-07] 事件 [S1/T2， T3]")).toEqual([{
      raw: "[S1/T2， T3]", refs: ["S1/T2", "S1/T3"], index: 13,
    }]);
    expect(findDiaryCitationGroups("[S1/Tbad]")).toEqual([{
      raw: "[S1/Tbad]", refs: [], index: 0,
    }]);
  });

  test("strips invalid members from mixed groups and canonicalizes the survivors", () => {
    const body = threeSections([
      "- 混合 [S1/T1，T2，S2/T3]",
    ]);
    const result = validateDiaryCitations(body, new Set(["S1/T1", "S2/T3"]), "agent");
    expect(result).toEqual({
      ok: true,
      body: threeSections(["- 混合 [S1/T1，S2/T3]"]),
      indexHook: "agent",
      report: {
        version: 2,
        total: 3,
        stripped: 1,
        items: [{ section: "工作", line: 2, original: "T2" }],
      },
    });
  });

  test("does not recognize or alter malformed citation-like brackets", () => {
    const body = threeSections([
      "- malformed [S2/Tbad] [S1/T1, T2] [T3]",
    ]);
    const result = validateDiaryCitations(body, new Set(["S1/T1"]));
    expect(result.body).toBe(body);
    expect(result.report).toEqual({ version: 2, total: 0, stripped: 0, items: [] });
  });
});

describe("citation stripping and v2 report", () => {
  test("strips a wholly invalid group while preserving every content line", () => {
    const invalidBullet = "- 越界 <private>secret</private> [S9/T9]\n延续仍保留";
    const body = threeSections([
      "**project**", invalidBullet,
      "**kept project**", "- 保留 [S1/T1]",
    ]);
    const result = validateDiaryCitations(body, new Set(["S1/T1"]), "agent hook");
    expect(result.body).toContain("**project**\n- 越界 <private>secret</private> \n延续仍保留");
    expect(result.report).toEqual({
      version: 2, total: 2, stripped: 1,
      items: [{ section: "工作", line: 3, original: "[S9/T9]" }],
    });
  });

  test("strips syntactically valid references to missing turns", () => {
    const body = threeSections([], ["- 人物事实 [S9/T9]"]);
    const result = validateDiaryCitations(body, new Set());
    expect(result.body).toContain("- 人物事实 ");
    expect(result.report).toEqual({
      version: 2, total: 1, stripped: 1,
      items: [{ section: "人物", line: 3, original: "[S9/T9]" }],
    });
  });
});

describe("index hook contamination defense", () => {
  test("keeps the agent hook even when invalid citations are stripped", () => {
    const clean = validateDiaryCitations(threeSections(["- work [S1/T1]"]), new Set(["S1/T1"]), "agent");
    expect(clean).toMatchObject({ ok: true, indexHook: "agent", report: { stripped: 0 } });
    const dirty = validateDiaryCitations(threeSections([
      "- work [S9/T9]",
    ]), new Set(), "still valid summary");
    expect(dirty).toMatchObject({
      ok: true, indexHook: "still valid summary", report: { stripped: 1 },
    });
  });
});

describe("stripIndexHookDatePrefix", () => {
  test("removes a leading date prefix matching the diary date", () => {
    expect(stripIndexHookDatePrefix("2026-07-11：三段式定稿", "2026-07-11")).toBe("三段式定稿");
    expect(stripIndexHookDatePrefix("2026-07-11: work done", "2026-07-11")).toBe("work done");
  });

  test("leaves a non-matching or absent prefix untouched", () => {
    expect(stripIndexHookDatePrefix("三段式定稿", "2026-07-11")).toBe("三段式定稿");
    expect(stripIndexHookDatePrefix("2026-07-10：other day", "2026-07-11")).toBe(
      "2026-07-10：other day",
    );
  });

  test("never strips down to an empty hook", () => {
    expect(stripIndexHookDatePrefix("2026-07-11：", "2026-07-11")).toBe("2026-07-11：");
  });
});
