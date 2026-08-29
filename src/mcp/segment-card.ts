import type { Database } from "bun:sqlite";

import {
  rankSegmentMembers,
  type RankedSegmentMember,
} from "../db/segment-rank";
import {
  getAttachedSessionIds,
  getSegment,
  segmentTagOf,
  type SegmentRecord,
} from "../db/segments";
import { latestSegmentFieldWriteEpoch } from "../db/segment-field-freshness";
import { countTurnsSince, getSession } from "../db/sessions";
import { getTurnById } from "../db/turns";
import { SEGMENT_WORKING_STATE_FIELDS, type SegmentWorkingStateField } from "../shared/segment-fields";
import { estimateTokens } from "../utils/token-estimate";

import {
  composeTurnMetadata,
  DEFAULT_PREVIEW_COUNT,
  formatEpoch,
  pushFieldCompleteness,
  RENDER_INDENT_STEP,
  renderNode,
  renderSessionTransitionLine,
  splitBulletField,
  type FormattedTurn,
  type TruncationSignal,
  type TurnRenderFields,
} from "./format";
import { buildTurnRelationLines } from "./relations-view";

/**
 * The segment card (ticket 03, spec "Tools"/ADR-0006): `recall(id="E<n>")`'s
 * canonical render, and `remember(attach)`'s tool result (swapping ticket
 * 02's provisional plain render — `mcp/remember.ts`'s own comment names this
 * module as the swap).
 *
 * Deliberately its own module rather than more functions on `recall.ts`
 * (already 1700+ lines before this ticket): the card has its own genuinely
 * new mechanism — token-budgeted field elision — that earns mutation-tested
 * isolation, the same reasoning that already gave the segment SPINE
 * (`segment-spine.ts`) its own file beside `format.ts`.
 */

export const SEGMENT_CARD_DEFAULT_PAGE_BUDGET = 1000;

/** The card's field rows sit one hierarchy rung under `[E<n>]`; a field's own rows, one rung under that (spec 金样例). */
const CARD_FIELD_INDENT = RENDER_INDENT_STEP;
const CARD_ROW_INDENT = `${RENDER_INDENT_STEP}${RENDER_INDENT_STEP}`;

/**
 * "card-scale" (spec "Budgets"): the same order of magnitude the segment
 * card's own per-turn rows are budgeted at. Re-exported here so the one
 * constant recall.ts resolves the `turn` default against and the one this
 * module's own member rows (`renderSegmentMembersByOrdinal`) forward cannot
 * drift apart.
 */
export { DEFAULT_TURN_TOKEN_BUDGET } from "./format";

// ---------------------------------------------------------------------------
// Event-order membership — an internal RESOLUTION axis (spec D8/D9), not a
// public address any more (one-address-grammar spec, ticket 10, retired the
// public `E<n>/T<m>` ordinal). It survives here as the ordering `recall.ts`
// resolves an `E<n>/S<a>/T<b>..S<c>/T<d>` range's two S/T endpoints against
// — NOT `rankSegmentMembers`' own anchors-first/derived-rank order (that
// order is a SELECTION concern the old inline listing used; the card no
// longer lists members inline at all — see the module comment above).
// ---------------------------------------------------------------------------

/**
 * A segment's members in EVENT order (chronological — spec D9 user story 21:
 * "the turn view exhaustive in event order with segment ordinals"), each
 * carrying its 1-based ordinal. Era-scoped like every other member read here.
 */
export function chronologicalSegmentMembers(
  db: Database,
  segment: Pick<SegmentRecord, "id">,
  eraCutoffEpoch: number | null,
): RankedSegmentMember[] {
  const members = rankSegmentMembers(db, segment.id, undefined, eraCutoffEpoch);
  return [...members].sort((left, right) => {
    if (left.createdAtEpoch !== right.createdAtEpoch) {
      return left.createdAtEpoch - right.createdAtEpoch;
    }
    return left.turnId - right.turnId;
  });
}

/** The members at 1-based EVENT-ORDER ordinals `ordinals` (empty = all) — the internal resolution `recall.ts`'s segment-member routes (`E<n>/T*`, and the S/T-addressed single/range forms) share. */
export function resolveSegmentMembersByOrdinal(
  db: Database,
  segment: Pick<SegmentRecord, "id">,
  eraCutoffEpoch: number | null,
  ordinals: readonly number[],
): RankedSegmentMember[] {
  const chronological = chronologicalSegmentMembers(db, segment, eraCutoffEpoch);
  if (ordinals.length === 0) {
    return chronological;
  }
  const wanted = new Set(ordinals);
  return chronological.filter((_member, index) => wanted.has(index + 1));
}

