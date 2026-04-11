import type { Database } from "bun:sqlite";

import { getSessionByContentId } from "../../db/sessions";
import { parseReplayTranscript, readAllTranscriptEntries } from "../../shared/transcript-parser";
import type { HookResult, NormalizedHookInput } from "../types";

export interface PostCompactHandlerDependencies {
  db: Database;
  now?: () => number;
}

interface CompactBoundaryEntry {
  uuid: string;
  compactMetadata?: {
    trigger?: string;
    preCompactTokenCount?: number;
    pre_tokens?: number;
  };
}

function getRawContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block): block is { type?: unknown; text?: unknown } => {
      return Boolean(block) && typeof block === "object";
    })
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
}

function findLatestCompactBoundary(
  transcriptPath: string,
): CompactBoundaryEntry | null {
  const entries = readAllTranscriptEntries(transcriptPath);

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (
      entry?.type === "system" &&
      entry.subtype === "compact_boundary" &&
      entry.uuid
    ) {
      return {
        uuid: entry.uuid,
        compactMetadata: entry.compactMetadata,
      };
    }
  }

  return null;
}

function findSummaryWrapper(
  transcriptPath: string,
  boundaryUuid: string,
): {
  promptId: string;
  lineNumber: number;
  content: string;
} | null {
  const entries = readAllTranscriptEntries(transcriptPath);
  const boundaryIndex = entries.findIndex(
    (entry) =>
      entry.type === "system" &&
      entry.subtype === "compact_boundary" &&
      entry.uuid === boundaryUuid,
  );

  if (boundaryIndex === -1) {
    return null;
  }

  const nextEntry = entries[boundaryIndex + 1];
  if (
    !nextEntry ||
    nextEntry.role !== "user" ||
    nextEntry.parentUuid !== boundaryUuid ||
    !nextEntry.promptId
  ) {
    return null;
  }

  const content = getRawContentText(nextEntry.content);
  if (!content) {
    return null;
  }

  return {
    promptId: nextEntry.promptId,
    lineNumber: nextEntry.lineNumber,
    content,
  };
}

function resolvePromptNumber(
  transcriptPath: string,
  promptId: string,
): number | null {
  return (
    parseReplayTranscript(transcriptPath).find((turn) => turn.promptId === promptId)
      ?.promptNumber ?? null
  );
}

function resolvePreCompactTokens(
  input: NormalizedHookInput,
  boundary: CompactBoundaryEntry,
): number | null {
  const rawMetadata =
    input.raw.compact_metadata && typeof input.raw.compact_metadata === "object"
      ? (input.raw.compact_metadata as {
          preCompactTokenCount?: unknown;
          pre_tokens?: unknown;
        })
      : null;

  if (typeof rawMetadata?.preCompactTokenCount === "number") {
    return rawMetadata.preCompactTokenCount;
  }

  if (typeof rawMetadata?.pre_tokens === "number") {
    return rawMetadata.pre_tokens;
  }

  if (typeof boundary.compactMetadata?.preCompactTokenCount === "number") {
    return boundary.compactMetadata.preCompactTokenCount;
  }

  if (typeof boundary.compactMetadata?.pre_tokens === "number") {
    return boundary.compactMetadata.pre_tokens;
  }

  return null;
}

function resolveTrigger(
  input: NormalizedHookInput,
  boundary: CompactBoundaryEntry,
): "manual" | "auto" {
  if (input.trigger === "auto" || input.trigger === "manual") {
    return input.trigger;
  }

  if (
    boundary.compactMetadata?.trigger === "auto" ||
    boundary.compactMetadata?.trigger === "manual"
  ) {
    return boundary.compactMetadata.trigger;
  }

  return "manual";
}

export function createPostCompactHandler(
  dependencies: PostCompactHandlerDependencies,
) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));

  return async function handlePostCompactHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (!input.sessionId || !input.transcriptPath) {
      return { continue: true };
    }

    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }

    const boundary = findLatestCompactBoundary(input.transcriptPath);
    if (!boundary) {
      return { continue: true };
    }

    const summaryWrapper = findSummaryWrapper(input.transcriptPath, boundary.uuid);
    if (!summaryWrapper) {
      return { continue: true };
    }

    const promptNumber = resolvePromptNumber(
      input.transcriptPath,
      summaryWrapper.promptId,
    );
    if (promptNumber === null) {
      return { continue: true };
    }

    const preCompactTokens = resolvePreCompactTokens(input, boundary);
    const trigger = resolveTrigger(input, boundary);
    const tags = [
      `compact:pre_tokens=${preCompactTokens ?? 0}`,
      `compact:trigger=${trigger}`,
    ];

    dependencies.db
      .query<
        never,
        [
          number,
          number,
          string,
          string,
          string,
          string,
          number,
          string,
          string,
          string,
          number,
        ]
      >(
        `INSERT OR IGNORE INTO turns (
          session_id,
          prompt_number,
          content_prompt_id,
          status,
          title,
          content,
          type,
          transcript_line_start,
          tags,
          files_read,
          files_modified,
          tool_call_count,
          created_at_epoch
        ) VALUES (?, ?, ?, 'extracted', ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        session.id,
        promptNumber,
        summaryWrapper.promptId,
        "/compact",
        summaryWrapper.content,
        "compact",
        summaryWrapper.lineNumber,
        JSON.stringify(tags),
        "[]",
        "[]",
        now(),
      );

    return { continue: true };
  };
}
