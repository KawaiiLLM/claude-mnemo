import type { SegmentRecord } from "../db/segments";
import type { OrphanAnchorRow, SegmentSpineRow } from "../db/segment-rank";
import { typeListGlyph } from "../shared/type-vocabulary";

import { RENDER_INDENT_STEP, truncateText } from "./format";

/**
 * The segment spine (spec D11): the new era's default reading surface.
 *
 * One line per segment — the chapter — plus one line per ORPHAN ANCHOR, a turn
 * with hard mechanical signals that no segment has claimed. A 1000-turn session
 * is meant to read as a few dozen of these lines, which is why the row carries
 * only pointers: the dominant type glyph, the topic tag, the title, the status,
 * the member count and span, and the phase trace. Everything else is one
 * `recall(id="E<n>")` away.
 *
 * There is no day grouping here, on purpose. Day grouping is the legacy arc's
 * organizing principle and it is what makes a long session over-budget: a
 * month-long session pays for 31 headers before it renders any content, and a
 * segment does not respect day boundaries anyway (70% of real topic arcs are
 * non-contiguous). `time=` covers the "what happened on the 14th" question.
 */

/** `⚑` marks a row that is a bare turn on a surface made of segments. */
const ORPHAN_GLYPH = "⚑";
const SPINE_ROW_INDENT = "";
/** Tags shown inline on a spine row before the rest collapse to `+N`. */
export const SPINE_TAG_CAP = 2;

/**
 * A row's type glyph (ticket 02, spec B5): `typeListGlyph` handles both the
 * current vocabulary and a legacy word reached through a member turn written
 * before the switch, so this is a thin, dominant-type-shaped wrapper over it.
 */
export function segmentTypeGlyph(
  type: string | readonly string[] | null | undefined,
): string {
  if (type === null || type === undefined) {
    return "•";
  }
  return typeListGlyph(typeof type === "string" ? [type] : type);
}

function formatTags(tags: readonly string[]): string {
  if (tags.length === 0) {
    return "";
  }
  const shown = tags.slice(0, SPINE_TAG_CAP).map((tag) => `#${tag}`);
  const hidden = tags.length - shown.length;
  return `${shown.join(" ")}${hidden > 0 ? ` +${hidden}` : ""}`;
}

function sanitize(value: string): string {
  return value.replaceAll("|", "/").replaceAll("→", "->");
}

/**
 * `phaseTrace` entries are whole type LISTS now (ticket 02, spec B5) — one
 * per collapsed run — so each entry can itself render as more than one
 * glyph (a run where members carried two simultaneous activities).
 */
export function formatPhaseTrace(
  phaseTrace: readonly (readonly string[])[],
): string {
  return phaseTrace.map((types) => segmentTypeGlyph(types)).join("→");
}

function formatSpan(row: SegmentSpineRow): string {
  if (row.firstPromptNumber === null || row.lastPromptNumber === null) {
    return "";
  }
  return row.firstPromptNumber === row.lastPromptNumber
    ? `T${row.firstPromptNumber}`
    : `T${row.firstPromptNumber}–T${row.lastPromptNumber}`;
}

/** `[E47] 🔧 #topic title [open] · 12 turns · T12–T87 · 🔍→⚖️→🔧` */
export function renderSpineRow(row: SegmentSpineRow, titleCap: number): string {
  const { segment } = row;
  const parts = [
    `[E${segment.id}]`,
    segmentTypeGlyph(row.dominantType),
    formatTags(segment.tags),
    sanitize(truncateText(segment.title, { limit: titleCap })),
    `[${segment.status}]`,
  ].filter((part) => part !== "");

  const facts = [
    `${row.memberCount} ${row.memberCount === 1 ? "turn" : "turns"}`,
    formatSpan(row),
    formatPhaseTrace(row.phaseTrace),
  ].filter((part) => part !== "");

  return `${SPINE_ROW_INDENT}${parts.join(" ")} · ${facts.join(" · ")}`.trimEnd();
}

/** `⚑ T101 🔴 title (corrector, cited 2)` */
export function renderOrphanRow(row: OrphanAnchorRow, titleCap: number): string {
  const { facts } = row;
  const label = facts.title === null || facts.title.trim() === ""
    ? "(untitled)"
    : sanitize(truncateText(facts.title, { limit: titleCap }));
  return `${SPINE_ROW_INDENT}${ORPHAN_GLYPH} T${facts.promptNumber} ${segmentTypeGlyph(
    facts.type,
  )} ${label} (${row.signals.join(", ")})`;
}

export interface SegmentSpineBlockInput {
  spine: readonly SegmentSpineRow[];
  orphans: readonly OrphanAnchorRow[];
  titleCap: number;
  /** Rows retained after budget shedding; undefined = all. */
  maxSegments?: number;
  maxOrphans?: number;
  /**
   * Milestone rows nested beneath each segment line (ticket 03), keyed by
   * segment id and pre-rendered by the caller through the same row renderer
   * the legacy arc uses — this module only places the lines, it never formats
   * one. A missing or empty entry means no nested content, which is exactly
   * what keeps a segment with no admitted rows byte-identical to the
   * pre-nesting renderer (spec D6/D9).
   */
  milestoneLinesBySegmentId?: ReadonlyMap<number, readonly string[]>;
}

/**
 * The whole spine block, ready to splice between the session header and the
 * legacy body. Empty when there is nothing on the era side, which is what makes
 * a null era cutoff byte-identical to the pre-ticket rendering.
 *
 * Shedding drops the OLDEST segments and the LOWEST-ranked orphans, and says so
 * with a fold line — an omission is never silent.
 */
