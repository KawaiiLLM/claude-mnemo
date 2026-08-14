import type { Database } from "bun:sqlite";

import type { CitationRelation } from "../db/citations";
import { runWriteTransaction } from "../db/database";
import {
  writeMemoryEdges,
  type EdgeNode,
  type EdgeProvenance,
} from "../db/memory-edges";
import {
  advanceNoteSettlementCursor,
  completeNoteSettlementJob,
  getNoteSettlementJob,
  NOTE_SETTLEMENT_MAX_ATTEMPTS,
  type NoteSettlementJob,
} from "../db/note-settlement";
import {
  parseQualifiedReferences,
  validateReferences,
  type ParsedReference,
} from "../db/references";
import {
  addSegmentMembers,
  applySegmentWrites,
  createSegment,
  findTopic,
  upsertTopic,
  type ExcludedSegmentWrite,
  type SegmentRecord,
  type SegmentWrite,
} from "../db/segments";
import { updateSessionSummaryRewrite } from "../db/sessions";
import { getShadowNote, upsertReconstructedShadowNote } from "../db/shadow-notes";
import { getTurnById, updateTurnById } from "../db/turns";
import {
  draftTurnFactsFromTitle,
  TOPIC_TAG_PREFIX,
  withDraftedTopicTag,
} from "../shared/type-vocabulary";
import type {
  NoteSettlementResponse,
  SettlementSegmentDirective,
} from "./note-settlement-response";

/**
 * Settlement write-back (spec D9, ticket 07).
 *
 * ONE transaction holds every per-session effect of a window — segments and
 * their members, the anchor and judged edges, the type/tag revision, the session
 * summary, the mechanical hole backfill — together with the job completion
 * and the cursor advance. That grouping is the whole point: the cursor is what
 * says "this window is settled", so a cursor that moved without the writes, or
 * writes that landed without the cursor, both produce a window nobody will ever
 * settle correctly again.
 *
 * The generation check runs FIRST and inside the same transaction. A dispatch
 * whose lease expired lost the window to a newer attempt, and the correct
 * handling of its (possibly excellent) result is to throw it away whole.
 *
 * The single exception is an open segment another settlement rewrote while this
 * one was thinking. Its write is excluded by the revision CAS and returned to
 * the caller with the latest body, so the judgement for THAT segment replays in
 * a small supplemental transaction — the committed partition writes are not
 * rolled back for it (裁决 14).
 */

/** Relation an anchor citation in a segment body records. */
const ANCHOR_RELATION: CitationRelation = "builds-on";

/**
 * Anchors come from the segment's own text, so they are `text-ref`; the edges
 * the model classified explicitly are `judged` and outrank them on the
 * provenance lattice when both name the same pair.
 */
const ANCHOR_PROVENANCE: EdgeProvenance = "text-ref";
const JUDGED_PROVENANCE: EdgeProvenance = "judged";

/**
 * Thrown INSIDE the write-back transaction when the mechanical backfill left a
 * runtime gap unfilled (spec D7, P1-2). Never escapes `applyNoteSettlementWriteBack`
 * uncaught — it is what forces the whole transaction to roll back (every
 * segment/edge/note this window's reply also produced, not just the missed
 * turn), matching the parser's own all-or-nothing rule: a batch that leaves a
 * hole open is a different and wrong answer, not a partial one to keep.
 */
class UnfilledGapError extends Error {}

/**
 * Thrown INSIDE the write-back transaction when a `turn_review` entry names an
 * address this writer was never shown, or one that does not resolve to a real
 * turn (ticket 05). Unlike a `members`/`edges` token — where an illegal
 * reference is dropped and logged, because a segment's judgement is still
 * meaningful without one citation — a review verdict for a turn nobody can
 * verify is not a smaller correct review, it is evidence the batch invented an
 * address. Same discipline as `UnfilledGapError`: throwing here rolls back
 * everything this reply produced, and the job stays `claimed` for a retry.
 */
class UnknownTurnAddressError extends Error {}

