export type MarkdownHeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface MarkdownSection {
  /** Empty for the untitled preamble section. */
  title: string;
  /** Zero for the untitled preamble; otherwise the ATX heading level. */
  level: MarkdownHeadingLevel;
  bodyLines: string[];
}

interface OpenFence {
  marker: "`" | "~";
  length: number;
}

const FENCE_START = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;

function splitDocumentLines(document: string): string[] {
  if (document.length === 0) return [];

  const lines = document.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function openingFence(line: string): OpenFence | null {
  const match = FENCE_START.exec(line);
  if (!match) return null;

  const run = match[1];
  return {
    marker: run[0] as OpenFence["marker"],
    length: run.length,
  };
}

function closesFence(line: string, fence: OpenFence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return Boolean(
    match && match[1][0] === fence.marker && match[1].length >= fence.length,
  );
}

/**
 * Splits a free-form Markdown document into its ATX-heading sections.
 *
 * The parser intentionally implements only the shared persona-document subset:
 * headings are recognized outside fenced code blocks, and pre-heading content
 * becomes a level-zero, untitled preamble section.
 */
export function parseMarkdownSections(document: string): MarkdownSection[] {
  const lines = splitDocumentLines(document);
  if (lines.length === 0) return [];

  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;
  let fence: OpenFence | null = null;

  for (const line of lines) {
    if (fence) {
      current ??= { title: "", level: 0, bodyLines: [] };
      current.bodyLines.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }

    const nextFence = openingFence(line);
    if (nextFence) {
      current ??= { title: "", level: 0, bodyLines: [] };
      current.bodyLines.push(line);
      fence = nextFence;
      continue;
    }

    const heading = ATX_HEADING.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = {
        title: heading[2],
        level: heading[1].length as Exclude<MarkdownHeadingLevel, 0>,
        bodyLines: [],
      };
      continue;
    }

    current ??= { title: "", level: 0, bodyLines: [] };
    current.bodyLines.push(line);
  }

  if (current) sections.push(current);
  return sections;
}
