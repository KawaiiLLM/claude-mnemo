import { describe, expect, test } from "bun:test";

import { estimateDiaryTokens } from "../../src/diary/domain";
import { renderPersonaDocumentInjection } from "../../src/diary/persona-render";

const path = "/data/persona/generations/7/user-profile.md";

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