export interface NoteSettlementWriteBackOptions {
  job: NoteSettlementJob;
  response: NoteSettlementResponse;
  nowEpoch: number;
  /** Turn ids this window may write a reconstruction note for (interior holes). */
  reconstructableTurnIds: ReadonlySet<number>;
  /**
   * Turns this prompt actually showed — the gate for `turn_review` addresses.
   * See `NoteSettlementContext.reviewableTurnIds` for why a review may not use
   * the session-lifetime exposure ledger the way a citation may.
   */
  reviewableTurnIds: ReadonlySet<number>;
  /** When the context was read; see `NoteSettlementContext.builtAtEpoch`. */
  contextBuiltAtEpoch: number;
  /** Segment ids the writer was shown — the exposure gate for `[E<n>]`. */
  exposedSegmentIds: ReadonlySet<number>;
  /** Ride turn recorded on reconstruction notes; the window's last turn. */
  rideTurnId: number | null;
  writerModel?: string | null;
  maxAttempts?: number;
  logger?: Pick<Console, "warn">;
}

export interface NoteSettlementSegmentConflict {
  directive: SettlementSegmentDirective;
  excluded: ExcludedSegmentWrite;
}

export interface NoteSettlementWriteBackCounts {
  segmentsCreated: number;
  segmentsExtended: number;
  /** New rows in the topic registry — spec D9's naming-drift alarm. */
  topicsMinted: number;
  topicsReused: number;
  membersAdded: number;
  anchorEdges: number;
  judgedEdges: number;
  rejectedReferences: number;
  notesReconstructed: number;
  notesRejected: number;
  /**
   * A reconstruction the model wrote for a turn that already carries an
   * `agent` note by the time the write-back runs — the race spec D7 (ticket
   * 05) requires a winner for: the main agent's own note landed while this
   * job was queued or in flight, and it wins. Distinct from `notesRejected`
   * (an address the model was never shown, or a turn outside this window's
   * backfill scope): this one names turns the model was correctly asked to
   * reconstruct, whose write simply arrived second.
   */
  notesYielded: number;
  summaryUpdated: boolean;
  /** Turns a `turn_review` directive actually landed on (spec D3, ticket 05). */
  turnsReviewed: number;
  /** Per-grade counts among `turnsReviewed`, indexed 0-4 (spec D13). */
  gradeHistogram: number[];
  /**
   * Reviewed turns whose type/tag verdict stepped aside because the agent's
   * own note landed after this job was claimed — the review graded them but
   * did not restate facts about a note it never read. A steady nonzero here
   * is not a fault; a LARGE share means settlement is routinely racing the
   * live agent and the window is being cut too close to the frontier.
   */
  reviewsYieldedToLateNote: number;
}

export interface NoteSettlementWriteBackResult
  extends NoteSettlementWriteBackCounts {
  committed: boolean;
  reason: string | null;
  conflicts: NoteSettlementSegmentConflict[];
}

const EMPTY_COUNTS: NoteSettlementWriteBackCounts = {
  segmentsCreated: 0,
  segmentsExtended: 0,
  topicsMinted: 0,
  topicsReused: 0,
  membersAdded: 0,
  anchorEdges: 0,
  judgedEdges: 0,
  rejectedReferences: 0,
  notesReconstructed: 0,
  notesRejected: 0,
  notesYielded: 0,
  summaryUpdated: false,
  turnsReviewed: 0,
  gradeHistogram: [0, 0, 0, 0, 0],
  reviewsYieldedToLateNote: 0,
};

/**
 * Parse one address token — `S12/T30`, `[S12/T30]`, `E47`, `[E47]`.
 *
 * The edge and member fields carry a bare token rather than an inline citation,
 * so they are bracketed here and handed to the SAME parser that reads a body.
 * One grammar, one place it is implemented (D7).
 */
export function parseAddressToken(token: string): ParsedReference | null {
  const trimmed = token.trim();
  const bracketed = trimmed.startsWith("[") ? trimmed : `[${trimmed}]`;
  const parsed = parseQualifiedReferences(bracketed);
  return parsed.length === 1 ? parsed[0]! : null;
}