// ---------------------------------------------------------------------------
// Field elision (spec "Tools"/"Injection", ticket 08): collapsed shows each
// field's NEWEST rows that fit a token budget; over budget, the LARGEST
// field's OLDEST rows go first — and (ticket 08) the summary layer
// (title/content/insight) competes in this SAME ladder as the six Working
// State fields, rather than rendering first, unconditionally, ahead of it.
// That is what lets Working State survive budget pressure first (spec user
// story 17) as an emergent property of "biggest field gives way first":
// title/content/insight are typically the largest single blobs on the card,
// so they are usually what yields under a tight budget, but nothing here
// hard-codes a layer priority — a bloated Working State field can just as
// well be the one that gives way. Pure and exported — this is exactly the
// mechanism ticket 03/08's mutation checks target.
// ---------------------------------------------------------------------------

/** The summary trio (each a single-row field: there is exactly one title, one content blob, one insight blob — never a bulleted list) plus the six Working State fields — every field competing in the card's one elision ladder. */
export type SegmentCardFieldKey = "title" | "content" | "insight" | SegmentWorkingStateField;

export interface SegmentCardFieldRows {
  field: SegmentCardFieldKey;
  /** Oldest-first — the field's own storage order (`appendSegmentWorkingStateRows` appends at the bottom; title/content/insight carry at most one row). */
  rows: readonly string[];
}

export interface ElidedSegmentCardField {
  field: SegmentCardFieldKey;
  totalRows: number;
  /** Newest-first-preserved (oldest-first among what's kept) — the rows that survived elision. */
  keptRows: readonly string[];
  droppedCount: number;
}

/**
 * Trim `fields` to fit `budgetTokens`, dropping the OLDEST row of whichever
 * field currently holds the MOST tokens, one row at a time, until the whole
 * set fits (or nothing is left to drop). Ties on "largest" break by
 * `fields`' own array order — title/content/insight then
 * `SEGMENT_WORKING_STATE_FIELDS`' declared order at every real call site —
 * so two fields of equal size trim deterministically rather than by
 * scheduling.
 */
export function elideSegmentCardFields(
  fields: readonly SegmentCardFieldRows[],
  budgetTokens: number,
): ElidedSegmentCardField[] {
  const rowTokens = fields.map((entry) => entry.rows.map((row) => estimateTokens(row)));
  const dropped = fields.map(() => 0);
  let total = rowTokens.reduce((sum, tokens) => sum + tokens.reduce((s, t) => s + t, 0), 0);

  while (total > budgetTokens) {
    let largestIndex = -1;
    let largestTokens = -1;
    for (let index = 0; index < fields.length; index += 1) {
      const remainingStart = dropped[index]!;
      if (remainingStart >= rowTokens[index]!.length) {
        continue;
      }
      const remainingTokens = rowTokens[index]!
        .slice(remainingStart)
        .reduce((s, t) => s + t, 0);
      if (remainingTokens > largestTokens) {
        largestTokens = remainingTokens;
        largestIndex = index;
      }
    }

    if (largestIndex === -1) {
      // Nothing left anywhere — budget too small even for zero rows; stop
      // rather than loop forever.
      break;
    }

    total -= rowTokens[largestIndex]![dropped[largestIndex]!]!;
    dropped[largestIndex]! += 1;
  }

  return fields.map((entry, index) => ({
    field: entry.field,
    totalRows: entry.rows.length,
    keptRows: entry.rows.slice(dropped[index]!),
    droppedCount: dropped[index]!,
  }));
}

const WORKING_STATE_PROPERTY: Record<
  SegmentWorkingStateField,
  "goal" | "constraints" | "decisions" | "done" | "nextSteps" | "reference"
> = {
  goal: "goal",
  constraints: "constraints",
  decisions: "decisions",
  done: "done",
  next_steps: "nextSteps",
  reference: "reference",
};

function segmentWorkingStateRows(segment: SegmentRecord): SegmentCardFieldRows[] {
  return SEGMENT_WORKING_STATE_FIELDS.map((field) => ({
    field,
    rows: splitBulletField(segment[WORKING_STATE_PROPERTY[field]]),
  }));
}

/**
 * A single-row summary-layer field (title/content/insight) as a
 * `SegmentCardFieldRows` entry — null/empty renders as zero rows, same as an
 * unset Working State field, so it competes in the ladder but never forces a
 * phantom row.
 */
function summaryFieldRows(field: "title" | "content" | "insight", value: string | null): SegmentCardFieldRows {
  return { field, rows: value ? [value] : [] };
}

