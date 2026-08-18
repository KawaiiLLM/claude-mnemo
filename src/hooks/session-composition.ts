import type { Database } from "bun:sqlite";

import {
  computeSegmentMemberFacetCounts,
  countLiveSegments,
  getTopic,
  listLiveSegmentsByActivity,
  type SegmentRecord,
} from "../db/segments";
import {
  listRecentSettlementProposals,
  type NoteSettlementProposalRecord,
} from "../db/note-settlement-proposals";
import { truncateText } from "../mcp/format";
import { recallMemory } from "../mcp/recall";
import { timelineQuery } from "../mcp/timeline";
import { typeWordGlyph } from "../shared/type-vocabulary";
import { estimateTokens } from "../utils/token-estimate";

/**
 * SessionStart's per-attached-segment blocks and the fixed roster/proposals
 * blocks (ticket 10, ADR-0006). Every function here is a COMPOSER, not a
 * renderer: the two segment blocks are the real readers' own byte output
 * under a one-line header (spec: "one 2000-token block per attached segment
 * composed from recall and timeline output, so injection has no dedicated
 * renderer to drift"); only the roster and the proposals block have content
 * this module originates, and both are new (no prior renderer to reuse).
 */

// ---------------------------------------------------------------------------
// Size governance shared by every emitted block (ticket 10 requirement 3).
// ---------------------------------------------------------------------------

/**
 * Claude Code persists an oversized SessionStart hook output to a file with
 * a 2KB preview at roughly 10K characters (ADR-0006 amended 2026-08-18; the
 * mechanism that already swallows the pre-ticket-10 milestones block). Every
 * block this module emits stays comfortably under that line.
 */
export const MAX_INJECTED_BLOCK_CHARS = 9_500;

/** recall/timeline's own interactive default (unchanged) — the injection call site passes 2000 explicitly instead. */
export const SEGMENT_BLOCK_PAGE_BUDGET = 2_000;

/** The demote ladder on a post-render size breach: halve, halve again, then hard-truncate below 500. */
const SEGMENT_BLOCK_DEMOTE_BUDGETS = [2_000, 1_000, 500] as const;

const HARD_TRUNCATION_MARKER =
  "\n\n… [block truncated to fit the SessionStart size limit]";

/** Last-resort character truncation, shared by every block kind (roster, proposals, segment blocks alike). */
export function enforceHardCharLimit(
  text: string,
  limit: number = MAX_INJECTED_BLOCK_CHARS,
): string {
  if (text.length <= limit) {
    return text;
  }
  const budget = Math.max(0, limit - HARD_TRUNCATION_MARKER.length);
  return `${text.slice(0, budget)}${HARD_TRUNCATION_MARKER}`;
}

// ---------------------------------------------------------------------------
// The two per-attached-segment blocks.
// ---------------------------------------------------------------------------

export type SegmentBlockKind = "fields" | "milestones";

/** How many attached segments the fixed SessionStart hook pool renders full blocks for (the persist-granularity experiment's "pool" verdict — see this ticket's Status note). */
export const ATTACHED_SEGMENT_BLOCK_SLOTS = 3;

function readerOutputAtBudget(
  db: Database,
  kind: SegmentBlockKind,
  segmentId: number,
  eraCutoffEpoch: number | null,
  pageBudget: number,
): string {
  if (kind === "fields") {
    return recallMemory(db, {
      id: `E${segmentId}`,
      depth: "collapsed",
      pageBudget,
      eraCutoffEpoch,
    });
  }
  return timelineQuery(db, {
    id: `E${segmentId}`,
    view: "milestones",
    pageBudget,
    eraCutoffEpoch,
  });
}

/** The self-identifying first line every emitted segment block carries. */
export function segmentBlockHeader(
  segmentId: number,
  topicName: string | null,
  kind: SegmentBlockKind,
): string {
  return `[E${segmentId}] #${topicName ?? "(no topic)"} · ${kind}`;
}

/**
 * The post-render size assertion and demote ladder (ticket 10 requirement
 * 3), pure and reader-agnostic so it is unit-testable without a database:
 * `header + "\n" + render(pageBudget)` at the first budget in `budgets`
 * that stays under `limit`; if every budget still overflows, the LAST
 * attempt is hard-truncated with a visible marker rather than re-rendered
 * again.
 */