export function renderSegmentSpineBlock(
  input: SegmentSpineBlockInput,
): string[] {
  const { spine, orphans, titleCap } = input;
  if (spine.length === 0 && orphans.length === 0) {
    return [];
  }

  const keptSegments = input.maxSegments === undefined
    ? [...spine]
    : spine.slice(Math.max(0, spine.length - Math.max(0, input.maxSegments)));
  const droppedSegments = spine.length - keptSegments.length;
  const keptOrphans = input.maxOrphans === undefined
    ? [...orphans]
    : orphans.slice(0, Math.max(0, input.maxOrphans));
  const droppedOrphans = orphans.length - keptOrphans.length;

  const headerParts = [
    `${spine.length} ${spine.length === 1 ? "segment" : "segments"}`,
  ];
  if (orphans.length > 0) {
    headerParts.push(
      `${orphans.length} orphan ${orphans.length === 1 ? "anchor" : "anchors"}`,
    );
  }

  const lines = ["", `── segment spine · ${headerParts.join(" · ")} ──`];

  if (droppedSegments > 0) {
    lines.push(
      `${SPINE_ROW_INDENT}… +${droppedSegments} earlier ${
        droppedSegments === 1 ? "segment" : "segments"
      }`,
    );
  }
  for (const row of keptSegments) {
    lines.push(renderSpineRow(row, titleCap));
    const nested = input.milestoneLinesBySegmentId?.get(row.segment.id);
    if (nested !== undefined && nested.length > 0) {
      lines.push(...nested);
    }
  }
  for (const row of keptOrphans) {
    lines.push(renderOrphanRow(row, titleCap));
  }
  if (droppedOrphans > 0) {
    lines.push(
      `${SPINE_ROW_INDENT}… +${droppedOrphans} orphan ${
        droppedOrphans === 1 ? "anchor" : "anchors"
      }`,
    );
  }

  return lines;
}

/**
 * Marks where the segment spine ends and the legacy arc begins, so a session
 * that straddles the cutoff never reads as one list written under two different
 * sets of semantics (spec D11: each side of the boundary renders by its own
 * rules). Emitted only when BOTH sides have content.
 */
export function legacyEraHeader(
  firstPromptNumber: number | null,
  lastPromptNumber: number | null,
): string {
  const span =
    firstPromptNumber === null || lastPromptNumber === null
      ? ""
      : ` · T${firstPromptNumber}–T${lastPromptNumber}`;
  return `── legacy era${span} ──`;
}

export interface SegmentHeaderInput {
  segment: SegmentRecord;
  memberCount: number;
  dominantType: string | null;
  phaseTrace: readonly (readonly string[])[];
  /** Qualified `S<n>/T<m>` addresses of the body's anchors, in body order. */
  anchorRefs: readonly string[];
  /**
   * Character cut for `desc`/`insight` — a plain char count, NOT the retired
   * `truncate`/`truncateCap` public knobs (ticket 11): this is a private
   * rendering parameter of this one helper, and its only caller
   * (`recall.ts`'s `renderSegmentSummary`) derives it from the `turn` token
   * budget, the same 4-chars-per-token conversion the browse feed already
   * uses for its own word-boundary field cuts.
   */
  charLimit: number;
}

/**
 * The `[E<n>]` record as recall renders it — the same collapsed/expanded shape
 * a session or turn gets, because a segment carries a turn's field shape and
 * the reader should not have to learn a second layout for the higher level.
 */
export function renderSegmentHeaderLines(input: SegmentHeaderInput): string[] {
  const { segment } = input;
  const tags = formatTags(segment.tags);
  const head = [
    `[E${segment.id}]`,
    segmentTypeGlyph(input.dominantType),
    tags,
    sanitize(segment.title),
  ]
    .filter((part) => part !== "")
    .join(" ");

  // The card's own `- stats:` row, on the one-line form (spec 金样例): the
  // facts that used to ride the head line as ` | N turns | [status] | rev N`
  // now sit where the card puts them, so a segment reads the same whether it
  // arrived through `recall(id="E<n>")` or through a search hit.
  const lines = [
    head,
    `${RENDER_INDENT_STEP}- stats: [${segment.status}] · ${input.memberCount} ${
      input.memberCount === 1 ? "turn" : "turns"
    } · rev ${segment.revision}`,
  ];

  if (segment.content) {
    lines.push(
      `${RENDER_INDENT_STEP}- content: ${truncateText(segment.content, { limit: input.charLimit })}`,
    );
  }
  // Ticket 14 (spec K5): a segment's `insight` is the most reusable thing it
  // holds — the routes ruled out and why — so it is the one field a reader
  // checking "did we already try this" most needs. A stored field no read
  // surface renders is this effort's recurring defect, and it would be
  // arriving here for the third time.
  if (segment.insight) {
    lines.push(
      `${RENDER_INDENT_STEP}- insight: ${truncateText(segment.insight, { limit: input.charLimit })}`,
    );
  }
  const trace = formatPhaseTrace(input.phaseTrace);
  if (trace !== "") {
    lines.push(`${RENDER_INDENT_STEP}- phases: ${trace}`);
  }
  if (input.anchorRefs.length > 0) {
    lines.push(`${RENDER_INDENT_STEP}- anchors: ${input.anchorRefs.join(", ")}`);
  }

  return lines;
}
