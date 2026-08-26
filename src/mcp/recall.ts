import type { Database } from "bun:sqlite";

import {
  getObservation,
  getExtractableObservationsForTurn,
} from "../db/observations";
import { listLanesForSegment } from "../db/lanes";
import { searchMemory, type SearchMemoryResult } from "../db/search";
import {
  deriveDominantType,
  rankSegmentMembers,
  resolveSegmentAnchorTurnIds,
  type RankedSegmentMember,
} from "../db/segment-rank";
import {
  countLiveSegments,
  getSegment,
  listLiveSegmentsByActivity,
  listSegmentsByActivity,
  SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH,
  segmentTagOf,
  type SegmentRecord,
} from "../db/segments";
import { getSession } from "../db/sessions";
import {
  getFirstTurn,
  getTurn,
  getTurnById,
  getTurnsForSession,
  type TurnRecord,
} from "../db/turns";
import { isSegmentEra } from "../segment-era";
import { resolveSessionTranscriptPath } from "../shared/paths";
import { typeListsEqual } from "../shared/type-vocabulary";

import {
  appendNavigationLegend,
  composeTurnMetadata,
  CONTEXT_TURN_RENDER_FIELDS,
  createTruncationSignal,
  DEFAULT_TURN_TOKEN_BUDGET,
  GATED_TURN_FIELDS,
  pushFieldCompleteness,
  RENDER_INDENT_STEP,
  REWIND_MARKER,
  renderNode,
  renderSessionTransitionLine,
  renderTurnAddress,
  resolveTurnFields,
  truncateText,
  type FormattedObservation,
  type FormattedSession,
  type FormattedTurn,
  type TruncationSignal,
  type TurnRenderFields,
} from "./format";
import {
  hasFilterCriteria,
  parseMemoryFilter,
  turnMatchesFilter,
  type MemoryFilterInput,
  type ParsedMemoryFilter,
  type RecallTurnField,
} from "./memory-filter";
import { estimateTokens } from "../utils/token-estimate";
import { buildTurnRelationLines } from "./relations-view";
import { renderSegmentHeaderLines } from "./segment-spine";
import {
  chronologicalSegmentMembers,
  renderSegmentCard,
  renderSegmentMembersByOrdinal,
  SEGMENT_CARD_DEFAULT_PAGE_BUDGET,
} from "./segment-card";
import { formatLaneVocabularyLine } from "./lane-vocabulary";
import { expandNumericSelector } from "./selectors";
import {
  recordFieldCompleteness,
  recordReadGrants,
  snapshotWriteGateSequence,
  type FieldCompletenessEntry,
  type ReadGrantEntry,
} from "../db/write-gate";

// ---------------------------------------------------------------------------
// The delivery ledger (peer round P1-6): a grant is a fact about DELIVERED
// BYTES, not about rendered ones.
// ---------------------------------------------------------------------------

/**
 * One rendered block's authorization, held until the response's final envelope
 * is known. `endOffset` is the character position in `recallMemoryBody`'s own
 * returned string at which this block is FINISHED — the whole of what earned
 * these entries is inside `text.slice(0, endOffset)`, so an envelope that
 * delivers at least that many characters delivered this block entire.
 */
interface DeliveryRecord {
  endOffset: number;
  grants: ReadGrantEntry[];
  completeness: FieldCompletenessEntry[];
}

/**
 * Collects what a render pass WOULD grant, and hands it over only once the
 * caller says how much of the render actually reached the reader.
 *
 * The gap this closes (peer round P1-6): the worker channel wraps every read in
 * a 100K-character envelope (`mcp/handlers.ts`), and grants used to be written
 * during the render — before that cut existed. A page whose tail was sliced off
 * still licensed a whole-field overwrite of turns the model never saw a byte
 * of. Recording after the cut is not enough on its own, either: something has to
 * say WHICH entities the surviving bytes contain, and that is a fact only the
 * renderer holds. So the renderer reports it (this ledger) instead of anything
 * downstream re-parsing the delivered text for addresses.
 *
 * Completeness rides the same records for the same reason and by the same rule:
 * `TruncationSignal.fieldCompleteness` is appended to in render order, so
 * everything pushed since the previous mark belongs to the block being marked
 * now. A field cut by the ENVELOPE (rather than by the per-item budget the
 * signal already knows about) simply never reaches the database — the record is
 * dropped, not rewritten to `complete: false`, because an earlier honest
 * complete read of that same field is still an honest one and P1-7's sequence
 * comparison is what decides whether it is still current.
 */
class DeliveryLedger {
  private readonly records: DeliveryRecord[] = [];
  private completenessCursor = 0;

  constructor(private readonly signal: TruncationSignal) {}

  /**
   * Everything rendered since the previous mark — the grants named here, plus
   * whatever per-field completeness the nested renderers pushed while it was
   * being built — is complete by character `endOffset`.
   */
  mark(endOffset: number, grants: readonly ReadGrantEntry[] = []): void {
    this.markWith(endOffset, grants, this.takePending());
  }

  /**
   * `mark` for a renderer whose completeness pushes do NOT arrive in output
   * order — the browse feed renders every page while packing and only then
   * learns which one it returns, so it captures each row's own slice as it
   * renders and hands it back here.
   */
  markWith(
    endOffset: number,
    grants: readonly ReadGrantEntry[],
    completeness: readonly FieldCompletenessEntry[],
  ): void {
    if (grants.length === 0 && completeness.length === 0) {
      return;
    }
    this.records.push({ endOffset, grants: [...grants], completeness: [...completeness] });
  }

  /** Everything pushed into the signal since the last mark, consumed. */
  takePending(): FieldCompletenessEntry[] {
    const pending = this.signal.fieldCompleteness ?? [];
    const taken = pending.slice(this.completenessCursor);
    this.completenessCursor = pending.length;
    return taken;
  }

  /**
   * Drops what `takePending` would return — a renderer that captured its own
   * per-row slices says so here, so those same entries are not ALSO swept into
   * the next mark. Without it the browse feed's first delivered row would
   * absorb the completeness of every row on every other page (they were all
   * rendered during packing), which is the completeness half of exactly the
   * over-grant P1-6 is about.
   */
  discardPending(): void {
    this.takePending();
  }

  /** The index a later `shiftFrom` treats as "records added after this point". */
  checkpoint(): number {
    return this.records.length;
  }

  /**
   * Moves every record added since `checkpoint` forward by `delta` — what a
   * composition site calls once it knows where the sub-render it just collected
   * offsets got spliced into the larger response (a page header above it, an
   * earlier item before it). Each renderer therefore only ever has to count
   * characters within its OWN output.
   */
  shiftFrom(checkpoint: number, delta: number): void {
    if (delta === 0) {
      return;
    }
    for (let index = checkpoint; index < this.records.length; index += 1) {
      this.records[index]!.endOffset += delta;
    }
  }

  /** Attributes any completeness nobody marked to the very end of the response — delivered only if nothing was cut at all. */
  sealAt(endOffset: number): void {
    this.mark(endOffset);
  }

  commit(
    db: Database,
    writer: string,
    deliveredChars: number,
    nowEpoch: number,
    sequence: number,
  ): void {
    const grants: ReadGrantEntry[] = [];
    const completeness: FieldCompletenessEntry[] = [];
    for (const record of this.records) {
      if (record.endOffset > deliveredChars) {
        continue;
      }
      grants.push(...record.grants);
      completeness.push(...record.completeness);
    }
    recordReadGrants(db, writer, grants, nowEpoch, sequence);
    recordFieldCompleteness(db, writer, completeness, nowEpoch, sequence);
  }
}

/** The offset a `joinPage` body starts at — the page header, when one renders, sits above it. */
function pageBodyOffset(header: string, body: string, pageCount: number): number {
  return pageCount > 1 && body ? header.length + 1 : 0;
}

export interface RecallInput {
  id?: string;
  // Ticket 04 (spec "Tools"): pure full-text search — the in-query prefix
  // dialect (`type:`/`tag:`/`file:`/`session:`/`project:`) is cut, not
  // aliased. A query containing `tag:foo` searches those literal characters.
  query?: string;
  /**
   * Ticket 04: the structured filter grammar shared with `timeline` —
   * {type, tag, session, time, file}, AND-composed with each other, with
   * `id`, and with `query`. Replaces the retired top-level `time` param
   * (folded in as `filter.time`, same grammar) — no non-schema caller in
   * this repo used the old top-level field, so it was cut clean rather than
   * kept as a deprecated alias.
   */
  filter?: MemoryFilterInput;
  page?: number;
  pageSize?: number;
  /**
   * Ticket 03 (spec "Budgets"): the segment card's own token budget (default
   * `SEGMENT_CARD_DEFAULT_PAGE_BUDGET` = 1000). Named distinctly from `page`
   * (the pre-existing 1-indexed page NUMBER, unchanged and still governing
   * item-count pagination everywhere else) precisely so the two do not
   * collide — `page` already has a heavily-tested numeric meaning across
   * every other recall route, and repurposing it would silently break every
   * caller passing `page: 2` to mean "the second page of items". `page`
   * still selects the segment card's own overflow escape (page ≥ 2 disables
   * elision — see `segment-card.ts`'s "stable page 2").
   */
  pageBudget?: number;
  /**
   * Ticket 03/11: per-item token cap (spec "Budgets") — the SOLE size knob
   * left on every rendered session/turn/observation block, default
   * `DEFAULT_TURN_TOKEN_BUDGET` (150). Applies wherever a node renders
   * through `renderNode` (format.ts); word-boundary cut, never a char count.
   */
  turn?: number;
  /**
   * P2 era boundary (spec D11). Observations created at or after it render
   * their mechanical fields (tool name + input/result prefixes) because nothing
   * summarizes them any more. `null` — the default — leaves every rendering on
   * the legacy path.
   */
  eraCutoffEpoch?: number | null;
  /**
   * Write gate (ticket 01, read-write-contract spec): the writer identity
   * (`session:<id>`, from `db/write-gate.ts`) whose read grant this render
   * should record for whatever it ends up showing — the "统一渲染器渲染即
   *记录" seam. `undefined`/`null` (every worker/test call site that has no
   * caller identity to attribute a grant to) means "record nothing", same
   * latitude `note`'s own `callerSessionId` gives an unknown caller.
   */
  readerId?: string | null;
  /** Test seam for the read-grant timestamp; defaults to the real clock. */
  now?: () => number;
}

const CHILD_PREVIEW_SIZE = 5;

type RoutedRecallId =
  | { kind: "sessions"; sessionIds?: number[] }
  | { kind: "turns"; sessionId: number; promptNumbers?: number[] }
  | { kind: "turn-by-id"; turnId: number }
  | { kind: "session-observation-list"; sessionId: number }
  | { kind: "observation-list"; sessionId: number; promptNumber: number }
  | { kind: "observation"; observationId: number }
  | { kind: "segments"; segmentIds?: number[] }
  // ticket 10 (one-address-grammar spec): `E<n>/T*` — every member of one
  // segment, in event order. The ordinal single/range forms this route used
  // to also carry (`E<n>/T<m>`, `E<n>/T3..7` — spec D9's EVENT-ORDER
  // position, NOT a session prompt number) retired: the same string resolved
  // to a different turn depending on where it was pasted. See
  // `retiredSegmentOrdinalRefusal` — checked by every caller of
  // `parseRoutedId` before it, so the old shape never reaches this parser.
  | { kind: "segment-members"; segmentId: number }
  // ticket 10: `E<n>/S<a>/T<b>` (one member) and
  // `E<n>/S<a>/T<b>..S<c>/T<d>` (a range, second form). The endpoints are
  // ORDINARY S/T addresses — parsing needs no database, so resolving them
  // against the segment's own event order happens at render time. `start`
  // equals `end` for the single form. The two endpoints need not share a
  // session; the range runs over the segment's own event order between them,
  // inclusive.
  | {
      kind: "segment-member-range";
      segmentId: number;
      start: { sessionId: number; promptNumber: number };
      end: { sessionId: number; promptNumber: number };
    };

function splitInsight(insight: string | null): string[] {
  if (!insight) {
    return [];
  }

  return insight
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-+\s*/, ""));
}

// ownership-and-note-cadence spec, "session 字段" ([S15069/T910]-[T913]):
// session retires its six task-shaped fields — insight/next_steps/decision/
// done/reference — unconditionally, superseding the older era-gated partial
// retirement (semantic-container ticket 09, which still rendered them on a
// pre-cutoff session). `title` and `content` are the session's only two
// remaining semantic fields; `content` keeps its EXISTING read path
// (including the era gate below) untouched — this ticket does not touch any
// write path, and the settlement-side writer for `content` is a later ticket.
function buildSessionSummaryFields(
  session: NonNullable<ReturnType<typeof getSession>>,
  eraCutoffEpoch: number | null = null,
): Pick<FormattedSession, "content"> {
  if (isSegmentEra(session.createdAtEpoch, eraCutoffEpoch)) {
    return { content: null };
  }

  return { content: session.content };
}

function formatParameterError(message: string): string {
  return `Parameter error: ${message}`;
}

/**
 * Ticket 14 (spec "选择器多选"): echoed on a rejected comma-separated `id`
 * list — either an item that does not parse at all, or a list whose items
 * do not all share the same address kind.
 */
const ID_SELECTOR_GRAMMAR_HINT =
  'each item must be one address: "S<n>", "S<n>/T<m>" (also T*, Ta..b), "E<n>" (also E*, Ea..b), "E<n>/T*" (every segment member), "E<n>/S<a>/T<b>" (one segment member), "E<n>/S<a>/T<b>..S<c>/T<d>" (a range within the segment), "T<n>" (global), "O<n>", "S<n>/T<m>/O*", or "S<n>/T*/O*" — every item in the list must be the SAME kind.';

/**
 * Ticket 10 (one-address-grammar spec): `E<n>/T<m>` (a single member) and
 * `E<n>/T<a>..<b>` (a range) — the segment's own 1-based EVENT-ORDER
 * ordinal — retired. The same string used to mean three different things
 * depending on where it was pasted (this ordinal, a segment-scoped GLOBAL
 * turn id elsewhere, and briefly a per-segment ordinal too), so a caller
 * still sending it gets a refusal NAMING the replacement grammar rather than
 * a silent reinterpretation — the two readings can differ by hundreds of
 * turns and a silent one lands the reader on the wrong row with no signal.
 * `E<n>/T*` (every member) names no ordinal and is unaffected — matched by
 * `parseRoutedId` itself, never this function. Checked by every caller of
 * `parseRoutedId` BEFORE it runs, so the retired shape never reaches the
 * parser at all (it would otherwise just fail to match and fall through to
 * the generic "invalid id selector" message, which names nothing).
 */
function retiredSegmentOrdinalRefusal(value: string): string | null {
  const match = /^E(\d+)\/T(\d+|\d+\.\.[A-Za-z]?\d+)$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const segmentId = match[1];
  return (
    `"${value}" uses the retired E<n>/T<ordinal> form — a segment's own event-order position is no ` +
    `longer an address. Use "E${segmentId}/S<session>/T<prompt>" for one member, ` +
    `"E${segmentId}/S<a>/T<b>..S<c>/T<d>" for a range, or "E${segmentId}/T*" for every member.`
  );
}

