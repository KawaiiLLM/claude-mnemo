import { basename } from "node:path";

import {
  parseMarkdownSections,
  type MarkdownSection,
} from "../shared/markdown-sections";
import { sortDiaryIndexRecentFirst } from "./diary-index";
import { estimateDiaryTokens } from "./domain";

export const PROFILE_INJECTION_TOKEN_BUDGET = 2_000;
export const DIARY_INDEX_INJECTION_TOKEN_BUDGET = 1_000;
export const SESSION_INJECTION_TOKEN_BUDGET = 2_000;

const sectionPointer = (remainingLines: number, displayPath: string) =>
  `（本节还有 ${remainingLines} 行，完整见 ${displayPath}）`;

const documentPointer = (remainingLines: number, displayPath: string) =>
  `（其余 ${remainingLines} 行省略，完整见 ${displayPath}）`;

export interface RenderPersonaDocumentOptions {
  sectionDisplayPaths?: readonly (string | null | undefined)[];
}

function headingLine(section: MarkdownSection): string | null {
  return section.level === 0
    ? null
    : `${"#".repeat(section.level)} ${section.title}`;
}

function renderSections(
  sections: readonly MarkdownSection[],
  includedLineCounts: readonly number[],
  displayPath: string,
  options: RenderPersonaDocumentOptions,
  reserveEveryPointer = false,
): string {
  const lines: string[] = [];
  let documentRemainingLines = 0;
  sections.forEach((section, index) => {
    const heading = headingLine(section);
    if (heading !== null) lines.push(heading);
    const included = includedLineCounts[index] ?? 0;
    lines.push(...section.bodyLines.slice(0, included));
    const remaining = section.bodyLines.length - included;
    if (remaining <= 0 && !reserveEveryPointer) {
      return;
    }

    const pointerTarget =
      options.sectionDisplayPaths?.[index] ?? displayPath;
    if (pointerTarget !== displayPath) {
      if (remaining > 0) {
        lines.push(sectionPointer(remaining, pointerTarget));
      }
      return;
    }

    documentRemainingLines += Math.max(remaining, 0);
  });
  if (documentRemainingLines > 0) {
    lines.push(documentPointer(documentRemainingLines, displayPath));
  }
  return lines.join("\n");
}

function fallbackPointerLines(
  sections: readonly MarkdownSection[],
  displayPath: string,
  options: RenderPersonaDocumentOptions,
): string[] {
  const remainingByTarget = new Map<string, number>();
  sections.forEach((section, index) => {
    if (section.bodyLines.length === 0) {
      return;
    }
    const target = options.sectionDisplayPaths?.[index] ?? displayPath;
    remainingByTarget.set(
      target,
      (remainingByTarget.get(target) ?? 0) + section.bodyLines.length,
    );
  });

  const hasDistinctTarget = [...remainingByTarget.keys()].some(
    (target) => target !== displayPath,
  );
  if (!hasDistinctTarget) {
    return [`（内容省略，完整见 ${displayPath}）`];
  }

  return [...remainingByTarget].map(([target, remainingLines]) =>
    documentPointer(remainingLines, target)
  );
}

/**
 * Renders the leading lines of every Markdown section within an injection budget.
 * The function is deliberately filesystem-free; displayPath is presentation only.
 */
