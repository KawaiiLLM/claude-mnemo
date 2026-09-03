/**
 * THE CUTOVER'S RECEIPT — names, tables and types (main-agent-edges spec D9,
 * ticket 01; RECEIPT-ONLY since ticket 12). The migration lives in
 * `db/schema.ts`, beside every other `memory_edges` and `turns` rebuild in
 * this codebase and for the same reason those do: it needs that file's DDL
 * builders. What lives HERE is everything a reader of the receipt needs
 * without the migration — the table names, the DDL that creates them, the
 * receipt payload types and the state marker's reader.
 *
 * ## Immutable archive, one marker (R10-10)
 *
 * The RECEIPT is five archive tables plus a `migration_receipts` payload, and
 * none of them is ever UPDATEd: every old `memory_edges` row (all columns,
 * wordless rows included) with the disposition the cutover gave it; the old
 * `turns.tags` of every normalised turn and the `segment_members` rows of those
 * turns; the write-gate stamps (`relations`, `tags`) of every turn the cutover
 * or the tags normalisation stamped — including the FACT that a turn had no
 * stamp, which a hand restore must put back as absence; the old
 * table/index/trigger DDL text verbatim from `sqlite_master`; and the
 * `sqlite_sequence` values of both rebuilt tables.
 *
 * The two tags archives are filled by the TAGS NORMALISATION, not by the
 * cutover (ticket 12): that step is the first migration on `turns.tags` and
 * runs on every open, fenced or not, so the archive of the old bytes is
 * written where the bytes change.
 *
 * The STATE MARKER is one row written LAST inside the cutover's transaction,
 * so a crash anywhere before it leaves the old schema standing and the archive
 * absent — the transaction rolls both back together.
 *
 * ## What is NOT receipted, and why (spec D9)
 *
 * Segment facets and derived type, the FTS rows of touched turns, the side
 * index `memory_edge_side_tags`, and the milestone/frontier caches are
 * DETERMINISTICALLY REBUILT from the restored rows, never copied — a copy
 * would be a second source of truth for a fact the restore recomputes anyway.
 *
 * ## RECEIPT-ONLY: there is no rollback tool (ruled, S15069/T2464)
 *
 * A rollback tool stood here and is DELETED (ticket 12). It could not name its
 * own boundary: a citing turn deleted after the cutover made it restore a
 * DANGLING edge, a forced detach that left `turns.tags` unchanged passed its
 * `written-since` check silently, and the cutover's own reset of pending
 * `stage='edges'` jobs was neither archived nor restorable. Machinery whose
 * safety condition cannot be stated is not safety.
 *
 * What stays is the RECEIPT: the archive tables above hold the pre-cutover
 * bytes, and `write_gate_sequence` records the sequence AFTER the cutover's
 * own stamps, so a reader can still say exactly which writes came later. A
 * recovery, if one is ever needed, is a hand-written one-shot over these
 * tables with the worker stopped — written against the state it actually
 * finds, which is the part the deleted tool had to guess.
 */

import type { Database } from "bun:sqlite";

/** The `migration_receipts` name. Deliberately not `lane-declaration-`/`lane-model-v12-`: tests count those prefixes as their own phase sets. */
export const MAIN_AGENT_EDGES_CUTOVER_RECEIPT = "main-agent-edges-cutover";

/** Transform 1's own `migration_receipts` name — the tags normalisation, which runs before every consumer of `turns.tags` and outside the cutover's fence. */
export const MAIN_AGENT_EDGES_TURN_TAGS_RECEIPT = "main-agent-edges-turn-tags";

/**
 * The reserved writer id the cutover's field stamps carry — the same
 * discipline `MEMBERSHIP_CUTOVER_MIGRATION_WRITER` follows for a mutator with
 * no identity of its own. A relations stamp under it is what tells a writer
 * holding a pre-cutover read grant that its set moved.
 */
export const MAIN_AGENT_EDGES_CUTOVER_WRITER = "migration:main-agent-edges-cutover";

export const MAIN_AGENT_EDGES_CUTOVER_STATE_TABLE = "main_agent_edges_cutover_state";
export const MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE = "main_agent_edges_cutover_edge_archive";
export const MAIN_AGENT_EDGES_CUTOVER_TURN_TAGS_ARCHIVE =
  "main_agent_edges_cutover_turn_tags_archive";
export const MAIN_AGENT_EDGES_CUTOVER_MEMBERSHIP_ARCHIVE =
  "main_agent_edges_cutover_membership_archive";
export const MAIN_AGENT_EDGES_CUTOVER_STAMP_ARCHIVE = "main_agent_edges_cutover_stamp_archive";
export const MAIN_AGENT_EDGES_CUTOVER_DDL_ARCHIVE = "main_agent_edges_cutover_ddl_archive";
export const MAIN_AGENT_EDGES_CUTOVER_SEQUENCE_ARCHIVE =
  "main_agent_edges_cutover_sequence_archive";

/** What the cutover did with one old `memory_edges` row. */
export type CutoverEdgeDisposition = "kept" | "rewritten" | "folded" | "deleted-wordless";