function parseRoutedId(value: string): RoutedRecallId | null {
  const trimmed = value.trim();

  const sessionObservationListMatch = /^S(\d+)\/T\*\/O\*$/i.exec(trimmed);
  if (sessionObservationListMatch) {
    return {
      kind: "session-observation-list",
      sessionId: Number(sessionObservationListMatch[1]),
    };
  }

  const observationListMatch = /^S(\d+)\/T(\d+)\/O\*$/i.exec(trimmed);
  if (observationListMatch) {
    return {
      kind: "observation-list",
      sessionId: Number(observationListMatch[1]),
      promptNumber: Number(observationListMatch[2]),
    };
  }

  const turnMatch = /^S(\d+)\/T(\*|\d+|\d+\.\.[A-Za-z]?\d+)$/i.exec(trimmed);
  if (turnMatch) {
    const promptNumbers = expandNumericSelector(turnMatch[2]!, "T");
    if (promptNumbers === null) {
      return null;
    }

    return {
      kind: "turns",
      sessionId: Number(turnMatch[1]),
      promptNumbers,
    };
  }

  const observationMatch = /^O(\d+)$/i.exec(trimmed);
  if (observationMatch) {
    return {
      kind: "observation",
      observationId: Number(observationMatch[1]),
    };
  }

  // `E<n>/T*` — every member of one segment, in event order (ticket 10).
  // Checked BEFORE the bare segment route below, since that route's own
  // pattern would otherwise stop at the digits and leave a trailing `/T*`
  // unmatched instead of falling through to this one. The ordinal
  // single/range forms this pattern used to also accept are retired — see
  // `retiredSegmentOrdinalRefusal`, checked by every caller before this
  // function runs.
  const segmentMemberWildcardMatch = /^E(\d+)\/T\*$/i.exec(trimmed);
  if (segmentMemberWildcardMatch) {
    return {
      kind: "segment-members",
      segmentId: Number(segmentMemberWildcardMatch[1]),
    };
  }

  // Ticket 10 (one-address-grammar spec): `E31/S123/T1` (one member) and
  // `E31/S123/T1..S456/T7` (a range). The endpoints are ORDINARY S/T
  // addresses; resolving them to the segment's own event-order position
  // needs the database, so it happens at render time
  // (`renderSegmentMemberRange`), not here. The single form is the range
  // form with `start` equal to `end`.
  const segmentMemberAddressMatch =
    /^E(\d+)\/S(\d+)\/T(\d+)(?:\.\.S(\d+)\/T(\d+))?$/i.exec(trimmed);
  if (segmentMemberAddressMatch) {
    const start = {
      sessionId: Number(segmentMemberAddressMatch[2]),
      promptNumber: Number(segmentMemberAddressMatch[3]),
    };
    const end =
      segmentMemberAddressMatch[4] !== undefined
        ? {
            sessionId: Number(segmentMemberAddressMatch[4]),
            promptNumber: Number(segmentMemberAddressMatch[5]),
          }
        : start;
    return {
      kind: "segment-member-range",
      segmentId: Number(segmentMemberAddressMatch[1]),
      start,
      end,
    };
  }

  // Segment route (spec D11): `E47`, and — symmetric with `S` — `E*` and
  // `E1..9`. `E` is the SAME token the write grammar uses (`[E47]`, see
  // db/references.ts), so a citation a settlement wrote is a working address a
  // reader can paste straight back into recall.
  const segmentMatch = /^E(\*|\d+|\d+\.\.[A-Za-z]?\d+)$/i.exec(trimmed);
  if (segmentMatch) {
    const segmentIds = expandNumericSelector(segmentMatch[1]!, "E");
    if (segmentIds === null) {
      return null;
    }

    return { kind: "segments", segmentIds };
  }

  // Global turn-by-DB-id route. Symmetric with `remember({ id: "T<n>" })` (which
  // also uses the DB id) and with the `<turn id="T<n>">` blocks the memory
  // worker sees, so the worker can recall a truncated turn it is extracting. The
  // main agent never uses bare `T<n>` — its output always scopes turns as
  // `S<id>/T<promptNumber>` — so this does not affect the session-scoped route.
  const turnByIdMatch = /^T(\d+)$/i.exec(trimmed);
  if (turnByIdMatch) {
    return {
      kind: "turn-by-id",
      turnId: Number(turnByIdMatch[1]),
    };
  }

  const sessionMatch = /^S(\*|\d+|\d+\.\.[A-Za-z]?\d+)$/i.exec(trimmed);
  if (sessionMatch) {
    const sessionIds = expandNumericSelector(sessionMatch[1]!, "S");
    if (sessionIds === null) {
      return null;
    }

    return {
      kind: "sessions",
      sessionIds,
    };
  }

  return null;
}

function buildSessionView(
  db: Database,
  session: NonNullable<ReturnType<typeof getSession>>,
  eraCutoffEpoch: number | null = null,
): FormattedSession {
  const turns = getTurnsForSession(db, session.id).map((turn) =>
    buildTurnView(db, turn, eraCutoffEpoch),
  );

  return {
    id: session.id,
    title: session.title,
    project: session.project,
    createdAtEpoch: session.createdAtEpoch,
    ...buildSessionSummaryFields(session, eraCutoffEpoch),
    turnCount: turns.length,
    observationCount: turns.reduce(
      (sum, turn) => sum + (turn.observationCount ?? 0),
      0,
    ),
    jsonlPath: resolveSessionTranscriptPath(session),
    turns,
  };
}

function getObservationCountByTurnId(
  db: Database,
  turnIds: number[],
): Map<number, number> {
  if (turnIds.length === 0) {
    return new Map();
  }

  const placeholders = turnIds.map(() => "?").join(", ");
  const rows = db
    .query<{ turnId: number; count: number }, number[]>(
      `SELECT turn_id AS turnId, COUNT(*) AS count
       FROM observations
       WHERE turn_id IN (${placeholders}) AND excluded_from_extraction = 0
       GROUP BY turn_id`,
    )
    .all(...turnIds);

  return new Map(rows.map((row) => [row.turnId, row.count]));
}

export function buildSessionSummary(
  db: Database,
  sessionId: number,
  eraCutoffEpoch: number | null = null,
): FormattedSession | null {
  const session = getSession(db, sessionId);
  if (!session) {
    return null;
  }

  const turnCount =
    db
      .query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM turns WHERE session_id = ?",
      )
      .get(session.id)?.count ?? 0;
  const observationCount =
    db
      .query<{ count: number }, [number]>(
        `SELECT COUNT(*) AS count
         FROM observations o
         JOIN turns t ON t.id = o.turn_id
         WHERE t.session_id = ? AND o.excluded_from_extraction = 0`,
      )
      .get(session.id)?.count ?? 0;

  return {
    id: session.id,
    title: session.title,
    project: session.project,
    createdAtEpoch: session.createdAtEpoch,
    ...buildSessionSummaryFields(session, eraCutoffEpoch),
    turnCount,
    observationCount,
    jsonlPath: undefined,
  };
}

export function buildCollapsedTurnsForSession(
  db: Database,
  sessionId: number,
): FormattedTurn[] {
  const turns = getTurnsForSession(db, sessionId);
  const observationCounts = getObservationCountByTurnId(
    db,
    turns.map((turn) => turn.id),
  );

  return turns.map((turn) => ({
    id: turn.id,
    promptNumber: turn.promptNumber,
    title: turn.title,
    content: turn.content,
    observationCount: observationCounts.get(turn.id) ?? 0,
    toolCallCount: turn.toolCallCount,
    filesReadCount: turn.filesRead.length,
    filesModifiedCount: turn.filesModified.length,
    status: turn.status,
    wasRolledBack: turn.wasRolledBack,
    // Ticket 12 (edge-mechanism-revision spec): `metadata` now rides in
    // `DEFAULT_TURN_RENDER_FIELDS`, so `formatTurnCompact` (this builder's
    // one caller, note-settlement-context.ts) renders it unconditionally —
    // same `buildTurnView` convention (no previous-turn epoch: this builder
    // is addressed by selector/session scope, not a session-ordered walk, so
    // there is no honest "previous" to name here either).
    metadata: composeTurnMetadata(turn, null),
  }));
}

export function buildFormattedSession(
  db: Database,
  sessionId: number,
  expandTurns: number[] = [],
  eraCutoffEpoch: number | null = null,
): FormattedSession | null {
  const session = getSession(db, sessionId);
  if (!session) {
    return null;
  }

  const turns = getTurnsForSession(db, session.id).map((turn) =>
    buildTurnView(db, turn, eraCutoffEpoch),
  );

  return {
    id: session.id,
    title: session.title,
    project: session.project,
    createdAtEpoch: session.createdAtEpoch,
    ...buildSessionSummaryFields(session, eraCutoffEpoch),
    turnCount: turns.length,
    observationCount: turns.reduce(
      (sum, turn) => sum + (turn.observationCount ?? 0),
      0,
    ),
    jsonlPath: resolveSessionTranscriptPath(session),
    turns: turns.map((turn) =>
      expandTurns.includes(turn.promptNumber)
        ? turn
        : {
            ...turn,
            promptPreview: undefined,
            responsePreview: undefined,
            insight: undefined,
            observations: undefined,
          },
    ),
  };
}

export function buildTurnView(
  db: Database,
  turn: TurnRecord,
  eraCutoffEpoch: number | null = null,
  fields?: TurnRenderFields,
): FormattedTurn {
  // Excluded observations (a `note` call) stay out of every reader-facing view:
  // their count, their ids and their tool names are as much of a leak as their
  // payloads would be — the P1 comparison needs the note channel invisible to
  // the pipeline's own output, and an id here is an id the model can then fetch.
  const observations = getExtractableObservationsForTurn(db, turn.id);
  return {
    id: turn.id,
    promptNumber: turn.promptNumber,
    title: turn.title,
    content: turn.content,
    observationCount: observations.length,
    toolCallCount: turn.toolCallCount,
    filesReadCount: turn.filesRead.length,
    filesModifiedCount: turn.filesModified.length,
    status: turn.status,
    promptPreview: turn.userPrompt,
    responsePreview: turn.assistantResponse,
    insight: splitInsight(turn.insight),
    filesRead: turn.filesRead,
    filesModified: turn.filesModified,
    observations: observations.map((observation) =>
      buildObservationView(observation, turn.createdAtEpoch, eraCutoffEpoch),
    ),
    wasRolledBack: turn.wasRolledBack,
    // No previous-turn epoch here: recall addresses turns by selector, not as
    // a session-ordered walk, so there is no "previous" this builder can name
    // honestly. The gap belongs to timeline's own session-scoped turn view.
    metadata: composeTurnMetadata(turn, null),
    // Edge-read-surface spec, ticket 01: the DB query behind `relations` runs
    // ONLY when a caller's own `fields` actually selects it — "costs nothing
    // when not requested" is enforced here, at the query boundary, not just
    // at render time (unlike `insight`/`filesRead`/etc. above, which are
    // already-loaded `TurnRecord` columns with no extra query to skip).
    relations: fields?.has("relations") ? buildTurnRelationLines(db, turn) : undefined,
  };
}

function previewItems<T>(items: T[], size = 5): { items: T[]; omittedCount: number } {
  return {
    items: items.slice(0, size),
    omittedCount: Math.max(0, items.length - size),
  };
}

function paginateItems<T>(
  items: T[],
  page: number,
  pageSize: number,
): { items: T[]; total: number; pageCount: number } {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;

  return {
    items: items.slice(offset, offset + pageSize),
    total,
    pageCount,
  };
}

/**
 * Packs `items` into pages by measuring a CANDIDATE page's actual rendered
 * cost via `renderPage`, rather than summing a per-item cost (ticket 03,
 * "pageBudget governs every listing surface at runtime"): several listing
 * surfaces in this file (`renderTurnScope`, `renderObservationScope`,
 * `renderGroupedSearchResults`) rebuild their own session/turn header fresh
 * from whatever items land on a given page, so one item's true marginal
 * cost depends on which page it joins and cannot be priced alone the way
 * `buildBrowseFeed`'s own per-unit packer prices a `BrowseUnit`. Same
 * "items or `pageBudget` tokens, whichever comes first" rule as that packer
 * (a page always holds at least one item, so a single oversized item can
 * never stall pagination) — ticket 03's pinned "one packing rule" applied
 * here with a measurement strategy suited to renderers that regroup a page
 * from scratch instead of rendering each item independently.
 *
 * `renderPage` MUST be side-effect-free: it runs multiple times per item
 * while probing for the boundary, so a caller whose real render records
 * read grants or mutates a `TruncationSignal` passes `readerId: null` /
 * `signal: undefined` here and performs the real, once-only render (with
 * the real values) against the chosen page's items afterward.
 */
function packItemsByRenderedPageCost<T>(
  items: readonly T[],
  pageSize: number,
  pageBudget: number,
  renderPage: (pageItems: T[]) => string,
): T[][] {
  const pages: T[][] = [];
  let current: T[] = [];

  for (const item of items) {
    const candidate = [...current, item];
    const overflowsCount = current.length >= pageSize;
    const overflowsBudget =
      current.length > 0 && estimateTokens(renderPage(candidate)) > pageBudget;

    if (current.length > 0 && (overflowsCount || overflowsBudget)) {
      pages.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0 || pages.length === 0) {
    pages.push(current);
  }
  return pages;
}

/**
 * `paginateItems`'s pageBudget-aware sibling (ticket 03). Same offset
 * semantics as `paginateItems` — an out-of-range `page` yields an empty
 * slice, `pageCount` still the true page count, no clamping — but the page
 * boundary itself comes from `packItemsByRenderedPageCost` instead of a
 * pure `pageSize` cut.
 */
function paginateByRenderedPageCost<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
  pageBudget: number,
  renderPage: (pageItems: T[]) => string,
): { items: T[]; total: number; pageCount: number } {
  const pages = packItemsByRenderedPageCost(items, pageSize, pageBudget, renderPage);
  const index = page - 1;
  return {
    items: index >= 0 && index < pages.length ? pages[index]! : [],
    total: items.length,
    pageCount: pages.length,
  };
}

function formatPageHeader(page: number, pageCount: number, total: number): string {
  return `page ${page} / ${pageCount} (total ${total})`;
}

function joinPage(header: string, body: string, pageCount: number): string {
  if (pageCount <= 1) {
    return body;
  }

  return body ? `${header}\n${body}` : header;
}

/**
 * Derives a fork-lineage breadcrumb string for a session with parentSessionId.
 * Returns null for root sessions. Null-tolerant: if the fork turn number cannot
 * be resolved the parenthetical is omitted (just "continues from S<id>").
 */
function deriveBreadcrumb(
  db: Database,
  session: NonNullable<ReturnType<typeof getSession>>,
): string | null {
  if (session.parentSessionId === null) {
    return null;
  }

  const parentRef = `S${session.parentSessionId}`;

  // Attempt to derive the fork turn: first turn of child → its parentTurnId →
  // look up that turn's promptNumber in the parent session.
  const firstTurn = getFirstTurn(db, session.id);
  if (firstTurn !== null && firstTurn.parentTurnId !== null) {
    const forkTurn = getTurnById(db, firstTurn.parentTurnId);
    if (forkTurn !== null) {
      return `continues from ${parentRef} (forked at T${forkTurn.promptNumber})`;
    }
  }

  return `continues from ${parentRef}`;
}

/**
 * `recall(id="S<n>")` — the one full session-DETAIL route. Ticket 11 retired
 * the collapsed/expanded depth switch that used to decide whether this
 * showed a turn preview at all: with no toggle left, it always does (bounded
 * by `CHILD_PREVIEW_SIZE` as before), and always includes the raw transcript
 * pointer — a caller after JUST the session's own summary line, with no
 * turns, uses `filter.fields` to render each previewed turn minimally rather
 * than suppressing the preview outright.
 */
/**
 * Ticket 14's P1-2 fix carried the previewed turn ids out of this render so
 * the `sessions` route could grant them; the peer round's P2-2 ruled that
 * grant wider than what the route delivers (a preview is not a read of the
 * turns it lists), and the field went with the grant. What the route records
 * is the SESSION.
 */
interface RenderedSession {
  text: string;
}