export function renderPersonaDocumentInjection(
  document: string,
  injectionTokenBudget: number,
  displayPath: string,
  options: RenderPersonaDocumentOptions = {},
): string {
  const sections = parseMarkdownSections(document);
  if (sections.length === 0) return "";

  const includedLineCounts = sections.map(() => 0);
  const skeleton = renderSections(
    sections,
    includedLineCounts,
    displayPath,
    options,
    true,
  );
  if (estimateDiaryTokens(skeleton) <= injectionTokenBudget) {
    outer: for (
      let sectionIndex = 0;
      sectionIndex < sections.length;
      sectionIndex += 1
    ) {
      const section = sections[sectionIndex]!;
      for (
        let lineIndex = 0;
        lineIndex < section.bodyLines.length;
        lineIndex += 1
      ) {
        includedLineCounts[sectionIndex] = lineIndex + 1;
        const candidate = renderSections(
          sections,
          includedLineCounts,
          displayPath,
          options,
        );
        if (estimateDiaryTokens(candidate) > injectionTokenBudget) {
          includedLineCounts[sectionIndex] = lineIndex;
          break outer;
        }
      }
    }
    return renderSections(sections, includedLineCounts, displayPath, options);
  }

  const topLevelHeadings = sections
    .filter((section) => section.level === 1)
    .map((section) => headingLine(section)!);
  const fallbackPointers = fallbackPointerLines(
    sections,
    displayPath,
    options,
  );
  const headingFallback = [...topLevelHeadings, ...fallbackPointers].join("\n");
  if (estimateDiaryTokens(headingFallback) <= injectionTokenBudget) {
    return headingFallback;
  }

  const distinctTargets = [
    ...new Set(
      (options.sectionDisplayPaths ?? [])
        .filter((target): target is string => Boolean(target))
        .filter((target) => target !== displayPath),
    ),
  ];
  const alternateTargets =
    distinctTargets.length > 0 ? `；另见 ${distinctTargets.join("、")}` : "";
  return `（${basename(displayPath)} 过大，完整见 ${displayPath}${alternateTargets}）`;
}

function renderBoundedInjectionBlock(input: {
  heading: string;
  document: string;
  displayPath: string;
  tokenBudget: number;
}): string {
  for (
    let documentBudget = input.tokenBudget;
    documentBudget >= 0;
    documentBudget -= 1
  ) {
    const documentView = renderPersonaDocumentInjection(
      input.document,
      documentBudget,
      input.displayPath,
    );
    const block = [
      input.heading,
      ...(documentView ? ["", documentView] : []),
    ].join("\n");
    if (estimateDiaryTokens(block) <= input.tokenBudget) return block;
  }

  return input.heading;
}

export function renderSessionStartPersonaInjection(input: {
  userProfile: string;
  path: string;
}): string {
  return renderBoundedInjectionBlock({
    heading: "## Persona",
    document: input.userProfile,
    displayPath: input.path,
    tokenBudget: PROFILE_INJECTION_TOKEN_BUDGET,
  });
}

function renderSessionStartDiaryIndex(input: {
  diaryIndex: string;
  path: string;
}): string {
  return renderPersonaDocumentInjection(
    sortDiaryIndexRecentFirst(input.diaryIndex),
    DIARY_INDEX_INJECTION_TOKEN_BUDGET,
    input.path,
  );
}

export function renderSessionStartRecentSessionsInjection(input: {
  recentSessions: string;
  diaryIndex: string;
  paths: {
    recentSessions: string;
    diaryIndex: string;
  };
}): string {
  const diaryIndex = renderSessionStartDiaryIndex({
    diaryIndex: input.diaryIndex,
    path: input.paths.diaryIndex,
  });
  const separator =
    input.recentSessions.trim().length > 0 && diaryIndex ? "\n\n" : "";
  const diaryTokens = estimateDiaryTokens(`${separator}${diaryIndex}`);
  let recentBudget = Math.max(
    0,
    SESSION_INJECTION_TOKEN_BUDGET - diaryTokens,
  );

  while (recentBudget >= 0) {
    const recentSessions = input.recentSessions.trim().length > 0
      ? renderBoundedInjectionBlock({
          heading: "## Recent Sessions",
          document: input.recentSessions,
          displayPath: input.paths.recentSessions,
          tokenBudget: recentBudget,
        })
      : "";
    const combined = `${recentSessions}${separator}${diaryIndex}`;
    if (estimateDiaryTokens(combined) <= SESSION_INJECTION_TOKEN_BUDGET) {
      return combined;
    }
    recentBudget -= 1;
  }

  return diaryIndex;
}
