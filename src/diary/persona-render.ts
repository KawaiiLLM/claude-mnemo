import { basename } from "node:path";

import {
  parseMarkdownSections,
  type MarkdownSection,
} from "../shared/markdown-sections";
import { estimateDiaryTokens } from "./domain";

export const PROFILE_PUBLISHED_TOKEN_BUDGET = 4_000;
export const EXPERIENCE_PUBLISHED_TOKEN_BUDGET = 6_000;
export const PROFILE_INJECTION_TOKEN_BUDGET = 1_000;
export const EXPERIENCE_INJECTION_TOKEN_BUDGET = 1_500;
export const PERSONA_INJECTION_TOKEN_BUDGET =
  PROFILE_INJECTION_TOKEN_BUDGET + EXPERIENCE_INJECTION_TOKEN_BUDGET;

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

export function renderPersonaProfile(userProfile: string): string {
  return ["## Persona", "", userProfile.trim()].join("\n");
}

export function renderPersonaExperienceBody(experience: string): string {
  return experience.trim();
}

export function measurePublishedPersona(persona: {
  userProfile: string;
  experience: string;
}): { profileTokens: number; experienceTokens: number } {
  return {
    profileTokens: estimateDiaryTokens(renderPersonaProfile(persona.userProfile)),
    experienceTokens: estimateDiaryTokens(
      renderPersonaExperienceBody(persona.experience),
    ),
  };
}
