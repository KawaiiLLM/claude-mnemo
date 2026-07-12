export interface CitationGroup {
  raw: string;
  refs: string[];
  index: number;
}

interface ParsedCitationGroup extends CitationGroup {
  members: string[];
  validSyntax: boolean;
}

function parseCitationGroups(text: string): ParsedCitationGroup[] {
  return [...text.matchAll(/\[(S\d+\/T[^\[\]\r\n]*)\]/g)].flatMap((match) => {
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    let bracketDepth = 0;
    for (let index = lineStart; index < match.index; index += 1) {
      if (text[index] === "[") bracketDepth += 1;
      else if (text[index] === "]" && bracketDepth > 0) bracketDepth -= 1;
    }
    if (bracketDepth !== 0) return [];

    const content = match[1]!;
    const parts = content.split("，").map((part) => part.trim());
    const first = parts[0]!.match(/^S(\d+)\/T(\d+)$/);
    const refs: string[] = [];
    let validSyntax = first !== null;
    if (first) {
      let session = `S${first[1]}`;
      refs.push(`${session}/T${first[2]}`);
      for (const part of parts.slice(1)) {
        const next = part.match(/^(?:S(\d+)\/)?T(\d+)$/);
        if (!next) {
          refs.length = 0;
          validSyntax = false;
          break;
        }
        if (next[1]) session = `S${next[1]}`;
        refs.push(`${session}/T${next[2]}`);
      }
    }
    return [{ raw: match[0], refs, index: match.index, members: parts, validSyntax }];
  });
}

/** Finds citation candidates whose content begins with an S<n>/T prefix. */
export function findCitationGroups(text: string): CitationGroup[] {
  return parseCitationGroups(text).map(({ raw, refs, index }) => ({ raw, refs, index }));
}

export interface CitationReportLocation {
  section: string;
  line: number;
}

export interface CitationValidationReportItem extends CitationReportLocation {
  original: string;
}

export interface CitationValidationReport {
  version: 2;
  total: number;
  stripped: number;
  items: CitationValidationReportItem[];
}

export interface StripInvalidCitationsResult {
  text: string;
  report: CitationValidationReport;
}

export interface CitationLineLocation {
  lineIndex: number;
  line: number;
}

/** Builds a reusable offset-to-line locator for citation validation reports. */
export function createCitationLineLocator(
  text: string,
): (offset: number) => CitationLineLocation {
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  return (citationOffset) => {
    let lineIndex = lineStarts.length - 1;
    while (lineIndex > 0 && lineStarts[lineIndex]! > citationOffset) lineIndex -= 1;
    return { lineIndex, line: lineIndex + 1 };
  };
}

function renderCitationGroup(refs: readonly string[]): string {
  let previousSession = "";
  const members = refs.map((ref, index) => {
    const match = ref.match(/^(S\d+)\/(T\d+)$/)!;
    const session = match[1]!;
    const rendered = index === 0 || session !== previousSession
      ? `${session}/${match[2]}`
      : match[2]!;
    previousSession = session;
    return rendered;
  });
  return `[${members.join("，")}]`;
}

/**
 * Removes only resolvable citation syntax that points outside the allow-set.
 * Malformed citation-like brackets are deliberately left byte-for-byte intact.
 */
export function stripInvalidCitations(
  text: string,
  allowedRefs: ReadonlySet<string>,
  locate: (offset: number) => CitationReportLocation,
): StripInvalidCitationsResult {
  const report: CitationValidationReport = {
    version: 2,
    total: 0,
    stripped: 0,
    items: [],
  };
  let cursor = 0;
  let output = "";

  for (const group of parseCitationGroups(text)) {
    if (!group.validSyntax) continue;
    output += text.slice(cursor, group.index);
    report.total += group.refs.length;
    const kept = group.refs.filter((ref) => allowedRefs.has(ref));
    const removed = group.refs.filter((ref) => !allowedRefs.has(ref));
    if (removed.length === 0) {
      output += group.raw;
    } else {
      report.stripped += removed.length;
      report.items.push({
        ...locate(group.index),
        original: kept.length === 0
          ? group.raw
          : group.members.filter((_, index) => !allowedRefs.has(group.refs[index]!)).join("，"),
      });
      output += kept.length === 0 ? "" : renderCitationGroup(kept);
    }
    cursor = group.index + group.raw.length;
  }

  output += text.slice(cursor);
  return { text: output, report };
}
