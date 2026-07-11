import { createHash } from "node:crypto";
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
  });

  test("date plus one citation is valid; two citations and date-only are deleted", () => {
    const body = threeSections([
      "- [2026-07] 合法 [S1/T1]",
      "- 双组 [S1/T1] [S1/T2]",
      "- [2026-07] 只有日期",
      "- 合法二 [S1/T1]",
      "- 合法三 [S1/T1]",
      "- 合法四 [S1/T1]",
    ]);
    const result = validateDiaryCitations(body, new Set(["S1/T1", "S1/T2"]), "agent");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report).toMatchObject({ version: 1, total: 6, deleted: 2 });
    expect(result.body).toContain("- [2026-07] 合法 [S1/T1]");
    expect(result.body).not.toContain("双组");
    expect(result.body).not.toContain("只有日期");
  });

  test("counts malformed S<n>/T-prefixed brackets as citation groups", () => {
    const body = threeSections([
      "- malformed second group [S1/T1] [S2/Tbad]",
      "- valid one [S1/T1]",
      "- valid two [S1/T1]",
    ]);
    const result = validateDiaryCitations(body, new Set(["S1/T1"]));
    expect(result).toMatchObject({ ok: true, report: { total: 3, deleted: 1 } });
    if (result.ok) expect(result.body).not.toContain("malformed second group");
  });
});

describe("citation deletion and report", () => {
  test("deletes invalid bullets with continuations and removes emptied project guides", () => {
    const deletedBullet = "- 越界 <private>secret</private> [S9/T9]\n延续也删除";
    const body = threeSections([
      "**empty project**", deletedBullet,
      "**kept project**", "- 保留 [S1/T1]",
      "- 也保留 [S1/T2]",
    ]);
    const result = validateDiaryCitations(body, new Set(["S1/T1", "S1/T2"]), "unsafe agent hook");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).not.toContain("empty project");
    expect(result.body).not.toContain("延续也删除");
    expect(result.report).toEqual({
      version: 1, total: 3, deleted: 1,
      items: [{
        section: "工作",
        sha256: createHash("sha256").update(deletedBullet, "utf8").digest("hex"),
        preview: "- 越界  [S9/T9]\n延续也删除",
      }],
    });
  });

  test("deletes citation-only bullets and caps report items and previews by code point", () => {
    const invalid = `- ${"🙂".repeat(100)} [S9/T9]`;
    const body = threeSections([
      "- [S1/T1]", ...Array.from({ length: 21 }, () => invalid),
      ...Array.from({ length: 44 }, (_, i) => `- valid ${i} [S1/T1]`),
    ]);
    const result = validateDiaryCitations(body, new Set(["S1/T1"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report).toMatchObject({ total: 66, deleted: 22 });
    expect(result.report.items).toHaveLength(20);
    expect(Array.from(result.report.items[1]!.preview)).toHaveLength(80);
  });

  test("passes exactly one-third deletion, fails above it, and fails total zero", () => {
    const exact = validateDiaryCitations(threeSections([
      "- valid [S1/T1]", "- valid [S1/T1]", "- invalid",
    ]), new Set(["S1/T1"]));
    expect(exact.ok).toBe(true);
    expect(validateDiaryCitations(threeSections([
      "- valid [S1/T1]", "- invalid",
    ]), new Set(["S1/T1"]))).toMatchObject({ ok: false, code: "excessive_deletions" });
    expect(validateDiaryCitations(threeSections([]), new Set())).toMatchObject({
      ok: false, code: "empty_diary", report: { total: 0, deleted: 0 },
    });
  });
});

describe("index hook contamination defense", () => {
  test("uses agent hook with no deletions and deterministic section-first fallback otherwise", () => {
    const clean = validateDiaryCitations(threeSections(["- work [S1/T1]"]), new Set(["S1/T1"]), "agent");
    expect(clean).toMatchObject({ ok: true, indexHook: "agent", report: { deleted: 0 } });
    const dirty = validateDiaryCitations(threeSections([
      "- work [S1/T1]", "- bad",
    ], ["- person [S1/T1]\ncontinued"], ["- reflect [S1/T1]"]), new Set(["S1/T1"]), "unsafe");
    expect(dirty).toMatchObject({
      ok: true, indexHook: "work；person continued；reflect", report: { deleted: 1 },
    });
  });

  test("truncates deterministic hook to 160 Unicode code points", () => {
    const result = validateDiaryCitations(threeSections([
      `- ${"🙂".repeat(170)} [S1/T1]`, "- invalid",
      "- valid [S1/T1]", "- valid [S1/T1]", "- valid [S1/T1]",
    ]), new Set(["S1/T1"]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(Array.from(result.indexHook)).toHaveLength(160);
  });

  test("uses the first surviving bullet from every project block", () => {
    const result = validateDiaryCitations(threeSections([
      "**one**", "- first [S1/T1]", "- later [S1/T1]",
      "**two**", "- second [S1/T1]", "- invalid",
    ]), new Set(["S1/T1"]));
    expect(result).toMatchObject({ ok: true, indexHook: "first；second" });
  });
});
