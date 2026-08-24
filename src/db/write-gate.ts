import type { Database } from "bun:sqlite";

import { isLiveTurn } from "./turn-liveness";

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

/**
 * The stand-in identity a stamp is written under when the mutating caller has
 * no writer id of its own (peer round P1-8): every construction path but the
 * MCP direct-execution entry point leaves `callerSessionId` unresolved, and
 * those writers are never GATED ("unknown always admits"). They still MUTATE,
 * though, so a revision stamp they skipped would leave some other writer's
 * completeness record looking current over a set that has since changed. An
 * anonymous stamp keeps the freshness half honest without granting the
 * anonymous caller anything: this string matches no real writer, so rule 2
 * ("writing is reading") never fires for it.
 */
export const ANONYMOUS_WRITER = "unknown";

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
// Writer context epoch (light-review-repairs 04, ticket 01's P1 repair): the
// soundness boundary that replaced PreCompact's two-table DELETE-as-wipe.
// ---------------------------------------------------------------------------

/**
 * `writer`'s own count of `write_gate_epochs` bumps. A writer with no row
 * here reads as epoch 0 — the exact default every pre-migration
 * `write_gate_reads`/`write_gate_field_completeness` row also carries (see
 * those columns' own comments in `db/schema.ts`), so a writer nobody has
 * ever bumped behaves exactly as it did before this ticket.
 */
function getWriterEpoch(db: Database, writer: string): number {
  const row = db
    .query<{ epoch: number }, [string]>(
      `SELECT epoch FROM write_gate_epochs WHERE writer = ?`,
    )
    .get(writer);
  return row?.epoch ?? 0;
}

/**
 * Advances `writer`'s context epoch by one and returns the new value — the
 * writer-context-epoch soundness boundary (light-review-repairs 04, repair
 * to grant-lifecycle ticket 01's P1) that replaces PreCompact's two-table
 * DELETE. Every read grant and completeness row `writer` earned under an
 * OLDER epoch becomes invisible to `checkFieldGate`/`checkRelationsGate` the
 * instant this commits — `getReadGrant` and `getFieldCompleteness` both
 * filter on the writer's CURRENT epoch — without physically touching either
 * row. That is the whole point: PreCompact (`hooks/handlers/compact.ts`)
 * calls this instead of the old `clearReadGrantsForWriter` DELETE, shrinking
 * PreCompact's own failure surface from two unbounded DELETEs to one
 * single-row UPSERT. Physical removal of the now-dead rows is deferred to
 * the janitor (`sweepStaleReadGrants`), which sweeps old-epoch rows
 * alongside its existing age sweep.
 *
 * `SessionStart(source=compact)`'s bare context handler
 * (`hooks/handlers/context.ts`) calls this AGAIN, unconditionally, before it
 * records the segment roster's own new grants — the crash backstop: if the
 * PreCompact bump above failed (it is best-effort, wrapped in its own
 * try/catch there), this second bump still lands before anything can be
 * granted under the writer's post-compact identity, so no grant earned
 * before compact survives either way. Calling this twice in a row is
 * harmless — nothing is granted between the two calls, so whether the
 * writer's current epoch ends up N+1 or N+2 decides nothing further: every
 * pre-compact row is equally dead under both.
 */
