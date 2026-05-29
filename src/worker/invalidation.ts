import type { Database } from "bun:sqlite";

import { getTurnById, getTurnsForSession, updateTurnById } from "../db/turns";
import type { TurnRecord } from "../db/turns";
import {
  detectInterruptedPromptIds,
  isChainParticipant,
  readAllTranscriptEntries,
  type TranscriptEntryWithLineNumber,
} from "../shared/transcript-parser";

// --- Reminder reason registry (D0) ----------------------------------------
//
// A reminder reason is a first-class descriptor that owns its *selection*
// (which turns qualify), its *tag lifecycle* (pending -> notified), its
// *private render data*, and its *render fragments*. `buildReminderEnvelope`
// (in server.ts) only owns the line grammar and never names a concrete reason.
//
// Tag namespace invariant: internal reminder tags are ALWAYS colon-namespaced
// (`reason:sub:kind`). The agent's freeform topic tags are hyphenated keywords.
// The two coexist in `turns.tags` and stay disjoint by convention — a reason's
// `key` is a registry identifier only and is NEVER written to or compared
// against the `tags` column. Only `pendingTag`/`notifiedTag` (colon strings)
// are written.

/** Cross-turn context computed once per collection pass, handed to `data()`. */
export interface ReminderContext {
  replacementByPromptId: Map<string, string>;
  // promptId -> DB turn id. The reminder envelope addresses turns by DB id
  // (matching the <turn id="T..."> blocks, remember(), recall(), and [T<n>]
  // markers) so the agent acts on a single, consistent id space.
  turnIdByPromptId: Map<string, number>;
}

export interface ReminderReason<D = unknown> {
  /** Registry identifier. Never written to or compared against `tags`. */
  key: string;
  /** Colon-namespaced tag written while the reminder is awaiting delivery. */
  pendingTag: string;
  /** Colon-namespaced tag written once the reminder has been delivered. */
  notifiedTag: string;
  /** Per-reason status policy (no longer hard-coded in the selector). */
  qualifies(turn: TurnRecord): boolean;
  /** Private render data; never flattened onto `ReminderItem`. */
  data(turn: TurnRecord, ctx: ReminderContext): D;
  /** Flag token inside the `(...)`, joined by `+` (e.g. "was_rolled_back"). */
  flagToken(turn: TurnRecord, data: D): string;
  /** Extra clause inside the `(...)`, after flags (e.g. "replaced by T43"). */
  parenExtra?(turn: TurnRecord, data: D): string | null;
  /** Lead body segment before content (e.g. `prompt="..."` when no title). */
  bodyLead?(turn: TurnRecord, data: D): string | null;
  /** Tail body segment; when present it replaces `priorContent` after `--`. */
  tail?(turn: TurnRecord, data: D): string | null;
}

/** A reason that fired on a specific turn, with its render fragments resolved. */
export interface ReminderReasonHit {
  key: string;
  pendingTag: string;
  notifiedTag: string;
  flagToken: string;
  parenExtra: string | null;
  bodyLead: string | null;
  tail: string | null;
}

export interface ReminderItem {
  turnId: number;
  promptNumber: number;
  priorTitle: string | null;
  priorContent: string | null;
  reasons: ReminderReasonHit[];
}

interface RollbackDetection {
  rolledBackPromptIds: Set<string>;
  replacementByPromptId: Map<string, string>;
}

const REMINDER_LIMIT = 10;

const interruptReason: ReminderReason = {
  key: "interrupt",
  pendingTag: "invalidated:notify-pending:interrupt",
  notifiedTag: "invalidated:notified:interrupt",
  qualifies: (turn) => turn.status === "extracted" || turn.status === "skipped",
  data: () => null,
  flagToken: () => "was_interrupted",
};

interface RollbackData {
  replacementTurnId: number | null;
}

const rollbackReason: ReminderReason<RollbackData> = {
  key: "rollback",
  pendingTag: "invalidated:notify-pending:rollback",
  notifiedTag: "invalidated:notified:rollback",
  qualifies: (turn) => turn.status === "extracted" || turn.status === "skipped",
  data: (turn, ctx) => {
    const replacementPromptId = turn.contentPromptId
      ? ctx.replacementByPromptId.get(turn.contentPromptId)
      : undefined;
    return {
      replacementTurnId: replacementPromptId
        ? ctx.turnIdByPromptId.get(replacementPromptId) ?? null
        : null,
    };
  },
  flagToken: () => "was_rolled_back",
  parenExtra: (_turn, data) =>
    data.replacementTurnId !== null
      ? `replaced by T${data.replacementTurnId}`
      : null,
};

