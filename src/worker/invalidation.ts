import type { Database } from "bun:sqlite";

import { getTurnById, getTurnsForSession, updateTurnById } from "../db/turns";
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
  priorContent: string | null;
  replacementPromptNumber: number | null;
  pendingKinds: InvalidationKind[];
}

type InvalidationKind = "interrupt" | "rollback";

interface RollbackDetection {
  rolledBackPromptIds: Set<string>;
  replacementByPromptId: Map<string, string>;
}

const REMINDER_LIMIT = 10;
const PENDING_TAGS: Record<InvalidationKind, string> = {
  interrupt: "invalidated:notify-pending:interrupt",
  rollback: "invalidated:notify-pending:rollback",
};
const NOTIFIED_TAGS: Record<InvalidationKind, string> = {
  interrupt: "invalidated:notified:interrupt",
  rollback: "invalidated:notified:rollback",
};

function getPendingKinds(tags: string[]): InvalidationKind[] {
  return (["interrupt", "rollback"] as const).filter((kind) =>
    tags.includes(PENDING_TAGS[kind]),
  );
}

function addPendingKind(tags: string[], kind: InvalidationKind): string[] {
  if (tags.includes(PENDING_TAGS[kind]) || tags.includes(NOTIFIED_TAGS[kind])) {
    return tags;
  }

  return [...tags, PENDING_TAGS[kind]];
}