export function bumpWriterEpoch(db: Database, writer: string): number {
  return db
    .query<{ epoch: number }, [string]>(
      `INSERT INTO write_gate_epochs (writer, epoch) VALUES (?, 1)
       ON CONFLICT(writer) DO UPDATE SET epoch = epoch + 1
       RETURNING epoch`,
    )
    .get(writer)!.epoch;
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
  const epoch = getWriterEpoch(db, writer);
  db.query<unknown, [string, string, number, number, number, number]>(
    `INSERT INTO write_gate_reads (writer, entity_type, entity_id, read_at_epoch, read_sequence, epoch)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(writer, entity_type, entity_id) DO UPDATE SET
       read_at_epoch = excluded.read_at_epoch,
       read_sequence = excluded.read_sequence,
       epoch = excluded.epoch`,
  ).run(writer, entityType, entityId, nowEpoch, sequence, epoch);
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
  const epoch = getWriterEpoch(db, writer);
  const stmt = db.query<unknown, [string, string, number, number, number, number]>(
    `INSERT INTO write_gate_reads (writer, entity_type, entity_id, read_at_epoch, read_sequence, epoch)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(writer, entity_type, entity_id) DO UPDATE SET
       read_at_epoch = excluded.read_at_epoch,
       read_sequence = excluded.read_sequence,
       epoch = excluded.epoch`,
  );
  for (const entry of entries) {
    stmt.run(writer, entry.entityType, entry.entityId, nowEpoch, sequence, epoch);
  }
}

interface ReadGrantRow {
  readAtEpoch: number;
  readSequence: number;
}

/**
 * Light-review-repairs 04 (P1): only a row recorded under `writer`'s CURRENT
 * epoch (`getWriterEpoch`) is visible here — a row earned under an older
 * epoch reads as "never read", the same verdict a physically deleted row
 * would produce, without this function (or its caller) needing to know
 * whether the row still physically exists.
 */
function getReadGrant(
  db: Database,
  writer: string,
  entityType: WriteGateEntityType,
  entityId: number,
): ReadGrantRow | null {
  const epoch = getWriterEpoch(db, writer);
  return (
    db
      .query<ReadGrantRow, [string, string, number, number]>(
        `SELECT read_at_epoch AS readAtEpoch, read_sequence AS readSequence
         FROM write_gate_reads
         WHERE writer = ? AND entity_type = ? AND entity_id = ? AND epoch = ?`,
      )
      .get(writer, entityType, entityId, epoch) ?? null
  );
}

/**
 * Physically clears every read grant AND per-field completeness row a writer
 * holds, unconditionally — a direct nuke, independent of epoch.
 *
 * Light-review-repairs 04 (P1): PreCompact (`hooks/handlers/compact.ts`) no
 * longer calls this. The grant-lifecycle wipe's soundness boundary is now
 * `bumpWriterEpoch` (a single-row UPSERT that makes every pre-bump row
 * invisible to the gates without touching it), because this DELETE pair was
 * itself the risk ticket 04 closes: two unbounded DELETEs is a larger failure
 * surface than one tiny UPSERT, and a failure here used to leave the
 * destroyed context's writer holding whole-field and relations licenses
 * until the next compact or the 30-day janitor. The physical removal this
 * function performs is now the janitor's job (`sweepStaleReadGrants`, which
 * sweeps old-epoch rows alongside its age sweep) — this function is kept as
 * a direct, unconditional writer-nuke primitive for any caller that genuinely
 * wants one (there is none in `src/` today), not as part of the correctness
 * path.
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
 * Read-write contract ticket 01: how old an untouched read-grant or
 * field-completeness row must be before the janitor sweep reclaims it. Pure
 * table hygiene, NOT a soundness boundary — the wipe that actually matters to
 * correctness is `clearReadGrantsForWriter`'s PreCompact call, which fires
 * the instant a writer's context is destroyed. A row surviving this long
 * licenses nothing a fresh read would not immediately re-earn; the number
 * only bounds how long a dead writer's rows linger in the two tables.
 */
