import { describe, expect, test } from "bun:test";

import { parseMarkdownSections } from "../../src/shared/markdown-sections";

describe("parseMarkdownSections", () => {
  test("treats headings inside fenced code blocks as body text", () => {
    expect(
      parseMarkdownSections([
        "# Visible",
        "before",
        "```md",
        "## Not a section",
        "```",
        "after",
      ].join("\n")),
    ).toEqual([
      {
        title: "Visible",
        level: 1,
        bodyLines: ["before", "```md", "## Not a section", "```", "after"],
      },
    ]);
  });

  test("treats headings inside tilde fences as body text", () => {
    expect(parseMarkdownSections("~~~\n# Not a section\n~~~\n# Visible")).toEqual([
      { title: "", level: 0, bodyLines: ["~~~", "# Not a section", "~~~"] },
      { title: "Visible", level: 1, bodyLines: [] },
    ]);
  });

  test("does not recognize a heading marker inside a block quote", () => {
    expect(parseMarkdownSections("> # Quoted\n> text\n# Visible")).toEqual([
      { title: "", level: 0, bodyLines: ["> # Quoted", "> text"] },
      { title: "Visible", level: 1, bodyLines: [] },
    ]);
  });

  test("emits content before the first heading as an untitled preamble", () => {
    expect(parseMarkdownSections("intro\n\n# Profile\ndetail")).toEqual([
      { title: "", level: 0, bodyLines: ["intro", ""] },
      { title: "Profile", level: 1, bodyLines: ["detail"] },
    ]);
  });

  test("represents adjacent headings as sections with zero body lines", () => {
    expect(parseMarkdownSections("# One\n## Two\ntext\n### Three")).toEqual([
      { title: "One", level: 1, bodyLines: [] },
      { title: "Two", level: 2, bodyLines: ["text"] },
      { title: "Three", level: 3, bodyLines: [] },
    ]);
  });

  test("preserves document order across mixed heading levels", () => {
    expect(parseMarkdownSections("## Two\na\n# One\nb\n###### Six\nc")).toEqual([
      { title: "Two", level: 2, bodyLines: ["a"] },
      { title: "One", level: 1, bodyLines: ["b"] },
      { title: "Six", level: 6, bodyLines: ["c"] },
    ]);
  });

  test("returns an untitled preamble for a document without headings", () => {
    expect(parseMarkdownSections("plain text\nsecond line")).toEqual([
      { title: "", level: 0, bodyLines: ["plain text", "second line"] },
    ]);
  });

  test("returns no sections for an empty document", () => {
    expect(parseMarkdownSections("")).toEqual([]);
  });
});
