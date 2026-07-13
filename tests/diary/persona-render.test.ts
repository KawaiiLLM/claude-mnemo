import { describe, expect, test } from "bun:test";

import { estimateDiaryTokens } from "../../src/diary/domain";
import {
  DIARY_INDEX_INJECTION_TOKEN_BUDGET,
  EXPERIENCE_INJECTION_TOKEN_BUDGET,
  PROFILE_INJECTION_TOKEN_BUDGET,
  renderPersonaDocumentInjection,
  renderSessionStartMemoryInjection,
} from "../../src/diary/persona-render";

const path = "/data/memory/user-profile.md";

describe("renderPersonaDocumentInjection", () => {
  test("renders an in-budget document in full without pointers", () => {
    const document = "preamble\n# Profile\nalpha\nbeta\n## Detail\ngamma";
    expect(renderPersonaDocumentInjection(document, 1_000, path)).toBe(document);
  });

  test("truncates in document order and reports the exact remaining line count", () => {
    const document = "# One\na\nb\nc\n# Two\nd\ne";
    const pointer = `（本节还有 2 行，完整见 ${path}）`;
    const skeleton = `# One\n（本节还有 3 行，完整见 ${path}）\n# Two\n（本节还有 2 行，完整见 ${path}）`;
    const budget = estimateDiaryTokens(`# One\na\n${pointer}\n# Two\n（本节还有 2 行，完整见 ${path}）`);
    expect(estimateDiaryTokens(skeleton)).toBeLessThanOrEqual(budget);
    expect(renderPersonaDocumentInjection(document, budget, path)).toBe(
      `# One\na\n${pointer}\n# Two\n（本节还有 2 行，完整见 ${path}）`,
    );
  });

  test("supports a headingless preamble", () => {
    const document = "first\nsecond\nthird";
    const budget = estimateDiaryTokens(`first\n（本节还有 2 行，完整见 ${path}）`);
    expect(renderPersonaDocumentInjection(document, budget, path)).toBe(
      `first\n（本节还有 2 行，完整见 ${path}）`,
    );
  });

  test("renders an empty document as an empty block", () => {
    expect(renderPersonaDocumentInjection("", 0, path)).toBe("");
  });

  test("truncates a single oversized section", () => {
    const document = `# One\n${"x".repeat(500)}\ntail`;
    const output = renderPersonaDocumentInjection(document, 100, path);
    expect(output).toBe(`# One\n（本节还有 2 行，完整见 ${path}）`);
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

  test("uses the unconditional one-line lower bound for a tiny budget", () => {
    expect(renderPersonaDocumentInjection("# One\na", 1, path)).toBe(
      `（user-profile.md 过大，完整见 ${path}）`,
    );
  });
});

describe("renderSessionStartMemoryInjection", () => {
  test("bounds all three current documents and preserves per-section overflow pointers", () => {
    const paths = {
      userProfile: "/data/memory/user-profile.md",
      experience: "/data/memory/experience.md",
      diaryIndex: "/data/diary/INDEX.md",
    };
    const longLines = (prefix: string, count: number) =>
      Array.from(
        { length: count },
        (_, index) => `- ${prefix} ${String(index).padStart(3, "0")} ${"中文内容".repeat(12)}`,
      ).join("\n");
    const rendered = renderSessionStartMemoryInjection({
      userProfile: `# User Profile\n${longLines("profile", 300)}`,
      experience: `# Experience\n${longLines("experience", 300)}`,
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
    expect(EXPERIENCE_INJECTION_TOKEN_BUDGET).toBe(2_000);
    expect(DIARY_INDEX_INJECTION_TOKEN_BUDGET).toBe(1_000);
    expect(estimateDiaryTokens(rendered.profile)).toBeLessThanOrEqual(2_000);
    expect(estimateDiaryTokens(rendered.experience)).toBeLessThanOrEqual(2_000);
    expect(estimateDiaryTokens(rendered.diaryIndex)).toBeLessThanOrEqual(1_000);
    expect(rendered.profile).toMatch(
      new RegExp(`本节还有 \\d+ 行，完整见 ${paths.userProfile}`),
    );
    expect(rendered.experience).toMatch(
      new RegExp(`本节还有 \\d+ 行，完整见 ${paths.experience}`),
    );
    expect(rendered.diaryIndex).toMatch(
      new RegExp(`本节还有 \\d+ 行，完整见 ${paths.diaryIndex.replace("/", "\\/")}`),
    );
  });

  test("sorts diary entries recent-first and has no archive input or output", () => {
    const archiveSentinel = "ARCHIVE_MUST_NEVER_BE_INJECTED";
    const rendered = renderSessionStartMemoryInjection({
      userProfile: "# User Profile\n\n- current profile\n",
      experience: "# Experience\n\n- current experience\n",
      diaryIndex: [
        "# Diary Index",
        "",
        "- 2026-07-08：older",
        "- 2026-07-10：newest",
        "- 2026-07-09：middle",
      ].join("\n"),
      paths: {
        userProfile: "/data/memory/user-profile.md",
        experience: "/data/memory/experience.md",
        diaryIndex: "/data/diary/INDEX.md",
      },
      archive: archiveSentinel,
    } as Parameters<typeof renderSessionStartMemoryInjection>[0] & {
      archive: string;
    });
    const combined = Object.values(rendered).join("\n");

    expect(rendered.diaryIndex.indexOf("2026-07-10")).toBeLessThan(
      rendered.diaryIndex.indexOf("2026-07-09"),
    );
    expect(rendered.diaryIndex.indexOf("2026-07-09")).toBeLessThan(
      rendered.diaryIndex.indexOf("2026-07-08"),
    );
    expect(combined).not.toContain(archiveSentinel);
    expect(combined).not.toContain("archive.md");
  });
});
