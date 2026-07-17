import { describe, expect, test } from "bun:test";

import { estimateDiaryTokens } from "../../src/diary/domain";
import {
  DIARY_INDEX_INJECTION_TOKEN_BUDGET,
  PROFILE_INJECTION_TOKEN_BUDGET,
  SESSION_INJECTION_TOKEN_BUDGET,
  renderPersonaDocumentInjection,
  renderSessionStartRecentSessionsInjection,
} from "../../src/diary/persona-render";

const path = "/data/memory/user-profile.md";

describe("renderPersonaDocumentInjection", () => {
  test("renders an in-budget document in full without pointers", () => {
    const document = "preamble\n# Profile\nalpha\nbeta\n## Detail\ngamma";
    expect(renderPersonaDocumentInjection(document, 1_000, path)).toBe(document);
  });

  test("truncates in document order and reports one document-level remaining line count", () => {
    const document = "# One\na\nb\nc\n# Two\nd\ne";
    const pointer = `（其余 4 行省略，完整见 ${path}）`;
    const skeleton = `# One\n# Two\n（其余 5 行省略，完整见 ${path}）`;
    const budget = estimateDiaryTokens(`# One\na\n# Two\n${pointer}`);
    expect(estimateDiaryTokens(skeleton)).toBeLessThanOrEqual(budget);
    expect(renderPersonaDocumentInjection(document, budget, path)).toBe(
      `# One\na\n# Two\n${pointer}`,
    );
    expect(renderPersonaDocumentInjection(document, budget, path).match(/完整见/g)).toHaveLength(1);
  });

  test("supports a headingless preamble", () => {
    const document = "first\nsecond\nthird";
    const budget = estimateDiaryTokens(`first\n（其余 2 行省略，完整见 ${path}）`);
    expect(renderPersonaDocumentInjection(document, budget, path)).toBe(
      `first\n（其余 2 行省略，完整见 ${path}）`,
    );
  });

  test("keeps a section pointer when its target differs from the document target", () => {
    const otherPath = "timeline()";
    const document = "# One\na\nb\n# Two\nc\nd";
    const skeleton = [
      "# One",
      `（本节还有 2 行，完整见 ${otherPath}）`,
      "# Two",
      `（其余 2 行省略，完整见 ${path}）`,
    ].join("\n");

    expect(
      renderPersonaDocumentInjection(
        document,
        estimateDiaryTokens(skeleton),
        path,
        { sectionDisplayPaths: [otherPath, path] },
      ),
    ).toBe(skeleton);
  });

  test("renders an empty document as an empty block", () => {
    expect(renderPersonaDocumentInjection("", 0, path)).toBe("");
  });

  test("truncates a single oversized section", () => {
    const document = `# One\n${"x".repeat(500)}\ntail`;
    const output = renderPersonaDocumentInjection(document, 100, path);
    expect(output).toBe(`# One\n（其余 2 行省略，完整见 ${path}）`);
    expect(estimateDiaryTokens(output)).toBeLessThanOrEqual(100);
  });

  test("degrades an oversized skeleton to top-level headings and a document pointer", () => {
    const document = "# One\na\n## Nested\nb\n# Two\nc";
    const fallback = `# One\n# Two\n（内容省略，完整见 ${path}）`;
    const output = renderPersonaDocumentInjection(
      document,
      estimateDiaryTokens(fallback),
      path,
    );
    expect(output).toBe(fallback);
  });

  test("preserves a distinct section target in the top-level-heading fallback", () => {
    const otherPath = "timeline()";
    const document = "# One\na\n## Nested\nb\n# Two\nc";
    const fallback = [
      "# One",
      "# Two",
      `（其余 1 行省略，完整见 ${otherPath}）`,
      `（其余 2 行省略，完整见 ${path}）`,
    ].join("\n");

    expect(
      renderPersonaDocumentInjection(
        document,
        estimateDiaryTokens(fallback),
        path,
        { sectionDisplayPaths: [otherPath, path, path] },
      ),
    ).toBe(fallback);
  });

  test("uses the unconditional one-line lower bound for a tiny budget", () => {
    expect(renderPersonaDocumentInjection("# One\na", 1, path)).toBe(
      `（user-profile.md 过大，完整见 ${path}）`,
    );
  });
});

describe("renderSessionStartRecentSessionsInjection", () => {
  test("bounds recent sessions plus diary index and uses a naked recall() pointer", () => {
    const paths = {
      recentSessions: "recall()",
      diaryIndex: "/data/diary/INDEX.md",
    };
    const longLines = (prefix: string, count: number) =>
      Array.from(
        { length: count },
        (_, index) => `- ${prefix} ${String(index).padStart(3, "0")} ${"中文内容".repeat(12)}`,
      ).join("\n");
    const rendered = renderSessionStartRecentSessionsInjection({
      recentSessions: `### Today\n${longLines("session", 300)}`,
      diaryIndex: [
        "# Diary Index",
        ...Array.from(
          { length: 300 },
          (_, index) => `- 2025-${String(12 - Math.floor(index / 28)).padStart(2, "0")}-${String(28 - (index % 28)).padStart(2, "0")}：${"日记摘要".repeat(10)}`,
        ),
      ].join("\n"),
      paths,
    });

    expect(PROFILE_INJECTION_TOKEN_BUDGET).toBe(2_000);
    expect(SESSION_INJECTION_TOKEN_BUDGET).toBe(2_000);
    expect(DIARY_INDEX_INJECTION_TOKEN_BUDGET).toBe(1_000);
    expect(estimateDiaryTokens(rendered)).toBeLessThanOrEqual(2_000);
    expect(rendered).toMatch(/其余 \d+ 行省略，完整见 recall\(\)/);
    expect(rendered).toMatch(
      new RegExp(`其余 \\d+ 行省略，完整见 ${paths.diaryIndex.replace("/", "\\/")}`),
    );
    expect(rendered).not.toContain('recall(id="S');
  });

  test("sorts diary entries recent-first without injecting experience content", () => {
    const rendered = renderSessionStartRecentSessionsInjection({
      recentSessions: "### Today\n- [S1] Recent session",
      diaryIndex: [
        "# Diary Index",
        "",
        "- 2026-07-08：older",
        "- 2026-07-10：newest",
        "- 2026-07-09：middle",
      ].join("\n"),
      paths: {
        recentSessions: "recall()",
        diaryIndex: "/data/diary/INDEX.md",
      },
    });

    expect(rendered.indexOf("2026-07-10")).toBeLessThan(
      rendered.indexOf("2026-07-09"),
    );
    expect(rendered.indexOf("2026-07-09")).toBeLessThan(
      rendered.indexOf("2026-07-08"),
    );
    expect(rendered).not.toContain("Experience");
    expect(rendered).not.toContain("experience.md");
  });
});
