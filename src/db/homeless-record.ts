import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";
import type { CitingNodeKind, EdgeNodeKind } from "./memory-edges";

/**
 * The homeless record layer (staged-settlement spec Rev 5, "Homeless
 * record"; ticket 02). Stage 1 disposes a topic group with no legal task
 * container as HOMELESS instead of inventing a lane for it; this module is
 * the durable, per-member record of that disposition and its later
 * resolution — read by stage 2 (retract-with-cause) and, later, the
 * connectivity-arming ticket's per-member exemption view. Self-contained: no
 * settlement wiring, no worker files, no `src/db/schema.ts` changes. The
 * caller owns wiring `ensureHomelessRecordTables` into `initializeSchema`
 * (see the export's own doc comment) — this module only defines and reads
 * its own four tables.
 *
 * `created_at_epoch` is used throughout rather than the spec prose's bare
 * `created_at`: every timestamp column in this codebase's schema carries the
 * `_epoch` suffix with zero exceptions (schema.ts), and the spec's own
 * shorthand is prose, not a literal column-name mandate.
 */

/** `task_scope_id`'s taskless sentinel — see `ensureHomelessRecordTables`'s doc comment for why 0, never NULL. */
export const TASKLESS_TASK_SCOPE_ID = 0;

const HOMELESS_GROUPS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS homeless_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    -- SQLite's UNIQUE index treats every NULL as distinct from every other
    -- NULL, so a nullable task_scope_id in the key below would let repeated
    -- taskless groups under the same (job, label) through the very conflict
    -- clause meant to stop them — the trap the spec names explicitly. NOT
    -- NULL with 0 as the taskless sentinel closes it by construction: 0 is a
    -- concrete value, and two taskless rows under the same (job, label)
    -- collide on the unique key exactly like two task-scoped ones would.
    task_scope_id INTEGER NOT NULL CHECK (task_scope_id >= 0),
    canonical_label TEXT NOT NULL,
    -- Caller-computed identity of the member set this group was disposed
    -- with (e.g. a hash of the sorted turn-id set). Compared, never
    -- recomputed here — see writeHomelessGroup's doc comment for the
    -- immutability contract this drives.
    member_fingerprint TEXT NOT NULL,
    reason TEXT NOT NULL,
    transition_seq INTEGER NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    UNIQUE (job_id, task_scope_id, canonical_label)
  );
`;

const HOMELESS_GROUPS_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_homeless_groups_job
    ON homeless_groups(job_id);
`;

const HOMELESS_MEMBERS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS homeless_members (
    group_id INTEGER NOT NULL REFERENCES homeless_groups(id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, turn_id)
  );
`;

const HOMELESS_MEMBERS_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_homeless_members_turn
    ON homeless_members(turn_id);
`;

const HOMELESS_SUPERSESSIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS homeless_supersessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    old_group_id INTEGER NOT NULL REFERENCES homeless_groups(id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    successor_kind TEXT NOT NULL CHECK (successor_kind IN ('homed', 'regrouped')),
    successor_group_id INTEGER REFERENCES homeless_groups(id) ON DELETE CASCADE,
    transition_seq INTEGER NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    -- A 'homed' member has no successor group (there is nowhere left to
    -- point); a 'regrouped' member must name one. Enforced here as a second
    -- line under the app-level check in writeHomelessSupersessions. SQLite
    -- requires every table-level constraint (this CHECK, the UNIQUE below)
    -- to follow ALL column definitions — it cannot be interleaved between
    -- them.
    CHECK (
      (successor_kind = 'homed' AND successor_group_id IS NULL)
      OR (successor_kind = 'regrouped' AND successor_group_id IS NOT NULL)
    ),
    -- "At most one live successor per (old_group_id, turn_id)" (spec):
    -- a member of an old group is superseded exactly once, full stop — a
    -- turn disposed again later gets a NEW group-membership event, not a
    -- second supersession row pointing at the same old group. The unique
    -- key is the mechanism, not just a description of it.
    UNIQUE (old_group_id, turn_id)
  );