function renderSession(
  db: Database,
  session: NonNullable<ReturnType<typeof getSession>>,
  fields: TurnRenderFields,
  turnSelector: Set<number> | undefined,
  eraCutoffEpoch: number | null = null,
  signal: TruncationSignal | undefined,
  turnBudget: number | undefined,
): RenderedSession {
  const view = buildSessionView(db, session, eraCutoffEpoch);
  const breadcrumb = deriveBreadcrumb(db, session);
  const lines = [
    renderNode(
      { type: "session", value: view },
      { includeRawPointer: true, turnBudget, signal },
    ),
  ];

  if (breadcrumb !== null) {
    lines.push(`${RENDER_INDENT_STEP}${breadcrumb}`);
  }

  const turns = getTurnsForSession(db, session.id).filter((turn) =>
    turnSelector ? turnSelector.has(turn.promptNumber) : true,
  );

  const preview = previewItems(turns, CHILD_PREVIEW_SIZE);
  for (const item of preview.items) {
    const turnView = buildTurnView(db, item, eraCutoffEpoch, fields);
    const turnLines = renderNode(
      { type: "turn", value: turnView },
      {
        indent: RENDER_INDENT_STEP,
        fields,
        sessionId: session.id,
        turnBudget,
        signal,
      },
    );
    lines.push(turnLines);
  }

  if (preview.omittedCount > 0) {
    lines.push(`${RENDER_INDENT_STEP}+${preview.omittedCount} more`);
  }

  return { text: lines.join("\n") };
}

function renderTurnScope(
  db: Database,
  turns: TurnRecord[],
  fields: TurnRenderFields,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
  turnBudget?: number,
  // Peer round P1-6: this renderer, not its caller, is what knows where one
  // turn's block ends — so it is what marks the delivery ledger. Offsets are
  // relative to the string this function returns; the caller shifts them once
  // it knows where that string lands in the response.
  ledger?: DeliveryLedger,
): string {
  const lines: string[] = [];
  // Character position of the END of `lines` so far, in the joined result.
  let cursor = 0;
  const appendLine = (line: string): void => {
    if (lines.length > 0) {
      cursor += 1; // the "\n" this join will insert
    }
    lines.push(line);
    cursor += line.length;
  };
  const grouped = new Map<number, TurnRecord[]>();
  for (const turn of turns) {
    const list = grouped.get(turn.sessionId) ?? [];
    list.push(turn);
    grouped.set(turn.sessionId, list);
  }

  const sessions = Array.from(grouped.keys())
    .map((sessionId) => getSession(db, sessionId))
    .filter(
      (session): session is NonNullable<ReturnType<typeof getSession>> =>
        session !== null,
    );

  for (const session of sessions) {
    const view = buildSessionSummary(db, session.id, eraCutoffEpoch);
    if (!view) {
      continue;
    }
    // Ticket 01 (render-boilerplate-trim spec, item 2): this session render
    // is an ANCESTOR header above this run's turn rows, not the thing the
    // caller addressed — a turn-addressed selector never asked about the
    // session's own narrative. `content` drops here only; the id+title
    // transition line still identifies which session owns the turns below
    // it. No write-gate field-completeness is recorded for session content
    // anywhere in this module, so dropping it records nothing different.
    appendLine(
      renderNode(
        { type: "session", value: { ...view, content: null } },
        { turnBudget, signal },
      ),
    );

    const sessionTurns = grouped.get(session.id) ?? [];
    for (const item of sessionTurns) {
      const turnView = buildTurnView(db, item, eraCutoffEpoch, fields);
      appendLine(
        renderNode(
          { type: "turn", value: turnView },
          {
            indent: RENDER_INDENT_STEP,
            fields,
            sessionId: session.id,
            signal,
            turnBudget,
          },
        ),
      );
      // One turn, one mark: a page whose tail the envelope cuts keeps the
      // grants of the turns whose blocks survived whole and loses the rest.
      ledger?.mark(cursor, [{ entityType: "turn", entityId: item.id }]);
    }
  }

  return lines.join("\n");
}

function renderObservationScope(
  db: Database,
  observations: Array<{ sessionId: number; turnId: number; observationId: number }>,
  includeParents: boolean,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
  turnBudget?: number,
): string {
  const lines: string[] = [];
  const grouped = new Map<number, Map<number, number[]>>();

  for (const row of observations) {
    const turnMap = grouped.get(row.sessionId) ?? new Map<number, number[]>();
    const list = turnMap.get(row.turnId) ?? [];
    list.push(row.observationId);
    turnMap.set(row.turnId, list);
    grouped.set(row.sessionId, turnMap);
  }

  if (!includeParents) {
    for (const entry of observations) {
      const row = entry;
      const observation = getObservation(db, row.observationId);
      if (!observation) {
        continue;
      }

      const observationView = buildOwnedObservationView(
        db,
        observation,
        eraCutoffEpoch,
      );

      lines.push(
        renderNode(
          { type: "observation", value: observationView },
          { turnBudget, signal },
        ),
      );
    }

    return lines.join("\n");
  }

  const sessions = Array.from(grouped.keys())
    .map((sessionId) => getSession(db, sessionId))
    .filter(
      (session): session is NonNullable<ReturnType<typeof getSession>> =>
        session !== null,
    );

  for (const session of sessions) {
    const sessionView = buildSessionSummary(db, session.id, eraCutoffEpoch);
    if (!sessionView) {
      continue;
    }
    lines.push(
      renderNode({ type: "session", value: sessionView }, { turnBudget, signal }),
    );
    const turnMap = grouped.get(session.id) ?? new Map<number, number[]>();
    const turns = getTurnsForSession(db, session.id).filter((turn) =>
      turnMap.has(turn.id),
    );

    for (const turn of turns) {
      const turnView = buildTurnView(db, turn, eraCutoffEpoch);
      lines.push(
        renderNode(
          { type: "turn", value: turnView },
          {
            indent: RENDER_INDENT_STEP,
            // Ticket 02: a FIXED-SHAPE surface — the `O*` routes render this
            // turn row as the header its observations hang under, and no
            // caller field selection reaches it. It declares `prompt` so a
            // note-less turn still says what was asked of it, now inside the
            // per-item `turn` budget instead of in the uncappable label.
            fields: CONTEXT_TURN_RENDER_FIELDS,
            sessionId: session.id,
            turnBudget,
            signal,
          },
        ),
      );

      const observationIds = turnMap.get(turn.id) ?? [];
      for (const observationEntry of observationIds) {
        const observationId = observationEntry;
        const observation = getObservation(db, observationId);
        if (!observation) {
          continue;
        }

        const observationView = buildObservationView(
          observation,
          turn.createdAtEpoch,
          eraCutoffEpoch,
        );

        lines.push(
          renderNode(
            { type: "observation", value: observationView },
            {
              indent: `${RENDER_INDENT_STEP}${RENDER_INDENT_STEP}`,
              sessionId: session.id,
              turnPromptNumber: turn.promptNumber,
              turnBudget,
              signal,
            },
          ),
        );
      }
    }
  }

  return lines.join("\n");
}

/**
 * One observation row. In the segment era the mechanical fields ride along
 * (spec D11): no pipeline summarizes an observation any more, so the tool name
 * and the head of its input and result ARE the row's content. Pre-era rows are
 * untouched — their summary is what they have.
 *
 * `toolName` itself is forwarded on BOTH sides (spec D3): the label/tool-name
 * dedup in format.ts needs to know the tool name regardless of era to decide
 * whether a `tool:` line would just repeat the label above it. It is a name,
 * not a raw call payload, so D5's "no raw tool fields on a legacy row" does not
 * cover it — only `toolInput`/`toolResult` (the actual raw fields) stay gated.
 *
 * The era is decided by `ownerCreatedAtEpoch`, the TURN's timestamp, never the
 * observation's own. An observation has no semantics of its own: whether
 * anything summarized it is a fact about the turn that produced it, and a
 * turn's tool calls straddle whatever instant the cutoff falls on. Reading the
 * observation's own stamp would leak era-only fields out of a legacy turn and
 * hide them inside an era one. A null owner (impossible under the foreign key)
 * reads as legacy — the safe half.
 */
function buildObservationView(
  observation: NonNullable<ReturnType<typeof getObservation>>,
  ownerCreatedAtEpoch: number | null,
  eraCutoffEpoch: number | null = null,
): FormattedObservation {
  const view: FormattedObservation = {
    id: observation.id,
    title: observation.title ?? observation.toolName ?? `Observation ${observation.id}`,
    content: observation.content,
  };

  if (
    ownerCreatedAtEpoch !== null &&
    isSegmentEra(ownerCreatedAtEpoch, eraCutoffEpoch)
  ) {
    view.toolName = observation.toolName;
    view.toolInput = observation.toolInput;
    view.toolResult = observation.toolResult;
  }

  return view;
}

/** `buildObservationView` for a caller that holds the observation but not its turn. */
function buildOwnedObservationView(
  db: Database,
  observation: NonNullable<ReturnType<typeof getObservation>>,
  eraCutoffEpoch: number | null,
): FormattedObservation {
  return buildObservationView(
    observation,
    getTurnById(db, observation.turnId)?.createdAtEpoch ?? null,
    eraCutoffEpoch,
  );
}

function renderSessionDetail(
  db: Database,
  sessionId: number,
  fields: TurnRenderFields,
  eraCutoffEpoch: number | null = null,
  signal: TruncationSignal | undefined,
  turnBudget: number | undefined,
): RenderedSession {
  const session = getSession(db, sessionId);
  return session
    ? renderSession(
        db,
        session,
        fields,
        undefined,
        eraCutoffEpoch,
        signal,
        turnBudget,
      )
    : { text: "Session not found." };
}

function renderObservationDetail(
  db: Database,
  observationId: number,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
  turnBudget?: number,
): string {
  const observation = getObservation(db, observationId);
  // Every listing route already drops excluded rows, so direct addressing must
  // read as "no such observation" too — otherwise the id a listing withheld is
  // still fetchable in full by guessing it.
  if (!observation || observation.excludedFromExtraction !== 0) {
    return "Observation not found.";
  }

  const view = buildOwnedObservationView(db, observation, eraCutoffEpoch);
  return renderNode({ type: "observation", value: view }, { turnBudget, signal });
}

/**
 * Facts a segment's header line reports, all derived from its members: the
 * dominant type (the member-type mode, spec D9's mechanical prior), the phase
 * trace, and the anchor addresses its own body designates.
 */
function buildSegmentFacts(
  db: Database,
  segment: SegmentRecord,
  eraCutoffEpoch: number | null = null,
): {
  memberCount: number;
  dominantType: string | null;
  phaseTrace: string[][];
  anchorRefs: string[];
  members: RankedSegmentMember[];
} {
  const members = rankSegmentMembers(db, segment.id, undefined, eraCutoffEpoch);
  const chronological = [...members].sort((left, right) => {
    if (left.createdAtEpoch !== right.createdAtEpoch) {
      return left.createdAtEpoch - right.createdAtEpoch;
    }
    return left.turnId - right.turnId;
  });

  // Flattened: a multi-valued member contributes every one of its own words
  // to the mode count (spec B5), not just a "first" pick — `deriveDominantType`
  // itself is untouched.
  const dominantType = deriveDominantType(
    chronological.flatMap((member) => member.type),
    segment.type,
  );

  // Consecutive runs of an IDENTICAL type list collapse to one entry (ticket
  // 02, spec B5) — same ordered-list rule the timeline's own phase grouping
  // applies (`typeListsEqual`), so the two "a function switch is not a
  // segment boundary" traces agree on what counts as a boundary.
  const phaseTrace: string[][] = [];
  for (const member of chronological) {
    if (member.type.length === 0) {
      continue;
    }
    const previous = phaseTrace[phaseTrace.length - 1];
    if (!previous || !typeListsEqual(previous, member.type)) {
      phaseTrace.push([...member.type]);
    }
  }

  const byTurnId = new Map(members.map((member) => [member.turnId, member] as const));
  const anchorRefs = resolveSegmentAnchorTurnIds(db, segment)
    .map((turnId) => byTurnId.get(turnId))
    .filter((member): member is RankedSegmentMember => member !== undefined)
    .map((member) => `S${member.sessionId}/T${member.promptNumber}`);

  return {
    memberCount: members.length,
    dominantType,
    phaseTrace,
    anchorRefs,
    members,
  };
}

/** One collapsed `[E<n>]` line, as a search hit renders it — `turnBudget` (tokens) converts to a char limit the same way the browse feed's own field cuts do. */
function renderSegmentSummary(
  db: Database,
  segmentId: number,
  turnBudget: number | undefined,
  eraCutoffEpoch: number | null = null,
): string | null {
  const segment = getSegment(db, segmentId);
  if (!segment) {
    return null;
  }
  const facts = buildSegmentFacts(db, segment, eraCutoffEpoch);
  return renderSegmentHeaderLines({
    segment,
    memberCount: facts.memberCount,
    dominantType: facts.dominantType,
    phaseTrace: facts.phaseTrace,
    anchorRefs: facts.anchorRefs,
    charLimit: Math.max(20, (turnBudget ?? DEFAULT_TURN_TOKEN_BUDGET) * BROWSE_CHARS_PER_TOKEN),
  }).join("\n");
}

function listSegmentIds(db: Database, segmentIds: number[] | undefined): number[] {
  // A single explicit id is a question about THAT segment, so a miss has to be
  // reported rather than silently yielding an empty page; a range or `*` is a
  // listing, where a gap is not an error.
  if (segmentIds && segmentIds.length === 1) {
    return segmentIds;
  }
  if (segmentIds && segmentIds.length > 0) {
    return segmentIds.filter((segmentId) => getSegment(db, segmentId) !== null);
  }
  return db
    .query<{ id: number }, []>("SELECT id FROM segments ORDER BY id DESC")
    .all()
    .map((row) => row.id);
}

/**
 * Ticket 04 (spec "Tools"): `type`/`tag`/`file`/`session` AND-compose with a
 * session-listing id selector (`S*`, `S1..9`, or bare `recall()`) the same
 * way `time` already did before this ticket. A session matches when at
 * least one of ITS turns does (`searchMemory`'s own session-facet clauses,
 * db/search.ts) — reused rather than re-implemented here, so the two
 * "does this session hold such a turn" answers can never drift apart. Plain
 * `after`/`before` narrowing (no other filter member set) keeps the original
 * simple JS-side filter, unchanged from before this ticket.
 */
function listSessionIds(
  db: Database,
  sessionIds: number[] | undefined,
  after?: number,
  before?: number,
  filter?: ParsedMemoryFilter,
): number[] {
  const hasExtraFilter =
    filter !== undefined &&
    (filter.type !== undefined ||
      filter.tag !== undefined ||
      filter.file !== undefined ||
      filter.sessionId !== undefined);

  if (hasExtraFilter) {
    const matched = new Set(
      searchMemory(db, {
        scope: "sessions",
        type: filter!.type,
        tag: filter!.tag,
        file: filter!.file,
        sessionId: filter!.sessionId,
        after,
        before,
      }).map((result) => result.sourceId),
    );
    const candidates =
      sessionIds && sessionIds.length > 0 ? sessionIds : [...matched];
    return candidates.filter((sessionId) => matched.has(sessionId));
  }

  const sessions = sessionIds && sessionIds.length > 0
    ? sessionIds
        .map((sessionId) => getSession(db, sessionId))
        .filter(
          (session): session is NonNullable<ReturnType<typeof getSession>> =>
            session !== null,
        )
    : db
        .query<{ id: number; createdAtEpoch: number }, []>(
          `SELECT id, created_at_epoch AS createdAtEpoch
           FROM sessions
           ORDER BY created_at_epoch DESC`,
        )
        .all()
        .map((row) => getSession(db, row.id))
        .filter(
          (session): session is NonNullable<ReturnType<typeof getSession>> =>
            session !== null,
        );

  return sessions
    .filter((session) => {
      if (after !== undefined && session.createdAtEpoch < after) {
        return false;
      }
      if (before !== undefined && session.createdAtEpoch > before) {
        return false;
      }
      return true;
    })
    .map((session) => session.id);
}

