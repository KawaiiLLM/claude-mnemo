import type { Database } from "bun:sqlite";

import {
  rankSegmentMembers,
  type RankedSegmentMember,
} from "../db/segment-rank";
import {
  computeSegmentMemberFacetCounts,
  getAttachedSessionIds,
  getSegment,
  getTopic,
  type SegmentRecord,
} from "../db/segments";
import { countTurnsSince, getSession } from "../db/sessions";
import { getTurnById } from "../db/turns";
import { MAINTENANCE_CADENCE } from "../shared/segment-cadence";
import { SEGMENT_WORKING_STATE_FIELDS, type SegmentWorkingStateField } from "../shared/segment-fields";
import { typeWordGlyph } from "../shared/type-vocabulary";
import { estimateTokens } from "../utils/token-estimate";

import {
  DEFAULT_PREVIEW_COUNT,
  formatEpoch,
  renderNode,
  splitBulletField,
  type FormattedTurn,
  type TruncationSignal,
  type TurnRenderFields,
} from "./format";

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

/**
 * "card-scale" (spec "Budgets"): the same order of magnitude the segment
 * card's own per-field rows are budgeted at (a fraction of the 1000-token
 * page budget). Re-exported here so the one constant recall.ts resolves the
 * `turn` default against and the one this module's own member-index rows
 * use cannot drift apart.
 */
export { DEFAULT_TURN_TOKEN_BUDGET } from "./format";

// ---------------------------------------------------------------------------
// Event-order membership — the addressing axis (spec D8/D9): `E<n>/T<m>`'s
// `<m>` is the member's 1-based position here, NOT its rank under
// `rankSegmentMembers`' own anchors-first/derived-rank order (that order is
// a SELECTION concern the old inline listing used; the card no longer lists
// members inline at all — see the module comment above).
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

/** `E<n>/T<m>` resolution: the members at 1-based ordinals `ordinals` (empty = all), in event order. */
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

