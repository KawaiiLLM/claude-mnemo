import type { Database } from "bun:sqlite";

import {
  claimNextQueueItem,
  deleteQueueItem,
  type PendingQueueItem,
  resetClaimedQueueItems,
  resetQueueItemClaim,
} from "../db/pending-queue";

export interface SessionState {
  sessionDbId: number;
  processingLock: Promise<void>;
}

export interface QueueRuntimeDeps {
  db: Database;
  now?: () => number;
  processObs: (sessionState: SessionState, observationId: number) => Promise<void>;
  processTurnStop: (sessionState: SessionState, turnId: number) => Promise<void>;
}

export interface ScanAndDrainOptions {
  sessionFilter?: number;
}

export interface QueueRuntime {
  compactingSessions: Set<number>;
  claimNextItem: (options?: ScanAndDrainOptions & { skippedSeqs?: Set<number> }) => PendingQueueItem | null;
  getOrCreateSessionState: (sessionDbId: number) => SessionState;
  processClaimedItem: (item: PendingQueueItem) => Promise<void>;
  scanAndDrainQueue: (sessionFilter?: number) => Promise<void>;
  drainSessionCompletely: (sessionDbId: number) => Promise<void>;
  recoverFromCrash: () => void;
}

export function createQueueRuntime(deps: QueueRuntimeDeps): QueueRuntime {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const sessionStates = new Map<number, SessionState>();
  const compactingSessions = new Set<number>();

  function getOrCreateSessionState(sessionDbId: number): SessionState {
    let existing = sessionStates.get(sessionDbId);
    if (existing) {
      return existing;
    }

    existing = {
      sessionDbId,
      processingLock: Promise.resolve(),
    };
    sessionStates.set(sessionDbId, existing);
    return existing;
  }

  function claimNextItem(
    options: ScanAndDrainOptions & { skippedSeqs?: Set<number> } = {},
  ): PendingQueueItem | null {
    return claimNextQueueItem(deps.db, now(), {
      sessionFilter: options.sessionFilter,
      skippedSeqs: options.skippedSeqs,
      excludeSessions:
        options.sessionFilter === undefined ? compactingSessions : undefined,
    });
  }

  async function processClaimedItem(item: PendingQueueItem): Promise<void> {
    const state = getOrCreateSessionState(item.sessionDbId);
    const prior = state.processingLock;
    let release!: () => void;
    state.processingLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;

    try {
      if (item.kind === "obs") {
        await deps.processObs(state, item.targetId);
      } else {
        await deps.processTurnStop(state, item.targetId);
      }
    } finally {
      release();
    }
  }

  async function scanAndDrainQueue(sessionFilter?: number): Promise<void> {
    const skippedSeqs = new Set<number>();

    while (true) {
      const item = claimNextItem({ sessionFilter, skippedSeqs });
      if (!item) {
        return;
      }

      try {
        await processClaimedItem(item);
        deleteQueueItem(deps.db, item.seq);
      } catch {
        resetQueueItemClaim(deps.db, item.seq);
        skippedSeqs.add(item.seq);
      }
    }
  }

  async function drainSessionCompletely(sessionDbId: number): Promise<void> {
    let previousCount = Number.POSITIVE_INFINITY;

    while (true) {
      await scanAndDrainQueue(sessionDbId);

      const state = sessionStates.get(sessionDbId);
      if (state) {
        while (true) {
          const before = state.processingLock;
          await before;
          if (before === state.processingLock) {
            break;
          }
        }
      }

      const remaining =
        deps.db
          .query<{ count: number }, [number]>(
            "SELECT COUNT(*) AS count FROM pending_queue WHERE session_db_id = ?",
          )
          .get(sessionDbId)?.count ?? 0;

      if (remaining === 0) {
        return;
      }

      if (remaining >= previousCount) {
        return;
      }

      previousCount = remaining;
    }
  }

  function recoverFromCrash(): void {
    resetClaimedQueueItems(deps.db);
  }

  return {
    compactingSessions,
    claimNextItem,
    getOrCreateSessionState,
    processClaimedItem,
    scanAndDrainQueue,
    drainSessionCompletely,
    recoverFromCrash,
  };
}