function applyTurnSelector(
  db: Database,
  sessionId: number,
  promptNumbers?: number[],
): TurnRecord[] {
  const turns = getTurnsForSession(db, sessionId);
  if (!promptNumbers || promptNumbers.length === 0) {
    return turns;
  }

  // `S<id>/T<n>` is strictly a session-scoped prompt_number selector. The worker
  // addresses turns by DB id, but it uses the separate global `T<n>` route for
  // that — never overload prompt numbers here (adopted sessions can start at
  // high/gapped prompt numbers, so a DB-id fallback would silently return the
  // wrong turn).
  const selected = new Set(promptNumbers);
  return turns.filter((turn) => selected.has(turn.promptNumber));
}

// ---------------------------------------------------------------------------
// Ticket 08 (read-write-contract spec, "一工具两形态" 搜索半边): matched-term
// bold + neighborhood, replacing the default even-split truncation for a
// search hit's content field. Score order (already `results`' own order —
// `searchQueryResults`/`searchMemory` sort by relevance) is what this
// section preserves through rendering, rather than re-sorting turns back to
// session-chronological order.
// ---------------------------------------------------------------------------

function extractQueryTerms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/["*]/g, ""))
    .filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bolds every occurrence of any term inside `text` — a reader scanning a hit sees every matched word, not only the one the window centered on. */
function boldAllTermOccurrences(text: string, terms: readonly string[]): string {
  const escaped = terms.map(escapeRegExp).filter(Boolean);
  if (escaped.length === 0) {
    return text;
  }
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
  return text.replace(pattern, "**$1**");
}

/**
 * Matched-term bold + neighborhood (spec: "匹配词加粗+邻域优先展示,替代默认
 * 字段均摊截断;尾部词边界切、两侧均分"). Finds the EARLIEST case-insensitive
 * occurrence of any term; the window is centered there, `windowChars` split
 * evenly across both sides, each side's tail cut at a WORD BOUNDARY (mirrors
 * `truncateText`'s own boundary rule, applied independently left and right).
 * No term found in `text` at all (the FTS hit came from a different field)
 * falls back to the ordinary word-boundary truncate from the start.
 */
export function boldSearchSnippet(
  text: string,
  terms: readonly string[],
  windowChars: number,
  signal?: TruncationSignal,
): string {
  if (terms.length === 0) {
    return truncateText(text, { limit: windowChars, signal });
  }

  const lower = text.toLowerCase();
  let matchStart = -1;
  let matchLength = 0;
  for (const term of terms) {
    if (!term) continue;
    const idx = lower.indexOf(term.toLowerCase());
    if (idx !== -1 && (matchStart === -1 || idx < matchStart)) {
      matchStart = idx;
      matchLength = term.length;
    }
  }

  if (matchStart === -1) {
    return truncateText(text, { limit: windowChars, signal });
  }

  const halfWindow = Math.max(10, Math.floor(windowChars / 2));
  const leftStart = Math.max(0, matchStart - halfWindow);
  const rightEnd = Math.min(text.length, matchStart + matchLength + halfWindow);

  let left = text.slice(leftStart, matchStart);
  let right = text.slice(matchStart + matchLength, rightEnd);
  const matched = text.slice(matchStart, matchStart + matchLength);
  const leftTruncated = leftStart > 0;
  const rightTruncated = rightEnd < text.length;

  // Word-boundary cut on each side independently — keep the END of the left
  // window (adjacent to the match) and the START of the right window.
  if (leftTruncated) {
    const spaceIdx = left.indexOf(" ");
    if (spaceIdx !== -1 && spaceIdx <= left.length * 0.2) {
      left = left.slice(spaceIdx + 1);
    }
  }
  if (rightTruncated) {
    const spaceIdx = right.lastIndexOf(" ");
    if (spaceIdx !== -1 && spaceIdx >= right.length * 0.8) {
      right = right.slice(0, spaceIdx);
    }
  }

  if ((leftTruncated || rightTruncated) && signal) {
    signal.truncated = true;
  }

  const windowText = `${left}${matched}${right}`;
  const bolded = boldAllTermOccurrences(windowText, terms);
  return `${leftTruncated ? "…" : ""}${bolded}${rightTruncated ? "…" : ""}`;
}

/**
 * Shallow-clones a formatted view with its `title`/`content` replaced by a
 * bold+neighborhood snippet — the search-shape's own fields, never mutating
 * the source view. Shared by `FormattedSession` and `FormattedObservation`,
 * whose only indexed text fields are these two (ticket 14, P2-5 fix, spec
 * "搜索加粗覆盖全部被索引字段" — see `withTurnSearchSnippet` for the wider
 * turn shape).
 */
function withBasicSearchSnippet<T extends { title?: string | null; content?: string | null }>(
  view: T,
  terms: readonly string[],
  windowChars: number,
  signal?: TruncationSignal,
): T {
  if (terms.length === 0) {
    return view;
  }
  // `T` is generic — TS cannot prove a spread-and-override object literal is
  // still exactly `T`, so the cast makes explicit what is structurally true
  // (every property of `view` survives the spread; only the two named fields
  // narrow).
  return {
    ...view,
    title: view.title ? boldSearchSnippet(view.title, terms, windowChars, signal) : view.title,
    content: view.content ? boldSearchSnippet(view.content, terms, windowChars, signal) : view.content,
  } as T;
}

/**
 * `withBasicSearchSnippet`'s turn-shaped sibling (ticket 14, P2-5 fix): a
 * turn indexes more than title/content for FTS (`db/search.ts` also matches
 * `user_prompt`/`assistant_response`), and a hit whose matched term lives
 * ONLY in one of those fields used to render with no bold and no
 * neighborhood at all — the matched evidence was invisible. `insight` is a
 * list; each row gets its own independent snippet rather than one window
 * over the joined text, since a match in row 3 should not need rows 1-2's
 * text to eat into its window.
 */
function withTurnSearchSnippet(
  view: FormattedTurn,
  terms: readonly string[],
  windowChars: number,
  signal?: TruncationSignal,
): FormattedTurn {
  if (terms.length === 0) {
    return view;
  }
  return {
    ...view,
    title: view.title ? boldSearchSnippet(view.title, terms, windowChars, signal) : view.title,
    content: view.content ? boldSearchSnippet(view.content, terms, windowChars, signal) : view.content,
    promptPreview: view.promptPreview
      ? boldSearchSnippet(view.promptPreview, terms, windowChars, signal)
      : view.promptPreview,
    responsePreview: view.responsePreview
      ? boldSearchSnippet(view.responsePreview, terms, windowChars, signal)
      : view.responsePreview,
    insight: view.insight?.map((row) => boldSearchSnippet(row, terms, windowChars, signal)),
  };
}

// ---------------------------------------------------------------------------
// Ticket 04 (view-render-repair spec, "命中即展示"): the matched-field probe
// — a per-row check of whether the search's own terms landed inside a turn's
// PROMPT text, reusing the exact term set the bolding above computes. No FTS
// column-attribution machinery: this never asks which indexed column
// produced the FTS hit, only whether the term is present in the field's own
// text.
// ---------------------------------------------------------------------------

/**
 * Whether any of `terms` occurs in `text` at a WORD boundary — the match is
 * not glued to another alphanumeric character on either side. A CJK term has
 * no alphanumeric neighbours to begin with, so the check degrades to a plain
 * substring test there.
 */
function hasWordBoundaryMatch(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  const isWordChar = (ch: string) => /[a-z0-9_]/i.test(ch);
  return terms.some((term) => {
    const needle = term.toLowerCase();
    if (!needle) return false;
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) return false;
      const before = idx > 0 ? lower[idx - 1]! : "";
      const after = idx + needle.length < lower.length ? lower[idx + needle.length]! : "";
      if (!isWordChar(before) && !isWordChar(after)) {
        return true;
      }
      from = idx + 1;
    }
  });
}

/**
 * Which of a turn's match-conditional fields (`format.ts`'s
 * `MATCH_CONDITIONAL_TURN_FIELDS`, currently just `prompt`) contain one of
 * the search's own terms — `turn.userPrompt` is the same raw text
 * `withTurnSearchSnippet` bolds into `promptPreview`. format.ts's own set is
 * the switch that decides which of these actually render; this probe simply
 * reports what matched, so it stays correct even if that set grows.
 */
function matchedTurnFields(turn: TurnRecord, terms: readonly string[]): TurnRenderFields {
  const matched = new Set<RecallTurnField>();
  if (turn.userPrompt && hasWordBoundaryMatch(turn.userPrompt, terms)) {
    matched.add("prompt");
  }
  return matched;
}

function renderGroupedSearchResults(
  db: Database,
  results: SearchMemoryResult[],
  fields: TurnRenderFields,
  turnBudget: number | undefined,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
  queryText?: string,
  // Peer round P1-6: the pending delivery ledger (`undefined` on a trial
  // render, and for a caller with no reader identity), replacing the
  // readerId/now/sequence trio this function used to record grants with
  // directly, mid-render.
  ledger?: DeliveryLedger,
): string {
  const terms = queryText ? extractQueryTerms(queryText) : [];
  // Ticket 11: the snippet window used to be the retired `truncate` char
  // param directly; it is now derived from the `turn` TOKEN budget, same
  // 4-chars-per-token conversion the browse feed's own field cuts use.
  const snippetWindow = Math.max(20, (turnBudget ?? DEFAULT_TURN_TOKEN_BUDGET) * BROWSE_CHARS_PER_TOKEN);
  // Score order (spec: "分数序替代时序"): `results` already arrived in
  // relevance order (`searchQueryResults`) — this map lets turns within a
  // session group render in THAT order (best rank first) instead of
  // `getTurnsForSession`'s chronological one. Ties keep the first (best)
  // rank a turn was seen at, across its possible turn+observation hits.
  const relevanceRank = new Map<number, number>();
  results.forEach((result, index) => {
    if (result.turnId !== null && !relevanceRank.has(result.turnId)) {
      relevanceRank.set(result.turnId, index);
    }
  });
  // Every block this render emits, in text order, with the ledger marked as
  // each one finishes (peer round P1-6) — `cursor` is the end of the joined
  // output so far, so a block's mark names exactly the prefix that contains it.
  const blocks: string[] = [];
  let cursor = 0;
  const appendBlock = (block: string, grants: readonly ReadGrantEntry[]): void => {
    if (!block) {
      return;
    }
    if (blocks.length > 0) {
      cursor += 1; // the "\n" this join will insert
    }
    blocks.push(block);
    cursor += block.length;
    ledger?.mark(cursor, grants);
  };

  // Segment hits lead: a `tag:` query returns the chapter AND its member turns
  // (spec user story 16), and the chapter is the index into the rest.
  for (const result of results) {
    if (result.layer !== "segment") {
      continue;
    }
    const line = renderSegmentSummary(db, result.sourceId, turnBudget, eraCutoffEpoch);
    if (line !== null) {
      appendBlock(line, [{ entityType: "segment", entityId: result.sourceId }]);
    }
  }

  const sessionGroups = new Map<
    number,
    {
      sessionHit: boolean;
      turnIds: Set<number>;
      observationIdsByTurnId: Map<number, number[]>;
    }
  >();
  const sessionOrder: number[] = [];

  for (const result of results) {
    if (result.layer === "segment" || result.sessionId === null) {
      continue;
    }
    const sessionId = result.sessionId;
    let group = sessionGroups.get(sessionId);
    if (!group) {
      group = {
        sessionHit: false,
        turnIds: new Set<number>(),
        observationIdsByTurnId: new Map<number, number[]>(),
      };
      sessionGroups.set(sessionId, group);
      sessionOrder.push(sessionId);
    }

    if (result.layer === "session") {
      group.sessionHit = true;
      continue;
    }

    if (result.layer === "turn" && result.turnId !== null) {
      group.turnIds.add(result.turnId);
    }

    if (result.layer === "observation" && result.turnId !== null && result.observationId !== null) {
      const observationIds = group.observationIdsByTurnId.get(result.turnId) ?? [];
      observationIds.push(result.observationId);
      group.observationIdsByTurnId.set(result.turnId, observationIds);
    }
  }

  for (const sessionId of sessionOrder) {
    const session = getSession(db, sessionId);
    const group = sessionGroups.get(sessionId);
    if (!session || !group) {
      continue;
    }
    // One session hit = one block; its own grant and the grants of the turn
    // rows nested under it share that block's end offset, so a block the
    // envelope cut in half licenses nothing at all.
    const blockGrants: ReadGrantEntry[] = [
      { entityType: "session", entityId: session.id },
    ];

    if (group.sessionHit && group.turnIds.size === 0) {
      // The session itself matched (its own title/content) with no specific
      // turn/observation hit — spec's "命中后的深入=用户用选择器自取,不做±N":
      // this renders the session's own snippet-bolded line, not every turn
      // dragged along underneath it (the old full nested render did).
      const sessionView = withBasicSearchSnippet(
        buildSessionSummary(db, session.id, eraCutoffEpoch) ??
          buildSessionView(db, session, eraCutoffEpoch),
        terms,
        snippetWindow,
        signal,
      );
      appendBlock(
        renderNode({ type: "session", value: sessionView }, { turnBudget, signal }),
        blockGrants,
      );
      continue;
    }

    // Ticket 01 (render-boilerplate-trim spec, item 2): a turn-level query
    // hit — `group.turnIds.size > 0`, the branch below the session-only-hit
    // early return above — renders this session as the ANCESTOR header over
    // its matched turn rows, not as the hit itself; `content` drops before
    // bolding so the discarded text neither costs a `boldSearchSnippet` call
    // nor spuriously marks `signal.truncated` for a window the reader never
    // sees.
    const sessionView = withBasicSearchSnippet(
      {
        ...(buildSessionSummary(db, session.id, eraCutoffEpoch) ??
          buildSessionView(db, session, eraCutoffEpoch)),
        content: null,
      },
      terms,
      snippetWindow,
      signal,
    );
    const lines = [
      renderNode(
        { type: "session", value: sessionView },
        { turnBudget, signal },
      ),
    ];
    // Score order (spec: "分数序替代时序"): turns within this session group
    // render in RELEVANCE order (best rank first), not `getTurnsForSession`'s
    // chronological one — ties (a turn with no direct relevance entry, e.g.
    // pulled in only via an observation hit) fall back to prompt order.
    const turns = getTurnsForSession(db, session.id)
      .filter(
        (turn) =>
          group.turnIds.has(turn.id) || group.observationIdsByTurnId.has(turn.id),
      )
      .sort((left, right) => {
        const leftRank = relevanceRank.get(left.id) ?? Number.POSITIVE_INFINITY;
        const rightRank = relevanceRank.get(right.id) ?? Number.POSITIVE_INFINITY;
        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }
        return left.promptNumber - right.promptNumber;
      });

    for (const turn of turns) {
      blockGrants.push({ entityType: "turn", entityId: turn.id });
      // A turn pulled in only via an observation hit (never itself a direct
      // turn-layer hit) renders at a FIXED field set regardless of what the
      // caller asked for — same "collapsed" floor the pre-ticket-11 depth
      // switch gave it; a turn that WAS itself a direct hit gets the caller's
      // own field selection. Ticket 02: that fixed set is the CONTEXT one
      // (default + `prompt`), since this row is the only thing naming a
      // note-less turn the search dragged in via one of its tool calls, and
      // the label no longer supplies the prompt for free. Computed BEFORE
      // `buildTurnView` (edge-read-surface spec, ticket 01) so a turn that
      // downgrades to that set — which never includes `relations` — never
      // pays for the relations query it will not render.
      const turnFields =
        group.observationIdsByTurnId.has(turn.id) && !group.turnIds.has(turn.id)
          ? CONTEXT_TURN_RENDER_FIELDS
          : fields;
      const turnView = withTurnSearchSnippet(
        buildTurnView(db, turn, eraCutoffEpoch, turnFields),
        terms,
        snippetWindow,
        signal,
      );

      lines.push(
        renderNode(
          { type: "turn", value: turnView },
          {
            indent: RENDER_INDENT_STEP,
            fields: turnFields,
            matchedFields: matchedTurnFields(turn, terms),
            sessionId: session.id,
            turnBudget,
            signal,
          },
        ),
      );

      const observationIds = group.observationIdsByTurnId.get(turn.id) ?? [];
      for (const observationId of observationIds) {
        const observation = getObservation(db, observationId);
        if (!observation) {
          continue;
        }

        const observationView = withBasicSearchSnippet(
          buildObservationView(observation, turn.createdAtEpoch, eraCutoffEpoch),
          terms,
          snippetWindow,
          signal,
        );
        lines.push(
          renderNode(
            { type: "observation", value: observationView },
            {
              indent: `${RENDER_INDENT_STEP}${RENDER_INDENT_STEP}`,
              sessionId: session.id,
              turnPromptNumber: turn.promptNumber,
              turnBudget,
              signal,
            },
          ),
        );
      }
    }

    appendBlock(lines.join("\n"), blockGrants);
  }

  // Ticket 08 (read-write-contract spec): the flagged gap — a `query=` render
  // used to record no read grants at all. Every segment/session/turn shown
  // above earns the reader a grant, same as the routed-id paths — as of peer
  // round P1-6 through the ledger above, once the envelope is known.
  return blocks.join("\n");
}

