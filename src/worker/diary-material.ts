import type { Database } from "bun:sqlite";

import type { TurnStatus } from "../db/turns";
import {
  estimateDiaryTokens,
  stripDiaryPrivateContent,
} from "../diary/domain";
import { calendarDayBounds } from "../diary/calendar";
import { DEFAULT_DREAM_AGENT_TIME_ZONE } from "../shared/config";

export const DIARY_MATERIAL_FIELD_TOKEN_BUDGET = 200;
const INTERNAL_TURN_ID_PATTERN = /\[T(\d+)\]/g;
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });

export interface DiaryMaterialRow {
  turnId: number;
  sessionId: number;
  project: string;
  sessionTitle: string | null;
  promptNumber: number;
  status: TurnStatus;
  userPrompt: string | null;
  assistantResponse: string | null;
  title: string | null;
  content: string | null;
  insight: string | null;
}

export interface DiaryTurnReference {
  sessionId: number;
  promptNumber: number;
}

export type DiaryTurnReferences = ReadonlyMap<number, DiaryTurnReference>;

export function loadDiaryMaterial(
  db: Database,
  date: string,
  timeZone = DEFAULT_DREAM_AGENT_TIME_ZONE,
): DiaryMaterialRow[] {
  const { startEpoch, endEpoch } = calendarDayBounds(date, timeZone);

  return db
    .query<DiaryMaterialRow, [number, number]>(
      `
        SELECT
          t.id AS turnId,
          s.id AS sessionId,
          s.project,
          s.title AS sessionTitle,
          t.prompt_number AS promptNumber,
          t.status,
          t.user_prompt AS userPrompt,
          t.assistant_response AS assistantResponse,
          t.title,
          t.content,
          t.insight
        FROM turns t
        JOIN sessions s ON s.id = t.session_id
        WHERE t.created_at_epoch >= ?
          AND t.created_at_epoch < ?
          AND t.status != 'undone'
        ORDER BY s.project ASC, s.id ASC, t.id ASC
      `,
    )
    .all(startEpoch, endEpoch);
}

interface RenderedDiaryMaterialBase {
  kind: "turn_manifest";
  ref: string;
  number: number;
  status: TurnStatus;
  user_prompt: string;
}

export type RenderedDiaryMaterial =
  | (RenderedDiaryMaterialBase & { summary: string })
  | (RenderedDiaryMaterialBase & {
    response: string;
    response_trust?: "low";
  });

function lastBoundaryIndex(
  value: string,
  codePoints: readonly string[],
  maxCodePoints: number,
): number {
  let sentenceBoundary = 0;
  let wordBoundary = 0;

  for (let index = 0; index < maxCodePoints; index += 1) {
    const codePoint = codePoints[index]!;
    if (/[。！？.!?；;\n]/u.test(codePoint)) {
      sentenceBoundary = index + 1;
      while (
        sentenceBoundary < maxCodePoints &&
        /[”’」』】）)]/u.test(codePoints[sentenceBoundary]!)
      ) {
        sentenceBoundary += 1;
      }
    }
  }

  for (const segment of WORD_SEGMENTER.segment(value)) {
    if (!segment.isWordLike) continue;
    const end = Array.from(
      value.slice(0, segment.index + segment.segment.length),
    ).length;
    if (end > maxCodePoints) break;
    wordBoundary = end;
  }

  return Math.max(sentenceBoundary, wordBoundary);
}

