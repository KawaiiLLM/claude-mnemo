import { describe, expect, test } from "bun:test";

import { parseDiaryEnvelope, validateDiaryCitations } from "../../src/diary/domain";
import { validatePersonaEnvelopeForRequest } from "../../src/worker/persona-maintenance";
import {
  CANONICAL_DIARY_WIRE_FORMAT_EXAMPLE,
  CANONICAL_PERSONA_WIRE_FORMAT_EXAMPLE,
} from "../../src/worker/prompt-wire-format";

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
  });
});