/**
 * Shared by both segment-member routes (ticket 10: `E<n>/T*`'s "every
 * member" and the new S/T-addressed single/range forms) — paginate
 * `wantedOrdinals` (1-based EVENT-ORDER positions, already resolved by the
 * caller) and render the chosen page. Extracted so address resolution
 * (`RoutedRecallId`-kind-specific) and pagination/rendering (identical
 * either way) do not drift into two independently-maintained copies.
 */
function renderSegmentMemberOrdinals(
  db: Database,
  segment: SegmentRecord,
  chronologicalMembers: readonly RankedSegmentMember[],
  wantedOrdinals: number[],
  fields: TurnRenderFields,
  page: number,
  pageSize: number,
  eraCutoffEpoch: number | null,
  signal: TruncationSignal | undefined,
  turnBudget: number | undefined,
  routeCheckpoint: number,
  ledger?: DeliveryLedger,
): string {
  // Paginate by MEMBER (never mid-turn by line): page the ordinal list
  // itself, so a large range (`E31/S1/T1..S1/T80`) still respects `pageSize`
  // the same way `S<n>/T*` does.
  const paged = paginateItems(wantedOrdinals, page, pageSize);

  // The member one slot BEFORE this page's first — what tells the renderer
  // whether the page opens mid-session-run (spec 补充裁决 "跨页引用自足").
  const firstOrdinal = paged.items[0];
  const precedingSessionId =
    firstOrdinal !== undefined && firstOrdinal > 1
      ? chronologicalMembers[firstOrdinal - 2]?.sessionId ?? null
      : null;

  const body = renderSegmentMembersByOrdinal(db, segment.id, paged.items, {
    fields,
    turnBudget,
    eraCutoffEpoch,
    signal,
    precedingSessionId,
  });
  // The segment itself, plus the specific member turns THIS page actually
  // shows — a reader can address those members individually via
  // `S<n>/T<m>` from here on. Marked at the END of the whole page: the
  // member renderer (`segment-card.ts`) composes its own page in one call
  // and reports no per-member boundary, so this route grants all-or-nothing
  // rather than guessing where one member's block stops (peer round P1-6 —
  // under-granting costs a re-read, over-granting licenses an unseen write).
  if (paged.items.length > 0) {
    ledger?.mark(body.length, [
      { entityType: "segment", entityId: segment.id },
      ...paged.items
        .map((ordinal) => chronologicalMembers[ordinal - 1])
        .filter((member): member is NonNullable<typeof member> => member !== undefined)
        .map((member) => ({ entityType: "turn" as const, entityId: member.turnId })),
    ]);
  }

  const header = formatPageHeader(page, paged.pageCount, paged.total);
  ledger?.shiftFrom(routeCheckpoint, pageBodyOffset(header, body, paged.pageCount));
  return joinPage(header, body, paged.pageCount);
}

function renderRoutedId(
  db: Database,
  routed: RoutedRecallId,
  fields: TurnRenderFields,
  page: number,
  pageSize: number,
  after?: number,
  before?: number,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
  pageBudget?: number,
  turnBudget?: number,
  // Ticket 04 (spec "Tools"): type/tag/file/session AND-compose with the id
  // selector — wired into the two MULTI-item listing kinds (`sessions`,
  // `turns`) alongside the pre-existing time narrowing above. A single
  // explicit-id address (turn-by-id, one segment, one observation) stays
  // filter-transparent, matching this codebase's existing rule that a
  // direct address is a question about THAT record, never a listing a
  // filter can empty out (see the segment route's own single-id comment
  // below).
  filter: ParsedMemoryFilter = {},
  // Peer round P1-6: the pending delivery ledger — who this render's grants
  // belong to, and when they are written, is the ledger's business now
  // (`undefined` for a caller with no reader identity, and on a trial render).
  // Offsets marked here are relative to THIS function's own returned string;
  // `recallMemoryBody` shifts them when it splices that string into a
  // multi-item response.
  ledger?: DeliveryLedger,
): string {
  const routeCheckpoint = ledger?.checkpoint() ?? 0;

  if (routed.kind === "sessions") {
    const paged = paginateItems(
      listSessionIds(db, routed.sessionIds, after, before, filter),
      page,
      pageSize,
    );

    // Rendered and marked in ONE pass, in text order: the completeness a
    // nested render pushes belongs to the item being rendered when it is
    // pushed, so the mark for that item has to happen before the next one
    // starts (peer round P1-6).
    const texts: string[] = [];
    let cursor = 0;
    for (const sessionId of paged.items) {
      const rendered = renderSessionDetail(
        db,
        sessionId,
        fields,
        eraCutoffEpoch,
        signal,
        turnBudget,
      );
      if (texts.length > 0) {
        cursor += 1; // the "\n" this join will insert
      }
      texts.push(rendered.text);
      cursor += rendered.text.length;
      // Peer round P2-2: the SESSION only. This route's turn rows are a
      // bounded PREVIEW of the session, not a read of those turns — ticket
      // 14's P1-2 fix granted them, and the peer round ruled that grant wider
      // than what the route delivers. A caller that means to write a turn
      // addresses it (`S<n>/T<m>`), which reads it as itself and grants it.
      ledger?.mark(cursor, [{ entityType: "session", entityId: sessionId }]);
    }

    const body = texts.join("\n");
    const header = formatPageHeader(page, paged.pageCount, paged.total);
    ledger?.shiftFrom(routeCheckpoint, pageBodyOffset(header, body, paged.pageCount));
    return joinPage(header, body, paged.pageCount);
  }

  if (routed.kind === "segments") {
    // A single explicit id (`E<n>`, not a range/wildcard): `page` is
    // reinterpreted for THIS one segment's own card — it selects between the
    // elided collapsed render (page 1) and the full, un-elided one (page 2+,
    // spec "Overflow ALWAYS paginates... stable page 2") — rather than
    // picking which of several records to show, since there is only one.
    if (routed.segmentIds && routed.segmentIds.length === 1) {
      const segmentId = routed.segmentIds[0]!;
      const card = renderSegmentCard(db, segmentId, {
        pageBudget,
        page,
        eraCutoffEpoch,
        signal,
      });
      // Peer round P2-2: an error page grants nothing. The grant used to be
      // recorded before the card was rendered, so a `recall(id="E999")` that
      // answered "Segment not found." still licensed writes to E999.
      if (getSegment(db, segmentId) !== null) {
        ledger?.mark(card.length, [{ entityType: "segment", entityId: segmentId }]);
      }
      return card;
    }

    // `E*` / `E1..9`: the OUTER pagination (page/pageSize) still selects
    // WHICH segment records appear, unchanged from before ticket 03 — each
    // one then renders its own card at (elision) page 1.
    const paged = paginateItems(
      listSegmentIds(db, routed.segmentIds),
      page,
      pageSize,
    );

    const cards: string[] = [];
    let cursor = 0;
    for (const segmentId of paged.items) {
      const card = renderSegmentCard(db, segmentId, {
        pageBudget,
        page: 1,
        eraCutoffEpoch,
        signal,
      });
      if (cards.length > 0) {
        cursor += 1;
      }
      cards.push(card);
      cursor += card.length;
      ledger?.mark(cursor, [{ entityType: "segment", entityId: segmentId }]);
    }

    const body = cards.join("\n");
    const header = formatPageHeader(page, paged.pageCount, paged.total);
    ledger?.shiftFrom(routeCheckpoint, pageBodyOffset(header, body, paged.pageCount));
    return joinPage(header, body, paged.pageCount);
  }

  if (routed.kind === "segment-members") {
    const segment = getSegment(db, routed.segmentId);
    if (!segment) {
      return "Segment not found.";
    }
    const chronologicalMembers = chronologicalSegmentMembers(db, segment, eraCutoffEpoch);
    const wantedOrdinals = chronologicalMembers.map((_member, index) => index + 1);
    return renderSegmentMemberOrdinals(
      db,
      segment,
      chronologicalMembers,
      wantedOrdinals,
      fields,
      page,
      pageSize,
      eraCutoffEpoch,
      signal,
      turnBudget,
      routeCheckpoint,
      ledger,
    );
  }

  // Ticket 10 (one-address-grammar spec): `E<n>/S<a>/T<b>` and
  // `E<n>/S<a>/T<b>..S<c>/T<d>` — both endpoints are ordinary S/T addresses,
  // resolved here (render time, database available) to their position in the
  // segment's own event order. Either endpoint missing from that order
  // refuses, naming it — an address that is not a member of this segment is
  // not silently dropped or clamped. The range then runs from the FIRST
  // endpoint through the SECOND inclusive; the two endpoints need not share
  // a session, and this is the min/max of their two ordinals, so either
  // pasting order names the same span.
  if (routed.kind === "segment-member-range") {
    const segment = getSegment(db, routed.segmentId);
    if (!segment) {
      return "Segment not found.";
    }
    const chronologicalMembers = chronologicalSegmentMembers(db, segment, eraCutoffEpoch);
    const ordinalOf = (address: { sessionId: number; promptNumber: number }): number =>
      chronologicalMembers.findIndex(
        (member) =>
          member.sessionId === address.sessionId && member.promptNumber === address.promptNumber,
      );

    const startOrdinal = ordinalOf(routed.start);
    if (startOrdinal === -1) {
      return formatParameterError(
        `S${routed.start.sessionId}/T${routed.start.promptNumber} is not a member of E${routed.segmentId}`,
      );
    }
    const endOrdinal = ordinalOf(routed.end);
    if (endOrdinal === -1) {
      return formatParameterError(
        `S${routed.end.sessionId}/T${routed.end.promptNumber} is not a member of E${routed.segmentId}`,
      );
    }

    const lower = Math.min(startOrdinal, endOrdinal);
    const upper = Math.max(startOrdinal, endOrdinal);
    const wantedOrdinals: number[] = [];
    for (let index = lower; index <= upper; index += 1) {
      wantedOrdinals.push(index + 1);
    }

    return renderSegmentMemberOrdinals(
      db,
      segment,
      chronologicalMembers,
      wantedOrdinals,
      fields,
      page,
      pageSize,
      eraCutoffEpoch,
      signal,
      turnBudget,
      routeCheckpoint,
      ledger,
    );
  }

  if (routed.kind === "turns") {
    const turns = applyTurnSelector(db, routed.sessionId, routed.promptNumbers).filter((turn) => {
      if (after !== undefined && turn.createdAtEpoch < after) {
        return false;
      }
      if (before !== undefined && turn.createdAtEpoch > before) {
        return false;
      }
      return turnMatchesFilter(turn, filter);
    });
    // Ticket 03: pageBudget can now force an earlier split than `pageSize`
    // alone — measured by trial-rendering candidate pages with `signal`
    // suppressed (`renderTurnScope` has no other side effect), then the
    // real render below (with the real `signal`) runs once against the
    // chosen page's items.
    const paged = paginateByRenderedPageCost(
      turns,
      page,
      pageSize,
      pageBudget ?? SEGMENT_CARD_DEFAULT_PAGE_BUDGET,
      (pageItems) =>
        renderTurnScope(db, pageItems, fields, eraCutoffEpoch, undefined, turnBudget),
    );
    // `renderTurnScope` marks the ledger per TURN as it renders (peer round
    // P1-6) — this route no longer records a grant for the whole page up
    // front, since half a page is exactly what the envelope can deliver.
    const body = renderTurnScope(
      db,
      paged.items,
      fields,
      eraCutoffEpoch,
      signal,
      turnBudget,
      ledger,
    );
    const header = formatPageHeader(page, paged.pageCount, paged.total);
    ledger?.shiftFrom(routeCheckpoint, pageBodyOffset(header, body, paged.pageCount));
    return joinPage(header, body, paged.pageCount);
  }

  if (routed.kind === "turn-by-id") {
    const turn = getTurnById(db, routed.turnId);
    if (!turn) {
      return "Turn not found.";
    }
    return renderTurnScope(
      db,
      [turn],
      fields,
      eraCutoffEpoch,
      signal,
      turnBudget,
      ledger,
    );
  }

  if (routed.kind === "observation-list") {
    const turn = getTurn(db, routed.sessionId, routed.promptNumber);
    if (!turn) {
      return "Turn not found.";
    }

    const observations = getExtractableObservationsForTurn(db, turn.id)
      .filter((observation) => {
        if (after !== undefined && observation.createdAtEpoch < after) {
          return false;
        }
        if (before !== undefined && observation.createdAtEpoch > before) {
          return false;
        }
        return true;
      })
      .map((observation) => ({
        sessionId: routed.sessionId,
        turnId: turn.id,
        observationId: observation.id,
      }));

    // Ticket 03: same trial-render / real-render split as the `turns` route
    // above — `renderObservationScope` has no side effect of its own to
    // suppress besides `signal`.
    const paged = paginateByRenderedPageCost(
      observations,
      page,
      pageSize,
      pageBudget ?? SEGMENT_CARD_DEFAULT_PAGE_BUDGET,
      (pageItems) =>
        renderObservationScope(db, pageItems, true, eraCutoffEpoch, undefined, turnBudget),
    );
    const body = renderObservationScope(
      db,
      paged.items,
      true,
      eraCutoffEpoch,
      signal,
      turnBudget,
    );
    // Write gate (ticket 14, P1-2 fix): the O* route's own turn/session
    // context — not the observations themselves, which carry no gated entity
    // type (spec: "O* 观察路由(其 turn/session context)"). Peer round P2-2:
    // recorded AFTER the page is rendered and only when the page actually
    // delivers rows — an out-of-range or empty page shows neither the turn
    // nor the session and grants neither.
    if (paged.items.length > 0) {
      ledger?.mark(body.length, [
        { entityType: "turn", entityId: turn.id },
        { entityType: "session", entityId: routed.sessionId },
      ]);
    }
    const header = formatPageHeader(page, paged.pageCount, paged.total);
    ledger?.shiftFrom(routeCheckpoint, pageBodyOffset(header, body, paged.pageCount));
    return joinPage(header, body, paged.pageCount);
  }

  if (routed.kind === "session-observation-list") {
    const observations = getTurnsForSession(db, routed.sessionId)
      .flatMap((turn) =>
        getExtractableObservationsForTurn(db, turn.id)
          .filter((observation) => {
            if (after !== undefined && observation.createdAtEpoch < after) {
              return false;
            }
            if (before !== undefined && observation.createdAtEpoch > before) {
              return false;
            }
            return true;
          })
          .map((observation) => ({
            sessionId: routed.sessionId,
            turnId: turn.id,
            observationId: observation.id,
          })),
      );

    // Ticket 03: same trial-render / real-render split as the other two
    // routes above.
    const paged = paginateByRenderedPageCost(
      observations,
      page,
      pageSize,
      pageBudget ?? SEGMENT_CARD_DEFAULT_PAGE_BUDGET,
      (pageItems) =>
        renderObservationScope(db, pageItems, true, eraCutoffEpoch, undefined, turnBudget),
    );
    const body = renderObservationScope(
      db,
      paged.items,
      true,
      eraCutoffEpoch,
      signal,
      turnBudget,
    );
    // Write gate (ticket 14, P1-2 fix): the session, plus exactly the turns
    // THIS page's own observation rows belong to — never every turn the
    // session has, since pagination may show only a slice of them. Peer round
    // P2-2: an empty page delivers no row and so grants nothing at all.
    if (paged.items.length > 0) {
      ledger?.mark(body.length, [
        { entityType: "session", entityId: routed.sessionId },
        ...[...new Set(paged.items.map((entry) => entry.turnId))].map((turnId) => ({
          entityType: "turn" as const,
          entityId: turnId,
        })),
      ]);
    }
    const header = formatPageHeader(page, paged.pageCount, paged.total);
    ledger?.shiftFrom(routeCheckpoint, pageBodyOffset(header, body, paged.pageCount));
    return joinPage(header, body, paged.pageCount);
  }

  if (routed.kind === "observation") {
    // Write gate (ticket 14, P1-2 fix): the observation's own owning turn/
    // session context — the observation itself has no gated entity type
    // (only segment/turn/session are managed write surfaces). Mirrors
    // `renderObservationDetail`'s own "excluded reads as not found" rule so a
    // grant is never recorded for a row the render did not actually show.
    const observation = getObservation(db, routed.observationId);
    const body = renderObservationDetail(
      db,
      routed.observationId,
      eraCutoffEpoch,
      signal,
      turnBudget,
    );
    if (observation && observation.excludedFromExtraction === 0) {
      const owningTurn = getTurnById(db, observation.turnId);
      if (owningTurn) {
        ledger?.mark(body.length, [
          { entityType: "turn", entityId: owningTurn.id },
          { entityType: "session", entityId: owningTurn.sessionId },
        ]);
      }
    }
    return body;
  }

  routed satisfies never;
  return formatParameterError(`unrecognized id kind`);
}

