import { createHash } from "node:crypto";
import {
  createCitationLineLocator,
  findCitationGroups,
  stripInvalidCitations,
  type CitationGroup,
  type CitationValidationReport,
} from "../shared/citation-validation";

const UTC_PLUS_EIGHT_SECONDS = 8 * 60 * 60;
const DIARY_BODY_LIMIT = 64 * 1_024;
const INDEX_HOOK_LIMIT = 160;

export const DIARY_SECTION_HEADINGS = [
  "## 工作",
  "## 人物",
  "## 反思",
] as const;

export type DiarySection = (typeof DIARY_SECTION_HEADINGS)[number];
export type DiarySectionName = "工作" | "人物" | "反思";

export function diaryDayOf(epochSeconds: number): string {
  return new Date((epochSeconds + UTC_PLUS_EIGHT_SECONDS) * 1_000)
    .toISOString()
    .slice(0, 10);
}

export function encodeSource(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export interface DiaryWatermarkMaterial {
  turnId: number;
  status: string;
  userPrompt: string | null;
  assistantResponse: string | null;
  title: string | null;
  content: string | null;
  insight: string | null;
}

export function truncateDiaryResponse(value: string): string {
  return Array.from(value).slice(0, 2_000).join("");
}

export function computeDiaryWatermark(
  material: readonly DiaryWatermarkMaterial[],
): string {
  if (material.length === 0) return "empty";

  const turnHashes = [...material]
    .sort((left, right) => left.turnId - right.turnId)
    .map((turn) =>
      createHash("sha256")
        .update(
          [
            turn.userPrompt ?? "",
            truncateDiaryResponse(turn.assistantResponse ?? ""),
            turn.title ?? "",
            turn.content ?? "",
            turn.insight ?? "",
            turn.status,
          ].join("\u0000"),
        )
        .digest("hex"),
    );

  return createHash("sha256")
    .update(turnHashes.join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

const MALFORMED_PRIVATE_CONTENT = "[redacted: malformed private content]";

export function stripDiaryPrivateContent(text: string): string {
  let privateBlockCount = 0;
  const stripped = text.replace(/<private>[\s\S]*?<\/private>/g, () => {
    privateBlockCount += 1;
    return "";
  });

  if (
    privateBlockCount > 100 ||
    stripped.includes("<private>") ||
    stripped.includes("</private>")
  ) {
    return MALFORMED_PRIVATE_CONTENT;
  }

  return stripped;
}

export interface ParsedDiaryEnvelope {
  body: string;
  indexHook: string;
}

interface DiaryBullet {
  section: DiarySection;
  lines: string[];
}

interface DiaryBlock {
  guide?: string;
  bullets: DiaryBullet[];
}

interface DiarySectionAst {
  heading: DiarySection;
  blocks: DiaryBlock[];
}

const PROJECT_GUIDE = /^\*\*[^*\r\n]+\*\*$/;

function parseDiaryBody(body: string): DiarySectionAst[] {
  const lines = body.split("\n");
  const headingIndexes = lines.flatMap((line, index) =>
    line.startsWith("## ") ? [index] : [],
  );
  if (
    headingIndexes.length !== DIARY_SECTION_HEADINGS.length ||
    headingIndexes.some(
      (lineIndex, index) => lines[lineIndex] !== DIARY_SECTION_HEADINGS[index],
    ) ||
    headingIndexes[0] !== 0
  ) {
    throw new Error("invalid diary section structure");
  }

  return DIARY_SECTION_HEADINGS.map((heading, sectionIndex) => {
    const start = headingIndexes[sectionIndex]! + 1;
    const end = headingIndexes[sectionIndex + 1] ?? lines.length;
    const sectionLines = lines.slice(start, end);
    const blocks: DiaryBlock[] = [];
    let block: DiaryBlock = { bullets: [] };
    let currentBullet: DiaryBullet | undefined;

    for (let index = 0; index < sectionLines.length; index += 1) {
      const line = sectionLines[index]!;
      if (line.startsWith("- ")) {
        currentBullet = { section: heading, lines: [line] };
        block.bullets.push(currentBullet);
        continue;
      }

      if (PROJECT_GUIDE.test(line)) {
        if (heading !== "## 工作" || sectionLines[index + 1]?.startsWith("- ") !== true) {
          throw new Error("invalid diary project guide");
        }
        if (block.guide !== undefined || block.bullets.length > 0) blocks.push(block);
        block = { guide: line, bullets: [] };
        currentBullet = undefined;
        continue;
      }

      if (currentBullet !== undefined) {
        currentBullet.lines.push(line);
        continue;
      }

      if (line.trim() !== "") {
        throw new Error("invalid diary continuation line");
      }
      if (block.guide !== undefined) {
        throw new Error("project guide must be immediately followed by a bullet");
      }
    }

    if (block.guide !== undefined || block.bullets.length > 0) blocks.push(block);
    return { heading, blocks };
  });
}

export function parseDiaryEnvelope(raw: string): ParsedDiaryEnvelope {
  const begin = "===DIARY_V2_BEGIN===";
  const end = "===DIARY_V2_END===";
  const hook = "===INDEX_HOOK_V1===";
  const lines = raw.split("\n");
  for (const sentinel of [begin, end, hook]) {
    if (lines.filter((line) => line === sentinel).length !== 1) {
      throw new Error(`invalid diary envelope sentinel: ${sentinel}`);
    }
  }

  const endLine = lines.indexOf(end);
  const hookLine = lines.indexOf(hook);
  if (
    lines[0] !== begin ||
    endLine <= 1 ||
    hookLine !== endLine + 1 ||
    hookLine !== lines.length - 2
  ) {
    throw new Error("invalid diary envelope ordering");
  }

  const body = lines.slice(1, endLine).join("\n");
  const indexHook = lines.at(-1) ?? "";
  if (Array.from(body).length > DIARY_BODY_LIMIT) {
    throw new Error("diary body exceeds 64K characters");
  }
  if (indexHook.length === 0 || Array.from(indexHook).length > INDEX_HOOK_LIMIT) {
    throw new Error("invalid diary index hook");
  }
  parseDiaryBody(body);
  return { body, indexHook };
}

export function stripIndexHookDatePrefix(indexHook: string, date: string): string {
  const stripped = indexHook
    .replace(new RegExp(`^${date}\\s*[：:]\\s*`), "")
    .trim();
  return stripped.length > 0 ? stripped : indexHook;
}

export interface CompileDiaryDocumentInput {
  date: string;
  sessions: readonly string[];
  projects: readonly string[];
  watermark: string;
  indexHook: string;
  body: string;
}

export function compileDiaryDocument(input: CompileDiaryDocumentInput): Uint8Array {
  const sessions = [...new Set(input.sessions)].sort();
  const projects = [...new Set(input.projects)].sort();
  const body = input.body.replace(/\n+$/, "");
  const document = [
    "---",
    "format: 2",
    `date: ${JSON.stringify(input.date)}`,
    `sessions: ${JSON.stringify(sessions)}`,
    `projects: ${JSON.stringify(projects)}`,
    `watermark: ${JSON.stringify(input.watermark)}`,
    `index_hook: ${JSON.stringify(input.indexHook)}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
  return new TextEncoder().encode(document);
}

export type DiaryCitationGroup = CitationGroup;

/** Finds only bracket groups whose content begins with a full S<n>/T<n> ref. */
export function findDiaryCitationGroups(text: string): DiaryCitationGroup[] {
  return findCitationGroups(text);
}

export function collectDiaryCitationRefs(values: readonly string[]): Set<string> {
  const refs = new Set<string>();
  for (const value of values) {
    for (const group of findDiaryCitationGroups(value)) {
      for (const ref of group.refs) refs.add(ref);
    }
  }
  return refs;
}

export type DiaryValidationReport = CitationValidationReport;

export interface ValidatedDiaryCitations {
  ok: true;
  body: string;
  indexHook: string;
  report: DiaryValidationReport;
}

export type DiaryCitationValidationResult = ValidatedDiaryCitations;

export function validateDiaryCitations(
  body: string,
  allowedRefs: ReadonlySet<string>,
  agentIndexHook = "",
): DiaryCitationValidationResult {
  parseDiaryBody(body);
  const lines = body.split("\n");
  const locateLine = createCitationLineLocator(body);
  const located = stripInvalidCitations(body, allowedRefs, (citationOffset) => {
    const { lineIndex, line } = locateLine(citationOffset);
    let section: DiarySectionName = "工作";
    for (let index = lineIndex; index >= 0; index -= 1) {
      const heading = lines[index];
      if (heading?.startsWith("## ")) {
        section = heading.slice(3) as DiarySectionName;
        break;
      }
    }
    return { section, line };
  });

  return {
    ok: true,
    body: located.text,
    indexHook: agentIndexHook,
    report: located.report,
  };
}

export type DiaryDocumentValidationResult =
  | { ok: true; format: 2 }
  | { ok: false; code: "invalid_utf8" | "invalid_frontmatter" | "invalid_format" };

/** Strictly validates the v2 discriminator without throwing. */
export function validateDiaryDocument(
  document: string | Uint8Array,
): DiaryDocumentValidationResult {
  let text: string;
  try {
    text = typeof document === "string"
      ? document
      : new TextDecoder("utf-8", { fatal: true }).decode(document);
  } catch {
    return { ok: false, code: "invalid_utf8" };
  }
  const lines = text.split("\n");
  if (lines[0] !== "---") return { ok: false, code: "invalid_frontmatter" };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { ok: false, code: "invalid_frontmatter" };
  const formatLines = lines.slice(1, end).filter((line) => line.startsWith("format:"));
  if (formatLines.length !== 1 || formatLines[0] !== "format: 2") {
    return { ok: false, code: "invalid_format" };
  }
  return { ok: true, format: 2 };
}

export function estimateDiaryTokens(text: string): number {
  let weightedCodePoints = 0;
  for (const codePoint of text) {
    weightedCodePoints += /\p{Script=Han}/u.test(codePoint) ? 1.1 : 0.6;
  }
  return Math.ceil(weightedCodePoints * 1.2);
}