interface ResolveResult {
  nodes: Map<string, EdgeNode>;
  rejected: number;
}

/**
 * Resolve address tokens to edge nodes through the production validator: the id
 * must exist AND must have been shown to this writer. An id that fails either
 * gate is logged and dropped — never stored, and never a reason to fail the
 * window it arrived with.
 */
function resolveTokens(
  db: Database,
  tokens: readonly string[],
  options: NoteSettlementWriteBackOptions,
): ResolveResult {
  const nodes = new Map<string, EdgeNode>();
  const references: ParsedReference[] = [];
  const tokenByRaw = new Map<string, string>();
  let rejected = 0;

  for (const token of tokens) {
    const parsed = parseAddressToken(token);
    if (!parsed) {
      rejected += 1;
      options.logger?.warn?.(
        `[claude-mnemo] settlement job ${options.job.id}: unparseable address "${token}"`,
      );
      continue;
    }
    tokenByRaw.set(parsed.raw, token);
    references.push(parsed);
  }

  const result = validateReferences(db, references, {
    writerSessionId: options.job.sessionId,
    exposedSegmentIds: options.exposedSegmentIds,
    logger: options.logger,
  });
  rejected += result.rejected.length;
  for (const accepted of result.accepted) {
    const token = tokenByRaw.get(accepted.reference.raw);
    if (token !== undefined) {
      nodes.set(token.trim(), accepted.node);
    }
  }

  return { nodes, rejected };
}

/** Anchor edges: every legal citation in a segment's body, segment → node. */
function writeAnchorEdges(
  db: Database,
  segment: SegmentRecord,
  options: NoteSettlementWriteBackOptions,
): { written: number; rejected: number } {
  const references = parseQualifiedReferences(segment.content);
  if (references.length === 0) {
    return { written: 0, rejected: 0 };
  }
  const { accepted, rejected } = validateReferences(db, references, {
    writerSessionId: options.job.sessionId,
    exposedSegmentIds: options.exposedSegmentIds,
    logger: options.logger,
  });
  const { written } = writeMemoryEdges(
    db,
    accepted.map((entry) => ({
      citing: { kind: "segment" as const, id: segment.id },
      cited: entry.node,
      relation: ANCHOR_RELATION,
      provenance: ANCHOR_PROVENANCE,
    })),
    options.nowEpoch,
  );
  return { written: written.length, rejected: rejected.length };
}

/**
 * Runtime gap coverage guard (spec D7, P1-2). A window's mechanical backfill is
 * validated against `options.reconstructableTurnIds` AFTER the reply's
 * directives have been applied, so a turn any OTHER writer already noted (the
 * main agent's own note landing mid-flight, spec D7's race guard above)
 * correctly reads as covered without the payload having said anything about
 * it — "回写只填空缺" applies here too: agent-covered is not a gap.
 */
export function applyNoteSettlementWriteBack(
  db: Database,
  options: NoteSettlementWriteBackOptions,
): NoteSettlementWriteBackResult {
  try {
    return applyNoteSettlementWriteBackTransaction(db, options);
  } catch (error) {
    if (
      error instanceof UnfilledGapError ||
      error instanceof UnknownTurnAddressError
    ) {
      return {
        ...EMPTY_COUNTS,
        committed: false,
        reason: error.message,
        conflicts: [],
      };
    }
    throw error;
  }
}