export const STALE_READ_GRANT_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Janitor backstop: sweeps read-grant AND field-completeness rows untouched
 * for `maxAgeSeconds` or more (spec: "janitor 兜底"; ticket 01 re-keys this
 * from "session completed" to AGE), PLUS — light-review-repairs 04, P1 —
 * rows recorded under a writer's OLD context epoch, now that PreCompact bumps
 * the epoch instead of physically deleting. Both staleness reasons are swept
 * for both tables by the same rule — a completeness row surviving without its
 * grant row (or the reverse), or a grant row already invisible to every gate
 * because its epoch is behind (or its counterpart's), is exactly as dead as
 * its sibling, so there is no reason to key one off the other.
 *
 * Deliberately NOT keyed off `sessions.completed_at_epoch` any more: a
 * completed session's grants still license a same-writer resume (it reloads
 * the full transcript), and the completion marker is never cleared on resume
 * (a separate, out-of-scope latent defect) — keying the sweep off it would
 * have kept destroying a live resume's grants for a session id the marker
 * never let go of. Age is a rule that self-heals independent of that marker.
 *
 * `nowEpoch` is the caller's own clock reading (not looked up here), so a
 * test can assert the exact boundary without waiting real days. `limit`
 * bounds each table's delete PER STALENESS REASON (age, then epoch), same
 * discipline as the SessionEnd call site that invokes this on every session's
 * exit — a routine sweep must never become an unbounded table scan. The
 * epoch-mismatch delete drives from `write_gate_epochs` — one row per writer
 * that has EVER been bumped, so it is small — and joins into each swept
 * table on `writer` (indexed: the leading column of that table's own primary
 * key), rather than scanning the swept table directly for a mismatch no
 * single-column index could express.
 */
export function sweepStaleReadGrants(
  db: Database,
  nowEpoch: number,
  limit: number,
  maxAgeSeconds: number = STALE_READ_GRANT_AGE_SECONDS,
): number {
  // "30+ days" (spec, and the acceptance box's "30-day-stale rows go") reads
  // as inclusive of the boundary itself, hence `<=`: a row exactly
  // `maxAgeSeconds` old is already stale, not one second short of it.
  const cutoffEpoch = nowEpoch - maxAgeSeconds;
  const clearedGrantsByAge = db
    .query<unknown, [number, number]>(
      `DELETE FROM write_gate_reads WHERE rowid IN (
         SELECT rowid FROM write_gate_reads WHERE read_at_epoch <= ? LIMIT ?
       )`,
    )
    .run(cutoffEpoch, limit).changes;
  const clearedGrantsByEpoch = db
    .query<unknown, [number]>(
      `DELETE FROM write_gate_reads WHERE rowid IN (
         SELECT r.rowid FROM write_gate_epochs we
         JOIN write_gate_reads r ON r.writer = we.writer AND r.epoch != we.epoch
         LIMIT ?
       )`,
    )
    .run(limit).changes;
  const clearedCompletenessByAge = db
    .query<unknown, [number, number]>(
      `DELETE FROM write_gate_field_completeness WHERE rowid IN (
         SELECT rowid FROM write_gate_field_completeness WHERE recorded_at_epoch <= ? LIMIT ?
       )`,
    )
    .run(cutoffEpoch, limit).changes;
  const clearedCompletenessByEpoch = db
    .query<unknown, [number]>(
      `DELETE FROM write_gate_field_completeness WHERE rowid IN (
         SELECT c.rowid FROM write_gate_epochs we
         JOIN write_gate_field_completeness c ON c.writer = we.writer AND c.epoch != we.epoch
         LIMIT ?
       )`,
    )
    .run(limit).changes;
  return (
    clearedGrantsByAge +
    clearedGrantsByEpoch +
    clearedCompletenessByAge +
    clearedCompletenessByEpoch
  );
}

// ---------------------------------------------------------------------------
// Per-field completeness (write-mode-edit-semantics spec D8, ticket 04 — the
// RECORD half). Ticket 06 adds the REQUIRE half at the bottom of this file
// (`checkFieldGate`'s `requireCompleteRead`): a `write` replacing content
// another writer put there must be authorized by a render that showed that
// field whole.
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
  const epoch = getWriterEpoch(db, writer);
  const stmt = db.query<
    unknown,
    [string, string, number, string, number, number, number, number]
  >(
    `INSERT INTO write_gate_field_completeness
       (writer, entity_type, entity_id, field, complete, recorded_sequence, recorded_at_epoch, epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(writer, entity_type, entity_id, field) DO UPDATE SET
       complete = excluded.complete,
       recorded_sequence = excluded.recorded_sequence,
       recorded_at_epoch = excluded.recorded_at_epoch,
       epoch = excluded.epoch`,
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
      epoch,
    );
  }
}

