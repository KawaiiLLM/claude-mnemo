import type { Database } from "bun:sqlite";

import { getTurnsForSession, updateTurnById } from "../db/turns";
import {
  detectInterruptedPromptIdsInEntries,
  isChainParticipant,
  readAllTranscriptEntries,
  type TranscriptEntryWithLineNumber,
} from "../shared/transcript-parser";

/**
 * Invalidation marks (D0).
 *
 * A turn the transcript shows as interrupted or rolled back carries a
 * colon-namespaced tag beside the boolean column, so a reader can tell the two
 * kinds apart. The reminder ENVELOPE these tags used to feed — the extraction
 * agent's per-turn "re-extract this" notice, its reason registry, its render
 * fragments and its notified half — went with the agent (ticket 15). The tag
 * namespace invariant survives: internal tags are ALWAYS colon-namespaced
 * (`reason:sub:kind`), the agent's freeform topic tags are hyphenated keywords,
 * and the two coexist in `turns.tags` without colliding.
 */

export interface RollbackDetection {
  rolledBackPromptIds: Set<string>;
  replacementByPromptId: Map<string, string>;
}

export interface InvalidationSets extends RollbackDetection {
  interruptedPromptIds: Set<string>;
}

const INTERRUPT_PENDING_TAG = "invalidated:notify-pending:interrupt";
const INTERRUPT_NOTIFIED_TAG = "invalidated:notified:interrupt";
const ROLLBACK_PENDING_TAG = "invalidated:notify-pending:rollback";
const ROLLBACK_NOTIFIED_TAG = "invalidated:notified:rollback";

function addPendingTag(
  tags: string[],
  pendingTag: string,
  notifiedTag: string,
): string[] {
  if (tags.includes(pendingTag) || tags.includes(notifiedTag)) {
    return tags;
  }
  return [...tags, pendingTag];
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

export function detectRollbackTopologyFromEntries(
  entries: TranscriptEntryWithLineNumber[],
): RollbackDetection {
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

export function detectRollbackTopology(
  transcriptPath: string,
): RollbackDetection {
  return detectRollbackTopologyFromEntries(
    readAllTranscriptEntries(transcriptPath),
  );
}

export function detectRolledBackPromptIds(transcriptPath: string): Set<string> {
  return detectRollbackTopology(transcriptPath).rolledBackPromptIds;
}

export function computeInvalidationSets(
  entries: TranscriptEntryWithLineNumber[],
): InvalidationSets {
  const rollbackDetection = detectRollbackTopologyFromEntries(entries);
  return {
    interruptedPromptIds: detectInterruptedPromptIdsInEntries(entries),
    rolledBackPromptIds: rollbackDetection.rolledBackPromptIds,
    replacementByPromptId: rollbackDetection.replacementByPromptId,
  };
}

export function applyInvalidationSets(
  db: Database,
  sessionDbId: number,
  invalidationSets: InvalidationSets,
  epoch: number,
): void {
  const { interruptedPromptIds, rolledBackPromptIds } = invalidationSets;
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
      nextTags = addPendingTag(nextTags, INTERRUPT_PENDING_TAG, INTERRUPT_NOTIFIED_TAG);
    }
    if (detectedRollback && !turn.wasRolledBack) {
      nextTags = addPendingTag(nextTags, ROLLBACK_PENDING_TAG, ROLLBACK_NOTIFIED_TAG);
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

export function applyInvalidation(
  db: Database,
  sessionDbId: number,
  transcriptPath: string,
  epoch: number,
): void {
  applyInvalidationSets(
    db,
    sessionDbId,
    computeInvalidationSets(readAllTranscriptEntries(transcriptPath)),
    epoch,
  );
}