function markKindsNotified(tags: string[], kinds: InvalidationKind[]): string[] {
  let nextTags = tags.filter(
    (tag) => !kinds.some((kind) => tag === PENDING_TAGS[kind]),
  );

  for (const kind of kinds) {
    if (!nextTags.includes(NOTIFIED_TAGS[kind])) {
      nextTags = [...nextTags, NOTIFIED_TAGS[kind]];
    }
  }

  return nextTags;
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

export function detectRollbackTopology(
  transcriptPath: string,
): RollbackDetection {
  const entries = readAllTranscriptEntries(transcriptPath);
  if (entries.length === 0) {
    return {
      rolledBackPromptIds: new Set(),
      replacementByPromptId: new Map(),
    };
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
    return {
      rolledBackPromptIds: new Set(),
      replacementByPromptId: new Map(),
    };
  }

  const mainChainUuids = new Set<string>();
  let cursor: TranscriptEntryWithLineNumber | undefined = tip;
  while (cursor?.uuid) {
    mainChainUuids.add(cursor.uuid);
    cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined;
  }

  const rolledBackPromptIds = new Set<string>();
  const replacementByPromptId = new Map<string, string>();
  for (const children of childrenByParent.values()) {
    const userChildren = children.filter(
      (child) =>
        child.role === "user" &&
        child.promptId &&
        child.isSidechain !== true &&
        isChainParticipant(child),
    );
    if (userChildren.length < 2) {
      continue;
    }

    const mainChild = userChildren.find((child) =>
      mainChainUuids.has(child.uuid ?? ""),
    );
    if (!mainChild?.promptId) {
      continue;
    }

    for (const child of userChildren) {
      const childPromptId = child.promptId;
      if (!childPromptId) {
        continue;
      }
      if (childPromptId === mainChild.promptId) {
        continue;
      }
      if (mainChainUuids.has(child.uuid ?? "")) {
        continue;
      }

      rolledBackPromptIds.add(childPromptId);
      replacementByPromptId.set(childPromptId, mainChild.promptId);
    }
  }

  return {
    rolledBackPromptIds,
    replacementByPromptId,
  };
}

export function detectRolledBackPromptIds(transcriptPath: string): Set<string> {
  return detectRollbackTopology(transcriptPath).rolledBackPromptIds;
}

export function applyInvalidation(
  db: Database,
  sessionDbId: number,
  transcriptPath: string,
  epoch: number,
): void {
  const interruptedPromptIds = detectInterruptedPromptIds(transcriptPath);
  const { rolledBackPromptIds } = detectRollbackTopology(transcriptPath);
  const turns = getTurnsForSession(db, sessionDbId);

  for (const turn of turns) {
    if (!turn.contentPromptId) {
      continue;
    }

    const detectedInterrupt = interruptedPromptIds.has(turn.contentPromptId);
    const detectedRollback = rolledBackPromptIds.has(turn.contentPromptId);
    const nextWasInterrupted = turn.wasInterrupted || detectedInterrupt;
    const nextWasRolledBack = turn.wasRolledBack || detectedRollback;
    let nextTags = turn.tags;

    if (detectedInterrupt && !turn.wasInterrupted) {
      nextTags = addPendingKind(nextTags, "interrupt");
    }
    if (detectedRollback && !turn.wasRolledBack) {
      nextTags = addPendingKind(nextTags, "rollback");
    }

    if (
      nextWasInterrupted === turn.wasInterrupted &&
      nextWasRolledBack === turn.wasRolledBack &&
      nextTags === turn.tags
    ) {
      continue;
    }

    updateTurnById(db, turn.id, {
      status: turn.status,
      wasInterrupted: nextWasInterrupted,
      wasRolledBack: nextWasRolledBack,
      replaceTags: nextTags,
      updatedAtEpoch: epoch,
    });
  }
}

function selectPendingReminderItems(
  db: Database,
  sessionDbId: number,
  transcriptPath?: string,
): ReminderItem[] {
  const turns = getTurnsForSession(db, sessionDbId);
  const promptNumberByPromptId = new Map(
    turns
      .filter((turn) => turn.contentPromptId)
      .map((turn) => [turn.contentPromptId!, turn.promptNumber] as const),
  );
  const replacementByPromptId =
    transcriptPath ? detectRollbackTopology(transcriptPath).replacementByPromptId : new Map<string, string>();
  const reminderTurns = turns
    .filter(
      (turn) =>
        turn.status !== "active" &&
        turn.status !== "undone" &&
        getPendingKinds(turn.tags).length > 0,
    )
    .sort((left, right) => {
      const leftEpoch = left.updatedAtEpoch ?? left.createdAtEpoch;
      const rightEpoch = right.updatedAtEpoch ?? right.createdAtEpoch;
      if (rightEpoch !== leftEpoch) {
        return rightEpoch - leftEpoch;
      }
      return right.promptNumber - left.promptNumber;
    });

  return reminderTurns.map((turn) => {
    const replacementPromptId =
      turn.wasRolledBack && turn.contentPromptId
        ? replacementByPromptId.get(turn.contentPromptId) ?? null
        : null;

    return {
      turnId: turn.id,
      promptNumber: turn.promptNumber,
      wasInterrupted: turn.wasInterrupted,
      wasRolledBack: turn.wasRolledBack,
      priorTitle: turn.title,
      priorContent: turn.content,
      replacementPromptNumber:
        replacementPromptId
          ? promptNumberByPromptId.get(replacementPromptId) ?? null
          : null,
      pendingKinds: getPendingKinds(turn.tags),
    };
  });
}

export function getReminderItems(
  db: Database,
  sessionDbId: number,
  transcriptPath?: string,
): ReminderItem[] {
  return selectPendingReminderItems(db, sessionDbId, transcriptPath)
    .slice(0, REMINDER_LIMIT)
    .sort((left, right) => left.promptNumber - right.promptNumber);
}

export function getSilencedReminderItems(
  db: Database,
  sessionDbId: number,
  transcriptPath?: string,
): ReminderItem[] {
  return selectPendingReminderItems(db, sessionDbId, transcriptPath).slice(
    REMINDER_LIMIT,
  );
}

export function markReminderItemsNotified(
  db: Database,
  items: ReadonlyArray<ReminderItem>,
  updatedAtEpoch: number,
): void {
  for (const item of items) {
    const turn = getTurnById(db, item.turnId);
    if (!turn) {
      continue;
    }

    updateTurnById(db, turn.id, {
      status: turn.status,
      replaceTags: markKindsNotified(turn.tags, item.pendingKinds),
      updatedAtEpoch,
    });
  }
}