`;

const HOMELESS_SUPERSESSIONS_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_homeless_supersessions_turn
    ON homeless_supersessions(turn_id);
`;

const HOMELESS_RETRACTION_AUDITS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS homeless_retraction_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    cause_group_id INTEGER NOT NULL REFERENCES homeless_groups(id) ON DELETE CASCADE,
    -- The deleted relation row's full composite identity (spec: "edge row
    -- id, citing kind+id, cited kind+id, relation word, tail tag, head
    -- tag"). No FK on edge_id: the row it names is gone by the time this
    -- audit row exists, so a live reference would be meaningless and a
    -- CASCADE-carrying one would delete the very audit trail this table
    -- exists to keep.
    edge_id INTEGER NOT NULL,
    citing_kind TEXT NOT NULL CHECK (citing_kind IN ('turn', 'segment', 'session')),
    citing_id INTEGER NOT NULL,
    cited_kind TEXT NOT NULL CHECK (cited_kind IN ('turn', 'segment')),
    cited_id INTEGER NOT NULL,
    relation_word TEXT NOT NULL,
    tail_tag TEXT NOT NULL,
    head_tag TEXT NOT NULL,
    -- 'bare-restored' is the outcome when deleting the last relation on a
    -- pair leaves the pair's bare citation row behind (db/citations.ts's
    -- restoreBareRowsForEmptiedPairs) rather than removing the pair
    -- entirely.
    outcome TEXT NOT NULL CHECK (outcome IN ('retracted', 'retracted-bare-restored')),
    created_at_epoch INTEGER NOT NULL
  );
`;

const HOMELESS_RETRACTION_AUDITS_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_homeless_retraction_audits_group
    ON homeless_retraction_audits(cause_group_id);
  CREATE INDEX IF NOT EXISTS idx_homeless_retraction_audits_job
    ON homeless_retraction_audits(job_id);
`;

/**
 * Creates the four homeless-record tables if absent. Pure additive DDL
 * (`CREATE TABLE`/`CREATE INDEX IF NOT EXISTS`), safe to call every time a
 * database opens — the same idempotency `initializeSchema`'s own DDL blocks
 * rely on. A single `db.exec` of concatenated DDL is fine here (unlike a
 * multi-statement DML copy): schema.ts's own `SCHEMA_SQL` is executed the
 * same way, and the documented `exec` trap this codebase guards against is
 * specifically about swallowed constraint failures mid multi-row DML, not
 * about `CREATE TABLE IF NOT EXISTS`.
 *
 * HANDOFF (not this ticket's file territory — `src/db/schema.ts` belongs to
 * ticket 01): the one-line wiring is calling `ensureHomelessRecordTables(db)`
 * from inside `initializeSchema`, after the `note_settlement_jobs` and
 * `turns` tables exist (both `job_id` and `turn_id` above are foreign keys
 * onto them). Until that line lands, every consumer of this module —
 * including this ticket's own tests — must call
 * `ensureHomelessRecordTables(db)` directly after `initializeSchema(db)`.
 */
export function ensureHomelessRecordTables(db: Database): void {
  db.exec(HOMELESS_GROUPS_TABLE_DDL);
  db.exec(HOMELESS_GROUPS_INDEX_DDL);
  db.exec(HOMELESS_MEMBERS_TABLE_DDL);
  db.exec(HOMELESS_MEMBERS_INDEX_DDL);
  db.exec(HOMELESS_SUPERSESSIONS_TABLE_DDL);
  db.exec(HOMELESS_SUPERSESSIONS_INDEX_DDL);
  db.exec(HOMELESS_RETRACTION_AUDITS_TABLE_DDL);
  db.exec(HOMELESS_RETRACTION_AUDITS_INDEX_DDL);
}

// ---------------------------------------------------------------------------
// Group records — immutable, no UPDATE path.
// ---------------------------------------------------------------------------

