import type { Database } from "bun:sqlite";

import type { SegmentRecord } from "../db/segments";
import {
  listRecentSettlementProposals,
  type NoteSettlementProposalRecord,
} from "../db/note-settlement-proposals";
import {
  recallMemory,
  renderSegmentRosterFeed,
  type SegmentRosterFeedOptions,
} from "../mcp/recall";
import { timelineQuery } from "../mcp/timeline";
import { renderMemoryRubricBlock } from "../shared/memory-rubric";

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
  readerId: string | null | undefined,
): string {
  if (kind === "fields") {
    return recallMemory(db, {
      id: `E${segmentId}`,
      pageBudget,
      eraCutoffEpoch,
      readerId,
    });
  }
  return timelineQuery(db, {
    id: `E${segmentId}`,
    view: "milestones",
    pageBudget,
    eraCutoffEpoch,
    readerId,
  });
}

/** The self-identifying first line every emitted segment block carries. */
export function segmentBlockHeader(
  segmentId: number,
  kind: SegmentBlockKind,
): string {
  return `[E${segmentId}] · ${kind}`;
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
  eraCutoffEpoch: number | null,
  /**
   * Write gate identity (`db/write-gate.ts`'s `sessionWriterId`) — OPTIONAL,
   * and the SessionStart segment-block hook path (ticket 01, spec D9)
   * deliberately never passes it. Those slots each run on their own
   * read-only connection (`hook-command.ts`'s "parallel hook processes must
   * not contend for the write lock" comment); a writer identity here makes
   * the render tail attempt a `write_gate_reads` INSERT, which throws on a
   * readonly handle — `milestones` surfaced the throw as a one-line error,
   * `fields` threw past the handler's broad catch and the whole block
   * vanished (the bug this ticket fixes). The read-write contract's grant
   * basis for these two blocks is therefore "not granted, not expanded" —
   * the roster's own grant (a separate renderer riding the sole writable
   * bare `context` command, `handlers/context.ts`) is untouched. Only a
   * caller on a writable connection — a future non-hook renderer, or a test
   * exercising this primitive directly — should pass this.
   */
  readerId?: string | null,
): string {
  const header = segmentBlockHeader(segment.id, kind);
  return composeWithDemoteLadder(header, (pageBudget) =>
    readerOutputAtBudget(db, kind, segment.id, eraCutoffEpoch, pageBudget, readerId),
  );
}

// ---------------------------------------------------------------------------
// Roster (ticket 14 rebuild, spec "roster 重建"): a unified-renderer segment
// LISTING — its own SEPARATE block from the rubric below, no shared budget
// between the two. `recall.ts`'s `renderSegmentRosterFeed` is the actual
// renderer (activity-recency order, title+tags fields, 100-tok item / 2000-
// tok page budgets, pagination, grant recording); this wrapper is the
// SessionStart-specific composer around it — the injection's own
// overflow-attached-segment pointer option and the hard char safety net
// every block in this module applies.
// ---------------------------------------------------------------------------

export type SegmentRosterOptions = SegmentRosterFeedOptions;

/**
 * The SessionStart roster block. Retired by this rebuild: topic-grouped
 * headers, the type facet glyph, the 40-segment count cap (token pagination
 * replaces it), and character-only title truncation — see
 * `renderSegmentRosterFeed`'s own doc comment for the renderer-side detail.
 */
export function renderSegmentRosterBlock(
  db: Database,
  options: SegmentRosterOptions = {},
): string {
  return enforceHardCharLimit(renderSegmentRosterFeed(db, options));
}

// ---------------------------------------------------------------------------
// The Memory Rubric's OWN block (ticket 14: "rubric 独占其块" — the ticket 11
// cohabitation with the segment roster, and its shared-budget/INCOMPLETE-
// marker logic, retire along with the roster rebuild above; the rubric's
// text is fixed-length prose with nothing left to share space with).
// ---------------------------------------------------------------------------

/**
 * The Memory Rubric's own slot. Ticket 03 (edge-mechanism-revision, "Rubric
 * v5 定稿入库,Policy 并入") retired the sibling `MEMORY_POLICY_TEXT` block
 * this used to concatenate here ([S15069/T1028]'s "和 rubric 一个块" cohabit-
 * ation) — Policy is now the rubric's own `## Policy` section, so this
 * composer wraps only `renderMemoryRubricBlock()`'s byte-identical output.
 */
export function renderRubricBlock(): string {
  return enforceHardCharLimit(renderMemoryRubricBlock());
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