function applyNoteSettlementWriteBackTransaction(
  db: Database,
  options: NoteSettlementWriteBackOptions,
): NoteSettlementWriteBackResult {
  const { job, response } = options;

  return runWriteTransaction(db, () => {
    const current = getNoteSettlementJob(db, job.id);
    if (
      !current ||
      current.claimGeneration !== job.claimGeneration ||
      current.status !== "claimed"
    ) {
      return {
        ...EMPTY_COUNTS,
        committed: false,
        reason:
          "settlement result discarded: the job was reclaimed under a new generation",
        conflicts: [],
      };
    }

    // `gradeHistogram` is mutated in place below (per-directive `+= 1`), so it
    // must be this call's OWN array — spreading `EMPTY_COUNTS` alone would
    // share its array reference across every window this process ever
    // settles, corrupting every later histogram with every earlier one's
    // counts.
    const counts: NoteSettlementWriteBackCounts = {
      ...EMPTY_COUNTS,
      gradeHistogram: [0, 0, 0, 0, 0],
    };
    const conflicts: NoteSettlementSegmentConflict[] = [];
    const landed: Array<{
      segment: SegmentRecord;
      directive: SettlementSegmentDirective;
    }> = [];

    // --- created segments -------------------------------------------------
    for (const directive of response.segments) {
      if (directive.action !== "create") {
        continue;
      }
      let topicId: number | null = null;
      if (directive.topic) {
        const existing = findTopic(db, directive.topic);
        const topic = upsertTopic(db, {
          name: directive.topic,
          aliases: directive.topicAliases,
          nowEpoch: options.nowEpoch,
        });
        topicId = topic.id;
        if (existing) {
          counts.topicsReused += 1;
        } else {
          counts.topicsMinted += 1;
        }
      }
      const segment = createSegment(db, {
        title: directive.title,
        topicId,
        content: directive.content,
        type: directive.type,
        tags: directive.tags,
        status: directive.status,
        // Settlement is the only writer allowed to say a conclusion was
        // overturned (`rolled-back`), because that value is hindsight.
        typeSource: "settlement",
        nowEpoch: options.nowEpoch,
      });
      counts.segmentsCreated += 1;
      landed.push({ segment, directive });
    }

    // --- extended segments, through the revision CAS ----------------------
    const extendDirectives = response.segments.filter(
      (directive) => directive.action === "extend",
    );
    if (extendDirectives.length > 0) {
      const writes: SegmentWrite[] = extendDirectives.map((directive) => ({
        segmentId: directive.segmentId!,
        expectedRevision: directive.expectedRevision!,
        title: directive.title,
        content: directive.content,
        type: directive.type,
        tags: directive.tags,
        status: directive.status,
      }));
      const { applied, excluded } = applySegmentWrites(db, writes, {
        nowEpoch: options.nowEpoch,
        source: "settlement",
      });
      for (const segment of applied) {
        const directive = extendDirectives.find(
          (candidate) => candidate.segmentId === segment.id,
        );
        if (directive) {
          counts.segmentsExtended += 1;
          landed.push({ segment, directive });
        }
      }
      for (const entry of excluded) {
        const directive = extendDirectives.find(
          (candidate) => candidate.segmentId === entry.write.segmentId,
        );
        if (directive) {
          // Members are held back with the body: the segment's whole judgement
          // is what replays, and half of it landing would attach turns to a
          // chapter whose text never mentions them.
          conflicts.push({ directive, excluded: entry });
        }
      }
    }

    // --- membership + anchors --------------------------------------------
    for (const entry of landed) {
      const { nodes, rejected } = resolveTokens(
        db,
        entry.directive.members,
        options,
      );
      counts.rejectedReferences += rejected;
      const turnIds = [...nodes.values()]
        .filter((node) => node.kind === "turn")
        .map((node) => node.id);
      counts.membersAdded += addSegmentMembers(
        db,
        entry.segment.id,
        turnIds,
        options.nowEpoch,
      ).length;

      const anchors = writeAnchorEdges(db, entry.segment, options);
      counts.anchorEdges += anchors.written;
      counts.rejectedReferences += anchors.rejected;
    }

    // --- judged edges -----------------------------------------------------
    if (response.edges.length > 0) {
      const tokens = response.edges.flatMap((edge) => [edge.citing, edge.cited]);
      const { nodes, rejected } = resolveTokens(db, tokens, options);
      counts.rejectedReferences += rejected;
      const inputs = response.edges
        .map((edge) => {
          const citing = nodes.get(edge.citing.trim());
          const cited = nodes.get(edge.cited.trim());
          return citing && cited
            ? {
                citing,
                cited,
                relation: edge.relation,
                provenance: JUDGED_PROVENANCE,
              }
            : null;
        })
        .filter((input): input is NonNullable<typeof input> => input !== null);
      counts.judgedEdges += writeMemoryEdges(
        db,
        inputs,
        options.nowEpoch,
      ).written.length;
    }

    // --- mechanical hole backfill (spec D7, ticket 05) ---------------------
    for (const note of response.reconstructedNotes) {
      const parsed = parseAddressToken(note.turn);
      const turnId =
        parsed && parsed.kind === "turn"
          ? (db
              .query<{ id: number }, [number, number]>(
                "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
              )
              .get(parsed.sessionId, parsed.promptNumber)?.id ?? null)
          : null;
      // Only a turn this window's context actually classified as a hole may be
      // reconstructed — a turn the agent skipped, a compact marker, or one
      // outside this window is the live discipline's business, not a hindsight
      // backfill's (D7's "机械回填,不覆盖" — the payload holds no discretion
      // beyond this membership test).
      if (turnId === null || !options.reconstructableTurnIds.has(turnId)) {
        counts.notesRejected += 1;
        options.logger?.warn?.(
          `[claude-mnemo] settlement job ${job.id}: refused reconstruction for ${note.turn} (not an owed hole of this window)`,
        );
        continue;
      }
      // WHERE-gated upsert: the main agent's own note can land between this
      // window being claimed and this write landing, and that note must win
      // (spec D7's race guard) — never overwritten by a hindsight
      // reconstruction of the same turn.
      const written = upsertReconstructedShadowNote(db, {
        turnId,
        title: note.title,
        content: note.content,
        insight: note.insight,
        writerModel: options.writerModel ?? null,
        writerOrigin: "settlement",
        rideTurnId: options.rideTurnId,
        nowEpoch: options.nowEpoch,
      });
      if (written) {
        counts.notesReconstructed += 1;

        // spec D7/D8, ticket 02: a mechanical reconstruction drafts its
        // turn's type and tag exactly as an agent-written note does — same
        // function, same title-derived answer, so a reader cannot tell which
        // write path produced the draft. Unconditional now (ticket 05, same
        // fix as note.ts's promotion path): a title with no `<activity>+
        // <topic>:` shape drafts neither, and that must CLEAR any stale
        // value rather than skip the write — there is nothing stale to clear
        // on a first-ever reconstruction, but the two call sites share one
        // derivation and one write discipline on purpose, so a future editor
        // cannot fix the bug in one and leave it in the other.
        //
        // Re-read rather than carry the row down: the topic tag replaces
        // only its own namespace, so the write needs whatever tags this turn
        // holds AT THIS MOMENT, and a window can reconstruct several notes —
        // or a `turn_review` directive further down can revise this same
        // turn — before this point is reached.
        const drafted = draftTurnFactsFromTitle(note.title);
        const existingTags = getTurnById(db, turnId)?.tags ?? [];
        updateTurnById(db, turnId, {
          type: drafted.type,
          replaceTags: withDraftedTopicTag(existingTags, drafted.tag),
        });
      } else {
        counts.notesYielded += 1;
      }
    }

    // --- turn review: grade, type, tag (spec D3/D9, ticket 05) -------------
    //
    // THE FENCE (spec's "note committed after the worker read the row is not
    // overwritten by the worker's older view"), argued once here rather than
    // per-line below:
    //
    // This whole function runs inside ONE `runWriteTransaction`, i.e. one
    // `BEGIN IMMEDIATE` … `COMMIT`. SQLite's IMMEDIATE mode takes the write
    // lock at BEGIN, before this callback's first statement — so no OTHER
    // writer transaction (in particular `note.ts`'s `noteTool`, which the
    // main agent calls WHILE its own turn is still running and which also
    // goes through `runWriteTransaction`) can commit while this transaction
    // is open. That makes the classic interleave — read, someone else commits,
    // write over them — impossible for anything strictly BETWEEN this
    // transaction's BEGIN and COMMIT.
    //
    // Note what that costs rather than what it buys: the MCP server and the
    // worker are separate processes on one WAL database, so the agent's note
    // does not silently lose the race, it BLOCKS on it — bounded by
    // `busy_timeout`, after which `runWriteTransaction` retries and finally
    // throws, and `noteTool` does not catch that. A long enough write-back
    // therefore surfaces as a failed note for the user. Serialization here is
    // a correctness guarantee bought with an availability risk elsewhere, not
    // a free one.
    //
    // It does NOT make every write in this loop safe by itself. The gap the
    // ticket actually found is upstream of this transaction: the settlement
    // window's CONTEXT is built, then an async model call runs for seconds,
    // during which any number of agent notes can land and commit in full
    // (ordinary, already-committed transactions, done before this one even
    // opens). Freshness alone is therefore not the whole fence, and it is
    // worth being precise about what each half buys, because the two are easy
    // to confuse:
    //
    //   1. RE-READ FRESH. Any value merged into a write must come from a read
    //      taken here, immediately before that write — never from context-
    //      build time, never from a read taken earlier in this transaction and
    //      carried down. `getTurnById` below is that read; it is what keeps a
    //      turn's non-topic tags (its session-arc role, its `compact:`
    //      machinery) from being erased by a stale copy of the tag list.
    //
    //   2. YIELD WHEN THE DOCUMENT CHANGED. Freshness cannot rescue a verdict
    //      that was formed about a note the model never saw. `type` and `tag`
    //      are facts ABOUT the note — derived from its title on every other
    //      write path in this codebase — so a review of a turn whose note
    //      arrived during the async gap is a review of a document that no
    //      longer exists. Re-reading the row would faithfully write a stale
    //      judgement onto fresh data, which is worse, not better. That case is
    //      detected below and the note-derived half of the verdict stands
    //      down.
    //
    // `title`, `content` and `insight` are never named in this call at all
    // (stay `undefined` ⇒ omitted, see `resolveNullable`), so a note's own
    // prose was never at risk from this loop — which is why a test that only
    // watches those three columns survive the interleave proves nothing about
    // either half above. `fireAfterNextTurnRead` in the test suite drops an
    // agent note into exactly this gap and pins the columns that CAN move.
    //
    // `grade` is the one field written unconditionally from the directive
    // regardless of what is stored — that is NOT the race, that is "confirm
    // or override" (D4): it judges what the turn did, read off raw material no
    // later note can change.
    //
    // It is NOT, however, uncontended. `remember` writes `grade`, `type` and
    // tags directly, so an agent correcting a turn during the model call is a
    // third writer this fence does not see: `remember` leaves no mark the
    // note-timestamp test can read, and a stale review will overwrite it. That
    // gap is open and known, not handled here.
    if (response.turnReview.length > 0) {
      const tokens = response.turnReview.map((directive) => directive.turn);
      const { nodes, rejected } = resolveTokens(db, tokens, options);
      if (rejected > 0) {
        const badToken = tokens.find((token) => !nodes.has(token.trim()));
        throw new UnknownTurnAddressError(
          `settlement job ${job.id}: turn_review referenced an address this ` +
            `writer was not shown or that does not exist` +
            (badToken ? ` ("${badToken}")` : ""),
        );
      }

      for (const directive of response.turnReview) {
        const node = nodes.get(directive.turn.trim());
        if (!node || node.kind !== "turn") {
          throw new UnknownTurnAddressError(
            `settlement job ${job.id}: turn_review entry "${directive.turn}" ` +
              "is not a turn address",
          );
        }
        const turnId = node.id;

        // Resolving through the exposure ledger is not enough for this
        // directive. That ledger accumulates every id ever shown to a writer
        // in this session, so a hallucinated `S1/T10` from a window settled
        // days ago resolves cleanly and lands a destructive write on a turn
        // nobody was looking at. A review may only revise what THIS prompt
        // showed.
        if (!options.reviewableTurnIds.has(turnId)) {
          throw new UnknownTurnAddressError(
            `settlement job ${job.id}: turn_review entry "${directive.turn}" ` +
              "names a turn outside this window and its rendered lookback",
          );
        }

        // The fence: fresh, right here, right before the write that uses it.
        const freshExisting = getTurnById(db, turnId);
        if (!freshExisting) {
          // Cannot happen — `node` above just resolved through a live DB
          // lookup — but a turn that vanished between that lookup and here
          // is nothing this directive can apply to.
          throw new UnknownTurnAddressError(
            `settlement job ${job.id}: turn_review entry "${directive.turn}" ` +
              "resolved to a turn that no longer exists",
          );
        }

        // The OTHER half of the fence. Re-reading the row is not enough on its
        // own, because `type` and `tag` are not free-standing verdicts: they
        // are facts ABOUT the note, derived from its title everywhere else in
        // this codebase. So if the note under review is no longer the note the
        // model reviewed, the verdict is about a document that no longer
        // exists, and writing it produces a row whose type/tag answer a title
        // nobody kept.
        //
        // That is exactly what the async gap above delivers: the agent notes
        // its own turn WHILE the turn runs, so a note can land between this
        // job being claimed and this write. One loop up, the reconstruction
        // already ruled on that collision — `upsertReconstructedShadowNote`'s
        // `WHERE writer_origin != 'agent'` makes the agent's account win and
        // the hindsight one yield. Letting this loop then stamp the yielded
        // reconstruction's type/tag onto the row would overturn that ruling in
        // the same transaction that made it.
        //
        // The boundary is when the CONTEXT was read, not when the job was
        // claimed: claiming happens first, context-building a moment later,
        // and a note arriving in between is one the model did see. Claim time
        // is also nullable, which would have made the whole fence fail open on
        // a row that never got one.
        //
        // `>=`, not `>`: these are epoch SECONDS, so a note committed in the
        // very second of the read is ambiguous, and the safe reading is that
        // the model missed it. The cost of being wrong that way is one turn
        // keeping its mechanical title-derived type instead of a reviewed one;
        // the cost of the other way is the clobber this whole comment is
        // about. Origin matters too: a note THIS window just reconstructed
        // also has a fresh timestamp, and its type/tag are precisely what the
        // review should be allowed to override — only an `agent` note outranks
        // the reviewer.
        const currentNote = getShadowNote(db, turnId);
        const noteSupersedesReview =
          currentNote !== null &&
          currentNote.writerOrigin === "agent" &&
          currentNote.updatedAtEpoch >= options.contextBuiltAtEpoch;

        if (noteSupersedesReview) {
          // Grade still lands: it judges what the turn DID, read off the raw
          // material, and no other writer competes for the column. Only the
          // note-derived facts step aside.
          updateTurnById(db, turnId, { significanceGrade: directive.grade });
          counts.reviewsYieldedToLateNote += 1;
        } else {
          const bareTag = directive.tag?.startsWith(TOPIC_TAG_PREFIX)
            ? directive.tag.slice(TOPIC_TAG_PREFIX.length)
            : directive.tag;
          const nextTags = withDraftedTopicTag(
            freshExisting.tags,
            bareTag ? `${TOPIC_TAG_PREFIX}${bareTag}` : null,
          );

          updateTurnById(db, turnId, {
            significanceGrade: directive.grade,
            type: directive.type,
            replaceTags: nextTags,
          });
        }

        counts.turnsReviewed += 1;
        counts.gradeHistogram[directive.grade] =
          (counts.gradeHistogram[directive.grade] ?? 0) + 1;
      }
    }

    // --- session summary ---------------------------------------------------
    if (response.sessionSummary) {
      const updated = updateSessionSummaryRewrite(
        db,
        job.sessionId,
        {
          title: response.sessionSummary.title,
          content: response.sessionSummary.content,
          decision: response.sessionSummary.decision,
          done: response.sessionSummary.done,
          current: response.sessionSummary.current,
          nextSteps: response.sessionSummary.nextSteps,
          reference: response.sessionSummary.reference,
        },
        options.nowEpoch,
      );
      counts.summaryUpdated = updated !== null;
    }

    // --- runtime gap coverage guard (spec D7, P1-2) ------------------------
    // Checked AFTER the reconstruction loop above, so a turn it just wrote —
    // or one another writer covered while this call was in flight — reads as
    // filled. Anything still open here is a gap the batch was supposed to
    // mechanically close and did not; throwing rolls back everything this
    // reply produced (segments, edges, the OTHER holes it did fill) and the
    // job stays `claimed`, so the caller's existing attempts/retry path picks
    // it up rather than a partially-covered window silently committing.
    const stillOpen = [...options.reconstructableTurnIds].filter(
      (turnId) => getShadowNote(db, turnId) === null,
    );
    if (stillOpen.length > 0) {
      throw new UnfilledGapError(
        `settlement job ${job.id}: ${stillOpen.length} runtime gap(s) left unfilled by the reconstruction batch (turn ids: ${stillOpen.join(", ")})`,
      );
    }

    // --- completion + cursor, same transaction -----------------------------
    completeNoteSettlementJob(db, job.id, options.nowEpoch, job.claimGeneration);
    advanceNoteSettlementCursor(
      db,
      job.sessionId,
      options.nowEpoch,
      options.maxAttempts ?? NOTE_SETTLEMENT_MAX_ATTEMPTS,
    );

    return { ...counts, committed: true, reason: null, conflicts };
  });
}