// ---------------------------------------------------------------------------
// Ticket 07 (read-write-contract spec, "视图(读面)"): the browse shape — bare
// `recall()` (no `id`, no `query`, no SCOPING filter — see `hasFilterCriteria`)
// renders a GLOBAL chronological turn feed instead of session-grouped
// listing. A session's title shows only on its FIRST appearance ON THE PAGE
// (spec user story 16); an alternation back to an already-shown session does
// not repeat it. `pageBudget` bounds a page by TOKENS — overflow rolls to
// another page, never truncating a shown block (spec: "溢出→分页,绝不截断整
// 块"). `turn` is the one per-field knife: word-boundary cut, its budget
// split evenly across whichever fields `filter.fields` selected (default
// title+content, mirroring the retired collapsed field-set).
// ---------------------------------------------------------------------------

const DEFAULT_BROWSE_FIELDS: readonly RecallTurnField[] = ["title", "content"];

/**
 * Bounded working set fetched before packing into pages. Not a full-corpus
 * scan: this project's own comments elsewhere size a session/segment at "a
 * few dozen or a few hundred" turns, so 500 of the MOST RECENT turns is
 * generous headroom for the browse feed's own default page. A corpus beyond
 * this cap loses turns older than the 500th most recent to the browse feed
 * specifically — they stay fully reachable by `id=`/`query=` addressing.
 */
const BROWSE_CANDIDATE_CAP = 500;

/** Approximate chars-per-token used only to size the per-field WORD-BOUNDARY cut — a guidance ratio, not the hard pageBudget ceiling that actually governs overflow. */
const BROWSE_CHARS_PER_TOKEN = 4;

function browseFieldText(
  db: Database,
  turn: TurnRecord,
  field: RecallTurnField,
): string | null {
  switch (field) {
    case "title":
      return turn.title;
    case "content":
      return turn.content;
    case "prompt":
      return turn.userPrompt;
    case "response":
      return turn.assistantResponse;
    case "insight": {
      const lines = splitInsight(turn.insight);
      return lines.length > 0 ? lines.join("; ") : null;
    }
    case "files": {
      const files = [...turn.filesRead, ...turn.filesModified];
      return files.length > 0 ? files.join(", ") : null;
    }
    case "observations": {
      const count = getExtractableObservationsForTurn(db, turn.id).length;
      return count > 0 ? `${count} observation${count === 1 ? "" : "s"}` : null;
    }
    case "relations": {
      // Edge-read-surface spec, ticket 01: same "; "-joined single-line
      // convention `insight` uses above — the browse row is one field line
      // per field, never a nested bullet list the way the unified renderer's
      // turn body can afford.
      const lines = buildTurnRelationLines(db, turn);
      return lines.length > 0 ? lines.join("; ") : null;
    }
    case "metadata":
      // No previous-turn epoch in a GLOBAL chronological feed: the unit before
      // this one is usually another session's turn, and a gap measured across
      // that boundary would be a number about nothing. The timeline's own turn
      // view, which is session-scoped, is where the gap belongs.
      return composeTurnMetadata(turn, null);
    default:
      return null;
  }
}

const BROWSE_TURN_INDENT = RENDER_INDENT_STEP;
const BROWSE_FIELD_INDENT = `${RENDER_INDENT_STEP}${RENDER_INDENT_STEP}`;

/**
 * The browse row's label (spec 金样例): the bracketed address, the turn's own
 * stored title when `title` is selected, then tail status markers. `title`
 * never renders as a field line here — it IS the row.
 *
 * Ticket 02: this row's own copy of the prompt fallback (and its `Untitled`
 * placeholder) retired with `format.ts`'s, for the same two reasons — it
 * rendered a field the caller had not selected, and it rendered it in the one
 * position the feed's per-field cut never reaches, so an oversized prompt
 * displaced the whole page's budget. A caller who wants the prompt on a
 * browse row selects `prompt`, which renders as a `- prompt:` field line
 * below, sharing the per-field character limit with every other selected
 * field.
 */
function formatBrowseTurnLabel(
  turn: TurnRecord,
  sessionId: number,
  includeSessionPrefix: boolean,
  titleText: string | null,
): string {
  const address = renderTurnAddress(turn.promptNumber, sessionId, includeSessionPrefix);
  const labelSegment = titleText ? ` ${titleText}` : "";
  const statusSegment = turn.status ? ` [${turn.status}]` : "";
  const rewindSegment = turn.wasRolledBack ? REWIND_MARKER : "";
  return `${BROWSE_TURN_INDENT}${address}${labelSegment}${statusSegment}${rewindSegment}`;
}

/**
 * One turn's field-selected render (spec: "turn = 唯一刀,词边界截断,均摊 across
 * 选中字段"). `turnBudget` (tokens) is split evenly across however many of
 * the selected fields actually produced text; each field's own cut is
 * word-boundary (`truncateText`, reused — its own limit is characters, so
 * the token budget is converted via `BROWSE_CHARS_PER_TOKEN`).
 */
function renderBrowseTurnBlock(
  db: Database,
  turn: TurnRecord,
  sessionId: number,
  fields: readonly RecallTurnField[],
  includeSessionPrefix: boolean,
  turnBudget: number | undefined,
  signal: TruncationSignal | undefined,
): string {
  const titleText = fields.includes("title") ? turn.title : null;
  if (fields.includes("title")) {
    // Ticket 04 (spec D8): never truncated on this row — it IS the label
    // (`formatBrowseTurnLabel`), rendered verbatim, never passed through
    // `truncateText` the way the field lines below are.
    pushFieldCompleteness(signal, "turn", turn.id, "title", true);
  }
  const label = formatBrowseTurnLabel(
    turn,
    sessionId,
    includeSessionPrefix,
    titleText,
  );
  // `title` never renders as a field line — it is the row label above.
  const values = fields.flatMap((field) => {
    if (field === "title") {
      return [];
    }
    const text = browseFieldText(db, turn, field);
    if (!text) {
      // Ticket 02: a selected field the turn simply has nothing stored for
      // still DELIVERED — there was nothing to cut, so it is recorded
      // complete. Without this a note-less, zero-edge turn could never earn
      // the relations gate on this surface, even though the caller selected
      // `relations` and the feed showed it everything it had. The unified
      // renderer already works this way (`recordTurnFieldCompleteness` pushes
      // for every selected gated field, text or no text) and so does `title`
      // three lines above; this is the same rule reaching the rest of them.
      if (GATED_TURN_FIELDS.includes(field)) {
        pushFieldCompleteness(signal, "turn", turn.id, field, true);
      }
      return [];
    }
    return [{ field, text }];
  });

  if (values.length === 0) {
    return label;
  }

  const perFieldCharLimit =
    turnBudget !== undefined
      ? Math.max(20, Math.floor((turnBudget * BROWSE_CHARS_PER_TOKEN) / values.length))
      : undefined;

  const fieldLines = values.map(({ field, text }) => {
    const rendered =
      perFieldCharLimit !== undefined
        ? truncateText(text, { limit: perFieldCharLimit, signal })
        : text;
    // Ticket 04 (spec D8): each field here gets its OWN `truncateText` call —
    // genuinely per-field, unlike a `renderNode` turn body's single shared
    // cut — so `rendered === text` (no cut happened) is an exact fact about
    // THIS field alone, independent of whatever happened to its neighbours.
    if (GATED_TURN_FIELDS.includes(field)) {
      pushFieldCompleteness(signal, "turn", turn.id, field, rendered === text);
    }
    // Ticket 10: `type`/`tags` ride inside this SAME `metadata` text — they
    // have no `RecallTurnField` slot of their own (see
    // `composeTurnMetadata`) — so their completeness fact is metadata's own
    // per-field truncation outcome, recorded under their own field names.
    if (field === "metadata") {
      const metadataComplete = rendered === text;
      pushFieldCompleteness(signal, "turn", turn.id, "type", metadataComplete);
      pushFieldCompleteness(signal, "turn", turn.id, "tags", metadataComplete);
    }
    // `metadata` is the one unprefixed field line (spec 金样例 补充): it
    // annotates the row above rather than naming a stored field.
    return field === "metadata"
      ? `${BROWSE_FIELD_INDENT}${rendered}`
      : `${BROWSE_FIELD_INDENT}- ${field}: ${rendered}`;
  });

  return [label, ...fieldLines].join("\n");
}

function renderBrowseSessionHeader(
  session: NonNullable<ReturnType<typeof getSession>>,
  withTitle: boolean,
): string {
  return renderSessionTransitionLine(session.id, withTitle ? session.title : null);
}

/**
 * One browsable unit: a turn (the common case) or a SESSION WITH NO TURNS AT
 * ALL YET (a freshly created session that has not produced a turn). Without
 * this second kind, a turn-only feed would silently drop such a session from
 * discoverability entirely — the pre-ticket-07 session-grouped listing
 * always showed every session's own line regardless of turn count, and bare
 * `recall()` must keep that guarantee.
 */
type BrowseUnit =
  | { kind: "turn"; epoch: number; turn: TurnRecord }
  | { kind: "session"; epoch: number; session: NonNullable<ReturnType<typeof getSession>> };

interface BrowsePackedUnit {
  unit: BrowseUnit;
  rendered: string;
}

function browseUnitSessionId(unit: BrowseUnit): number {
  return unit.kind === "turn" ? unit.turn.sessionId : unit.session.id;
}

interface PagePackEntry<T> {
  item: T;
  rendered: string;
}

/**
 * Greedy token-budget page packer (ticket 03): consecutive items fill a
 * page until either `pageSize` items or `budgetTokens` tokens is reached,
 * whichever comes first — a page always holds at least one item, so a
 * single oversized item cannot stall pagination. `render(item, atPageTop)`
 * renders an item KNOWING whether it opens a fresh page, which is what lets
 * a caller give the opening row of a page its self-contained form (spec 补充
 * 裁决 "跨页引用自足") instead of a form that assumes the previous item is
 * still on screen. `onPageStart` resets any page-scoped render state (e.g.
 * "have we shown this session's title yet in THIS page") between pages;
 * `onItemPacked` runs exactly once per item, after it lands on a page
 * (never twice, even though `render` itself may run twice for an item that
 * turns out to open a new page).
 *
 * Extracted from `buildBrowseFeed`'s own inline loop — the ONE packing
 * mechanism this file has (ticket 03 pinned decision: "no second packing
 * algorithm"); `buildBrowseFeed` below is this function's first caller, not
 * a parallel implementation of the same rule.
 */
function packPagesByTokenBudget<T>(
  items: readonly T[],
  pageSize: number,
  budgetTokens: number,
  render: (item: T, atPageTop: boolean) => string,
  onPageStart: () => void,
  onItemPacked: (item: T) => void,
): PagePackEntry<T>[][] {
  const pages: PagePackEntry<T>[][] = [];
  let current: PagePackEntry<T>[] = [];
  let used = 0;

  for (const item of items) {
    let rendered = render(item, current.length === 0);
    let cost = estimateTokens(rendered);
    const overflowsCount = current.length >= pageSize;
    const overflowsBudget = current.length > 0 && used + cost > budgetTokens;

    if (current.length > 0 && (overflowsCount || overflowsBudget)) {
      pages.push(current);
      current = [];
      used = 0;
      onPageStart();
      rendered = render(item, true);
      cost = estimateTokens(rendered);
    }

    current.push({ item, rendered });
    used += cost;
    onItemPacked(item);
  }
  if (current.length > 0 || pages.length === 0) {
    pages.push(current);
  }
  return pages;
}

/**
 * Builds and paginates the global chronological feed. Greedy token-budget
 * packing (same shape as `timeline.ts`'s `paginateByTokenBudget`):
 * consecutive units (most-recent first) fill a page until either `pageSize`
 * items or `pageBudget` tokens is reached, whichever comes first — a page
 * always holds at least one item, so a single oversized turn cannot stall
 * pagination. Every packed page independently tracks its own
 * first-appearance set, which is what makes "session title on first
 * appearance, not repeated on alternation" a per-PAGE fact.
 */