function truncateMaterialField(value: string): string {
  const normalized = stripDiaryPrivateContent(value).trim();
  if (
    estimateDiaryTokens(normalized) <= DIARY_MATERIAL_FIELD_TOKEN_BUDGET
  ) {
    return normalized;
  }

  const codePoints = Array.from(normalized);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${codePoints.slice(0, middle).join("").trimEnd()}…`;
    if (estimateDiaryTokens(candidate) <= DIARY_MATERIAL_FIELD_TOKEN_BUDGET) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  const boundary = lastBoundaryIndex(normalized, codePoints, low);
  return `${codePoints.slice(0, boundary).join("").trimEnd()}…`;
}

function materialValue(value: string | null, fallback: string): string {
  return truncateMaterialField(value?.trim() || fallback);
}

function dropLeadingTitle(content: string, title: string): string {
  if (!content.startsWith(title)) return content;
  const remainder = content.slice(title.length);
  if (remainder.length === 0) return "";
  if (!/^[\s:：—–-]/u.test(remainder)) return content;
  return remainder.replace(/^[\s:：—–-]+/u, "").trim();
}

function rewriteInternalTurnIds(
  value: string,
  turnReferences: DiaryTurnReferences,
): string {
  return value.replace(INTERNAL_TURN_ID_PATTERN, (literal, idDigits: string) => {
    const reference = turnReferences.get(Number.parseInt(idDigits, 10));
    return reference
      ? `[S${reference.sessionId}/T${reference.promptNumber}]`
      : literal;
  });
}

export function loadDiaryTurnReferences(
  db: Database,
  rows: readonly Pick<DiaryMaterialRow, "title" | "content">[],
): Map<number, DiaryTurnReference> {
  const turnIds = new Set<number>();
  for (const row of rows) {
    for (const value of [row.title, row.content]) {
      if (!value) continue;
      for (const match of value.matchAll(INTERNAL_TURN_ID_PATTERN)) {
        turnIds.add(Number.parseInt(match[1]!, 10));
      }
    }
  }

  const findReference = db.query<DiaryTurnReference, [number]>(
    `SELECT t.session_id AS sessionId, t.prompt_number AS promptNumber
     FROM turns t
     JOIN sessions s ON s.id = t.session_id
     WHERE t.id = ?`,
  );
  const references = new Map<number, DiaryTurnReference>();
  for (const turnId of turnIds) {
    const reference = findReference.get(turnId);
    // Unknown ids and dangling session rows stay opaque in rendered material.
    if (reference) references.set(turnId, reference);
  }
  return references;
}

export function renderDiaryMaterial(
  row: DiaryMaterialRow,
  turnReferences: DiaryTurnReferences,
): RenderedDiaryMaterial {
  const base: RenderedDiaryMaterialBase = {
    kind: "turn_manifest",
    ref: `S${row.sessionId}/T${row.promptNumber}`,
    number: row.promptNumber,
    status: row.status,
    user_prompt: materialValue(row.userPrompt, "（无 prompt）"),
  };

  if (row.status === "extracted") {
    const title = rewriteInternalTurnIds(
      row.title?.trim() || "",
      turnReferences,
    );
    const content = rewriteInternalTurnIds(
      row.content?.trim() || "",
      turnReferences,
    );
    const contentWithoutTitle = title
      ? dropLeadingTitle(content, title)
      : content;
    return {
      ...base,
      summary: truncateMaterialField(
        contentWithoutTitle || title || "（无摘要）",
      ),
    };
  }

  return {
    ...base,
    response: materialValue(row.assistantResponse, "（无 response）"),
    ...(row.status === "skipped" ? { response_trust: "low" as const } : {}),
  };
}

export function renderDiaryMaterialLines(
  rows: readonly DiaryMaterialRow[],
  turnReferences: DiaryTurnReferences,
): string[] {
  const lines: string[] = [];
  let previousSessionId: number | null = null;
  for (const row of rows) {
    if (row.sessionId !== previousSessionId) {
      lines.push(JSON.stringify({
        kind: "session_manifest",
        ref: `S${row.sessionId}`,
        project: row.project,
        title: row.sessionTitle?.trim() || "（无标题）",
      }));
      previousSessionId = row.sessionId;
    }
    lines.push(JSON.stringify(renderDiaryMaterial(row, turnReferences)));
  }
  return lines;
}
