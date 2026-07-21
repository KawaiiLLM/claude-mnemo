import { describe, expect, test } from "bun:test";

import type { Rule } from "../../src/db/rules";
import { estimateDiaryTokens } from "../../src/diary/domain";
import {
  RULE_DIGEST_TOKEN_BUDGET,
  renderRuleDigest,
} from "../../src/rules/digest";

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 1,
    name: "trace-before-claim",
    claim: "涉及排他性断言时，先检查可溯源材料再下结论。",
    rationale: "避免把未核实的判断写成事实。",
    scope: "global",
    triggerKind: "none",
    triggerSpec: null,
    status: "provisional",
    evidence: [],
    createdAtEpoch: 100,
    updatedAtEpoch: 100,
    lastEvidenceAtEpoch: 100,
    ...overrides,
  };
}

describe("renderRuleDigest", () => {
  test("renders only applicable none or digest-only rules with confirmed rules first", () => {
    const rendered = renderRuleDigest({
      project: "/projects/current",
      rules: [
        rule({ id: 8, name: "ordinary-trigger", triggerKind: "prompt", triggerSpec: { kind: "prompt", keywords: ["ordinary"] } }),
        rule({ id: 7, name: "retired-none", status: "retired" }),
        rule({ id: 6, name: "other-project", scope: "/projects/other" }),
        rule({ id: 5, name: "digest-result", status: "digest_only", triggerKind: "result", triggerSpec: { kind: "result", tool: "Bash", patterns: ["ECONNRESET", "timed out"] } }),
        rule({ id: 4, name: "provisional-none", lastEvidenceAtEpoch: 500 }),
        rule({ id: 3, name: "confirmed-older", status: "confirmed", lastEvidenceAtEpoch: 200 }),
        rule({ id: 2, name: "confirmed-newer", status: "confirmed", lastEvidenceAtEpoch: 300 }),
      ],
    });

    expect(rendered).toStartWith("## Rule Digest\n");
    expect(rendered).toContain("confirmed-newer");
    expect(rendered).toContain("confirmed-older");
    expect(rendered).toContain("provisional-none");
    expect(rendered).toContain("digest-result");
    expect(rendered).not.toContain("ordinary-trigger");
    expect(rendered).not.toContain("retired-none");
    expect(rendered).not.toContain("other-project");
    expect(rendered.indexOf("confirmed-newer")).toBeLessThan(rendered.indexOf("confirmed-older"));
    expect(rendered.indexOf("confirmed-older")).toBeLessThan(rendered.indexOf("provisional-none"));
    expect(rendered.indexOf("provisional-none")).toBeLessThan(rendered.indexOf("digest-result"));
    expect(rendered).toContain("适用范围：所有项目");
    expect(rendered).toContain("情境：由你根据规则正文中的条件自我匹配");
    expect(rendered).toContain("情境：Bash 的结果包含任一片段：ECONNRESET、timed out");
  });

  test("omits the whole block when no rule qualifies", () => {
    expect(renderRuleDigest({
      project: "/projects/current",
      rules: [
        rule({ triggerKind: "prompt", triggerSpec: { kind: "prompt", keywords: ["ordinary"] } }),
      ],
    })).toBe("");
  });

  test("stops item-by-item at the independent 500-token budget deterministically", () => {
    const rules = [
      rule({ id: 1, name: "first-long", status: "confirmed", claim: "先".repeat(280) }),
      rule({ id: 2, name: "second-too-long", status: "confirmed", claim: "次".repeat(280) }),
      rule({ id: 3, name: "third-short", status: "confirmed", claim: "不应越过前一条塞入。" }),
    ];

    const first = renderRuleDigest({ project: "/projects/current", rules });
    const second = renderRuleDigest({ project: "/projects/current", rules: [...rules].reverse() });

    expect(RULE_DIGEST_TOKEN_BUDGET).toBe(500);
    expect(estimateDiaryTokens(first)).toBeLessThanOrEqual(RULE_DIGEST_TOKEN_BUDGET);
    expect(first).toBe(second);
    expect(first).toContain("first-long");
    expect(first).not.toContain("second-too-long");
    expect(first).not.toContain("third-short");
  });
});