function buildBrowseFeed(
  db: Database,
  page: number,
  pageSize: number,
  pageBudget: number,
  turnBudget: number | undefined,
  fields: readonly RecallTurnField[] | undefined,
  signal: TruncationSignal | undefined,
  // Peer round P1-6: the pending delivery ledger, replacing the
  // readerId/now/sequence trio this feed used to record grants with directly.
  ledger: DeliveryLedger | undefined,
): string {
  const turnIdRows = db
    .query<{ id: number }, [number]>(
      `SELECT id FROM turns ORDER BY created_at_epoch DESC, id DESC LIMIT ?`,
    )
    .all(BROWSE_CANDIDATE_CAP);
  const turnUnits: BrowseUnit[] = turnIdRows
    .map((row) => getTurnById(db, row.id))
    .filter((turn): turn is TurnRecord => turn !== null)
    .map((turn) => ({ kind: "turn", epoch: turn.createdAtEpoch, turn }));

  // Sessions with no turn at all yet — kept as their own browse unit so
  // discoverability matches the pre-ticket-07 listing exactly.
  const emptySessionRows = db
    .query<{ id: number; createdAtEpoch: number }, [number]>(
      `SELECT id, created_at_epoch AS createdAtEpoch FROM sessions
       WHERE id NOT IN (SELECT DISTINCT session_id FROM turns)
       ORDER BY created_at_epoch DESC LIMIT ?`,
    )
    .all(BROWSE_CANDIDATE_CAP);
  const sessionCache = new Map<number, ReturnType<typeof getSession>>();
  const sessionFor = (sessionId: number) => {
    if (!sessionCache.has(sessionId)) {
      sessionCache.set(sessionId, getSession(db, sessionId));
    }
    return sessionCache.get(sessionId) ?? null;
  };
  const emptySessionUnits: BrowseUnit[] = emptySessionRows.flatMap((row) => {
    const session = sessionFor(row.id);
    return session ? [{ kind: "session" as const, epoch: row.createdAtEpoch, session }] : [];
  });

  const units = [...turnUnits, ...emptySessionUnits].sort((left, right) => {
    if (left.epoch !== right.epoch) {
      return right.epoch - left.epoch;
    }
    return browseUnitSessionId(right) - browseUnitSessionId(left);
  });

  if (units.length === 0) {
    return joinPage(formatPageHeader(1, 1, 0), "", 1);
  }

  const resolvedFields = fields && fields.length > 0 ? fields : DEFAULT_BROWSE_FIELDS;

  /**
   * `carriedSessionId` is the session the PREVIOUS page ended inside. When
   * this page's first unit belongs to it, the run continues across the page
   * break: no transition line is repeated, and the row carries the full
   * `[S<n>][T<m>]` address instead, so the page stays self-contained for a
   * citation join (spec 补充裁决 "跨页引用自足").
   */
  /**
   * A transition line is emitted on every session CHANGE, carrying the title
   * only on that session's FIRST appearance in the page (spec 金样例) — an
   * alternation back to a session already shown gets a bare `[S<n>]`, which is
   * what keeps the reader's "whose turn is this" answer on-screen without
   * paying for the title twice.
   *
   * `runSessionId` is the session the previous unit belonged to; at the top of
   * a page it is the session the PREVIOUS PAGE ended inside, so a run that
   * spans the page break repeats no transition line and instead gives the
   * opening row the full `[S<n>][T<m>]` address (spec 补充裁决 "跨页引用自足").
   */
  // Peer round P1-6: each row's OWN per-field completeness, captured as it is
  // rendered. `packPagesByTokenBudget` renders every unit of every page (some
  // twice) before this function knows which page it returns, so the ledger's
  // ordinary "everything pushed since the last mark" rule cannot attribute
  // these — a row is keyed to its slice here and the ledger is handed the
  // slice explicitly below. A row rendered twice overwrites its own entry with
  // the second (kept) render's slice, which is the one whose text ships.
  const completenessByUnit = new Map<BrowseUnit, FieldCompletenessEntry[]>();

  const renderForPage = (
    unit: BrowseUnit,
    seenSessions: ReadonlySet<number>,
    runSessionId: number | null,
    atPageTop: boolean,
  ): string => {
    const completenessBefore = signal?.fieldCompleteness?.length ?? 0;
    const rendered = renderForPageBody(unit, seenSessions, runSessionId, atPageTop);
    completenessByUnit.set(
      unit,
      (signal?.fieldCompleteness ?? []).slice(completenessBefore),
    );
    return rendered;
  };

  const renderForPageBody = (
    unit: BrowseUnit,
    seenSessions: ReadonlySet<number>,
    runSessionId: number | null,
    atPageTop: boolean,
  ): string => {
    const sessionId = browseUnitSessionId(unit);
    const continuesRun = runSessionId === sessionId;
    const header = continuesRun
      ? null
      : renderBrowseSessionHeader(
          unit.kind === "session" ? unit.session : sessionFor(sessionId)!,
          !seenSessions.has(sessionId),
        );
    if (unit.kind === "session") {
      // The transition line IS the whole render for a turnless session — there
      // is no turn body to show.
      return header ?? "";
    }
    const session = sessionFor(unit.turn.sessionId);
    if (!session) {
      return "";
    }
    const block = renderBrowseTurnBlock(
      db,
      unit.turn,
      session.id,
      resolvedFields,
      continuesRun && atPageTop,
      turnBudget,
      signal,
    );
    return header === null ? block : `${header}\n${block}`;
  };

  const validUnits = units.filter(
    (unit) => !(unit.kind === "turn" && !sessionFor(unit.turn.sessionId)),
  );

  let seenInPage = new Set<number>();
  let runSessionId: number | null = null;
  const feedCheckpoint = ledger?.checkpoint() ?? 0;

  // Ticket 03: the packing LOOP itself now lives in `packPagesByTokenBudget`
  // (extracted, byte-identical behavior) — this closure supplies only the
  // browse-specific per-page render state (`seenInPage`, `runSessionId`)
  // that decides title-on-first-appearance and the cross-page citation
  // escape.
  const packed = packPagesByTokenBudget(
    validUnits,
    pageSize,
    pageBudget,
    (unit, atPageTop) => renderForPage(unit, seenInPage, runSessionId, atPageTop),
    () => {
      seenInPage = new Set();
    },
    (unit) => {
      seenInPage.add(browseUnitSessionId(unit));
      runSessionId = browseUnitSessionId(unit);
    },
  );

  const pages: BrowsePackedUnit[][] = packed.map((pageEntries) =>
    pageEntries.map(({ item, rendered }) => ({ unit: item, rendered })),
  );

  const pageCount = pages.length;
  const clampedPage = Math.min(Math.max(1, page), pageCount);
  const pageItems = pages[clampedPage - 1] ?? [];

  // Peer round P1-6: one mark per browse ROW, at that row's own end offset —
  // the feed already renders each unit into its own string, so this is the
  // finest attribution any route in this file can offer, and a page the
  // envelope cuts mid-feed keeps exactly the rows that arrived whole.
  //
  // Packing pushed every page's completeness into the signal; those entries
  // are already captured per row in `completenessByUnit`, so they are dropped
  // here rather than swept into the first row's mark below.
  ledger?.discardPending();
  const grantedSessions = new Set<number>();
  const renderedRows: string[] = [];
  let cursor = 0;
  for (const item of pageItems) {
    if (!item.rendered) {
      continue;
    }
    if (renderedRows.length > 0) {
      cursor += 1;
    }
    renderedRows.push(item.rendered);
    cursor += item.rendered.length;
    const sessionId = browseUnitSessionId(item.unit);
    const grants: ReadGrantEntry[] = [];
    if (item.unit.kind === "turn") {
      grants.push({ entityType: "turn", entityId: item.unit.turn.id });
    }
    if (!grantedSessions.has(sessionId)) {
      grantedSessions.add(sessionId);
      grants.push({ entityType: "session", entityId: sessionId });
    }
    ledger?.markWith(cursor, grants, completenessByUnit.get(item.unit) ?? []);
  }

  const body = renderedRows.join("\n");
  const header = formatPageHeader(clampedPage, pageCount, units.length);
  ledger?.shiftFrom(feedCheckpoint, pageBodyOffset(header, body, pageCount));
  return joinPage(header, body, pageCount);
}

/**
 * Bare `recall()` — no `id`, no `query` (ticket 03, spec user story 18):
 * segments lead, the browse turn feed follows. Segments are recency-ordered
 * by last member-or-state edit (`listSegmentsByActivity`, ADR-0005's roster
 * rule) and bounded by `pageSize`, same as the roster is budget-truncated;
 * the section only appears on page 1 — later pages are pure browse-feed
 * pagination, so a caller paging through turns never sees the segments
 * header repeat.
 *
 * Ticket 07 (read-write-contract spec): the sessions section retired in
 * favour of `buildBrowseFeed`'s global chronological turn feed — see that
 * function's own doc comment.
 */
function renderBareOverview(
  db: Database,
  page: number,
  pageSize: number,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
  pageBudget?: number,
  turnBudget?: number,
  // Ticket 04: the segments section above is ticket 02/03/05 territory and
  // stays unfiltered — bare `recall()`'s roster-first behavior is unchanged.
  // Reached here only with no SCOPING criterion set (`hasFilterCriteria`
  // gates the caller before this function runs) — `filter.fields` is the
  // only member that can legitimately be set.
  filter: ParsedMemoryFilter = {},
  // Peer round P1-6: the pending delivery ledger (see `renderRoutedId`).
  ledger?: DeliveryLedger,
): string {
  const parts: string[] = [];
  // Character position of the end of `parts` so far, in the joined result.
  let cursor = 0;
  const appendPart = (part: string): void => {
    if (parts.length > 0) {
      cursor += 1; // the "\n" this join will insert
    }
    parts.push(part);
    cursor += part.length;
  };

  if (page === 1) {
    const segments = listSegmentsByActivity(db, pageSize);
    if (segments.length > 0) {
      appendPart(`── segments (${segments.length}) ──`);
      for (const segment of segments) {
        appendPart(
          renderSegmentCard(db, segment.id, {
            pageBudget,
            page: 1,
            eraCutoffEpoch,
            signal,
          }),
        );
        // Peer round P1-6: the grant follows the card it belongs to, at that
        // card's own end offset — it used to be recorded BEFORE the card
        // rendered, so a roster the envelope cut still licensed every segment
        // on it.
        ledger?.mark(cursor, [{ entityType: "segment", entityId: segment.id }]);
      }
    }
  }

  appendPart(`── turns ──`);
  const feedCheckpoint = ledger?.checkpoint() ?? 0;
  const feedBase = cursor + 1; // the "\n" between the header line and the feed
  const feed = buildBrowseFeed(
    db,
    page,
    pageSize,
    pageBudget ?? SEGMENT_CARD_DEFAULT_PAGE_BUDGET,
    turnBudget,
    filter.fields,
    signal,
    ledger,
  );
  ledger?.shiftFrom(feedCheckpoint, feedBase);
  appendPart(feed);

  return parts.join("\n");
}

// Ticket 04 (spec "Tools"): `query` is pure FTS text now (the prefix dialect
// is cut, not aliased); every non-text criterion comes from the structured
// `filter` object instead. `project` is deliberately absent — it left the
// grammar along with the rest of the old dialect.
function searchQueryResults(
  db: Database,
  text: string | undefined,
  filter: ParsedMemoryFilter,
  eraCutoffEpoch: number | null = null,
): SearchMemoryResult[] {
  return searchMemory(db, {
    query: text,
    type: filter.type,
    file: filter.file,
    tag: filter.tag,
    sessionId: filter.sessionId,
    after: filter.after,
    before: filter.before,
    // Only the observation layer reads this, and only to decide whether a
    // status still means anything (db/search.ts).
    eraCutoffEpoch,
    // A segment is not bound to a session (spec D6), so it legitimately carries
    // a null `sessionId`; only session-layer rows that lost their session are
    // dropped here.
  }).filter((r) => r.layer === "segment" || r.sessionId !== null);
}

/**
 * A rendered response plus the authorization it has NOT yet been given (peer
 * round P1-6). `text` is the whole render; `commit` writes the read grants and
 * completeness records for however much of it the caller's own envelope
 * actually delivers.
 *
 * Two callers, two envelopes: the main agent's tool result is the render
 * verbatim (`commitDelivered(text.length)`, what `recallMemory` does for every
 * caller that has no envelope of its own), and the worker channel's is a
 * private-tag-stripped 100K slice (`mcp/handlers.ts`). Nothing else may
 * commit — a caller that renders and never calls this simply grants nothing,
 * which is the honest reading of "these bytes never reached a reader".
 */
export interface RecallDelivery {
  text: string;
  /**
   * `deliveredChars` is measured in `text`'s OWN coordinates. A caller whose
   * envelope also removes characters (private-tag stripping) passes the length
   * of what it delivered rather than trying to map back through the removal:
   * deletions only ever shrink, so the delivered prefix of the stripped text is
   * a prefix of at-least-that-many characters of `text`. The error is therefore
   * one-directional — a block may be judged undelivered when it in fact
   * arrived, never the reverse — and under-granting costs a re-read while
   * over-granting licenses a write over bytes nobody saw.
   */
  commitDelivered(deliveredChars: number): void;
}

// Response-scoped: one signal per call, threaded through every render helper
// below it, so "was anything truncated" is a fact about the WHOLE response
// (spec D1) rather than something each render site has to decide on its own.
export function recallMemory(db: Database, input: RecallInput): string {
  const delivery = recallMemoryDelivery(db, input);
  delivery.commitDelivered(delivery.text.length);
  return delivery.text;
}

export function recallMemoryDelivery(db: Database, input: RecallInput): RecallDelivery {
  const signal = createTruncationSignal();
  // Ticket 04 (spec D8) / ticket 14 (P1-3 fix): ONE pre-render snapshot for
  // the whole pass, taken before a single row is read — every grant and every
  // completeness record this call eventually commits carries it, so a foreign
  // write landing between render and commit cannot make either look fresher
  // than what the render actually showed.
  const sequence = snapshotWriteGateSequence(db);
  // No reader identity = nothing to attribute, so nothing is collected either
  // (the same latitude every render call site already gave `readerId`).
  const ledger = input.readerId ? new DeliveryLedger(signal) : undefined;
  const body = recallMemoryBody(db, input, signal, ledger);
  // Anything the routes did not claim belongs to the response's very end: it
  // survives only when the envelope cut nothing at all.
  ledger?.sealAt(body.length);
  // The legend appends BELOW the body, so every offset above still names the
  // same character in the returned text.
  const text = appendNavigationLegend(body, signal);
  const readerId = input.readerId;
  return {
    text,
    commitDelivered: (deliveredChars: number): void => {
      if (!ledger || !readerId) {
        return;
      }
      const now = input.now ?? (() => Math.floor(Date.now() / 1000));
      ledger.commit(db, readerId, deliveredChars, now(), sequence);
    },
  };
}

