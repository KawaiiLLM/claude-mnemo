import type { Database } from "bun:sqlite";

/**
 * The read-write contract's gate (`.scratch/read-write-contract/spec.md`,
 * "门(写面)"). One shared module for the whole write gate — the read-grant
 * ledger, the per-field freshness stamp, the monotonic sequence both key off,
 * and the three-judgment admit/reject check every managed writer (`note`,
 * `remember`, and ticket 05's settlement facade) consumes identically.
 *
 * Vocabulary (CONTEXT.md "Write gate"): Read grant, Stale, Writer.
 */

export type WriteGateEntityType = "segment" | "turn" | "session";

// ---------------------------------------------------------------------------
// Writer identity (pinned cross-ticket contract — do not re-decide).
// ---------------------------------------------------------------------------

/** The main agent's writer identity: the caller's own mnemo session. */
export function sessionWriterId(sessionDbId: number): string {
  return `session:${sessionDbId}`;
}

/**
 * Settlement's per-run writer identity (ticket 05 only writes this format —
 * this ticket defines it so the encoding cannot drift between the two
 * callers). Each claimed run is its own identity: a lapsed claim and its
 * successor are "other writers" to each other, so the freshness check alone
 * makes the old claim's writes stale without a dedicated CAS.
 */
export function claimWriterId(jobId: number, generation: number): string {
  return `claim:${jobId}:${generation}`;
}

const SESSION_WRITER_PATTERN = /^session:(\d+)$/;

/** A writer id rendered for a human-facing error message — `session:123` -> `S123`. */
export function formatWriterForDisplay(writer: string): string {
  const match = SESSION_WRITER_PATTERN.exec(writer);
  if (match) {
    return `S${match[1]}`;
  }
  return writer;
}

// ---------------------------------------------------------------------------
// The monotonic sequence (spec: "用序列号而非整数秒比较").
// ---------------------------------------------------------------------------

/**
 * The next value in the write gate's single counter. Callers needing a fresh
 * number for a stamp call this inside their own write transaction — it self-
 * seeds on first use, so no separate schema-time insert is needed.
 */
