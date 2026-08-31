import type { Database } from "bun:sqlite";

import type { SegmentRecord } from "../db/segments";
import {
  recallMemory,
  renderSegmentRosterFeed,
  type SegmentRosterFeedOptions,
} from "../mcp/recall";
import { buildSegmentFrontierSection } from "../mcp/timeline";
import { renderMainAgentRubricBlock } from "../shared/memory-rubric";

/**
 * SessionStart's per-attached-segment blocks and the fixed roster block
 * (ticket 10, ADR-0006; lane-model-v12 ticket 15 retired the `proposals`
 * block along with the `propose` verb that was its only source). The
 * `fields` block is the real reader's own byte output under a one-line
 * header (spec: "one 2000-token block per attached segment composed from
 * recall and timeline output, so injection has no dedicated renderer to
 * drift"). The `milestones` block's producer is the FRONTIER SECTION
 * (frontier-injection spec Rev 5, ticket 02 — replacing the retired
 * split-segment milestone card): per-lane digest lines plus elected rows,
 * budget-fitted by the runtime tokenizer inside
 * `buildSegmentFrontierSection` itself. That function is deliberately NOT
 * `timelineQuery`: `timeline(id="E<n>", view="milestones")`, the MCP query
 * surface, keeps running the single-election `renderSegmentTimeline`
 * unchanged (the old scorer lives — spec "Scorer scope and retirement").
 *
 * PERF NOTE OF RECORD (ticket 07, correcting ticket 06's carried wording —
 * this is the release-note phrasing): SessionStart composition measured
 * ~0.85s WARM per slot on a production-scale corpus (E60 shape: 33 lanes /
 * ~2000 settled / 1400 edges). The SessionStart slots run as PARALLEL hook
 * processes, so per-slot CPU vs parallel wall time is UNMEASURED — the
 * earlier "three max-scale attached tasks would stack to ~2.5s" claim
 * assumed serial stacking and is unsupported; it is retired. The
 * ~0.85s/slot warm figure stands.
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

/** Last-resort character truncation, shared by every block kind (roster, rubric, segment blocks alike). */
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
  // The frontier section never rides the demote ladder or the char clamp
  // (ticket 07 P1-1): the host character constraint threads INTO the
  // renderer, whose own tag-floor ladder (rows → pointers → bare `#tag`
  // lines → continuation marker, amended spec T2235) degrades whole fields
  // and whole lines — `enforceHardCharLimit`'s mid-line cut would delete
  // legal tags from the authoritative vocabulary surface, which the floor
  // exists to prevent. The limit passed is the slot's remainder after the
  // `[E<n>] · milestones` header line and its newline.
  return buildSegmentFrontierSection(
    db,
    segmentId,
    eraCutoffEpoch,
    pageBudget,
    readerId,
    undefined,
    MAX_INJECTED_BLOCK_CHARS -
      segmentBlockHeader(segmentId, "milestones").length -
      "\n".length,
  );
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
 * renderer.
 *
 * `fields`: on a post-render size breach the SAME reader re-runs at a
 * halved `pageBudget` (2000 → 1000 → 500); below 500 the composed string is
 * hard-truncated with a visible marker rather than re-rendered again.
 *
 * `milestones` (ticket 07 P1-1): NEVER char-truncated and never demoted —
 * the frontier renderer receives the host character constraint directly
 * (see `readerOutputAtBudget`) and owns the whole degradation ladder, so
 * the composition layer's clamp is not even in its path. One render, one
 * budget, the constraint satisfied by construction.
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
  if (kind === "milestones") {
    // Direct composition — the renderer already fit itself inside
    // MAX_INJECTED_BLOCK_CHARS minus this header (its tag floor outranks
    // even the token budget; a mid-line cut here would drop legal tags).
    return `${header}\n${readerOutputAtBudget(
      db,
      kind,
      segment.id,
      eraCutoffEpoch,
      SEGMENT_BLOCK_PAGE_BUDGET,
      readerId,
    )}`;
  }
  return composeWithDemoteLadder(header, (pageBudget) =>
    readerOutputAtBudget(db, kind, segment.id, eraCutoffEpoch, pageBudget, readerId),
  );
}

// ---------------------------------------------------------------------------
// Roster (ticket 14 rebuild, spec "roster 重建"): a unified-renderer segment
// LISTING — its own SEPARATE block from the rubric below, no shared budget
// between the two. `recall.ts`'s `renderSegmentRosterFeed` is the actual
// renderer (activity-recency order, tag-led rows, 16-tok item / 2000-tok page
// budgets, pagination, grant recording); this wrapper is the
// SessionStart-specific composer around it — the injection's own
// attached/overflow-attached segment options and the hard char safety net
// every block in this module applies.
//
// Vocabulary (frontier-injection ticket 03): this block carries the TASK-tag
// half only — one segment tag leading each row. The LANE vocabulary's
// authoritative surface is the frontier digest lines in the `milestones`
// blocks above (`buildSegmentFrontierSection`, one digest line per declared
// lane of an attached task, zero-settled included), whose own vocabulary
// floor outranks even the hard budget — the roster's retired `- lanes:`
// expansion has no successor here. The roster still skips the demote ladder
// (`composeWithDemoteLadder`: 2000 → 1000 → 500 → hard truncation): it is
// composed once, at full budget, and only the 9500-char safety net can touch
// it — a task vocabulary that shrinks under size pressure would fail a writer
// exactly when the session is largest, which is when the write gate is
// busiest.
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
 * The Memory Rubric's own slot — ONE block, both halves.
 *
 * lane-model-v12 ticket 12 split the rubric in three (see
 * `shared/memory-rubric.ts`). This slot renders the two halves the main agent
 * needs — CONCEPTS (shared byte-identically with settlement) plus the
 * MAIN-AGENT ACTIONS (SessionStart only) — inside a SINGLE
 * `<mnemo-memory-rubric>` tag pair, under this module's single
 * `MAX_INJECTED_BLOCK_CHARS` governor.
 *
 * One slot, one block, and this is a hard rule rather than a preference: a
 * SessionStart hook slot whose output crosses roughly 10K characters is
 * persisted to a file and replaced by a 2KB preview, so two independently
 * budgeted blocks sharing one slot detonate the moment their SUM crosses the
 * line — later than either half's own growth would ever warn. The retired
 * `<mnemo-note-taking>` block (its own slot, `context notes`) is gone in the
 * same ticket for the related reason: what it carried was a call contract,
 * and call contracts live on the tool description.
 */
export function renderRubricBlock(): string {
  return enforceHardCharLimit(renderMainAgentRubricBlock());
}