function recallMemoryBody(
  db: Database,
  input: RecallInput,
  signal: TruncationSignal,
  ledger?: DeliveryLedger,
): string {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = input.pageSize ?? 10;
  const eraCutoffEpoch = input.eraCutoffEpoch ?? null;
  const pageBudget = input.pageBudget ?? SEGMENT_CARD_DEFAULT_PAGE_BUDGET;
  // Ticket 11: no more depth-dependent default — every render always has a
  // finite per-item token budget (spec: "obs 恒截断，由 turn 预算驱动",
  // generalized to every node kind). A caller's explicit `turn` always wins.
  const turnBudget = input.turn ?? DEFAULT_TURN_TOKEN_BUDGET;
  // Ticket 11: `filter.fields` is the SOLE field-selection mechanism — no
  // more depth-driven default field set.
  const fields = resolveTurnFields(input.filter?.fields);
  // Ticket 04: the ONE structured filter, AND-composed with `id`, and (below)
  // with `query`. Replaces the retired top-level `time` param and the
  // in-query prefix dialect alike.
  const { parsed: filter, error: filterError } = parseMemoryFilter(input.filter);

  if (filterError) {
    return formatParameterError(filterError);
  }

  if (input.id) {
    // Ticket 14 (spec "选择器多选"): `id="E31, E32"` — a comma-separated
    // list, each item parsed by the EXISTING grammar above, rendered in
    // order, sharing this call's own page/turn budgets. A single item (the
    // overwhelmingly common case, and every pre-ticket-14 caller) takes the
    // untouched single-item path below unchanged.
    const idItems = input.id
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (idItems.length <= 1) {
      // Ticket 10: checked BEFORE `parseRoutedId` so the retired ordinal
      // form gets a refusal naming the new grammar rather than falling
      // through to `parseRoutedId`'s own generic "invalid id selector"
      // message, which names nothing a caller could act on.
      const retiredOrdinal = retiredSegmentOrdinalRefusal(input.id.trim());
      if (retiredOrdinal) {
        return formatParameterError(retiredOrdinal);
      }
      const routed = parseRoutedId(input.id.trim());
      if (!routed) {
        return formatParameterError(`invalid id selector "${input.id}"`);
      }

      return renderRoutedId(
        db,
        routed,
        fields,
        page,
        pageSize,
        filter.after,
        filter.before,
        eraCutoffEpoch,
        signal,
        pageBudget,
        turnBudget,
        filter,
        ledger,
      );
    }

    const routedItems: RoutedRecallId[] = [];
    for (const item of idItems) {
      const retiredOrdinal = retiredSegmentOrdinalRefusal(item);
      if (retiredOrdinal) {
        return formatParameterError(`${retiredOrdinal} (in comma list "${input.id}")`);
      }
      const routed = parseRoutedId(item);
      if (!routed) {
        return formatParameterError(
          `invalid id selector "${item}" in comma list "${input.id}" — ${ID_SELECTOR_GRAMMAR_HINT}`,
        );
      }
      routedItems.push(routed);
    }

    const firstKind = routedItems[0]!.kind;
    if (routedItems.some((routed) => routed.kind !== firstKind)) {
      return formatParameterError(
        `mixed id kinds in comma list "${input.id}" — ${ID_SELECTOR_GRAMMAR_HINT}`,
      );
    }

    // Rendered in order, each item's ledger offsets shifted by where its own
    // text lands in the joined response (peer round P1-6).
    const itemTexts: string[] = [];
    let cursor = 0;
    for (const routed of routedItems) {
      const itemCheckpoint = ledger?.checkpoint() ?? 0;
      const itemText = renderRoutedId(
        db,
        routed,
        fields,
        page,
        pageSize,
        filter.after,
        filter.before,
        eraCutoffEpoch,
        signal,
        pageBudget,
        turnBudget,
        filter,
        ledger,
      );
      if (itemTexts.length > 0) {
        cursor += 2; // the "\n\n" this join will insert
      }
      ledger?.shiftFrom(itemCheckpoint, cursor);
      itemTexts.push(itemText);
      cursor += itemText.length;
    }
    return itemTexts.join("\n\n");
  }

  // Ticket 04: a `filter` alone (no `query`) also runs the search/listing
  // path rather than falling through to the bare roster — mirrors the old
  // in-query dialect's own behavior, where a filter-only string (e.g. the
  // retired `type:discovery`) never fell back to an unfiltered overview.
  if (input.query || hasFilterCriteria(filter)) {
    // Ticket 04: `query` is pure FTS text — no in-string dialect. A query
    // containing `tag:foo` searches those literal characters; scoping comes
    // from `filter` alone now.
    const text = (input.query ?? "").trim();

    // A non-empty query that parses to nothing actionable (pure whitespace,
    // no filter member set) would otherwise silently run an unfiltered
    // search and surface recent sessions as if they matched. Reject it so an
    // empty-looking query reads as an error, not a false hit. A filter
    // member alone (no text) still counts as a criterion.
    const hasCriteria = text.length > 0 || hasFilterCriteria(filter);

    if (!hasCriteria) {
      return formatParameterError(
        `query "${input.query}" has no searchable terms or filters`,
      );
    }

    const results = searchQueryResults(
      db,
      text || undefined,
      filter,
      input.eraCutoffEpoch ?? null,
    );
    // Ticket 03: pageBudget can now force an earlier split than `pageSize`
    // alone — measured by trial-rendering candidate slices of `results`
    // with grant recording AND `signal` suppressed (`readerId: null`,
    // `signal: undefined`), since `renderGroupedSearchResults` records a
    // read grant for everything it renders and must never do so twice for
    // the same entity across trial passes. The real render below (with the
    // real `readerId`/`signal`) runs once against the chosen page's items.
    const paged = paginateByRenderedPageCost(results, page, pageSize, pageBudget, (pageItems) =>
      renderGroupedSearchResults(
        db,
        pageItems,
        fields,
        turnBudget,
        eraCutoffEpoch,
        undefined,
        text || undefined,
        undefined,
      ),
    );

    const searchCheckpoint = ledger?.checkpoint() ?? 0;
    const body = renderGroupedSearchResults(
      db,
      paged.items,
      fields,
      turnBudget,
      eraCutoffEpoch,
      signal,
      text || undefined,
      ledger,
    );
    const header = formatPageHeader(page, paged.pageCount, paged.total);
    ledger?.shiftFrom(searchCheckpoint, pageBodyOffset(header, body, paged.pageCount));
    return joinPage(header, body, paged.pageCount);
  }

  return renderBareOverview(
    db,
    page,
    pageSize,
    eraCutoffEpoch,
    signal,
    pageBudget,
    turnBudget,
    filter,
    ledger,
  );
}

// ---------------------------------------------------------------------------
// Ticket 14 (read-write-contract spec, "roster 重建"): the SessionStart
// roster as a unified-renderer segment listing in its own right — the
// bespoke topic-grouped composer this replaces lived in
// hooks/session-composition.ts; this lives HERE because its own render pass
// now goes through the identical recordReadGrants/snapshotWriteGateSequence
// seam every other route in this file uses, rather than a second,
// independently-hand-kept grant recording site. Retires: topic grouping
// headers, the type facet glyph, the 40-segment cap (pagination replaces
// it), and character-cap title truncation (the item TOKEN budget's own
// word-boundary cut replaces it).
//
// lane-model-v12 ticket 18 (ruling [S15069/T1670]) makes this block the
// injection's ONE vocabulary surface: every tag a session may write appears
// here and nowhere else — one segment tag per row (the segment's own name,
// leading the row), and under the ATTACHED row, that segment's declared lanes.
// The segment card gave up its `- lanes:` row for it, on a measured budget
// asymmetry: the card renders 1972 of a 2000-token budget while this block
// renders 289 in a slot of roughly 2400, and the card — unlike this block —
// demotes to 500 tokens under SessionStart size pressure, which is the one
// moment a writer most needs the words the gate will judge it against.
// ---------------------------------------------------------------------------

/**
 * Item budget for a roster row — the tag, the id, and as much title as fits.
 *
 * Lowered from 100 (read-write-contract ticket 14) by lane-model-v12 ticket
 * 18, and the two halves of that ticket's first requirement are one mechanism:
 * the tag LEADS the row, so the knife eats the TITLE. Under the row's previous
 * shape (`E<id> <title> — #tag`) a long title pushed the tag past the knife —
 * the roster would spend its budget on prose and then cut the one word a
 * writer came for. Tag-first inverts that, which is what lets the row carry
 * MORE (a lane vocabulary) for LESS than the row it replaces.
 *
 * 16 tokens ≈ 64 characters via `BROWSE_CHARS_PER_TOKEN`. MEASURED against the
 * ten live standing containers: their titles run 63–140 characters and every
 * one of them is `<name> standing container: <blurb>` or `<subject>: <blurb>`
 * — the discriminating phrase is the leading one, and 64 characters of row
 * clears it on all ten. The row answers "does this turn belong here", not
 * "what is this segment about"; the card answers the second, one
 * `recall(id="E<n>")` away.
 */
export const DEFAULT_ROSTER_ITEM_BUDGET_TOKENS = 16;
/** Page budget (spec: "page 2000 tok"). */
export const DEFAULT_ROSTER_PAGE_BUDGET_TOKENS = 2_000;
/** Pagination here is TOKEN-driven, not count-driven — every live segment has to be fetched up front to pack pages correctly, so this is a generous headroom cap, not a display limit (mirrors `BROWSE_CANDIDATE_CAP`'s own role). */
const ROSTER_CANDIDATE_CAP = 500;

export interface SegmentRosterFeedOptions {
  /** 1-indexed; default 1 (spec: "分页默认展示第一页" — SessionStart always injects page 1). */
  page?: number;
  pageBudget?: number;
  itemBudget?: number;
  /**
   * Ticket 02's segment-era freeze. `undefined` (every production caller)
   * applies `SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH` — a pre-redesign legacy
   * arc-segment never reaches the roster; an explicit `null` is era-blind
   * (status-only), for tests probing other roster properties.
   */
  segmentEraCutoffEpoch?: number | null;
  /** Segments attached to the CURRENT session but past the SessionStart block-slot pool — annotated with a recall pointer instead of a full block (spec: "挂靠溢出指路行为保留", equivalent wording). */
  overflowAttachedSegmentIds?: ReadonlySet<number>;
  /**
   * Segments attached to the CURRENT session — a SUPERSET of
   * `overflowAttachedSegmentIds` (lane-model-v12 ticket 18). Each of these
   * expands one extra line naming its declared lane vocabulary; an unattached
   * segment never does. Empty/absent means no session context (a direct call,
   * or a SessionStart with nothing attached yet) and no row expands.
   */
  attachedSegmentIds?: ReadonlySet<number>;
  readerId?: string | null;
  now?: () => number;
}

/**
 * The word a roster row leads with when nobody has named the segment yet — the
 * same word the card header prints for the same state, deliberately WITHOUT
 * the `#`: nine of the ten live standing containers are unnamed today (a
 * container's tag is a name a human picks, lane-model-v12 ticket 14), and a
 * `#(unnamed)` in the leading column would put a word in the writable position
 * that the write gate rejects on sight.
 */
const UNNAMED_SEGMENT_LEAD = "(unnamed)";

/**
 * One roster row: `- #<tag> E<id> <title>`, word-boundary cut to the item's own
 * token budget — the writable tag FIRST (lane-model-v12 ticket 18; see
 * `DEFAULT_ROSTER_ITEM_BUDGET_TOKENS` for why that ordering is the saving),
 * then the id, then as much title as the budget leaves.
 *
 * Two things are appended AFTER the knife, never inside it:
 *
 * - the overflow pointer, because it is a navigation instruction rather than
 *   content — a cut one reads as a broken `recall(id=...)` call;
 * - `laneTags`, the attached segment's lane vocabulary, as one indented
 *   `- lanes:` line of bare tags. NO degradation ladder, deliberately (ruling
 *   [S15069/T1667]): a vocabulary that does not fit is the symptom of lane
 *   proliferation, and truncating it would hide exactly the count that says so
 *   while handing a writer a vocabulary the gate judges it against but the
 *   roster did not finish showing. Overflow paginates instead — the packer
 *   below already keeps every page at one item minimum, so the line always
 *   renders whole somewhere.
 */
function renderRosterLine(
  segment: Pick<SegmentRecord, "id" | "title" | "tags">,
  itemBudgetTokens: number,
  overflow: ReadonlySet<number>,
  laneTags: readonly string[],
): string {
  const tag = segmentTagOf(segment);
  const lead = tag ? `#${tag}` : UNNAMED_SEGMENT_LEAD;
  const charLimit = Math.max(20, itemBudgetTokens * BROWSE_CHARS_PER_TOKEN);
  const head = truncateText(`- ${lead} E${segment.id} ${segment.title}`, { limit: charLimit });
  const attachedNote = overflow.has(segment.id)
    ? ` (attached, not rendered here — recall(id="E${segment.id}"))`
    : "";
  // Shared with both attach receipts (`mcp/lane-vocabulary.ts`, peer review
  // A4): the row and the receipt render the SAME word list, so a session that
  // attaches mid-conversation and one that reads the roster at SessionStart are
  // looking at one vocabulary, not two spellings of it.
  const vocabulary = formatLaneVocabularyLine(laneTags);
  const laneLine = vocabulary === null ? "" : `\n  ${vocabulary}`;
  return `${head}${attachedNote}${laneLine}`;
}

/**
 * The SessionStart roster block (ticket 14): live segments, activity-recency
 * ordered (`listLiveSegmentsByActivity`, unchanged ordering rule), each row
 * `#tag E<id> <short title>`, packed into pages by a TOKEN page budget (never
 * a segment-count cap) — a page always holds at least one item, so a single
 * oversized row cannot stall pagination. Records a read grant for every
 * segment the returned page actually shows, under its OWN pre-render
 * sequence snapshot (ticket 14, P1-3 fix) — this is its own independent
 * render pass, not nested inside another one.
 *
 * lane-model-v12 ticket 18: an ATTACHED segment (`attachedSegmentIds`) adds
 * one indented `- lanes:` line of bare tags — its declared lane vocabulary,
 * read from the `lanes` registry, in the registry's own alphabetical order
 * (this is a word LIST to pick from, not an activity feed; the card's retired
 * row sorted newest-first because it carried addresses, and this one does
 * not). Lane tags are segment-scoped, so only the attached segment's own lanes
 * ever appear on its row.
 */
export function renderSegmentRosterFeed(
  db: Database,
  options: SegmentRosterFeedOptions = {},
): string {
  const page = Math.max(1, options.page ?? 1);
  const pageBudget = options.pageBudget ?? DEFAULT_ROSTER_PAGE_BUDGET_TOKENS;
  const itemBudget = options.itemBudget ?? DEFAULT_ROSTER_ITEM_BUDGET_TOKENS;
  const segmentEraCutoffEpoch =
    options.segmentEraCutoffEpoch === undefined
      ? SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH
      : options.segmentEraCutoffEpoch;
  const overflow = options.overflowAttachedSegmentIds ?? new Set<number>();
  const attached = options.attachedSegmentIds ?? new Set<number>();
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  // P1-3 discipline (peer round 2): the grant sequence is snapshotted at
  // render START, before ANY segment row is read — a foreign stamp landing
  // between these reads and the record call below must leave the grant
  // looking older than it, never fresher.
  const renderStartSequence = snapshotWriteGateSequence(db);

  const totalLive = countLiveSegments(db, segmentEraCutoffEpoch);
  const candidates = listLiveSegmentsByActivity(db, ROSTER_CANDIDATE_CAP, segmentEraCutoffEpoch);
  const header = `## Segment roster (${totalLive} live)`;

  if (candidates.length === 0) {
    return `${header}\n(no live segments yet — remember(create) mints one)`;
  }

  // Only the ATTACHED segments pay for a lane lookup — an unattached row never
  // expands, so the common roster (nothing attached, or one attachment out of
  // ten) costs exactly the queries it did before this ticket.
  const rendered = candidates.map((entry) => ({
    segmentId: entry.id,
    text: renderRosterLine(
      entry,
      itemBudget,
      overflow,
      attached.has(entry.id) ? listLanesForSegment(db, entry.id).map((lane) => lane.tag) : [],
    ),
  }));

  // Greedy token-budget packing into pages — same shape as `buildBrowseFeed`'s
  // own packer above.
  const pages: (typeof rendered)[] = [];
  let current: typeof rendered = [];
  let used = 0;
  for (const item of rendered) {
    const cost = estimateTokens(item.text) + 1;
    if (current.length > 0 && used + cost > pageBudget) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += cost;
  }
  if (current.length > 0 || pages.length === 0) {
    pages.push(current);
  }

  const pageCount = pages.length;
  const clampedPage = Math.min(Math.max(1, page), pageCount);
  const pageItems = pages[clampedPage - 1] ?? [];

  if (options.readerId && pageItems.length > 0) {
    recordReadGrants(
      db,
      options.readerId,
      pageItems.map((item) => ({ entityType: "segment" as const, entityId: item.segmentId })),
      now(),
      renderStartSequence,
    );
  }

  return joinPage(
    formatPageHeader(clampedPage, pageCount, totalLive),
    [header, ...pageItems.map((item) => item.text)].join("\n"),
    pageCount,
  );
}