/**
 * One Working State field (spec 金样例 card block). A field that HOLDS rows
 * names itself and lets the rows speak (`- goal:` then one bullet each); an
 * EMPTY field still renders, as `- constraints: 0 rows` — the sample keeps
 * every zero-row line unfolded, because "we never wrote a constraint down" is
 * itself the answer a reader came for.
 */
function renderElidedField(entry: ElidedSegmentCardField): string[] {
  if (entry.totalRows === 0) {
    return [`${CARD_FIELD_INDENT}- ${entry.field}: 0 rows`];
  }
  const lines = [`${CARD_FIELD_INDENT}- ${entry.field}:`];
  if (entry.droppedCount > 0) {
    // The ellipsis sits at the TOP of the field (spec pinned decision): the
    // rows below it are what survived, oldest-of-the-survivors first.
    lines.push(`${CARD_ROW_INDENT}- … +${entry.droppedCount} earlier`);
  }
  for (const row of entry.keptRows) {
    lines.push(`${CARD_ROW_INDENT}- ${row}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Header facts
// ---------------------------------------------------------------------------

/** Only what the bare `- sessions:` id list needs: the id, and the recency the cap sorts on. */
interface AttachedSessionRow {
  sessionId: number;
  lastActiveEpoch: number;
}

function buildAttachedSessionRows(
  db: Database,
  segment: SegmentRecord,
  members: readonly RankedSegmentMember[],
): AttachedSessionRow[] {
  const membersBySession = new Map<number, RankedSegmentMember[]>();
  for (const member of members) {
    const list = membersBySession.get(member.sessionId) ?? [];
    list.push(member);
    membersBySession.set(member.sessionId, list);
  }

  const attachedSessionIds = getAttachedSessionIds(db, segment.id);
  const rows: AttachedSessionRow[] = [];
  for (const sessionId of attachedSessionIds) {
    const session = getSession(db, sessionId);
    if (!session) {
      continue;
    }
    const sessionMembers = membersBySession.get(sessionId) ?? [];
    // A consulted-only session (attached, no member turn) has no member
    // timestamp to date itself by, so it falls back to the session's own.
    const lastActiveEpoch =
      sessionMembers.length === 0
        ? (session.updatedAtEpoch ?? session.createdAtEpoch)
        : Math.max(...sessionMembers.map((member) => member.createdAtEpoch));

    rows.push({ sessionId, lastActiveEpoch });
  }
  return rows;
}

/**
 * "maintenance N turns ago" (spec "Injection": "maintenance distance"), read
 * without a caller session — `remember`'s own receipt (ADR-0002) counts turns
 * in the ONE session writing at that moment; recall has no such session, so
 * this generalises the same measure as the busiest attached session's own
 * distance: the MAX across sessions, not the sum (ticket 14 #10 — summing
 * made five attached sessions read five-fold, incomparable to the 10/20
 * thresholds the receipt counts in single-session units). Zero attached
 * sessions reads as zero — nothing to count turns in.
 */
function maintenanceTurnsAgo(
  db: Database,
  segment: SegmentRecord,
  attachedSessionIds: readonly number[],
): number {
  // Measured from the segment's own FIELD stamps, not `updated_at_epoch`
  // (memory-guidance ticket 02): every row write bumps that column — a retag,
  // a status toggle, a facet recompute — so a segment nobody had maintained in
  // 200 turns read as freshly maintained the moment its tag changed. This is
  // the same source the maintenance reminder counts from, so the card and the
  // reminder cannot disagree about whether a segment has been looked after.
  // Never-written falls back to the segment's own creation, which is what
  // "distance since maintenance" means when there has never been any.
  const lastFieldWrite = latestSegmentFieldWriteEpoch(db, segment.id) ?? segment.createdAtEpoch;
  return attachedSessionIds.reduce(
    (max, sessionId) => Math.max(max, countTurnsSince(db, sessionId, lastFieldWrite)),
    0,
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface RenderSegmentCardOptions {
  /** Token budget for the whole card (default `SEGMENT_CARD_DEFAULT_PAGE_BUDGET`). Page 1 only — page ≥ 2 never elides. */
  pageBudget?: number;
  /**
   * 1-indexed. `page >= 2` is the "stable page 2" overflow escape (spec
   * "Overflow ALWAYS paginates... never drop items silently"): elision is
   * skipped and every Working State row renders regardless of budget, AND
   * the member index appears — ticket 11 retired the separate `depth` switch
   * that used to gate the member index on its own, so `page` alone now
   * decides both: a caller that hit the ellipsis on page 1 gets the full
   * card, deterministically, by asking for page 2.
   */
  page?: number;
  eraCutoffEpoch?: number | null;
  signal?: TruncationSignal;
}

/**
 * Attached-session rows shown in full on the card (ticket 08): ADR-0005
 * binding rows accumulate forever — no detach, no expiry — so an unbounded
 * per-row render lets attachment count alone push the header past the page
 * budget and starve every other field to zero. Capped at the same "preview
 * N, fold the rest into a count" scale this renderer's own turn/observation
 * previews already use (`DEFAULT_PREVIEW_COUNT`, format.ts) rather than
 * inventing a second constant for the same shape. Gated by `elides` below —
 * page 2 / expanded still show every row, the same "elision is skipped,
 * nothing drops silently" contract Working State's own fields already carry
 * there.
 */
export const MAX_ATTACHED_SESSION_ROWS = DEFAULT_PREVIEW_COUNT;

// ---------------------------------------------------------------------------
// Page >= 2 overflow pagination (bounded-read-surfaces ticket 01). "Stable
// page 2" (spec "Overflow ALWAYS paginates... never drop items silently")
// skips elision, but "every row renders" and "every row renders in ONE
// response" are not the same promise — a Working State field accumulates
// forever (no detach, no expiry, the same shape ADR-0005 already names for
// the attached-session rows above) and the member index grows with the
// segment's own lifetime, so the un-elided page is exactly as unbounded as
// the fields it un-elides. This packs the un-elided content into INDIVISIBLE
// units (one field heading, one field ROW, one member-index ROW) and pages
// them by `pageBudget` — the SAME name and meaning `RecallInput.pageBudget`
// already carries, never truncating a unit, naming the exact next call at the
// bottom — the shape `lane_check` already shipped
// (`shared/lane-checker-render.ts`'s `renderLaneCheckerReportsPaged`), copied
// rather than reinvented.
// ---------------------------------------------------------------------------

interface CardOverflowUnit {
  /** `SegmentCardFieldKey` for a field-owned unit (drives per-field completeness below); `"member-index"` for a member row, which carries no completeness signal of its own — it never did, even before pagination. */
  field: SegmentCardFieldKey | "member-index";
  lines: readonly string[];
}

function packCardOverflowUnits(
  units: readonly CardOverflowUnit[],
  pageBudget: number,
): CardOverflowUnit[][] {
  const pages: CardOverflowUnit[][] = [];
  let current: CardOverflowUnit[] = [];
  let currentTokens = 0;
  for (const unit of units) {
    const unitTokens = estimateTokens(unit.lines.join("\n"));
    if (current.length > 0 && currentTokens + unitTokens > pageBudget) {
      pages.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(unit);
    currentTokens += unitTokens;
  }
  if (current.length > 0 || pages.length === 0) {
    pages.push(current);
  }
  return pages;
}

function unitsToLines(units: readonly CardOverflowUnit[]): string[] {
  const lines: string[] = [];
  for (const unit of units) {
    lines.push(...unit.lines);
  }
  return lines;
}

/** Same shape as `lane_check`'s own continuation footer: states how many pages remain and the exact call that reaches the next one. A single-page overflow (the common case) carries no footer at all — nothing to continue. */
function cardOverflowFooter(segmentId: number, page: number, pageCount: number): string {
  if (pageCount <= 1) {
    return "";
  }
  const remaining = pageCount - page;
  const hint =
    remaining > 0
      ? `${remaining} more page(s) -- call recall(id="E${segmentId}", page=${page + 1}) for the next`
      : "this was the last page";
  return `\n\n-- page ${page}/${pageCount}: ${hint} --`;
}

export function renderSegmentCard(
  db: Database,
  segmentId: number,
  options: RenderSegmentCardOptions,
): string {
  const segment = getSegment(db, segmentId);
  if (!segment) {
    return "Segment not found.";
  }
  return renderSegmentCardRecord(db, segment, options);
}

export function renderSegmentCardRecord(
  db: Database,
  segment: SegmentRecord,
  options: RenderSegmentCardOptions,
): string {
  const eraCutoffEpoch = options.eraCutoffEpoch ?? null;
  const pageBudget = options.pageBudget ?? SEGMENT_CARD_DEFAULT_PAGE_BUDGET;
  const page = Math.max(1, options.page ?? 1);
  const elides = page <= 1;

  const members = chronologicalSegmentMembers(db, segment, eraCutoffEpoch);
  const attachedSessionIds = getAttachedSessionIds(db, segment.id);
  const sessionRows = buildAttachedSessionRows(db, segment, members);
  const maintenance = maintenanceTurnsAgo(db, segment, attachedSessionIds);

  // -----------------------------------------------------------------------
  // The fixed header: meta line, attached sessions (row
  // count capped — see MAX_ATTACHED_SESSION_ROWS). Header lines are never
  // dropped — what's left of `pageBudget` after this is what the field
  // ladder below competes for, which is exactly why no single header line
  // may grow without bound. The `[E<n>]` id marker itself is added when
  // `lines` opens, after the title survives (or doesn't) elision.
  // -----------------------------------------------------------------------
  const headerLines: string[] = [];

  const metaParts = [
    `[${segment.status}]`,
    `${members.length} ${members.length === 1 ? "turn" : "turns"}`,
    `created ${formatEpoch(segment.createdAtEpoch)}`,
    `last edit ${formatEpoch(segment.updatedAtEpoch)}`,
    // Ticket 12's nudge half (T825 "每 20 轮还没更新，提醒一次") retired
    // (ticket 13, spec "节奏与建段指导"): this header only ever reached a
    // session with the card already in view (SessionStart, or `recall` on an
    // ATTACHED segment) — silent for exactly the session that most needs the
    // reminder, the one that has never attached anything. The universal
    // 20-turn `remember` check (hooks/note-reminder.ts's
    // `renderRememberReminder`, rendered on every UserPromptSubmit) carries
    // that function now; this line states only the bare fact.
    `maintenance ${maintenance} ${maintenance === 1 ? "turn" : "turns"} ago`,
  ];
  // The sample's `- stats:` row (金样例 card block): the card's meta facts are
  // a NAMED field like every other row on the card, not a bare header line
  // floating under the title.
  headerLines.push(`${CARD_FIELD_INDENT}- stats: ${metaParts.join(" · ")}`);

  // THE CARD CARRIES NO VOCABULARY (lane-model-v12 ticket 18, ruling
  // [S15069/T1670]). Three rows left this header across tickets 14 and 18 —
  // `- tags:`, `- type:` (member-frequency histograms that READ like a
  // vocabulary without being one) and `- lanes:` (a real vocabulary, in the
  // wrong block). What remains describes only this segment's STATE: stats,
  // sessions, and the field ladder's goal / constraints / decisions /
  // next_steps.
  //
  // The lane vocabulary now renders in the ROSTER, under the attached segment
  // (`recall.ts`'s `renderSegmentRosterFeed`). The move was decided on a
  // measured budget asymmetry, not on taste: this fields block renders 1972 of
  // its 2000-token page budget on E60 — its prose fields are being cut today —
  // while the roster block sits at 289 tokens in a slot of roughly 2400. The
  // roster is also not in any degradation ladder: this card demotes to a
  // 500-token render under SessionStart size pressure
  // (`hooks/session-composition.ts`), and a vocabulary that disappears under
  // pressure is worse than useless to a writer the gate is about to judge.
  //
  // WHERE THE FREED BUDGET GOES, stated deliberately because ticket 14 warned
  // against letting it leak: to the field ladder, via `fieldsBudget =
  // pageBudget - headerTokens` below — no knife is raised anywhere to catch
  // it. Ticket 14's warning was that prose must not eat the budget owed to a
  // vocabulary WHILE THE VOCABULARY IS STILL ON THIS CARD; it is not, so the
  // named constant that carried the raise (`RETIRED_HISTOGRAM_ROW_TOKENS`,
  // 186) is deleted rather than repointed at some other row. State is all this
  // card renders, so state is what its whole budget buys.

  // A BARE ID LIST on one row (spec 金样例: `- sessions: Sxxx, Sxxx`). The
  // per-session title/turn-count/last-active rows this replaces were the
  // card's own second listing of facts every one of those sessions already
  // renders for itself — one `recall(id="S<n>")` away — and they were what
  // made attachment count alone able to starve the field ladder below.
  // Newest-active first, so the cap keeps the sessions still in play; the
  // remainder folds into a count rather than vanishing.
  const sessionsByRecency = [...sessionRows].sort(
    (left, right) => right.lastActiveEpoch - left.lastActiveEpoch,
  );
  const visibleSessionRows = elides
    ? sessionsByRecency.slice(0, MAX_ATTACHED_SESSION_ROWS)
    : sessionsByRecency;
  const overflowSessionCount = sessionsByRecency.length - visibleSessionRows.length;
  const sessionIdList = [
    ...visibleSessionRows.map((row) => `S${row.sessionId}`),
    ...(overflowSessionCount > 0 ? [`+${overflowSessionCount} more`] : []),
  ].join(", ");

  headerLines.push(
    `${CARD_FIELD_INDENT}- sessions: ${sessionRows.length === 0 ? "(none attached)" : sessionIdList}`,
  );

  // -----------------------------------------------------------------------
  // The elision ladder (ticket 08): the summary trio (title/content/
  // insight) and the six Working State fields all compete for what's left
  // of the budget after the fixed header above — no character-level
  // `truncate` anywhere in this card any more (spec "Tools": "The character
  // `truncate` knob retires"). The largest field gives way first, its
  // oldest rows first; ellipsis at the top of what remains (T829/T830).
  // -----------------------------------------------------------------------
  const cardFieldRows: SegmentCardFieldRows[] = [
    summaryFieldRows("title", segment.title),
    summaryFieldRows("content", segment.content),
    summaryFieldRows("insight", segment.insight),
    ...segmentWorkingStateRows(segment),
  ];

  const headerTokens = estimateTokens(headerLines.join("\n"));
  const fieldsBudget = Math.max(0, pageBudget - headerTokens);
  const elidedFields = elides
    ? elideSegmentCardFields(cardFieldRows, fieldsBudget)
    : cardFieldRows.map((entry) => ({
        field: entry.field,
        totalRows: entry.rows.length,
        keptRows: entry.rows,
        droppedCount: 0,
      }));

  if (
    elides &&
    (elidedFields.some((entry) => entry.droppedCount > 0) || overflowSessionCount > 0) &&
    options.signal
  ) {
    options.signal.truncated = true;
  }

  const fieldByKey = new Map(elidedFields.map((entry) => [entry.field, entry] as const));
  const titleField = fieldByKey.get("title")!;
  const contentField = fieldByKey.get("content")!;
  const insightField = fieldByKey.get("insight")!;

  const titleText = titleField.keptRows[0];
  // Ticket 14 (spec D3f): the segment's OWN tag moves into the header, beside
  // its id. It is one of the two legal sources a writer may draw a `tags`
  // value from and the ONE that decides membership, yet before this ticket it
  // appeared nowhere on the card — only in the roster, which the writer has
  // usually scrolled past by the time it writes a note. `(unnamed)` is printed
  // rather than omitted: an unnamed container takes no derived members, and
  // silence would read as "nothing to carry" instead of "nobody has named this
  // yet".
  const ownTag = segmentTagOf(segment);
  const idLine = `[E${segment.id}] #${ownTag ?? "(unnamed)"}${titleText ? ` ${titleText}` : ""}`;

  if (elides) {
    // Ticket 04 (write-mode-edit-semantics spec D8): the elision ladder above
    // already knows, PER FIELD, whether it dropped anything — a completeness
    // fact genuinely independent per field (unlike a turn node's own
    // whole-body cut, format.ts's `recordTurnFieldCompleteness`), which is
    // exactly what a later `write` judgment needs: one long field's
    // truncation must not connect a short field on the same card.
    for (const entry of elidedFields) {
      pushFieldCompleteness(
        options.signal,
        "segment",
        segment.id,
        entry.field,
        entry.droppedCount === 0,
      );
    }

    // The summary trio's own two prose fields — unchanged in spirit from the
    // pre-ticket-03 render (spec K5): still the segment's browsable half,
    // rendered whenever a row survived the ladder above (empty/elided both
    // read as "nothing to show" — the overall truncation signal, not a
    // per-field marker, is what tells a reader something was cut, same as
    // every other renderer in this codebase).
    const lines: string[] = [idLine, ...headerLines];
    const contentText = contentField.keptRows[0];
    if (contentText) {
      lines.push(`${CARD_FIELD_INDENT}- content: ${contentText}`);
    }
    const insightText = insightField.keptRows[0];
    if (insightText) {
      lines.push(`${CARD_FIELD_INDENT}- insight: ${insightText}`);
    }
    for (const field of SEGMENT_WORKING_STATE_FIELDS) {
      lines.push(...renderElidedField(fieldByKey.get(field)!));
    }
    return lines.join("\n");
  }

  // page >= 2 (bounded-read-surfaces ticket 01): the un-elided content, packed
  // into indivisible units and paged by `pageBudget` — see the module comment
  // above `CardOverflowUnit`. `title` never joins this pagination: it is
  // already fixed inside `idLine`, above, on every page, so it needs no unit
  // of its own here.
  const overflowUnits: CardOverflowUnit[] = [];
  const contentText = contentField.keptRows[0];
  if (contentText) {
    overflowUnits.push({ field: "content", lines: [`${CARD_FIELD_INDENT}- content: ${contentText}`] });
  }
  const insightText = insightField.keptRows[0];
  if (insightText) {
    overflowUnits.push({ field: "insight", lines: [`${CARD_FIELD_INDENT}- insight: ${insightText}`] });
  }
  for (const field of SEGMENT_WORKING_STATE_FIELDS) {
    const entry = fieldByKey.get(field)!;
    if (entry.totalRows === 0) {
      overflowUnits.push({ field, lines: [`${CARD_FIELD_INDENT}- ${entry.field}: 0 rows`] });
      continue;
    }
    overflowUnits.push({ field, lines: [`${CARD_FIELD_INDENT}- ${entry.field}:`] });
    for (const row of entry.keptRows) {
      overflowUnits.push({ field, lines: [`${CARD_ROW_INDENT}- ${row}`] });
    }
  }
  overflowUnits.push({
    field: "member-index",
    lines: [`${CARD_FIELD_INDENT}- member index (event order):`],
  });
  if (members.length === 0) {
    overflowUnits.push({ field: "member-index", lines: [`${CARD_ROW_INDENT}- (no members)`] });
  }
  for (const [index, member] of members.entries()) {
    const turn = getTurnById(db, member.turnId);
    const address = `S${member.sessionId}/T${member.promptNumber}`;
    // Title or bare address (floor-and-render-fidelity ticket 03, ticket
    // 02 hand-off): a note-less turn's own prompt never leaks here — the
    // retired `turn?.userPrompt` fallback was a third copy of the exact
    // pattern render-fidelity ticket 02 already swept out of the turn
    // label and the segment header's own anchor refs.
    overflowUnits.push({
      field: "member-index",
      lines: [`${CARD_ROW_INDENT}- ${index + 1}. ${turn?.title ? `${address} "${turn.title}"` : address}`],
    });
  }

  const packedPages = packCardOverflowUnits(overflowUnits, pageBudget);
  const fullPageCount = packedPages.length;
  const fullPageIndex = page - 2; // page=2 is the first un-elided page
  const inRange = fullPageIndex >= 0 && fullPageIndex < fullPageCount;
  const pageUnits = inRange ? packedPages[fullPageIndex]! : [];
  const pageUnitSet = new Set(pageUnits);

  // Field completeness for THIS page (bounded-read-surfaces ticket 01): a
  // field split across two full-pages is complete only on the page that holds
  // EVERY one of its own units — the same "did the reader see the whole
  // field" question `droppedCount === 0` answered before pagination could
  // ever split one field's rows across two responses. `title` is always
  // complete here (never paginated — see above).
  pushFieldCompleteness(options.signal, "segment", segment.id, "title", true);
  for (const field of ["content", "insight", ...SEGMENT_WORKING_STATE_FIELDS] as const) {
    const fieldUnits = overflowUnits.filter((unit) => unit.field === field);
    const complete = fieldUnits.length === 0 || fieldUnits.every((unit) => pageUnitSet.has(unit));
    pushFieldCompleteness(options.signal, "segment", segment.id, field, complete);
  }

  // A genuinely multi-page overflow IS a truncation of THIS response, exactly
  // like page 1's own elision signal — a reader who stops at this one page
  // has not seen the whole card.
  if (fullPageCount > 1 && options.signal) {
    options.signal.truncated = true;
  }

  const footer = inRange ? cardOverflowFooter(segment.id, page, 1 + fullPageCount) : "";
  const lines: string[] = [idLine, ...headerLines, ...unitsToLines(pageUnits)];
  return lines.join("\n") + footer;
}

// ---------------------------------------------------------------------------
// Segment member rendering (`E<n>/T*`, and the S/T-addressed single/range
// forms recall.ts resolves to an ordinal list before calling this) — the
// turn field-set switch applies exactly as it does everywhere else in
// recall (spec: "Applies to every recall turn render"), via the shared
// `renderNode`.
// ---------------------------------------------------------------------------

export interface RenderSegmentMembersOptions {
  fields?: TurnRenderFields;
  turnBudget?: number;
  eraCutoffEpoch?: number | null;
  signal?: TruncationSignal;
  /**
   * Session id of the member immediately BEFORE this page's first one, when a
   * previous page exists. Equal to the first rendered member's session means
   * the page opens in the MIDDLE of a session run: the run's transition line
   * was spent on the previous page, so this page's first row carries the full
   * `[S<n>][T<m>]` address instead (spec 补充裁决 "跨页引用自足").
   */
  precedingSessionId?: number | null;
  /**
   * Phase-connectivity ticket 07, decision 2: the OUTPUT collector every
   * member this pass actually EMITTED a block for is pushed into, in render
   * order. Supplied only by the lane route, whose read receipt is written from
   * it — "the member ids this call RENDERED" is a fact only this loop knows,
   * and re-deriving it from the caller's own pagination is what ticket 05
   * shipped and what the ninth peer round found wrong: the two computations
   * are free to drift, and the receipt is the one that gets believed.
   *
   * The loop below skips an `ordinals` entry that resolves to nothing
   * (`resolveSegmentMembersByOrdinal` drops an out-of-range ordinal) and one
   * whose turn row is gone, so what lands here is at most what was asked for
   * and can be less.
   */
  emittedTurnIds?: number[];
}

/**
 * Render the segment's members at the given 1-based EVENT-ORDER ordinals
 * (empty = every member) in the one row hierarchy (spec 金样例, originally
 * `recall(id="E31/T1..10")`; one-address-grammar spec, ticket 10, moved the
 * PUBLIC selector to `recall(id="E31/S<a>/T<b>..S<c>/T<d>")` — this
 * renderer's own ordinal-indexed input is unchanged, only its caller now
 * resolves S/T addresses to ordinals first): the `[E<n>]` line, a `[S<n>]`
 * transition line whenever the run changes session, then bare `[T<m>]` rows.
 * The event-order ordinal is a selection handle only (spec D9: "citations
 * always S/T because late-settling members shift event order") and no
 * longer occupies the row — the transition line plus the bare address IS the
 * `S<n>/T<m>` citation, split across two rungs instead of repeated on every
 * row.
 */
export function renderSegmentMembersByOrdinal(
  db: Database,
  segmentId: number,
  ordinals: readonly number[],
  options: RenderSegmentMembersOptions,
): string {
  const segment = getSegment(db, segmentId);
  if (!segment) {
    return "Segment not found.";
  }

  const eraCutoffEpoch = options.eraCutoffEpoch ?? null;
  const resolved = resolveSegmentMembersByOrdinal(db, segment, eraCutoffEpoch, ordinals);
  if (resolved.length === 0) {
    return ordinals.length === 0 ? "(no members)" : "Segment member not found.";
  }

  const lines: string[] = [`[E${segment.id}] ${segment.title}`];
  const seenSessionIds = new Set<number>();
  let runSessionId: number | null = options.precedingSessionId ?? null;
  let pageOpensMidSession =
    options.precedingSessionId !== undefined &&
    options.precedingSessionId !== null &&
    options.precedingSessionId === resolved[0]!.sessionId;

  for (const member of resolved) {
    const turn = getTurnById(db, member.turnId);
    if (!turn) {
      continue;
    }
    if (member.sessionId !== runSessionId) {
      lines.push(
        renderSessionTransitionLine(
          member.sessionId,
          seenSessionIds.has(member.sessionId) ? null : getSession(db, member.sessionId)?.title ?? null,
          RENDER_INDENT_STEP,
        ),
      );
      seenSessionIds.add(member.sessionId);
      runSessionId = member.sessionId;
    }
    const view: FormattedTurn = {
      id: turn.id,
      promptNumber: turn.promptNumber,
      title: turn.title,
      // Ticket 12 follow-through (golden sample Image #7: the E<n>/T route is
      // the sample's FIRST frame, metadata line included) — this route builds
      // its own FormattedTurn, so the default-field change alone missed it.
      metadata: composeTurnMetadata(turn, null),
      content: turn.content,
      status: turn.status,
      promptPreview: turn.userPrompt,
      responsePreview: turn.assistantResponse,
      insight: turn.insight
        ? turn.insight
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.replace(/^-+\s*/, ""))
        : [],
      filesRead: turn.filesRead,
      filesModified: turn.filesModified,
      observationCount: 0,
      wasRolledBack: turn.wasRolledBack,
      // Edge-read-surface spec, ticket 01: query gated on the caller's own
      // `fields` selection, same "costs nothing when not requested" contract
      // `recall.ts`'s `buildTurnView` follows.
      relations: options.fields?.has("relations")
        ? buildTurnRelationLines(db, turn)
        : undefined,
    };
    lines.push(
      renderNode(
        { type: "turn", value: view },
        {
          indent: `${RENDER_INDENT_STEP}${RENDER_INDENT_STEP}`,
          fields: options.fields,
          sessionId: member.sessionId,
          includeSessionPrefix: pageOpensMidSession,
          turnBudget: options.turnBudget,
          signal: options.signal,
        },
      ),
    );
    // Ticket 07: recorded HERE, beside the push that emits the block, so a
    // future member the loop learns to skip drops out of the receipt by
    // construction rather than by somebody remembering to update a second
    // copy of this loop's arithmetic.
    options.emittedTurnIds?.push(member.turnId);
    pageOpensMidSession = false;
  }

  return lines.join("\n");
}