export interface NoteSettlementSegmentReplayOptions {
  job: NoteSettlementJob;
  segmentId: number;
  /** The revision read back from the conflict — what this write CASes on. */
  expectedRevision: number;
  title?: string;
  content?: string;
  type?: string[];
  tags?: string[];
  status?: SegmentRecord["status"];
  memberTokens?: readonly string[];
  exposedSegmentIds: ReadonlySet<number>;
  nowEpoch: number;
  logger?: Pick<Console, "warn">;
}

export interface NoteSettlementSegmentReplayResult {
  applied: boolean;
  reason: string | null;
  membersAdded: number;
  anchorEdges: number;
  rejectedReferences: number;
}

/**
 * Re-apply ONE segment's judgement after a revision conflict, in its own small
 * transaction. Deliberately not a retry of the window: the committed partition
 * writes stand, and only the contested document is written again.
 */
export function applyNoteSettlementSegmentReplay(
  db: Database,
  options: NoteSettlementSegmentReplayOptions,
): NoteSettlementSegmentReplayResult {
  return runWriteTransaction(db, () => {
    const { applied, excluded } = applySegmentWrites(
      db,
      [
        {
          segmentId: options.segmentId,
          expectedRevision: options.expectedRevision,
          title: options.title,
          content: options.content,
          type: options.type,
          tags: options.tags,
          status: options.status,
        },
      ],
      { nowEpoch: options.nowEpoch, source: "settlement" },
    );

    const segment = applied[0];
    if (!segment) {
      return {
        applied: false,
        reason: excluded[0]?.reason ?? "segment write rejected",
        membersAdded: 0,
        anchorEdges: 0,
        rejectedReferences: 0,
      };
    }

    const writeBackOptions: NoteSettlementWriteBackOptions = {
      job: options.job,
      response: {
        segments: [],
        edges: [],
        reconstructedNotes: [],
        turnReview: [],
        sessionSummary: null,
      },
      nowEpoch: options.nowEpoch,
      reconstructableTurnIds: new Set<number>(),
      // A segment replay carries an empty `turnReview`, so neither of these is
      // ever consulted — an empty gate and the replay's own clock are the
      // honest values, not a borrowed context's.
      reviewableTurnIds: new Set<number>(),
      contextBuiltAtEpoch: options.nowEpoch,
      exposedSegmentIds: options.exposedSegmentIds,
      rideTurnId: null,
      logger: options.logger,
    };

    const { nodes, rejected } = resolveTokens(
      db,
      options.memberTokens ?? [],
      writeBackOptions,
    );
    const membersAdded = addSegmentMembers(
      db,
      segment.id,
      [...nodes.values()]
        .filter((node) => node.kind === "turn")
        .map((node) => node.id),
      options.nowEpoch,
    ).length;
    const anchors = writeAnchorEdges(db, segment, writeBackOptions);

    return {
      applied: true,
      reason: null,
      membersAdded,
      anchorEdges: anchors.written,
      rejectedReferences: rejected + anchors.rejected,
    };
  });
}