function renderElidedField(entry: ElidedSegmentCardField): string[] {
  const lines = [`  - ${entry.field}: ${entry.totalRows} ${entry.totalRows === 1 ? "row" : "rows"}`];
  if (entry.droppedCount > 0) {
    // The ellipsis sits at the TOP of the field (spec pinned decision): the
    // rows below it are what survived, oldest-of-the-survivors first.
    lines.push(`    - … +${entry.droppedCount} earlier`);
  }
  for (const row of entry.keptRows) {
    lines.push(`    - ${row}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Header facts
// ---------------------------------------------------------------------------

function topicNameForSegment(db: Database, segment: SegmentRecord): string | null {
  if (segment.topicId === null) {
    return null;
  }
  return getTopic(db, segment.topicId)?.name ?? null;
}

interface AttachedSessionRow {
  sessionId: number;
  title: string | null;
  memberCount: number;
  lastActiveEpoch: number;
  consultedOnly: boolean;
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
    const consultedOnly = sessionMembers.length === 0;
    const lastActiveEpoch = consultedOnly
      ? (session.updatedAtEpoch ?? session.createdAtEpoch)
      : Math.max(...sessionMembers.map((member) => member.createdAtEpoch));

    rows.push({
      sessionId,
      title: session.title,
      memberCount: sessionMembers.length,
      lastActiveEpoch,
      consultedOnly,
    });
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
  return attachedSessionIds.reduce(
    (max, sessionId) => Math.max(max, countTurnsSince(db, sessionId, segment.updatedAtEpoch)),
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
  /** Per-member-turn token cap, forwarded to the member index's turn rows. */
  turnBudget?: number;
  includeDbTurnIds?: boolean;
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
  const facetCounts = computeSegmentMemberFacetCounts(db, segment.id, eraCutoffEpoch);
  const topicName = topicNameForSegment(db, segment);
  const attachedSessionIds = getAttachedSessionIds(db, segment.id);
  const sessionRows = buildAttachedSessionRows(db, segment, members);
  const maintenance = maintenanceTurnsAgo(db, segment, attachedSessionIds);

  // -----------------------------------------------------------------------
  // The fixed header: meta line, tag/type facets, attached sessions (row
  // count capped — see MAX_ATTACHED_SESSION_ROWS). Never elided — what's
  // left of `pageBudget` after this is what the field ladder below competes
  // for. The `[E<n>]` id marker itself is added when `lines` opens, after
  // the title survives (or doesn't) elision.
  // -----------------------------------------------------------------------
  const headerLines: string[] = [];

  const metaParts = [
    `#${topicName ?? "(no topic)"}`,
    `[${segment.status}]`,
    `${members.length} ${members.length === 1 ? "turn" : "turns"}`,
    `created ${formatEpoch(segment.createdAtEpoch)}`,
    `last edit ${formatEpoch(segment.updatedAtEpoch)}`,
    // Ticket 12's nudge half (T825 "每 20 轮还没更新，提醒一次"): the 20-turn
    // nudge lives HERE, session-side — this header renders at SessionStart
    // and in recall, so it reaches a session that never calls `remember`;
    // the write receipt only ever reached whoever was already maintaining.
    `maintenance ${maintenance} ${maintenance === 1 ? "turn" : "turns"} ago${
      maintenance >= MAINTENANCE_CADENCE.nudgeAtOrAbove
        ? " — consider a maintenance pass"
        : ""
    }`,
  ];
  headerLines.push(`  ${metaParts.join(" · ")}`);

  if (facetCounts.tags.length > 0) {
    headerLines.push(
      `  - tags: ${facetCounts.tags.map((entry) => `#${entry.word}×${entry.count}`).join(" ")}`,
    );
  }
  if (facetCounts.type.length > 0) {
    headerLines.push(
      `  - type: ${facetCounts.type
        .map((entry) => `${typeWordGlyph(entry.word)}${entry.word}×${entry.count}`)
        .join(" ")}`,
    );
  }

  // Newest-active first, capped (ticket 08 checklist item 3): a session's
  // own row survives in preference to an older, colder one; the remainder
  // folds into one count line instead of vanishing or growing the header
  // without bound.
  const sessionsByRecency = [...sessionRows].sort(
    (left, right) => right.lastActiveEpoch - left.lastActiveEpoch,
  );
  const visibleSessionRows = elides
    ? sessionsByRecency.slice(0, MAX_ATTACHED_SESSION_ROWS)
    : sessionsByRecency;
  const overflowSessionCount = sessionsByRecency.length - visibleSessionRows.length;

  headerLines.push(`  - sessions: ${sessionRows.length === 0 ? "(none attached)" : ""}`.trimEnd());
  for (const row of visibleSessionRows) {
    const label = `S${row.sessionId}${row.title ? ` "${row.title}"` : ""}`;
    const stats = row.consultedOnly
      ? "consulted only"
      : `${row.memberCount} ${row.memberCount === 1 ? "turn" : "turns"}`;
    headerLines.push(`    - ${label}: ${stats}, last active ${formatEpoch(row.lastActiveEpoch)}`);
  }
  if (overflowSessionCount > 0) {
    headerLines.push(
      `    - … +${overflowSessionCount} more ${overflowSessionCount === 1 ? "session" : "sessions"}`,
    );
  }

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
  const lines: string[] = [`- [E${segment.id}]${titleText ? ` ${titleText}` : ""}`];
  lines.push(...headerLines);

  // The summary trio's own two prose fields — unchanged in spirit from the
  // pre-ticket-03 render (spec K5): still the segment's browsable half,
  // rendered whenever a row survived the ladder above (empty/elided both
  // read as "nothing to show" — the overall truncation signal, not a
  // per-field marker, is what tells a reader something was cut, same as
  // every other renderer in this codebase).
  const contentText = contentField.keptRows[0];
  if (contentText) {
    lines.push(`  - desc: ${contentText}`);
  }
  const insightText = insightField.keptRows[0];
  if (insightText) {
    lines.push(`  - insight: ${insightText}`);
  }

  for (const field of SEGMENT_WORKING_STATE_FIELDS) {
    lines.push(...renderElidedField(fieldByKey.get(field)!));
  }

  if (!elides) {
    lines.push(`  - member index (event order):`);
    if (members.length === 0) {
      lines.push(`    - (no members)`);
    }
    for (const [index, member] of members.entries()) {
      const turn = getTurnById(db, member.turnId);
      const title = turn?.title ?? turn?.userPrompt ?? "untitled";
      lines.push(`    - ${index + 1}. S${member.sessionId}/T${member.promptNumber} "${title}"`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// `E<n>/T<m>` member rendering — the turn field-set switch applies exactly as
// it does everywhere else in recall (spec: "Applies to every recall turn
// render"), via the shared `renderNode`.
// ---------------------------------------------------------------------------

export interface RenderSegmentMembersOptions {
  fields?: TurnRenderFields;
  includeDbTurnIds?: boolean;
  turnBudget?: number;
  eraCutoffEpoch?: number | null;
  signal?: TruncationSignal;
}

/**
 * Render the segment's members at the given 1-based EVENT-ORDER ordinals
 * (empty = every member), each row carrying its own `[S<n>][T<n>]` home
 * address — the ordinal is a navigation handle only (spec D9: "citations
 * always S/T because late-settling members shift event order"), never the
 * identity a citation should use.
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

  const chronological = chronologicalSegmentMembers(db, segment, eraCutoffEpoch);
  const ordinalByTurnId = new Map(chronological.map((member, index) => [member.turnId, index + 1] as const));

  const lines: string[] = [];
  for (const member of resolved) {
    const turn = getTurnById(db, member.turnId);
    if (!turn) {
      continue;
    }
    const view: FormattedTurn = {
      id: turn.id,
      promptNumber: turn.promptNumber,
      transcriptLineStart: turn.transcriptLineStart,
      title: turn.title,
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
    };
    const ordinal = ordinalByTurnId.get(member.turnId);
    const rendered = renderNode(
      { type: "turn", value: view },
      {
        fields: options.fields,
        sessionId: member.sessionId,
        includeDbTurnIds: options.includeDbTurnIds,
        turnBudget: options.turnBudget,
        signal: options.signal,
      },
    );
    lines.push(ordinal !== undefined ? `  ⟨E${segmentId}/T${ordinal}⟩ ${rendered.trimStart()}` : rendered);
  }

  return lines.join("\n");
}