export function nextWriteGateSequence(db: Database): number {
  return db
    .query<{ value: number }, []>(
      `INSERT INTO write_gate_sequence (id, value) VALUES (1, 1)
       ON CONFLICT(id) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get()!.value;
}

/**
 * The counter's current value, without consuming one — what a read grant
 * snapshots. Ticket 14 (P1-3 fix, spec "授权序列渲染前快照"): every render
 * pass must call this ONCE at the moment it STARTS (before it reads any
 * row), then carry the returned number through to whatever
 * `recordReadGrant(s)` call eventually records what it rendered. Calling
 * this again at record time — the bug this fix closes — lets a foreign
 * write that lands between render and record make the grant look fresher
 * than what the render pass actually showed: a reader who fetched a field's
 * value BEFORE a concurrent writer changed it would still get a grant
 * stamped with the sequence AFTER that write, and a subsequent
 * `checkFieldGate` call would then wrongly treat the stale render as
 * current.
 */
export function snapshotWriteGateSequence(db: Database): number {
  const row = db
    .query<{ value: number }, []>(`SELECT value FROM write_gate_sequence WHERE id = 1`)
    .get();
  return row?.value ?? 0;
}

// ---------------------------------------------------------------------------
// Read grants (spec: "读集... 统一渲染器渲染即记录").
// ---------------------------------------------------------------------------

export interface ReadGrantEntry {
  entityType: WriteGateEntityType;
  entityId: number;
}

/**
 * Records (or refreshes) `writer`'s read grant on one entity — the seam every
 * render path (recall/timeline tool renders, SessionStart injection) calls
 * for whatever it just rendered. Idempotent and non-destructive: re-reading
 * an entity just bumps the grant's own snapshot forward; it never touches
 * another writer's grant or any field stamp.
 *
 * `sequence` (ticket 14, P1-3 fix): the caller's OWN `snapshotWriteGateSequence(db)`
 * value, captured at the START of the render pass that produced this entity —
 * never looked up here, at record time, which is what let a foreign write
 * landing between render and record masquerade as already-seen. See
 * `snapshotWriteGateSequence`'s own doc comment for the failure this closes.
 */
export function recordReadGrant(
  db: Database,
  writer: string,
  entityType: WriteGateEntityType,
  entityId: number,
  nowEpoch: number,
  sequence: number,
): void {
  db.query<unknown, [string, string, number, number, number]>(
    `INSERT INTO write_gate_reads (writer, entity_type, entity_id, read_at_epoch, read_sequence)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(writer, entity_type, entity_id) DO UPDATE SET
       read_at_epoch = excluded.read_at_epoch,
       read_sequence = excluded.read_sequence`,
  ).run(writer, entityType, entityId, nowEpoch, sequence);
}

/**
 * Batch form of `recordReadGrant` — one render pass, several entities shown
 * (e.g. a listing page). `sequence`: same pre-render snapshot contract as
 * `recordReadGrant` — ONE value for the whole batch, since every entity this
 * single render pass showed was current as of the same render-start instant.
 */
export function recordReadGrants(
  db: Database,
  writer: string,
  entries: readonly ReadGrantEntry[],
  nowEpoch: number,
  sequence: number,
): void {
  if (entries.length === 0) {
    return;
  }
  const stmt = db.query<unknown, [string, string, number, number, number]>(
    `INSERT INTO write_gate_reads (writer, entity_type, entity_id, read_at_epoch, read_sequence)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(writer, entity_type, entity_id) DO UPDATE SET
       read_at_epoch = excluded.read_at_epoch,
       read_sequence = excluded.read_sequence`,
  );
  for (const entry of entries) {
    stmt.run(writer, entry.entityType, entry.entityId, nowEpoch, sequence);
  }
}

interface ReadGrantRow {
  readAtEpoch: number;
  readSequence: number;
}

function getReadGrant(
  db: Database,
  writer: string,
  entityType: WriteGateEntityType,
  entityId: number,
): ReadGrantRow | null {
  return (
    db
      .query<ReadGrantRow, [string, string, number]>(
        `SELECT read_at_epoch AS readAtEpoch, read_sequence AS readSequence
         FROM write_gate_reads
         WHERE writer = ? AND entity_type = ? AND entity_id = ?`,
      )
      .get(writer, entityType, entityId) ?? null
  );
}

/**
 * Clears every read grant a writer holds — session-end cleanup (spec:
 * "session 终结时清理其读集"). Also sweeps that writer's own per-field
 * completeness rows (ticket 04): they are keyed by writer exactly like a
 * grant, so a completed writer's completeness facts are just as stale as its
 * grants and must not survive to be misread by anything reusing the id.
 */
export function clearReadGrantsForWriter(db: Database, writer: string): number {
  const clearedCompleteness = db
    .query<unknown, [string]>(`DELETE FROM write_gate_field_completeness WHERE writer = ?`)
    .run(writer).changes;
  const clearedGrants = db
    .query<unknown, [string]>(`DELETE FROM write_gate_reads WHERE writer = ?`)
    .run(writer).changes;
  return clearedGrants + clearedCompleteness;
}

/**
 * Janitor backstop: sweeps read grants held by `session:<id>` writers whose
 * session has already completed (spec: "janitor 兜底"). A completed
 * session's SessionEnd hook should already have cleared its own grants via
 * `clearReadGrantsForWriter` — this is what self-heals a missed one (a crash
 * between completion and that call, for instance), bounded by `limit` so a
 * routine SessionEnd is never turned into an unbounded table scan.
 */
export function sweepReadGrantsForCompletedSessions(
  db: Database,
  limit: number,
): number {
  const rows = db
    .query<{ writer: string }, [number]>(
      `SELECT DISTINCT r.writer AS writer
       FROM write_gate_reads r
       JOIN sessions s ON s.id = CAST(substr(r.writer, 9) AS INTEGER)
       WHERE r.writer LIKE 'session:%' AND s.completed_at_epoch IS NOT NULL
       LIMIT ?`,
    )
    .all(limit);
  let cleared = 0;
  for (const row of rows) {
    cleared += clearReadGrantsForWriter(db, row.writer);
  }
  return cleared;
}

// ---------------------------------------------------------------------------
// Per-field completeness (write-mode-edit-semantics spec D8, ticket 04 — the
// RECORD half only). A later, blocked ticket decides what `write` REQUIRES
// of this data; this module only stores what a render pass actually showed.
// ---------------------------------------------------------------------------

export interface FieldCompletenessEntry {
  entityType: WriteGateEntityType;
  entityId: number;
  field: string;
  complete: boolean;
}

/**
 * Records (or refreshes) `writer`'s completeness fact for every entry in
 * `entries` — the seam a renderer's OWN per-field truncation signal
 * (`format.ts`'s `TruncationSignal.fieldCompleteness`, `segment-card.ts`'s
 * elision ladder) flushes through once its render pass is done. Later wins
 * (ON CONFLICT overwrite): a field read truncated once and complete the next
 * is recorded complete — it is never permanently disqualified by an earlier
 * truncated read, the same "re-reading refreshes, never accumulates" rule
 * `recordReadGrant` itself already follows.
 *
 * `sequence`: the SAME pre-render `snapshotWriteGateSequence(db)` value the
 * caller's own `recordReadGrant(s)` call for this pass already carries (see
 * that function's doc comment) — completeness belongs to what THIS render
 * pass showed, never to whatever the counter reads at record time.
 */
export function recordFieldCompleteness(
  db: Database,
  writer: string,
  entries: readonly FieldCompletenessEntry[],
  nowEpoch: number,
  sequence: number,
): void {
  if (entries.length === 0) {
    return;
  }
  const stmt = db.query<unknown, [string, string, number, string, number, number, number]>(
    `INSERT INTO write_gate_field_completeness
       (writer, entity_type, entity_id, field, complete, recorded_sequence, recorded_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(writer, entity_type, entity_id, field) DO UPDATE SET
       complete = excluded.complete,
       recorded_sequence = excluded.recorded_sequence,
       recorded_at_epoch = excluded.recorded_at_epoch`,
  );
  for (const entry of entries) {
    stmt.run(
      writer,
      entry.entityType,
      entry.entityId,
      entry.field,
      entry.complete ? 1 : 0,
      sequence,
      nowEpoch,
    );
  }
}

export interface FieldCompletenessRecord {
  complete: boolean;
  sequence: number;
  recordedAtEpoch: number;
}

/** `writer`'s own last-recorded completeness fact for one field, or `null` if no render pass of theirs ever showed it. */
export function getFieldCompleteness(
  db: Database,
  writer: string,
  entityType: WriteGateEntityType,
  entityId: number,
  field: string,
): FieldCompletenessRecord | null {
  const row = db
    .query<
      { complete: number; sequence: number; recordedAtEpoch: number },
      [string, string, number, string]
    >(
      `SELECT complete, recorded_sequence AS sequence, recorded_at_epoch AS recordedAtEpoch
       FROM write_gate_field_completeness
       WHERE writer = ? AND entity_type = ? AND entity_id = ? AND field = ?`,
    )
    .get(writer, entityType, entityId, field);
  return row
    ? { complete: row.complete === 1, sequence: row.sequence, recordedAtEpoch: row.recordedAtEpoch }
    : null;
}

// ---------------------------------------------------------------------------
// Field stamps (spec: "字段印章表").
// ---------------------------------------------------------------------------

export interface WriteGateStamp {
  writer: string;
  writeSequence: number;
  writtenAtEpoch: number;
}

export function getFieldStamp(
  db: Database,
  entityType: WriteGateEntityType,
  entityId: number,
  field: string,
): WriteGateStamp | null {
  return (
    db
      .query<WriteGateStamp, [string, number, string]>(
        `SELECT writer, write_sequence AS writeSequence, written_at_epoch AS writtenAtEpoch
         FROM write_gate_stamps
         WHERE entity_type = ? AND entity_id = ? AND field = ?`,
      )
      .get(entityType, entityId, field) ?? null
  );
}

/**
 * Stamps one field as just written by `writer` — the write gate's own half
 * of "检查-写入原子": call this from INSIDE the same write transaction as the
 * actual field mutation, after the gate check has already passed. Advances
 * the monotonic sequence, so a later `checkFieldGate` can tell whether this
 * write happened before or after any given reader's grant.
 *
 * An explicit `null` clear is a write like any other (spec: "清空后的字段是
 * 「被写过」而非「从未写过」") — this function does not know or care what
 * value was written, only that a write happened, so callers stamp a clear
 * exactly the way they stamp any other value.
 */
export function stampField(
  db: Database,
  entityType: WriteGateEntityType,
  entityId: number,
  field: string,
  writer: string,
  nowEpoch: number,
): WriteGateStamp {
  const writeSequence = nextWriteGateSequence(db);
  db.query<unknown, [string, number, string, string, number, number]>(
    `INSERT INTO write_gate_stamps (entity_type, entity_id, field, writer, write_sequence, written_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_type, entity_id, field) DO UPDATE SET
       writer = excluded.writer,
       write_sequence = excluded.write_sequence,
       written_at_epoch = excluded.written_at_epoch`,
  ).run(entityType, entityId, field, writer, writeSequence, nowEpoch);
  return { writer, writeSequence, writtenAtEpoch: nowEpoch };
}

// ---------------------------------------------------------------------------
// The gate check (spec: "三判次序").
// ---------------------------------------------------------------------------

export type WriteGateVerdict =
  | { ok: true }
  | { ok: false; reason: "never-read"; message: string }
  | { ok: false; reason: "stale"; message: string; staleWriter: string };

/**
 * Error text (spec: "报文两分... 两形态在报文层可区分"). `address` is the
 * caller's own display form for the entity ("E42", "S15069/T332") — this
 * module has no opinion on addressing, it only names the field and the other
 * writer.
 */
function neverReadMessage(address: string): string {
  return `${address} has not been read this session — recall(id="${address}") first, then write it.`;
}

function staleMessage(field: string, address: string, staleWriter: string): string {
  const label = formatWriterForDisplay(staleWriter);
  return (
    `${field} on ${address} was changed by ${label} since you last read it — ` +
    `recall(id="${address}") again before writing ${field}.`
  );
}

/**
 * The three-judgment check for one field (spec "三判次序"), evaluated
 * against the CURRENT database state — callers run this inside their own
 * write transaction, immediately before performing the write, so there is no
 * gap between the check and the mutation it guards ("检查-写入原子").
 *
 * (1) Granted (this writer has read the entity) and the field was not
 *     written by someone else since that read -> admit.
 * (2) Not granted, but this writer's own prior write is still the field's
 *     last one ("writing is reading") -> admit.
 * (3) Not granted, and the field has never been written by anyone -> admit
 *     (a create is not gated on having read the thing it creates).
 * (4) Otherwise -> reject, `never-read` when this writer holds no grant at
 *     all on the entity, `stale` when it does but the field outran it.
 */
export function checkFieldGate(
  db: Database,
  writer: string,
  entityType: WriteGateEntityType,
  entityId: number,
  field: string,
  address: string,
): WriteGateVerdict {
  const grant = getReadGrant(db, writer, entityType, entityId);
  const stamp = getFieldStamp(db, entityType, entityId, field);

  if (grant) {
    const movedSinceRead =
      stamp !== null && stamp.writer !== writer && stamp.writeSequence > grant.readSequence;
    if (!movedSinceRead) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: "stale",
      message: staleMessage(field, address, stamp!.writer),
      staleWriter: stamp!.writer,
    };
  }

  if (stamp === null || stamp.writer === writer) {
    return { ok: true };
  }

  return { ok: false, reason: "never-read", message: neverReadMessage(address) };
}
