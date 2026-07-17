import { basename } from "node:path";

import {
  parseMarkdownSections,
  type MarkdownSection,
} from "../shared/markdown-sections";
import { sortDiaryIndexRecentFirst } from "./diary-index";
import { estimateDiaryTokens } from "./domain";

export const PROFILE_INJECTION_TOKEN_BUDGET = 2_000;
export const EXPERIENCE_INJECTION_TOKEN_BUDGET = 2_000;
export const DIARY_INDEX_INJECTION_TOKEN_BUDGET = 1_000;
export const SESSION_INJECTION_TOKEN_BUDGET = 2_000;

export interface SessionStartMemoryInjection {
  profile: string;
  experience: string;
  diaryIndex: string;
}

export interface SessionStartMemoryInjectionInput {
  userProfile: string;
  experience: string;
  diaryIndex: string;
  paths: {
    userProfile: string;
    experience: string;
    diaryIndex: string;
  };
}

const sectionPointer = (remainingLines: number, displayPath: string) =>
  `（本节还有 ${remainingLines} 行，完整见 ${displayPath}）`;

function headingLine(section: MarkdownSection): string | null {
  return section.level === 0
    ? null
    : `${"#".repeat(section.level)} ${section.title}`;
}

function renderSections(
  sections: readonly MarkdownSection[],
  includedLineCounts: readonly number[],
  displayPath: string,
  reserveEveryPointer = false,
): string {
  const lines: string[] = [];
  sections.forEach((section, index) => {
    const heading = headingLine(section);
    if (heading !== null) lines.push(heading);
    const included = includedLineCounts[index] ?? 0;
    lines.push(...section.bodyLines.slice(0, included));
    const remaining = section.bodyLines.length - included;
    if (remaining > 0 || reserveEveryPointer) {
      lines.push(sectionPointer(Math.max(remaining, 0), displayPath));
    }
  });
  return lines.join("\n");
}

/**
 * Renders the leading lines of every Markdown section within an injection budget.
 * The function is deliberately filesystem-free; displayPath is presentation only.
 */
export function renderPersonaDocumentInjection(
  document: string,
  injectionTokenBudget: number,
  displayPath: string,
): string {
  const sections = parseMarkdownSections(document);
  if (sections.length === 0) return "";

  const includedLineCounts = sections.map(() => 0);
  const skeleton = renderSections(
    sections,
    includedLineCounts,
    displayPath,
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
        );
        if (estimateDiaryTokens(candidate) > injectionTokenBudget) {
          includedLineCounts[sectionIndex] = lineIndex;
          break outer;
        }
      }
    }
    return renderSections(sections, includedLineCounts, displayPath);
  }

  const topLevelHeadings = sections
    .filter((section) => section.level === 1)
    .map((section) => headingLine(section)!);
  const documentPointer = `（内容省略，完整见 ${displayPath}）`;
  const headingFallback = [...topLevelHeadings, documentPointer].join("\n");
  if (estimateDiaryTokens(headingFallback) <= injectionTokenBudget) {
    return headingFallback;
  }

  return `（${basename(displayPath)} 过大，完整见 ${displayPath}）`;
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

function renderSessionStartExperienceBlock(input: {
  experience: string;
  path: string;
  tokenBudget: number;
}): string {
  return renderBoundedInjectionBlock({
    heading: "## Experience",
    document: input.experience,
    displayPath: input.path,
    tokenBudget: input.tokenBudget,
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

export function renderSessionStartExperienceInjection(input: {
  experience: string;
  diaryIndex: string;
  paths: {
    experience: string;
    diaryIndex: string;
  };
}): string {
  const diaryIndex = renderSessionStartDiaryIndex({
    diaryIndex: input.diaryIndex,
    path: input.paths.diaryIndex,
  });
  const separator = diaryIndex ? "\n\n" : "";
  const diaryTokens = estimateDiaryTokens(`${separator}${diaryIndex}`);
  const experienceBudget = Math.max(
    0,
    EXPERIENCE_INJECTION_TOKEN_BUDGET - diaryTokens,
  );
  const experience = renderSessionStartExperienceBlock({
    experience: input.experience,
    path: input.paths.experience,
    tokenBudget: experienceBudget,
  });
  const combined = `${experience}${separator}${diaryIndex}`;

  if (estimateDiaryTokens(combined) <= EXPERIENCE_INJECTION_TOKEN_BUDGET) {
    return combined;
  }

  return renderSessionStartExperienceBlock({
    experience: input.experience,
    path: input.paths.experience,
    tokenBudget: Math.max(0, experienceBudget - 1),
  }) + separator + diaryIndex;
}

export function renderSessionStartMemoryInjection(
  input: SessionStartMemoryInjectionInput,
): SessionStartMemoryInjection {
  return {
    profile: renderSessionStartPersonaInjection({
      userProfile: input.userProfile,
      path: input.paths.userProfile,
    }),
    experience: renderSessionStartExperienceBlock({
      experience: input.experience,
      path: input.paths.experience,
      tokenBudget: EXPERIENCE_INJECTION_TOKEN_BUDGET,
    }),
    diaryIndex: renderSessionStartDiaryIndex({
      diaryIndex: input.diaryIndex,
      path: input.paths.diaryIndex,
    }),
  };
}
