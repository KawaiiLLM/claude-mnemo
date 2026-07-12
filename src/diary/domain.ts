import { createHash } from "node:crypto";

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

export interface DiaryCitationGroup {
  raw: string;
  refs: string[];
  index: number;
}

/** Finds only bracket groups whose content begins with a full S<n>/T<n> ref. */
export function findDiaryCitationGroups(text: string): DiaryCitationGroup[] {
  return [...text.matchAll(/\[(S\d+\/T[^\]\r\n]*)\]/g)].map((match) => {
    const content = match[1]!;
    const parts = content.split("，").map((part) => part.trim());
    const first = parts[0]!.match(/^S(\d+)\/T(\d+)$/);
    const refs: string[] = [];
    if (first) {
      let session = `S${first[1]}`;
      refs.push(`${session}/T${first[2]}`);
      for (const part of parts.slice(1)) {
        const next = part.match(/^(?:S(\d+)\/)?T(\d+)$/);
        if (!next) {
          refs.length = 0;
          break;
        }
        if (next[1]) session = `S${next[1]}`;
        refs.push(`${session}/T${next[2]}`);
      }
    }
    return { raw: match[0], refs, index: match.index };
  });
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

export interface DiaryValidationReportItem {
  section: DiarySectionName;
  sha256: string;
  preview: string;
}

export interface DiaryValidationReport {
  version: 1;
  total: number;
  deleted: number;
  items: DiaryValidationReportItem[];
}

export interface ValidatedDiaryCitations {
  ok: true;
  body: string;
  indexHook: string;
  report: DiaryValidationReport;
}

export interface InvalidDiaryCitations {
  ok: false;
  code: "empty_diary" | "excessive_deletions";
  report: DiaryValidationReport;
}

export type DiaryCitationValidationResult =
  | ValidatedDiaryCitations
  | InvalidDiaryCitations;

function bulletIsValid(bullet: string, allowedRefs: ReadonlySet<string>): boolean {
  const groups = findDiaryCitationGroups(bullet);
  if (
    groups.length !== 1 ||
    groups[0]!.refs.length === 0 ||
    groups[0]!.refs.some((ref) => !allowedRefs.has(ref))
  ) {
    return false;
  }
  const withoutCitation = bullet
    .replace(groups[0]!.raw, "")
    .replace(/^- /, "")
    .replace(/\s/gu, "");
  return Array.from(withoutCitation).length >= 1;
}

function bulletTextWithoutCitation(bullet: string): string {
  let text = bullet.replace(/^- /, "");
  for (const group of findDiaryCitationGroups(text)) text = text.replace(group.raw, "");
  return text.replace(/\r?\n/g, "").trim();
}

export function validateDiaryCitations(
  body: string,
  allowedRefs: ReadonlySet<string>,
  agentIndexHook = "",
): DiaryCitationValidationResult {
  const ast = parseDiaryBody(body);
  const report: DiaryValidationReport = { version: 1, total: 0, deleted: 0, items: [] };
  const survivingByBlock = new Map<DiaryBlock, DiaryBullet[]>();

  for (const section of ast) {
    for (const block of section.blocks) {
      const surviving: DiaryBullet[] = [];
      survivingByBlock.set(block, surviving);
      for (const bullet of block.bullets) {
        report.total += 1;
        const completeBullet = bullet.lines.join("\n");
        if (bulletIsValid(completeBullet, allowedRefs)) {
          surviving.push(bullet);
          continue;
        }
        report.deleted += 1;
        if (report.items.length < 20) {
          report.items.push({
            section: section.heading.slice(3) as DiarySectionName,
            sha256: createHash("sha256").update(completeBullet, "utf8").digest("hex"),
            preview: Array.from(stripDiaryPrivateContent(completeBullet)).slice(0, 80).join(""),
          });
        }
      }
    }
  }

  if (report.total === 0) return { ok: false, code: "empty_diary", report };
  if (report.deleted * 3 > report.total) {
    return { ok: false, code: "excessive_deletions", report };
  }

  const output: string[] = [];
  for (const section of ast) {
    output.push(section.heading);
    for (const block of section.blocks) {
      const surviving = survivingByBlock.get(block)!;
      if (surviving.length === 0) continue;
      if (block.guide !== undefined) output.push(block.guide);
      for (const bullet of surviving) output.push(...bullet.lines);
    }
  }

  const indexHook = report.deleted === 0
    ? agentIndexHook
    : Array.from(
        ast.flatMap((section) =>
          section.blocks.flatMap((block) => {
            const first = survivingByBlock.get(block)?.[0];
            return first ? [bulletTextWithoutCitation(first.lines.join("\n"))] : [];
          }),
        ).join("；"),
      ).slice(0, INDEX_HOOK_LIMIT).join("");

  return { ok: true, body: output.join("\n"), indexHook, report };
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
