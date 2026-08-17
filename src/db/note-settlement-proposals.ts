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

/**
 * Store one proposal. The caller (the membership facade's `propose` action)
 * has already validated every address resolves to a real turn this
 * dispatch reviewed — this function stores exactly what it is given, the
 * same "storage mechanics only" discipline `db/segments.ts` keeps for
 * segment writes.
 */
export function recordNoteSettlementProposal(
  db: Database,
  input: RecordNoteSettlementProposalInput,
): NoteSettlementProposalRecord {
  const inserted = db
    .query<ProposalRow, [number, number, string, string, number]>(
      `INSERT INTO note_settlement_proposals (job_id, session_id, title, addresses, created_at_epoch)
       VALUES (?, ?, ?, ?, ?)
       RETURNING ${PROPOSAL_COLUMNS}`,
    )
    .get(
      input.jobId,
      input.sessionId,
      input.title,
      JSON.stringify(input.addresses),
      input.nowEpoch,
    );
  if (!inserted) {
    throw new Error("Failed to record settlement proposal.");
  }
  return mapProposalRow(inserted);
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