export function composeWithDemoteLadder(
  header: string,
  render: (pageBudget: number) => string,
  budgets: readonly number[] = SEGMENT_BLOCK_DEMOTE_BUDGETS,
  limit: number = MAX_INJECTED_BLOCK_CHARS,
): string {
  let composed = "";
  for (const pageBudget of budgets) {
    composed = `${header}\n${render(pageBudget)}`;
    if (composed.length < limit) {
      return composed;
    }
  }
  return enforceHardCharLimit(composed, limit);
}

/**
 * One of the two per-attached-segment blocks: the header above the REAL
 * reader's byte-for-byte output at `pageBudget: 2000` — no dedicated
 * renderer. On a post-render size breach the SAME reader re-runs at a
 * halved `pageBudget` (2000 → 1000 → 500); below 500 the composed string is
 * hard-truncated with a visible marker rather than re-rendered again.
 */
export function renderAttachedSegmentBlock(
  db: Database,
  kind: SegmentBlockKind,
  segment: Pick<SegmentRecord, "id">,
  topicName: string | null,
  eraCutoffEpoch: number | null,
): string {
  const header = segmentBlockHeader(segment.id, topicName, kind);
  return composeWithDemoteLadder(header, (pageBudget) =>
    readerOutputAtBudget(db, kind, segment.id, eraCutoffEpoch, pageBudget),
  );
}

// ---------------------------------------------------------------------------
// Roster: every live segment, grouped by topic, budget-truncated.
// ---------------------------------------------------------------------------

const ROSTER_HEADER = "## Segment roster";
const ROSTER_MAX_SEGMENTS = 40;
const ROSTER_TITLE_TRUNCATE = 80;

/**
 * Ticket 12 (T819: "注入时给出所有段的 title 和 type/tags，方便挂靠"): a
 * roster row's tags are no longer hard-capped at a fixed count — that cut a
 * segment with eight one-word tags down to three and let three-verbose-words
 * eat the same three slots a differently-tagged segment would spend on ten.
 * Tags already arrive count-desc, alpha-tiebroken (`compareDerivedTags`,
 * db/segments.ts — "which is also the natural truncation under a budget"),
 * so the greedy take here is that ordering's own intended consumer, not a
 * new rule. `type` gets no such cap: the vocabulary is closed and small
 * (`MEMORY_TYPES`), so every stated type for a segment already fits in a
 * roster line's worth of tokens — the pattern segment-card.ts's own type
 * line already uses, reused here rather than invented twice.
 */
const ROSTER_TAG_FACET_BUDGET_TOKENS = 20;

/**
 * Greedily render `entries` (already sorted, most-significant first) via
 * `render`, stopping once the running token cost would exceed
 * `budgetTokens` — except the first entry always renders, so a single
 * over-budget item degrades to "one item, not zero" rather than an empty
 * facet line. Mirrors `truncateLines`' own "always keep the first, budget
 * the rest" shape (mcp/format.ts) instead of a second ad hoc cutoff rule.
 */
function budgetedFacetText<T>(
  entries: readonly T[],
  render: (entry: T) => string,
  budgetTokens: number,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const rendered = render(entry);
    const cost = estimateTokens(rendered) + (parts.length > 0 ? 1 : 0); // +1 for the joining space
    if (parts.length > 0 && used + cost > budgetTokens) {
      break;
    }
    parts.push(rendered);
    used += cost;
  }
  return parts.join(" ");
}

export interface SegmentRosterOptions {
  eraCutoffEpoch?: number | null;
  /** Segments attached to the CURRENT session but past the block-slot pool — annotated with a recall pointer instead of getting their own block. */
  overflowAttachedSegmentIds?: ReadonlySet<number>;
  /** Roster candidate cap, exposed for tests; production leaves the default. */
  limit?: number;
}