export const MAIN_AGENT_EDGES_CUTOVER_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS ${MAIN_AGENT_EDGES_CUTOVER_STATE_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL CHECK (status = 'complete'),
    applied_at_epoch INTEGER NOT NULL,
    -- The write-gate sequence AFTER the cutover's own stamps: what a later
    -- reader uses to tell its own writes from the migration's (module header).
    write_gate_sequence INTEGER NOT NULL
  );

  -- Every old memory_edges row, all columns verbatim, keyed on its old id.
  CREATE TABLE IF NOT EXISTS ${MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE} (
    id INTEGER PRIMARY KEY,
    citing_kind TEXT NOT NULL,
    citing_id INTEGER NOT NULL,
    cited_kind TEXT NOT NULL,
    cited_id INTEGER NOT NULL,
    relation TEXT,
    provenance TEXT NOT NULL,
    tail_tag TEXT NOT NULL,
    head_tag TEXT NOT NULL,
    relation_class TEXT NOT NULL,
    relation_coverage TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    disposition TEXT NOT NULL CHECK (
      disposition IN ('kept', 'rewritten', 'folded', 'deleted-wordless')
    )
  );

  -- The old tags column (NULL preserved as NULL) of every turn transform 1 rewrote.
  CREATE TABLE IF NOT EXISTS ${MAIN_AGENT_EDGES_CUTOVER_TURN_TAGS_ARCHIVE} (
    turn_id INTEGER PRIMARY KEY,
    tags TEXT
  );

  -- The segment_members rows of those turns, as they stood.
  CREATE TABLE IF NOT EXISTS ${MAIN_AGENT_EDGES_CUTOVER_MEMBERSHIP_ARCHIVE} (
    segment_id INTEGER NOT NULL,
    turn_id INTEGER NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (segment_id, turn_id)
  );

  -- The write-gate stamps the cutover overwrote. writer IS NULL records that
  -- the turn had NO stamp for that field before the cutover, so a restore
  -- deletes rather than rewrites.
  CREATE TABLE IF NOT EXISTS ${MAIN_AGENT_EDGES_CUTOVER_STAMP_ARCHIVE} (
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    writer TEXT,
    write_sequence INTEGER,
    written_at_epoch INTEGER,
    PRIMARY KEY (entity_type, entity_id, field)
  );

  -- sqlite_master rows (tables, indexes, triggers) of both rebuilt tables, verbatim.
  CREATE TABLE IF NOT EXISTS ${MAIN_AGENT_EDGES_CUTOVER_DDL_ARCHIVE} (
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    tbl_name TEXT NOT NULL,
    sql TEXT,
    PRIMARY KEY (kind, name)
  );

  CREATE TABLE IF NOT EXISTS ${MAIN_AGENT_EDGES_CUTOVER_SEQUENCE_ARCHIVE} (
    name TEXT PRIMARY KEY,
    seq INTEGER NOT NULL
  );
`;

/**
 * Transform 1's own receipt (ticket 12): the tags normalisation is the FIRST
 * migration on `turns.tags` and runs on every open whether or not the
 * cutover's fence is up, so it carries its own `migration_receipts` payload
 * rather than a field of the cutover's — one step, one receipt.
 */
export interface TurnTagsNormalisationReceipt {
  nullToEmpty: number;
  nonArrayToEmpty: number;
  nonStringMembersDropped: number;
  /** Distinct turns touched — the row count of the tags archive this step wrote. */
  turnsChanged: number;
}

/** The counts the cutover's `migration_receipts` payload carries — one number per transform, per the spec's own report list. */
export interface MainAgentEdgesCutoverReceipt {
  /**
   * Pairs whose rows COLLAPSED: more than one row on the pair before, exactly
   * one after. Counted over the raw row population, wordless rows included
   * (ticket 12, P3) — a pair of one wordless row and one class-bearing row is
   * a pair the fold touched, and reporting 0 for it was a receipt defect.
   */
  foldedPairs: number;
  /** Rows the fold itself deleted — class-bearing losers only. A wordless loser is counted by `wordlessDeleted`, never twice. */
  foldedRowsDeleted: number;
  /**
   * Of the pairs holding MORE THAN ONE CLASS-BEARING row: how many differed in
   * class (or coverage) versus only in stored sides. These two partition that
   * population, not `foldedPairs` — their sum is `foldedPairs` minus the pairs
   * that collapsed only because a wordless row shared the pair.
   */
  foldedPairsByClass: number;
  foldedPairsBySidesOnly: number;
  /** Surviving rows whose coverage moved to `full` under D9's "any full -> full" rule. */
  coveragePromoted: number;
  /** Transform 3/4, per SIDE. */
  redundantCleared: number;
  invalidCleared: number;
  /** D1: every row carrying no class. */
  wordlessDeleted: number;
  rowsBefore: number;
  rowsAfter: number;
  /** Side-index rows after the rebuild — equal to the number of non-empty stored sides, asserted. */
  sideIndexRows: number;
  /** Distinct citing turns stamped `relations` (folded / cleared / deleted / rewritten rows). */
  citersStamped: number;
  /** Jobs the fence found expired and reaped, and pending/failed `stage='edges'` jobs reset to stage 1. */
  claimsReaped: { abandoned: number; returnedToPending: number };
  edgesStageJobsReset: number;
  /** The write-gate sequence recorded with the receipt — what tells a later write from the migration's own. */
  writeGateSequence: number;
  durationMs: number;
}

export interface MainAgentEdgesCutoverState {
  status: "complete";
  appliedAtEpoch: number;
  writeGateSequence: number;
}

export function readMainAgentEdgesCutoverState(db: Database): MainAgentEdgesCutoverState | null {
  const exists =
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(MAIN_AGENT_EDGES_CUTOVER_STATE_TABLE) !== null;
  if (!exists) {
    return null;
  }
  return (
    db
      .query<MainAgentEdgesCutoverState, []>(
        `SELECT status, applied_at_epoch AS appliedAtEpoch,
                write_gate_sequence AS writeGateSequence
           FROM ${MAIN_AGENT_EDGES_CUTOVER_STATE_TABLE} WHERE id = 1`,
      )
      .get() ?? null
  );
}

/** What one call to the cutover did. */
export type MainAgentEdgesCutoverOutcome =
  | { ran: "already" }
  | { ran: "deferred"; claimedJobs: number }
  | { ran: "cut-over"; receipt: MainAgentEdgesCutoverReceipt };