export interface FieldCompletenessRecord {
  complete: boolean;
  sequence: number;
  recordedAtEpoch: number;
}

/**
 * `writer`'s own last-recorded completeness fact for one field, or `null` if
 * no render pass of theirs ever showed it. Light-review-repairs 04 (P1): only
 * a row recorded under `writer`'s CURRENT epoch is visible — same rule as
 * `getReadGrant`, and for the same reason (`checkRelationsGate`'s
 * unconditional completeness requirement depends on this exactly as much as
 * `checkFieldGate`'s `requireCompleteRead` does).
 */
export function getFieldCompleteness(
  db: Database,
  writer: string,
  entityType: WriteGateEntityType,
  entityId: number,
  field: string,
): FieldCompletenessRecord | null {
  const epoch = getWriterEpoch(db, writer);
  const row = db
    .query<
      { complete: number; sequence: number; recordedAtEpoch: number },
      [string, string, number, string, number]
    >(
      `SELECT complete, recorded_sequence AS sequence, recorded_at_epoch AS recordedAtEpoch
       FROM write_gate_field_completeness
       WHERE writer = ? AND entity_type = ? AND entity_id = ? AND field = ? AND epoch = ?`,
    )
    .get(writer, entityType, entityId, field, epoch);
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
  | { ok: false; reason: "stale"; message: string; staleWriter: string }
  | { ok: false; reason: "incomplete-read"; message: string };

/**
 * Error text (spec: "报文三分... 三形态在报文层可区分" — ticket 06 added the
 * third). `address` is the caller's own display form for the entity ("E42",
 * "S15069/T332") — this module has no opinion on addressing, it only names
 * the field, the other writer, and what to do next.
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
 * Ticket 06 (write-mode-edit-semantics spec D2/D8): the third rejection. It
 * MUST name the field and the remedy — "否则写者无从下手" — because the
 * writer cannot otherwise tell which of the fields it just sent was the one
 * its read never delivered whole. Covers both shapes of "not delivered in
 * full" (a render that cut the field, and a render that never selected it at
 * all): the record is absent in the second case, and the remedy — read it
 * again until it comes back whole — is the same either way, so splitting
 * them would buy a distinction the writer cannot act on differently.
 *
 * `remedy` comes from the CALLER (`FieldGateOptions.completeReadRemedy`)
 * because the read that delivers a field whole differs per surface: a turn
 * field is widened with `turn`, a segment card's with `pageBudget`, and a
 * turn's `type`/`tags` are not selectable by their own names at all — they
 * ride the `metadata` line. A gate that guessed one of those would send the
 * other two writers back to a read that cannot possibly clear the rejection.
 */
function incompleteReadMessage(
  field: string,
  address: string,
  remedy?: string,
  // Peer round P1-7: the third shape of "your complete view does not
  // authorize this write" — the read DID deliver the field whole, but a
  // foreign write landed after it. Same rejection class and same remedy (read
  // it whole again), a different first sentence, because a writer told "it was
  // cut short" about a field it demonstrably saw in full would go looking for
  // a budget problem that does not exist.
  outdatedBy?: string,
): string {
  const howToRead =
    remedy ?? `re-read it with a bigger budget until ${field} renders complete,`;
  const cause =
    outdatedBy === undefined
      ? `${field} on ${address} was not delivered in full by the read that granted this write —` +
        ` it was cut short, or not shown at all.`
      : `${field} on ${address} was delivered whole to you earlier, but ${formatWriterForDisplay(outdatedBy)}` +
        ` changed it after that read — the complete view you hold is out of date.`;
  return (
    `${cause} A whole-field write may not land over content you` +
    ` have not seen whole: ${howToRead} then write it — or use edit, which changes only the` +
    ` span it matches and needs no complete read.`
  );
}

/**
 * Ticket 06 (spec D2): the one thing `write` asks for beyond the three
 * judgments, supplied by the CALLER because only the caller knows both the
 * mode and whether the field currently holds anything.
 */
export interface FieldGateOptions {
  /**
   * Set by a `write` (whole-field replacement) that would land over content
   * already there. The caller leaves it false/absent for an `edit` (it only
   * touches the span it matched, spec D3) and for a `write` onto an empty
   * field (the create path has no old content to lose).
   */
  requireCompleteRead?: boolean;
  /**
   * The rejection's own remedy clause — the exact read that would deliver
   * THIS field whole on the caller's surface, phrased as an imperative
   * ending in a comma ("re-read it with recall(...), "). Optional; the
   * fallback names no specific call, so a caller that can name one should.
   */
  completeReadRemedy?: string;
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
 *
 * Both write modes (`write` and `edit`, spec D1) go through this check
 * identically — D5/D6: "看见" and "内容一致" are two independent premises, so
 * an exact `oldString` match never substitutes for having read, and a foreign
 * write since the read invalidates BOTH modes.
 *
 * `options.requireCompleteRead` (ticket 06, spec D2) is the one thing layered
 * on top, and only `write` over existing content sets it: the grant must come
 * from a render that showed THIS field whole (ticket 04's per-field
 * completeness records). Its evaluation order matters —
 *
 * The two admissions that do NOT rest on a render (rule 3, never written by
 * anyone; rule 2, this writer's own last write — "writing is reading") are
 * tested FIRST, so the completeness requirement can only ever bite the case
 * it exists for: replacing content ANOTHER writer put there. Rules 1/4 give
 * exactly the verdicts they gave before this reordering (a grant is only
 * consulted once a foreign stamp exists, which is the only case where it
 * changed anything); what the order buys is that a create path and a
 * self-rewrite are never blocked for want of a completeness record they had
 * no way to earn.
 */
export function checkFieldGate(
  db: Database,
  writer: string,
  entityType: WriteGateEntityType,
  entityId: number,
  field: string,
  address: string,
  options: FieldGateOptions = {},
): WriteGateVerdict {
  const stamp = getFieldStamp(db, entityType, entityId, field);

  // Rule 3 — never written by anyone: the create path, admitted without a
  // read and (ticket 06) without a complete one, since there is no old
  // content an overwrite could silently drop.
  if (stamp === null) {
    return { ok: true };
  }

  // Rule 2 — writing is reading: no field a writer already owns can go stale
  // under its own hand, and the only content its overwrite can lose is
  // content it put there itself.
  if (stamp.writer === writer) {
    return { ok: true };
  }

  // From here the field holds another writer's content.
  const grant = getReadGrant(db, writer, entityType, entityId);
  if (!grant) {
    return { ok: false, reason: "never-read", message: neverReadMessage(address) };
  }
  if (stamp.writeSequence > grant.readSequence) {
    return {
      ok: false,
      reason: "stale",
      message: staleMessage(field, address, stamp.writer),
      staleWriter: stamp.writer,
    };
  }

  // Rule 1 admits — plus ticket 06's extra requirement for a whole-field
  // `write`. An absent record and a `complete: false` record are the same
  // answer: this writer's grant did not come with a full view of this field.
  if (options.requireCompleteRead) {
    const completeness = getFieldCompleteness(db, writer, entityType, entityId, field);
    if (!completeness || !completeness.complete) {
      return {
        ok: false,
        reason: "incomplete-read",
        message: incompleteReadMessage(field, address, options.completeReadRemedy),
      };
    }
    // Peer round P1-7: completeness is SEQUENCED, not boolean-forever. The
    // grant above can be refreshed by ANY later read of the entity — an
    // unrelated-field recall bumps `read_sequence` without ever showing this
    // field — so the staleness judgment two blocks up can pass on a grant
    // newer than the foreign write while this writer's newest complete view of
    // THIS field still predates it. Comparing the completeness record's own
    // sequence against the field's write sequence is what closes that gap:
    // the render that showed the field whole must be at-or-after the write it
    // is being asked to overwrite. (`>=`, not `>`: `stampField` consumes the
    // number it stamps, so a read taken after that write snapshots exactly it.)
    if (completeness.sequence < stamp.writeSequence) {
      return {
        ok: false,
        reason: "incomplete-read",
        message: incompleteReadMessage(
          field,
          address,
          options.completeReadRemedy,
          stamp.writer,
        ),
      };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// The relations gate (peer round P1-8): relations as a first-class gated
// surface with its own revision stamp.
// ---------------------------------------------------------------------------

/**
 * The pseudo-field a turn's relation SET is gated and stamped under. Not a
 * column on `turns` — the set lives in `memory_edges` — but everything the
 * gate needs from a field (a per-entity revision, a per-writer completeness
 * record, a comparison between the two) is exactly what the stamp and
 * completeness tables already store, so the relations gate is a third user of
 * those two tables rather than a fourth mechanism beside them.
 *
 * Deliberately distinct from `mcp/note.ts`'s `EDGE_WRITE_GATE_FIELD` (`type`),
 * which answers a different question — "does this writer maintain this turn at
 * all" — and which an edge write still passes through. `type` cannot answer
 * "have you seen the edges you are about to change": nothing about reading a
 * turn's type chapter shows its relation set, and a turn whose type nobody ever
 * wrote admits under rule 3 with no read at all.
 */
export const RELATIONS_GATE_FIELD = "relations";

/**
 * Bumps a citing turn's relations revision — called from INSIDE the same write
 * transaction as every attach/retract, on every path (peer round P1-8: "every
 * attach/retract stamps"). `writer` may be `null` for a caller with no identity
 * of its own; the stamp is still written, under `ANONYMOUS_WRITER` (see that
 * constant for why the mutation must be recorded even when the mutator is not
 * gated).
 */
export function stampTurnRelationsRevision(
  db: Database,
  turnId: number,
  writer: string | null,
  nowEpoch: number,
): WriteGateStamp {
  return stampField(
    db,
    "turn",
    turnId,
    RELATIONS_GATE_FIELD,
    writer ?? ANONYMOUS_WRITER,
    nowEpoch,
  );
}

/** The remedy clause the relations rejection carries — the one read that delivers the set. */
export function relationsReadRemedy(address: string): string {
  return `recall(id="${address}", filter={fields:["relations"]})`;
}

/**
 * The relation-mutation check (peer round P1-8), run inside the mutation's own
 * transaction like every other gate call. It is STRICTER than `checkFieldGate`
 * in the one way that matters here: a complete read is required
 * UNCONDITIONALLY, not only when another writer's content is at stake.
 *
 * `checkFieldGate`'s rules 2 and 3 exist because a field with no foreign
 * content holds nothing an overwrite could silently lose. A relation write is
 * not an overwrite: it is an ADDITION to (or a subtraction from) a set whose
 * other members are exactly what decides whether this one is legal or
 * redundant — a lane already has a terminus, the pair already carries this
 * relation, the edge being retracted is not there at all. "Nobody has written
 * this set yet" therefore licenses nothing, which is why the pull story's
 * "relations recall earns the write" needed a gate of its own rather than a
 * borrowed one.
 *
 * Rule 2 survives in one form: a writer whose OWN mutation is the current
 * revision has by construction read the set (it passed this same check to get
 * there) and knows what its own write did, so a second mutation in the same run
 * is not sent back for a re-read.
 */
export function checkRelationsGate(
  db: Database,
  writer: string,
  turnId: number,
  address: string,
): WriteGateVerdict {
  const stamp = getFieldStamp(db, "turn", turnId, RELATIONS_GATE_FIELD);
  if (stamp && stamp.writer === writer) {
    return { ok: true };
  }

  const completeness = getFieldCompleteness(
    db,
    writer,
    "turn",
    turnId,
    RELATIONS_GATE_FIELD,
  );
  if (!completeness || !completeness.complete) {
    return {
      ok: false,
      reason: "incomplete-read",
      message:
        `the relations of ${address} were not delivered to this run — a relation write states how ` +
        `this turn's edges stand, so the current set has to be in front of you first. Read it with ` +
        `${relationsReadRemedy(address)}, then write the edge.`,
    };
  }
  if (stamp && completeness.sequence < stamp.writeSequence) {
    return {
      ok: false,
      reason: "stale",
      staleWriter: stamp.writer,
      message:
        `the relations of ${address} were changed by ${formatWriterForDisplay(stamp.writer)} since you ` +
        `last read them — read the set again with ${relationsReadRemedy(address)} before writing an edge.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Turn liveness (peer round P2-3): the ONE live-turn check every turn-targeted
// mutation runs inside its own write transaction.
// ---------------------------------------------------------------------------

export type TurnLivenessVerdict = { ok: true } | { ok: false; message: string };

/**
 * Re-reads `turnId`'s liveness from the database and refuses a write to a turn
 * that is no longer a node (peer round P2-3). Two properties it exists for:
 *
 *   - **It runs INSIDE the mutation transaction.** Every caller resolves its
 *     turn long before it writes — through an address parse, a range check, a
 *     gate check — and a rollback or a skip landing in that gap left the write
 *     to a turn the graph no longer contains. The commit loader then ignores
 *     the dead node, so the write is invisible AND the window still reads as
 *     settled.
 *   - **It is the graph's own predicate, not a second one.** `isLiveTurn`
 *     (`db/turn-liveness.ts`, law 8) is what the lane loader filters every node
 *     and endpoint by; a write admitted under a laxer rule than the one that
 *     decides visibility is precisely the drift this check closes.
 */
export interface TurnLivenessOptions {
  /**
   * Set by a write that would itself REVIVE a dormant turn — a prose note on
   * an era turn, which `db/turns.ts`'s `promoteTurnFromNote` promotes back out
   * of `skipped` as it lands. The two tiers of law 8 differ exactly here:
   * `skipped` is a reversible floor whose documented exit is a late note, so
   * refusing that note would make the tier unreachable rather than safe, while
   * `was_rolled_back` is permanent and no write of any kind reaches it.
   */
  revivesTurn?: boolean;
}

export function checkTurnLiveForWrite(
  db: Database,
  turnId: number,
  address: string,
  options: TurnLivenessOptions = {},
): TurnLivenessVerdict {
  const row = db
    .query<{ wasRolledBack: number; status: string }, [number]>(
      `SELECT was_rolled_back AS wasRolledBack, status FROM turns WHERE id = ?`,
    )
    .get(turnId);
  if (!row) {
    return { ok: false, message: `${address} no longer exists — nothing was written.` };
  }
  if (isLiveTurn({ wasRolledBack: row.wasRolledBack !== 0, status: row.status })) {
    return { ok: true };
  }
  if (row.wasRolledBack !== 0) {
    return {
      ok: false,
      message:
        `${address} was rolled back — it is not a node in the graph any more, and no write reaches ` +
        "it. Nothing was written.",
    };
  }
  if (options.revivesTurn) {
    return { ok: true };
  }
  return {
    ok: false,
    message:
      `${address} is skipped — it is dormant, so it carries no type, no edges and no membership ` +
      "until a note revives it. Write its note first (title and content), or leave it alone. " +
      "Nothing was written.",
  };
}