/**
 * The read-before-write discovery listing (ADR-0002: "create only... with
 * the segment roster in view"; ADR-0005: "the roster's own... recency
 * ordering"). Every LIVE segment (frozen legacy arc-segments excluded — see
 * `listLiveSegmentsByActivity`), grouped under its topic as a coarse project
 * header, each row the title plus its derived type and tag facets with
 * counts (ticket 12, T819: "给出所有段的 title 和 type/tags，方便挂靠" — type
 * unbounded, tags budget-trimmed, see `ROSTER_TAG_FACET_BUDGET_TOKENS`),
 * recency-ordered, truncated on segment COUNT with a `recall()` pointer for
 * the remainder.
 */
export function renderSegmentRoster(
  db: Database,
  options: SegmentRosterOptions = {},
): string {
  const eraCutoffEpoch = options.eraCutoffEpoch ?? null;
  const limit = options.limit ?? ROSTER_MAX_SEGMENTS;
  const overflow = options.overflowAttachedSegmentIds ?? new Set<number>();
  const totalLive = countLiveSegments(db);
  const candidates = listLiveSegmentsByActivity(db, limit);

  const lines: string[] = [`${ROSTER_HEADER} (${totalLive} live)`];

  if (candidates.length === 0) {
    lines.push(
      "(no live segments yet — remember(create) mints one from a topic)",
    );
    return enforceHardCharLimit(lines.join("\n"));
  }

  const groups = new Map<string, typeof candidates>();
  for (const entry of candidates) {
    const key = entry.topicName ?? "(no topic)";
    const group = groups.get(key);
    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }

  for (const [topicName, entries] of groups) {
    lines.push(`### ${topicName} (${entries.length})`);
    for (const { segment } of entries) {
      const facets = computeSegmentMemberFacetCounts(db, segment.id, eraCutoffEpoch);
      const typeText = facets.type
        .map((entry) => `${typeWordGlyph(entry.word)}${entry.word}×${entry.count}`)
        .join(" ");
      const tagsText = budgetedFacetText(
        facets.tags,
        (entry) => `#${entry.word}×${entry.count}`,
        ROSTER_TAG_FACET_BUDGET_TOKENS,
      );
      const facetText = [typeText, tagsText].filter(Boolean).join(" ");
      const attachedNote = overflow.has(segment.id)
        ? ` (attached, not rendered here — recall(id="E${segment.id}"))`
        : "";
      lines.push(
        `- E${segment.id} ${truncateText(segment.title, { limit: ROSTER_TITLE_TRUNCATE })}` +
          `${facetText ? ` — ${facetText}` : ""}${attachedNote}`,
      );
    }
  }

  if (totalLive > candidates.length) {
    lines.push(`… ${totalLive - candidates.length} more: recall()`);
  }

  return enforceHardCharLimit(lines.join("\n"));
}

export function topicNameForSegment(
  db: Database,
  segment: Pick<SegmentRecord, "topicId">,
): string | null {
  return segment.topicId ? getTopic(db, segment.topicId)?.name ?? null : null;
}

// ---------------------------------------------------------------------------
// Proposals: at most three, newest first, with the render-time ask-user
// boilerplate ticket 08 deliberately left for this ticket to add.
// ---------------------------------------------------------------------------

const PROPOSALS_HEADER = "## Proposals";
export const MAX_RENDERED_PROPOSALS = 3;
const PROPOSAL_ASK_BOILERPLATE = "ask the user before adopting this — never auto-create";

function renderProposalLine(proposal: NoteSettlementProposalRecord): string {
  return `- "${proposal.title}" — ${proposal.addresses.join(", ")} — ${PROPOSAL_ASK_BOILERPLATE}`;
}

/**
 * Settlement stores addresses + a suggested title only (ticket 08); the
 * "ask the user" reminder is this render-time boilerplate, added once per
 * row here rather than per stored proposal (ticket 08's own deviation note:
 * "the renderer (ticket 10) is expected to attach that boilerplate at
 * render time").
 */
export function renderProposalsBlock(
  db: Database,
  limit: number = MAX_RENDERED_PROPOSALS,
): string {
  const proposals = listRecentSettlementProposals(db, limit);
  const lines = [PROPOSALS_HEADER];
  if (proposals.length === 0) {
    lines.push("(none pending)");
  } else {
    for (const proposal of proposals) {
      lines.push(renderProposalLine(proposal));
    }
  }
  return enforceHardCharLimit(lines.join("\n"));
}
