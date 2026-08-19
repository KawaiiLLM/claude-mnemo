import type { Database } from "bun:sqlite";

/**
 * Homeless-cluster proposals (ticket 08, spec "Proposal", ADR-0002).
 *
 * When settlement finds several homeless turns of one window reading as ONE
 * task, it stores a text-only suggestion here instead of minting a segment —
 * addresses, a suggested title, and (rendered by the reader) a reminder to
 * ask the user. Never a database segment, never auto-adopted:
 * `remember(create)`'s own `members` field already accepts seed turn
 * addresses (ticket 02) — approving a proposal is just handing its
 * `addresses` to that call verbatim, one more `remember` call, nothing this
 * module needs to special-case.
 *
 * Storage is a plain job-scoped log, not a queue: nothing here is ever
 * marked "consumed" or "dismissed" (no such verb exists yet — the roster's
 * own "at most three, newest first" trim is what keeps an old, ignored
 * proposal from crowding out fresher ones, the same recency-over-lifecycle
 * discipline ADR-0005 already applies to the segment roster).
 */

export interface NoteSettlementProposalRecord {
  id: number;
  jobId: number;
  sessionId: number;
  title: string;
  /** "S<session>/T<prompt>" addresses, ready to pass straight to remember(create)'s members. */
  addresses: string[];
  createdAtEpoch: number;
}

/**
 * The idempotency key's canonical form (ticket 05, spec "propose 携幂等键"):
 * sorted, trimmed, de-duplicated, JSON-encoded — order-independent, so
 * restating the SAME address set (in any order, with any duplicate) matches
 * whatever an earlier attempt already stored. Shared by
 * `recordNoteSettlementProposal` below and `db/schema.ts`'s
 * `ensureNoteSettlementProposalIdempotencyKey` (the one-time backfill for
 * rows written before this column existed) — one canonicalization, not two
 * independently hand-kept copies that could drift apart.
 */
export function canonicalizeSettlementProposalAddresses(
  addresses: readonly string[],
): string {
  const normalized = [...new Set(addresses.map((raw) => raw.trim()))].sort();
  return JSON.stringify(normalized);
}

interface ProposalRow {
  id: number;
  jobId: number;
  sessionId: number;
  title: string;
  addresses: string;
  createdAtEpoch: number;
}

const PROPOSAL_COLUMNS = `
  id,
  job_id AS jobId,
  session_id AS sessionId,
  title,
  addresses,
  created_at_epoch AS createdAtEpoch
`;

function mapProposalRow(row: ProposalRow): NoteSettlementProposalRecord {
  const parsed = JSON.parse(row.addresses) as unknown;
  return {
    id: row.id,
    jobId: row.jobId,
    sessionId: row.sessionId,
    title: row.title,
    addresses: Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [],
    createdAtEpoch: row.createdAtEpoch,
  };
}

export interface RecordNoteSettlementProposalInput {
  jobId: number;
  sessionId: number;
  title: string;
  addresses: readonly string[];
  nowEpoch: number;
}

export interface RecordNoteSettlementProposalResult {
  record: NoteSettlementProposalRecord;
  /**
   * True when this call matched an EARLIER proposal (same session, same
   * canonical address set) instead of inserting a new row — the re-claimed-
   * job retry case the idempotency key exists for (spec: "重试回执'已存
   * 在'"). The returned `record`'s `title` is THIS call's own title in that
   * case too (ticket 14, spec "propose 撞键刷新 title", 2026-08-19 revision):
   * title is excluded from the key itself (still session + canonical
   * addresses), but a conflicting call's title now REFRESHES the stored row
   * rather than being discarded — a later settlement pass has seen more of
   * the window and its title is hindsight-informed, so the newest proposal's
   * wording wins.
   */
  alreadyExisted: boolean;
}

/**
 * Store one proposal, idempotent on (session, canonical address set) — a
 * RE-CLAIMED job (a fresh job id after a lease was reclaimed, spec: "重试=新
 * job id") retrying the same `propose` call lands on the SAME row rather than
 * a duplicate. The caller (the membership facade's `propose` action) has
 * already validated every address resolves to a real turn this dispatch
 * reviewed — this function stores exactly what it is given, the same
 * "storage mechanics only" discipline `db/segments.ts` keeps for segment
 * writes.
 *
 * UPDATE-then-INSERT, not `INSERT ... ON CONFLICT`: an `ON CONFLICT DO
 * UPDATE ... RETURNING` cannot itself tell the caller whether it inserted or
 * updated (SQLite's `RETURNING` returns a row either way), and that
 * distinction is exactly `alreadyExisted`. Trying the UPDATE first and
 * falling through to INSERT only on a miss gets the flag for free from which
 * statement actually produced a row — two statements, not a race: both run
 * inside the caller's own write transaction
 * (`evaluateSettlementMembershipWrite`'s `apply: true` path, itself inside
 * `runWriteTransaction`), so nothing else can insert between them.
 */
export function recordNoteSettlementProposal(
  db: Database,
  input: RecordNoteSettlementProposalInput,
): RecordNoteSettlementProposalResult {
  const addressesKey = canonicalizeSettlementProposalAddresses(input.addresses);

  const updated = db
    .query<ProposalRow, [string, number, string]>(
      `UPDATE note_settlement_proposals SET title = ?
       WHERE session_id = ? AND addresses_key = ?
       RETURNING ${PROPOSAL_COLUMNS}`,
    )
    .get(input.title, input.sessionId, addressesKey);
  if (updated) {
    return { record: mapProposalRow(updated), alreadyExisted: true };
  }

  const inserted = db
    .query<ProposalRow, [number, number, string, string, string, number]>(
      `INSERT INTO note_settlement_proposals (job_id, session_id, title, addresses, addresses_key, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING ${PROPOSAL_COLUMNS}`,
    )
    .get(
      input.jobId,
      input.sessionId,
      input.title,
      JSON.stringify(input.addresses),
      addressesKey,
      input.nowEpoch,
    );
  if (!inserted) {
    // Neither the UPDATE nor the INSERT produced a row — a genuine storage
    // bug, not a case the caller can meaningfully retry differently.
    throw new Error("Failed to record settlement proposal.");
  }
  return { record: mapProposalRow(inserted), alreadyExisted: false };
}

/**
 * At most `limit` proposals, newest first (spec: "rendered at most three
 * newest-first") — global across every session, matching the roster's own
 * cross-session recency ordering (a proposal surfaces to whichever session
 * starts next, not only the one that produced it). Ticket 10 is the reader
 * that renders this at SessionStart; this is the storage + read path ticket
 * 08 owes it.
 */
export function listRecentSettlementProposals(
  db: Database,
  limit: number,
): NoteSettlementProposalRecord[] {
  if (limit <= 0) {
    return [];
  }
  return db
    .query<ProposalRow, [number]>(
      `SELECT ${PROPOSAL_COLUMNS} FROM note_settlement_proposals
       ORDER BY created_at_epoch DESC, id DESC
       LIMIT ?`,
    )
    .all(limit)
    .map(mapProposalRow);
}
