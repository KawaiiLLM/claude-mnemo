import { describe, expect, test } from "bun:test";

import { parseDiaryEnvelope, validateDiaryCitations } from "../../src/diary/domain";
import { validatePersonaEnvelopeForRequest } from "../../src/worker/persona-maintenance";
import {
  CANONICAL_DIARY_WIRE_FORMAT_EXAMPLE,
  CANONICAL_PERSONA_WIRE_FORMAT_EXAMPLE,
} from "../../src/worker/prompt-wire-format";
import { buildDiaryPrompt } from "../../src/worker/diary-job";
import { buildPersonaPrompt } from "../../src/worker/diary-runtime";

describe("production prompt wire-format examples", () => {
  test("the diary example passes the production parser and citation validator", () => {
    const parsed = parseDiaryEnvelope(CANONICAL_DIARY_WIRE_FORMAT_EXAMPLE);
    const validated = validateDiaryCitations(
      parsed.body,
      new Set(["S1/T1", "S1/T2", "S2/T1"]),
      parsed.indexHook,
    );

    expect(validated.ok).toBe(true);
    expect(CANONICAL_DIARY_WIRE_FORMAT_EXAMPLE).not.toContain("### 项目");
    expect(CANONICAL_DIARY_WIRE_FORMAT_EXAMPLE).not.toMatch(/^\s*- 无\s*$/m);
    expect(CANONICAL_DIARY_WIRE_FORMAT_EXAMPLE).toContain("用户");
    const peopleSection = CANONICAL_DIARY_WIRE_FORMAT_EXAMPLE.match(
      /## 人物\n([\s\S]*?)\n## 反思/,
    )?.[1];
    expect(peopleSection).toBeDefined();
    for (const bullet of peopleSection!.split("\n").filter((line) => line.startsWith("- "))) {
      expect(bullet).toStartWith("- 用户");
    }
  });

  test("the persona example passes the production structure gate", () => {
    const sourceDiary = [
      "---",
      'projects: ["/absolute/path"]',
      "---",
      "- fixture evidence [S1/T1]",
    ].join("\n");

    expect(() =>
      validatePersonaEnvelopeForRequest(CANONICAL_PERSONA_WIRE_FORMAT_EXAMPLE, {
        op: "rebuild",
        diaries: [{ date: "2026-07-12", content: sourceDiary }],
      }),
    ).not.toThrow();
    expect(CANONICAL_PERSONA_WIRE_FORMAT_EXAMPLE).not.toMatch(
      /^ {2}- (?:路径|进度|反馈|\[\d{4}-\d{2}\])/m,
    );
    expect(CANONICAL_PERSONA_WIRE_FORMAT_EXAMPLE).toContain("用户");
    const userProfile = CANONICAL_PERSONA_WIRE_FORMAT_EXAMPLE.match(
      /===USER_PROFILE_V1_BEGIN===\n([\s\S]*?)\n===USER_PROFILE_V1_END===/,
    )?.[1];
    expect(userProfile).toBeDefined();
    expect(userProfile).not.toContain("我");
  });

  test("production prompts state the voice and semantic admission contracts", () => {
    const diaryPrompt = buildDiaryPrompt("2026-07-12", [], []);
    expect(diaryPrompt).toContain("「我」始终只指 agent");
    expect(diaryPrompt).toContain("用户一律称为「用户」");
    expect(diaryPrompt).toContain("每条 bullet 以「用户」开头");
    expect(diaryPrompt).toContain("反思节保持 agent 第一人称");

    const personaPrompt = buildPersonaPrompt({ op: "rebuild", diaries: [] });
    expect(personaPrompt).toContain("USER_PROFILE_V1 全文以第三人称描述「用户」，禁止出现「我」");
    expect(personaPrompt).toContain("EXPERIENCE_V1 中的「我」始终只指 agent");
    expect(personaPrompt).toContain("不得与任何 dated impression bullet 重复表述");
    expect(personaPrompt).toContain("反馈：只记录协作中的纠正或教训");
    expect(personaPrompt).toContain("进度：只记录项目当前状态");
  });
});
