import { describe, expect, test } from "bun:test";

import { renderFileTree } from "../../src/shared/file-tree";

describe("renderFileTree maxChars cap", () => {
  test("without maxChars output is unchanged (regression guard)", () => {
    const paths = [
      "/proj/src/a.ts",
      "/proj/src/b.ts",
      "/proj/docs/readme.md",
    ];
    const uncapped = renderFileTree(paths);
    // A generous cap that the small tree never reaches must be byte-identical.
    expect(renderFileTree(paths, { maxChars: 10_000 })).toBe(uncapped);
    expect(uncapped).toContain("/proj");
  });

  test("with maxChars output stays within budget and reports omitted files", () => {
    const total = 300;
    const paths = Array.from(
      { length: total },
      (_, index) => `/proj/a/file${String(index).padStart(3, "0")}.ts`,
    );

    const maxChars = 800;
    const capped = renderFileTree(paths, { maxChars });

    expect(capped.length).toBeLessThanOrEqual(maxChars);
    expect(capped).toMatch(/\n {2}\.\.\.\(\+\d+ more files\)$/);

    // N (reported omitted) + shown file lines === total files.
    const match = capped.match(/\.\.\.\(\+(\d+) more files\)$/);
    const omitted = Number(match![1]);
    const shownFileLines = capped
      .split("\n")
      .filter(
        (line, index) =>
          index > 0 &&
          !line.endsWith("/") &&
          !line.includes("more files"),
      ).length;
    expect(omitted + shownFileLines).toBe(total);
    expect(omitted).toBeGreaterThan(0);
  });

  test("a single pathologically long path still honors maxChars", () => {
    const longPath = `/proj/${"a".repeat(3000)}/file.ts`;
    const capped = renderFileTree([longPath], { maxChars: 200 });
    expect(capped.length).toBeLessThanOrEqual(200);
    expect(capped.endsWith("...")).toBe(true);
    // A single short path is returned verbatim.
    expect(renderFileTree(["/proj/a.ts"], { maxChars: 200 })).toBe("/proj/a.ts");
  });

  test("maxChars larger than the rendered tree leaves it intact", () => {
    const paths = Array.from(
      { length: 5 },
      (_, index) => `/proj/a/file${index}.ts`,
    );
    const uncapped = renderFileTree(paths);
    expect(renderFileTree(paths, { maxChars: 5000 })).toBe(uncapped);
    expect(uncapped).not.toContain("more files");
  });
});