export interface WriteHomelessGroupInput {
  jobId: number;
  /** The task's id, or `TASKLESS_TASK_SCOPE_ID` (0) — never a sentinel `null`. */
  taskScopeId: number;
  canonicalLabel: string;
  memberFingerprint: string;
  reason: string;
  transitionSeq: number;
  turnIds: readonly number[];
  createdAtEpoch: number;
}

export type WriteHomelessGroupResult =
  | { outcome: "created"; groupId: number }
  | { outcome: "no-op"; groupId: number };

/**
 * Thrown by `writeHomelessGroup` when the (job, task_scope, label) key
 * already holds a group whose member fingerprint or reason differs from the
 * one just offered. Group records are immutable — there is no UPDATE path in
 * this module at all — so a genuine correction is never "write over it": it
 * is a fresh transition superseding the old group's members
 * (`writeHomelessSupersessions`) and a new group, if one is needed, under a
 * new transition_seq. After a successful stage transition the job's stage
 * moves to `edges` (ticket 03) and stage 1 never runs again for that job, so
 * in the shipped system this path becomes additionally unreachable — the
 * refusal is the mechanism, the unreachability is the invariant it buys.
 */
export class HomelessGroupImmutabilityError extends Error {
  readonly jobId: number;
  readonly taskScopeId: number;
  readonly canonicalLabel: string;
  readonly existingFingerprint: string;
  readonly existingReason: string;
  readonly attemptedFingerprint: string;
  readonly attemptedReason: string;

  constructor(details: {
    jobId: number;
    taskScopeId: number;
    canonicalLabel: string;
    existingFingerprint: string;
    existingReason: string;
    attemptedFingerprint: string;
    attemptedReason: string;
  }) {
    super(
      `homeless group (job ${details.jobId}, task_scope ${details.taskScopeId}, ` +
        `"${details.canonicalLabel}") already exists with a different ` +
        `${details.existingFingerprint !== details.attemptedFingerprint ? "member fingerprint" : "reason"} — ` +
        "group records are immutable; supersede the old group's members instead of writing over it.",
    );
    this.name = "HomelessGroupImmutabilityError";
    this.jobId = details.jobId;
    this.taskScopeId = details.taskScopeId;
    this.canonicalLabel = details.canonicalLabel;
    this.existingFingerprint = details.existingFingerprint;
    this.existingReason = details.existingReason;
    this.attemptedFingerprint = details.attemptedFingerprint;
    this.attemptedReason = details.attemptedReason;
  }
}

interface ExistingGroupKeyRow {
  id: number;
  memberFingerprint: string;
  reason: string;
}

/**
 * Writes a homeless group and its member rows under the immutability
 * contract (spec): same key (`job_id, task_scope_id, canonical_label`) with
 * the same `member_fingerprint` AND the same `reason` is a success no-op —
 * the fingerprint is trusted as the identity of "the same disposition",
 * never re-derived from `turnIds` here. Same key with a different
 * fingerprint or reason throws `HomelessGroupImmutabilityError`. There is no
 * UPDATE statement anywhere in this module — the only two outcomes are
 * "created" and "no-op".
 *
 * Read-then-write inside one `IMMEDIATE` transaction (the same idiom
 * `db/sessions.ts`'s `upsertSession` uses): SQLite's write lock serializes
 * concurrent callers across the read and the write, so this is race-safe
 * without a second guard at the unique index — the index still exists as the
 * hard backstop (see `ensureHomelessRecordTables`'s doc comment on the NULL
 * trap).
 */
