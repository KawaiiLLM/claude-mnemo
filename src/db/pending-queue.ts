import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";

export type PendingQueueKind = "obs" | "turn-stop" | "diary";

export interface PendingQueueItem {
  seq: number;
  kind: PendingQueueKind;
  targetId: number;
  sessionDbId: number;
  claimedAtEpoch: number | null;
  enqueuedAtEpoch: number;
}

export interface EnqueueQueueItemInput {
  kind: PendingQueueKind;
  targetId: number;
  sessionDbId: number;
  enqueuedAtEpoch: number;
}

export interface ClaimNextQueueItemOptions {
  sessionFilter?: number;
  excludeSessions?: Set<number>;
  skippedSeqs?: Set<number>;
}

interface PendingQueueRow {
  seq: number;
  kind: PendingQueueKind;
  targetId: number;
  sessionDbId: number;
  claimedAtEpoch: number | null;
  enqueuedAtEpoch: number;
}

const PENDING_QUEUE_SELECT = `
  SELECT
    seq,
    kind,
    target_id AS targetId,
    session_db_id AS sessionDbId,
    claimed_at_epoch AS claimedAtEpoch,
    enqueued_at_epoch AS enqueuedAtEpoch
  FROM pending_queue
`;

export function enqueueQueueItem(
  db: Database,
  input: EnqueueQueueItemInput,
): PendingQueueItem {
  const inserted = db
    .query<
      PendingQueueRow,
      [PendingQueueKind, number, number, number]
    >(
      `
        INSERT INTO pending_queue (
          kind,
          target_id,
          session_db_id,
          enqueued_at_epoch
        ) VALUES (?, ?, ?, ?)
        RETURNING
          seq,
          kind,
          target_id AS targetId,
          session_db_id AS sessionDbId,
          claimed_at_epoch AS claimedAtEpoch,
          enqueued_at_epoch AS enqueuedAtEpoch
      `,
    )
    .get(
      input.kind,
      input.targetId,
      input.sessionDbId,
      input.enqueuedAtEpoch,
    );

  if (!inserted) {
    throw new Error("Failed to enqueue pending queue item.");
  }

  return inserted;
}

export function claimNextQueueItem(
  db: Database,
  claimedAtEpoch: number,
  options: ClaimNextQueueItemOptions = {},
): PendingQueueItem | null {
  return runWriteTransaction(db, () => {
    const clauses = ["claimed_at_epoch IS NULL", "kind != 'diary'"];
    const params: Array<number> = [];

    if (options.sessionFilter !== undefined) {
      clauses.push("session_db_id = ?");
      params.push(options.sessionFilter);
    }

    if (options.excludeSessions && options.excludeSessions.size > 0) {
      const placeholders = Array.from(options.excludeSessions)
        .map(() => "?")
        .join(", ");
      clauses.push(`session_db_id NOT IN (${placeholders})`);
      params.push(...options.excludeSessions);
    }

    if (options.skippedSeqs && options.skippedSeqs.size > 0) {
      const placeholders = Array.from(options.skippedSeqs)
        .map(() => "?")
        .join(", ");
      clauses.push(`seq NOT IN (${placeholders})`);
      params.push(...options.skippedSeqs);
    }

    const row = db
      .query<PendingQueueRow, Array<number>>(
        `${PENDING_QUEUE_SELECT}
         WHERE ${clauses.join(" AND ")}
         ORDER BY seq ASC
         LIMIT 1`,
      )
      .get(...params);

    if (!row) {
      return null;
    }

    const result = db
      .query<unknown, [number, number]>(
        `
          UPDATE pending_queue
          SET claimed_at_epoch = ?
          WHERE seq = ? AND claimed_at_epoch IS NULL
        `,
      )
      .run(claimedAtEpoch, row.seq);

    if (result.changes !== 1) {
      throw new Error(`unexpected claim race on pending_queue seq=${row.seq}`);
    }

    return {
      ...row,
      claimedAtEpoch,
    };
  });
}

export const claimNextItem = claimNextQueueItem;

export function resetQueueItemClaim(db: Database, seq: number): void {
  db.query<unknown, [number]>(
    "UPDATE pending_queue SET claimed_at_epoch = NULL WHERE seq = ?",
  ).run(seq);
}

export const releaseQueueClaim = resetQueueItemClaim;

export function resetClaimedQueueItems(db: Database): void {
  db.query<unknown, []>(
    "UPDATE pending_queue SET claimed_at_epoch = NULL WHERE claimed_at_epoch IS NOT NULL",
  ).run();
}

export function resetClaimedQueueItemsForSession(
  db: Database,
  sessionDbId: number,
): void {
  db.query<unknown, [number]>(
    `UPDATE pending_queue
     SET claimed_at_epoch = NULL
     WHERE session_db_id = ? AND claimed_at_epoch IS NOT NULL`,
  ).run(sessionDbId);
}

export function deleteQueueItem(db: Database, seq: number): void {
  db.query<unknown, [number]>("DELETE FROM pending_queue WHERE seq = ?").run(seq);
}

export function listPendingQueueItems(
  db: Database,
  sessionFilter?: number,
): PendingQueueItem[] {
  if (sessionFilter === undefined) {
    return db
      .query<PendingQueueRow, []>(
        `${PENDING_QUEUE_SELECT} ORDER BY seq ASC`,
      )
      .all();
  }

  return db
    .query<PendingQueueRow, [number]>(
      `${PENDING_QUEUE_SELECT} WHERE session_db_id = ? ORDER BY seq ASC`,
    )
    .all(sessionFilter);
}

export const listQueueItems = listPendingQueueItems;

export function getPendingQueueCount(
  db: Database,
  sessionFilter?: number,
): number {
  if (sessionFilter === undefined) {
    return (
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pending_queue",
        )
        .get()?.count ?? 0
    );
  }

  return (
    db
      .query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM pending_queue WHERE session_db_id = ?",
      )
      .get(sessionFilter)?.count ?? 0
  );
}

export function countQueueItemsForSession(
  db: Database,
  sessionDbId: number,
): number {
  return getPendingQueueCount(db, sessionDbId);
}

export function queueItemExistsForTurn(
  db: Database,
  kind: PendingQueueKind,
  targetId: number,
): boolean {
  const row = db
    .query<{ one: number }, [PendingQueueKind, number]>(
      "SELECT 1 AS one FROM pending_queue WHERE kind = ? AND target_id = ? LIMIT 1",
    )
    .get(kind, targetId);
  return row !== null;
}
