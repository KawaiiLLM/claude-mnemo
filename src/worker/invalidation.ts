import type { Database } from "bun:sqlite";

import { getTurnsForSession, updateTurnById } from "../db/turns";
import {
  detectInterruptedPromptIds,
  isChainParticipant,
  readAllTranscriptEntries,
  type TranscriptEntryWithLineNumber,
} from "../shared/transcript-parser";

export interface ReminderItem {
  turnId: number;
  promptNumber: number;
  wasInterrupted: boolean;
  wasRolledBack: boolean;
  priorTitle: string | null;
  replacementPromptNumber: number | null;
}

function selectLatestMainLeaf(
  entries: TranscriptEntryWithLineNumber[],
): TranscriptEntryWithLineNumber | null {
  const parentSet = new Set(
    entries
      .map((entry) => entry.parentUuid)
      .filter((uuid): uuid is string => Boolean(uuid)),
  );

  const leaves = entries.filter(
    (entry) =>
      entry.uuid &&
      !parentSet.has(entry.uuid) &&
      entry.isSidechain !== true &&
      isChainParticipant(entry),
  );

  if (leaves.length === 0) {
    return null;
  }

  return leaves.reduce((latest, entry) => {
    const latestTime = latest.timestamp ?? "";
    const entryTime = entry.timestamp ?? "";
    if (entryTime > latestTime) {
      return entry;
    }
    if (entryTime === latestTime && entry.lineNumber > latest.lineNumber) {
      return entry;
    }
    return latest;
  });
}

export function detectRolledBackPromptIds(transcriptPath: string): Set<string> {
  const entries = readAllTranscriptEntries(transcriptPath);
  if (entries.length === 0) {
    return new Set();
  }

  const byUuid = new Map(
    entries
      .filter((entry): entry is TranscriptEntryWithLineNumber & { uuid: string } =>
        typeof entry.uuid === "string",
      )
      .map((entry) => [entry.uuid, entry] as const),
  );
  const childrenByParent = new Map<string, TranscriptEntryWithLineNumber[]>();

  for (const entry of entries) {
    if (!entry.parentUuid) {
      continue;
    }
    const children = childrenByParent.get(entry.parentUuid) ?? [];
    children.push(entry);
    childrenByParent.set(entry.parentUuid, children);
  }

  const tip = selectLatestMainLeaf(entries);
  if (!tip?.uuid) {
    return new Set();
  }

  const mainChainUuids = new Set<string>();
  let cursor: TranscriptEntryWithLineNumber | undefined = tip;
  while (cursor?.uuid) {
    mainChainUuids.add(cursor.uuid);
    cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined;
  }

  const rolledBackPromptIds = new Set<string>();
  for (const children of childrenByParent.values()) {
    for (const child of children) {
      if (
        child.role === "user" &&
        child.promptId &&
        child.isSidechain !== true &&
        isChainParticipant(child) &&
        !mainChainUuids.has(child.uuid ?? "")
      ) {
        rolledBackPromptIds.add(child.promptId);
      }
    }
  }

  return rolledBackPromptIds;
}

export function applyInvalidation(
  db: Database,
  sessionDbId: number,
  transcriptPath: string,
  epoch: number,
): void {
  const interruptedPromptIds = detectInterruptedPromptIds(transcriptPath);
  const rolledBackPromptIds = detectRolledBackPromptIds(transcriptPath);
  const turns = getTurnsForSession(db, sessionDbId);

  for (const turn of turns) {
    if (!turn.contentPromptId) {
      continue;
    }

    const nextWasInterrupted =
      turn.wasInterrupted || interruptedPromptIds.has(turn.contentPromptId);
    const nextWasRolledBack =
      turn.wasRolledBack || rolledBackPromptIds.has(turn.contentPromptId);

    if (
      nextWasInterrupted === turn.wasInterrupted &&
      nextWasRolledBack === turn.wasRolledBack
    ) {
      continue;
    }

    const nextStatus: "active" | "extracted" | "skipped" | "undone" =
      turn.status === "extracted" || turn.status === "skipped"
        ? "active"
        : turn.status;

    updateTurnById(db, turn.id, {
      status: nextStatus,
      wasInterrupted: nextWasInterrupted,
      wasRolledBack: nextWasRolledBack,
      updatedAtEpoch: epoch,
    });
  }
}

export function getReminderItems(
  db: Database,
  sessionDbId: number,
): ReminderItem[] {
  const turns = getTurnsForSession(db, sessionDbId);
  const reminderTurns = turns.filter((turn) => turn.status === "active");

  return reminderTurns.map((turn) => {
    const replacement = turns.find(
      (candidate) =>
        candidate.promptNumber > turn.promptNumber &&
        candidate.status !== "undone" &&
        !candidate.wasInterrupted &&
        !candidate.wasRolledBack,
    );

    return {
      turnId: turn.id,
      promptNumber: turn.promptNumber,
      wasInterrupted: turn.wasInterrupted,
      wasRolledBack: turn.wasRolledBack,
      priorTitle: turn.title,
      replacementPromptNumber: replacement?.promptNumber ?? null,
    };
  });
}