export function writeHomelessGroup(
  db: Database,
  input: WriteHomelessGroupInput,
): WriteHomelessGroupResult {
  return runWriteTransaction(db, () => {
    const existing = db
      .query<ExistingGroupKeyRow, [number, number, string]>(
        `SELECT id, member_fingerprint AS memberFingerprint, reason
         FROM homeless_groups
         WHERE job_id = ? AND task_scope_id = ? AND canonical_label = ?`,
      )
      .get(input.jobId, input.taskScopeId, input.canonicalLabel);

    if (existing) {
      if (
        existing.memberFingerprint === input.memberFingerprint &&
        existing.reason === input.reason
      ) {
        return { outcome: "no-op", groupId: existing.id };
      }
      throw new HomelessGroupImmutabilityError({
        jobId: input.jobId,
        taskScopeId: input.taskScopeId,
        canonicalLabel: input.canonicalLabel,
        existingFingerprint: existing.memberFingerprint,
        existingReason: existing.reason,
        attemptedFingerprint: input.memberFingerprint,
        attemptedReason: input.reason,
      });
    }

    const inserted = db
      .query<{ id: number }, [number, number, string, string, string, number, number]>(
        `INSERT INTO homeless_groups (
           job_id, task_scope_id, canonical_label, member_fingerprint,
           reason, transition_seq, created_at_epoch
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        input.jobId,
        input.taskScopeId,
        input.canonicalLabel,
        input.memberFingerprint,
        input.reason,
        input.transitionSeq,
        input.createdAtEpoch,
      )!;

    const insertMember = db.query<unknown, [number, number]>(
      `INSERT INTO homeless_members (group_id, turn_id) VALUES (?, ?)`,
    );
    for (const turnId of input.turnIds) {
      insertMember.run(inserted.id, turnId);
    }

    return { outcome: "created", groupId: inserted.id };
  });
}

export interface HomelessGroupRecord {
  id: number;
  jobId: number;
  taskScopeId: number;
  canonicalLabel: string;
  memberFingerprint: string;
  reason: string;
  transitionSeq: number;
  createdAtEpoch: number;
}

const HOMELESS_GROUP_COLUMNS = `
  id,
  job_id AS jobId,
  task_scope_id AS taskScopeId,
  canonical_label AS canonicalLabel,
  member_fingerprint AS memberFingerprint,
  reason,
  transition_seq AS transitionSeq,
  created_at_epoch AS createdAtEpoch
`;

/** Test/inspection surface — a group record by id, or null. */
export function loadHomelessGroup(db: Database, groupId: number): HomelessGroupRecord | null {
  return (
    db
      .query<HomelessGroupRecord, [number]>(
        `SELECT ${HOMELESS_GROUP_COLUMNS} FROM homeless_groups WHERE id = ?`,
      )
      .get(groupId) ?? null
  );
}

/** Test/inspection surface — every turn id belonging to a group, ascending. */
export function loadHomelessGroupMembers(db: Database, groupId: number): number[] {
  return db
    .query<{ turnId: number }, [number]>(
      `SELECT turn_id AS turnId FROM homeless_members WHERE group_id = ? ORDER BY turn_id ASC`,
    )
    .all(groupId)
    .map((row) => row.turnId);
}

// ---------------------------------------------------------------------------
// Supersessions — member-row-level resolution of a stale homeless group.
// ---------------------------------------------------------------------------

export type HomelessSupersessionKind = "homed" | "regrouped";

export interface HomelessSupersessionMapping {
  oldGroupId: number;
  turnId: number;
  successorKind: HomelessSupersessionKind;
  /** Required (and validated) for `regrouped`; must be null for `homed`. */
  successorGroupId: number | null;
}

export interface WriteHomelessSupersessionsInput {
  transitionSeq: number;
  createdAtEpoch: number;
  mappings: readonly HomelessSupersessionMapping[];
}

/**
 * Thrown when two mappings in the SAME `writeHomelessSupersessions` call
 * disagree about one turn's outcome — spec: "all mappings one transition
 * writes for one turn agree on the outcome". A turn can legitimately appear
 * twice in one batch (member of two different old groups being resolved by
 * the same transition), but every row for that turn must name the same
 * successor_kind and, if regrouped, the same successor group.
 */
export class HomelessSupersessionOutcomeConflictError extends Error {
  readonly turnId: number;
  readonly firstOutcome: string;
  readonly conflictingOutcome: string;

  constructor(turnId: number, firstOutcome: string, conflictingOutcome: string) {
    super(
      `turn ${turnId} was mapped to two different outcomes in one transition ` +
        `(${firstOutcome} vs ${conflictingOutcome}) — every mapping this transition ` +
        "writes for one turn must agree on the outcome.",
    );
    this.name = "HomelessSupersessionOutcomeConflictError";
    this.turnId = turnId;
    this.firstOutcome = firstOutcome;
    this.conflictingOutcome = conflictingOutcome;
  }
}

/**
 * Thrown when a `regrouped` mapping's successor group does not exist, or
 * exists but was created under a DIFFERENT `transition_seq` than the mapping
 * itself — spec: "a regrouped successor group carries the SAME
 * transition_seq as the mapping". The successor group and the mapping that
 * points to it are two rows the same transition writes together; a mismatch
 * means they came from different writes, which the mapping is never allowed
 * to claim.
 */
export class HomelessSupersessionSuccessorTransitionError extends Error {
  readonly turnId: number;
  readonly successorGroupId: number;
  readonly mappingTransitionSeq: number;
  readonly successorTransitionSeq: number | null;

  constructor(details: {
    turnId: number;
    successorGroupId: number;
    mappingTransitionSeq: number;
    successorTransitionSeq: number | null;
  }) {
    super(
      details.successorTransitionSeq === null
        ? `turn ${details.turnId}'s regrouped mapping names successor group ` +
          `${details.successorGroupId}, which does not exist.`
        : `turn ${details.turnId}'s regrouped mapping (transition_seq ` +
          `${details.mappingTransitionSeq}) names successor group ${details.successorGroupId}, ` +
          `which was created under a different transition_seq ` +
          `(${details.successorTransitionSeq}) — a regrouped successor must be created by ` +
          "the SAME transition as the mapping that points to it.",
    );
    this.name = "HomelessSupersessionSuccessorTransitionError";
    this.turnId = details.turnId;
    this.successorGroupId = details.successorGroupId;
    this.mappingTransitionSeq = details.mappingTransitionSeq;
    this.successorTransitionSeq = details.successorTransitionSeq;
  }
}

function supersessionOutcomeSignature(mapping: HomelessSupersessionMapping): string {
  return `${mapping.successorKind}:${mapping.successorGroupId ?? "null"}`;
}

/**
 * Writes one transition's supersession mappings. Validates, in order:
 *
 *  1. shape — `homed` carries no successor group, `regrouped` carries one
 *     (the table's own CHECK constraint is the second line of defense);
 *  2. same-transition agreement per turn (`HomelessSupersessionOutcomeConflictError`);
 *  3. a `regrouped` successor group exists and was created at this same
 *     `transitionSeq` (`HomelessSupersessionSuccessorTransitionError`).
 *
 * "At most one live successor per (old_group_id, turn_id)" is enforced by
 * the table's own `UNIQUE (old_group_id, turn_id)` — a second write for a
 * pair already resolved throws the raw SQLite constraint error, not a named
 * one here, since it is a storage-layer invariant rather than a caller
 * input-shape judgement.
 */
export function writeHomelessSupersessions(
  db: Database,
  input: WriteHomelessSupersessionsInput,
): void {
  return runWriteTransaction(db, () => {
    const outcomeByTurn = new Map<number, string>();
    for (const mapping of input.mappings) {
      if (mapping.successorKind === "homed" && mapping.successorGroupId !== null) {
        throw new Error(
          `turn ${mapping.turnId}'s 'homed' mapping must not carry a successor group.`,
        );
      }
      if (mapping.successorKind === "regrouped" && mapping.successorGroupId === null) {
        throw new Error(
          `turn ${mapping.turnId}'s 'regrouped' mapping must name a successor group.`,
        );
      }

      const signature = supersessionOutcomeSignature(mapping);
      const priorSignature = outcomeByTurn.get(mapping.turnId);
      if (priorSignature !== undefined && priorSignature !== signature) {
        throw new HomelessSupersessionOutcomeConflictError(
          mapping.turnId,
          priorSignature,
          signature,
        );
      }
      outcomeByTurn.set(mapping.turnId, signature);

      if (mapping.successorKind === "regrouped") {
        const successor = db
          .query<{ transitionSeq: number }, [number]>(
            `SELECT transition_seq AS transitionSeq FROM homeless_groups WHERE id = ?`,
          )
          .get(mapping.successorGroupId!);
        if (!successor || successor.transitionSeq !== input.transitionSeq) {
          throw new HomelessSupersessionSuccessorTransitionError({
            turnId: mapping.turnId,
            successorGroupId: mapping.successorGroupId!,
            mappingTransitionSeq: input.transitionSeq,
            successorTransitionSeq: successor?.transitionSeq ?? null,
          });
        }
      }
    }

    const insert = db.query<
      unknown,
      [number, number, string, number | null, number, number]
    >(
      `INSERT INTO homeless_supersessions (
         old_group_id, turn_id, successor_kind, successor_group_id,
         transition_seq, created_at_epoch
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const mapping of input.mappings) {
      insert.run(
        mapping.oldGroupId,
        mapping.turnId,
        mapping.successorKind,
        mapping.successorGroupId,
        input.transitionSeq,
        input.createdAtEpoch,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// The active view — the SOLE entry point, reducing events, not groups.
// ---------------------------------------------------------------------------

export interface HomelessActiveDisposition {
  turnId: number;
  groupId: number;
  jobId: number;
  taskScopeId: number;
  canonicalLabel: string;
  reason: string;
  /** The transition_seq of the winning event, not necessarily the group's own. */
  transitionSeq: number;
}

interface HomelessEvent {
  transitionSeq: number;
  kind: "creation" | HomelessSupersessionKind;
  groupId: number | null;
}

/**
 * The homeless active view (spec round 4): a turn's disposition is the
 * result of its single highest-`transition_seq` EVENT, never "the highest
 * covering group" (that reading was retracted — a `homed` supersession
 * creates no covering group, so it would leave a stale homeless record
 * active forever). Two event kinds exist for a turn:
 *
 *   - group-membership creation, timestamped by the OWNING GROUP's own
 *     transition_seq (a member has no transition_seq of its own — joining a
 *     group at its creation IS the event);
 *   - supersession, timestamped by the transition that wrote it.
 *
 * `job_id` ordering is never used as a time proxy (overlapping backfills and
 * manual queues commit out of id order) — only `transition_seq` decides.
 *
 * This is the module's ONLY reduction implementation and every consumer
 * (stage 2's retract-with-cause, the future connectivity-arming ticket's
 * per-member exemption view) must call THIS function rather than re-deriving
 * "is this turn homeless" from the raw tables — that duplication is exactly
 * how the round-3 covering-group bug happened.
 */
export function resolveActiveHomelessDisposition(
  db: Database,
  turnId: number,
): HomelessActiveDisposition | null {
  const creationEvents = db
    .query<{ transitionSeq: number; groupId: number }, [number]>(
      `SELECT g.transition_seq AS transitionSeq, g.id AS groupId
       FROM homeless_members m
       JOIN homeless_groups g ON g.id = m.group_id
       WHERE m.turn_id = ?`,
    )
    .all(turnId)
    .map((row): HomelessEvent => ({
      transitionSeq: row.transitionSeq,
      kind: "creation",
      groupId: row.groupId,
    }));

  const supersessionEvents = db
    .query<
      { transitionSeq: number; kind: HomelessSupersessionKind; groupId: number | null },
      [number]
    >(
      `SELECT transition_seq AS transitionSeq, successor_kind AS kind,
              successor_group_id AS groupId
       FROM homeless_supersessions
       WHERE turn_id = ?`,
    )
    .all(turnId)
    .map((row): HomelessEvent => ({
      transitionSeq: row.transitionSeq,
      kind: row.kind,
      groupId: row.groupId,
    }));

  const events = [...creationEvents, ...supersessionEvents];
  if (events.length === 0) {
    return null;
  }

  events.sort((a, b) => b.transitionSeq - a.transitionSeq);
  const winner = events[0]!;

  if (winner.kind === "homed" || winner.groupId === null) {
    return null;
  }

  const group = loadHomelessGroup(db, winner.groupId);
  if (!group) {
    return null;
  }

  return {
    turnId,
    groupId: group.id,
    jobId: group.jobId,
    taskScopeId: group.taskScopeId,
    canonicalLabel: group.canonicalLabel,
    reason: group.reason,
    transitionSeq: winner.transitionSeq,
  };
}

// ---------------------------------------------------------------------------
// Retraction audit — full composite identity of a deleted relation row.
// ---------------------------------------------------------------------------

export type HomelessRetractionOutcome = "retracted" | "retracted-bare-restored";

export interface HomelessRetractionAuditRecord {
  jobId: number;
  causeGroupId: number;
  edgeId: number;
  citingKind: CitingNodeKind;
  citingId: number;
  citedKind: EdgeNodeKind;
  citedId: number;
  relationWord: string;
  tailTag: string;
  headTag: string;
  outcome: HomelessRetractionOutcome;
  createdAtEpoch: number;
}

/**
 * Writes one retraction audit row. MUST be called inside the same
 * transaction as the relation-row deletion it records (spec) — this
 * function does not open its own transaction (unlike every write helper
 * above) precisely so it composes into the caller's, the same bare-`.run()`
 * shape `db/phase-retype-audit.ts`'s `recordPhaseRetypeAudit` uses for the
 * same reason. A caller that calls this standalone, outside any transaction,
 * still gets a durable row (bun:sqlite auto-commits a bare statement) — it
 * simply loses the atomicity guarantee with whatever deletion motivated it,
 * which is the caller's discipline to keep, not this function's to enforce.
 */
export function recordHomelessRetractionAudit(
  db: Database,
  record: HomelessRetractionAuditRecord,
): number {
  const row = db
    .query<
      { id: number },
      [
        number,
        number,
        number,
        string,
        number,
        string,
        number,
        string,
        string,
        string,
        string,
        number,
      ]
    >(
      `INSERT INTO homeless_retraction_audits (
         job_id, cause_group_id, edge_id, citing_kind, citing_id,
         cited_kind, cited_id, relation_word, tail_tag, head_tag,
         outcome, created_at_epoch
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      record.jobId,
      record.causeGroupId,
      record.edgeId,
      record.citingKind,
      record.citingId,
      record.citedKind,
      record.citedId,
      record.relationWord,
      record.tailTag,
      record.headTag,
      record.outcome,
      record.createdAtEpoch,
    )!;
  return row.id;
}

export interface HomelessRetractionAuditRow extends HomelessRetractionAuditRecord {
  id: number;
}

const HOMELESS_RETRACTION_AUDIT_COLUMNS = `
  id,
  job_id AS jobId,
  cause_group_id AS causeGroupId,
  edge_id AS edgeId,
  citing_kind AS citingKind,
  citing_id AS citingId,
  cited_kind AS citedKind,
  cited_id AS citedId,
  relation_word AS relationWord,
  tail_tag AS tailTag,
  head_tag AS headTag,
  outcome,
  created_at_epoch AS createdAtEpoch
`;

/** Test/inspection surface — every retraction audit row caused by one group, ascending by id. */
export function loadHomelessRetractionAuditsForGroup(
  db: Database,
  causeGroupId: number,
): HomelessRetractionAuditRow[] {
  return db
    .query<HomelessRetractionAuditRow, [number]>(
      `SELECT ${HOMELESS_RETRACTION_AUDIT_COLUMNS}
       FROM homeless_retraction_audits
       WHERE cause_group_id = ?
       ORDER BY id ASC`,
    )
    .all(causeGroupId);
}