function truncatePrompt(value: string | null, limit: number): string {
  const text = (value ?? "").trim().replace(/\s+/g, " ");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 3)}...`;
}

export const DELIVERY_DROPPED_PENDING_TAG = "delivery:dropped:notify-pending";
export const DELIVERY_DROPPED_NOTIFIED_TAG = "delivery:dropped:notified";

interface DeliveryDroppedData {
  notExtracted: boolean;
  prompt: string | null;
}

// A flush unit (slice or merged batch) failed maxFlushAttempts times and was
// dropped; the turn's memory may be incomplete (D9). qualifies keeps `active`
// (a never-extracted turn whose only delivery failed still warrants a notice).
const deliveryDroppedReason: ReminderReason<DeliveryDroppedData> = {
  key: "delivery-dropped",
  pendingTag: DELIVERY_DROPPED_PENDING_TAG,
  notifiedTag: DELIVERY_DROPPED_NOTIFIED_TAG,
  qualifies: (turn) => turn.status !== "undone",
  data: (turn) => ({
    notExtracted: turn.status === "active",
    prompt: turn.status === "active" ? truncatePrompt(turn.userPrompt, 200) : null,
  }),
  flagToken: () => "delivery_dropped",
  parenExtra: (_turn, data) => (data.notExtracted ? "not yet extracted" : null),
  bodyLead: (_turn, data) =>
    data.notExtracted && data.prompt ? `prompt="${data.prompt}"` : null,
  tail: (_turn, data) =>
    data.notExtracted
      ? "one or more parts of this turn could not be delivered; record intent if possible"
      : "record may be incomplete, one or more parts could not be delivered after repeated failures",
};

// Registered reasons. Adding a reason is array-only — collection, notification,
// limit/silenced splitting, and envelope grammar all become available for free.
const REMINDER_REASONS: ReminderReason<any>[] = [
  interruptReason,
  rollbackReason,
  deliveryDroppedReason,
];

function renderReasonHit<D>(
  reason: ReminderReason<D>,
  turn: TurnRecord,
  ctx: ReminderContext,
): ReminderReasonHit {
  const data = reason.data(turn, ctx);
  return {
    key: reason.key,
    pendingTag: reason.pendingTag,
    notifiedTag: reason.notifiedTag,
    flagToken: reason.flagToken(turn, data),
    parenExtra: reason.parenExtra?.(turn, data) ?? null,
    bodyLead: reason.bodyLead?.(turn, data) ?? null,
    tail: reason.tail?.(turn, data) ?? null,
  };
}

function addPendingReason(tags: string[], reason: ReminderReason): string[] {
  if (tags.includes(reason.pendingTag) || tags.includes(reason.notifiedTag)) {
    return tags;
  }
  return [...tags, reason.pendingTag];
}

function markHitsNotified(tags: string[], hits: ReminderReasonHit[]): string[] {
  let nextTags = tags.filter(
    (tag) => !hits.some((hit) => tag === hit.pendingTag),
  );
  for (const hit of hits) {
    if (!nextTags.includes(hit.notifiedTag)) {
      nextTags = [...nextTags, hit.notifiedTag];
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
      nextTags = addPendingReason(nextTags, interruptReason);
    }
    if (detectedRollback && !turn.wasRolledBack) {
      nextTags = addPendingReason(nextTags, rollbackReason);
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

// Mark a turn whose flush unit was dropped (D8). Passes `status: turn.status`
// explicitly so updateTurnById does NOT auto-promote an active (never-extracted)
// turn to extracted — which would both corrupt status and suppress the
// "not yet extracted" reminder branch (turns.ts auto-promote trap).
export function flagDeliveryDropped(
  db: Database,
  turnId: number,
  updatedAtEpoch: number,
): void {
  const turn = getTurnById(db, turnId);
  if (!turn) {
    return;
  }
  const nextTags = addPendingReason(turn.tags, deliveryDroppedReason);
  if (nextTags === turn.tags) {
    return;
  }
  updateTurnById(db, turnId, {
    status: turn.status,
    replaceTags: nextTags,
    updatedAtEpoch,
  });
}

function buildReminderContext(
  turns: TurnRecord[],
  transcriptPath?: string,
): ReminderContext {
  const turnIdByPromptId = new Map(
    turns
      .filter((turn) => turn.contentPromptId)
      .map((turn) => [turn.contentPromptId!, turn.id] as const),
  );
  const replacementByPromptId = transcriptPath
    ? detectRollbackTopology(transcriptPath).replacementByPromptId
    : new Map<string, string>();
  return { replacementByPromptId, turnIdByPromptId };
}

function collectReminderItems(
  db: Database,
  sessionDbId: number,
  transcriptPath?: string,
): ReminderItem[] {
  const turns = getTurnsForSession(db, sessionDbId);
  const ctx = buildReminderContext(turns, transcriptPath);

  const ranked: Array<{ item: ReminderItem; sortEpoch: number }> = [];
  for (const turn of turns) {
    const hits: ReminderReasonHit[] = [];
    for (const reason of REMINDER_REASONS) {
      if (turn.tags.includes(reason.pendingTag) && reason.qualifies(turn)) {
        hits.push(renderReasonHit(reason, turn, ctx));
      }
    }
    if (hits.length === 0) {
      continue;
    }
    ranked.push({
      item: {
        turnId: turn.id,
        promptNumber: turn.promptNumber,
        priorTitle: turn.title,
        priorContent: turn.content,
        reasons: hits,
      },
      sortEpoch: turn.updatedAtEpoch ?? turn.createdAtEpoch,
    });
  }

  ranked.sort((left, right) => {
    if (right.sortEpoch !== left.sortEpoch) {
      return right.sortEpoch - left.sortEpoch;
    }
    return right.item.promptNumber - left.item.promptNumber;
  });

  return ranked.map((entry) => entry.item);
}

export function getReminderItems(
  db: Database,
  sessionDbId: number,
  transcriptPath?: string,
): ReminderItem[] {
  return collectReminderItems(db, sessionDbId, transcriptPath)
    .slice(0, REMINDER_LIMIT)
    .sort((left, right) => left.promptNumber - right.promptNumber);
}

export function getSilencedReminderItems(
  db: Database,
  sessionDbId: number,
  transcriptPath?: string,
): ReminderItem[] {
  return collectReminderItems(db, sessionDbId, transcriptPath).slice(
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
      replaceTags: markHitsNotified(turn.tags, item.reasons),
      updatedAtEpoch,
    });
  }
}
