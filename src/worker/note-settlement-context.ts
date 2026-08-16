import type { Database } from "bun:sqlite";

import { listOwedNoteTurnsInRange } from "../db/note-debt";
import type { NoteSettlementJob } from "../db/note-settlement";
import {
  listOpenSegments,
  listTopics,
  type SegmentRecord,
  type TopicRecord,
} from "../db/segments";
import { getSession, type SessionRecord } from "../db/sessions";
import { getShadowNote, type ShadowNoteRecord } from "../db/shadow-notes";
import { getTurnsForSession, type TurnRecord } from "../db/turns";
import { estimateDiaryTokens } from "../diary/domain";
import { renderSessionMilestoneInjection } from "../hooks/milestone-injection";
import { formatTurnAddress } from "../hooks/note-reminder";
import { buildCollapsedTurnsForSession } from "../mcp/recall";
import { formatTurnCollapsed } from "../mcp/format";
import { renderSessionStateInjection } from "../mcp/session-output";
import { stripPrivateTags } from "../shared/tag-stripping";

/**
 * Settlement context assembly (spec D9, ticket 07).
 *
 * Everything the settlement call reads is rendered by the SAME builders the
 * live surfaces use — `buildCollapsedTurnsForSession` + `formatTurnCollapsed`
 * for the preceding turns, `renderSessionMilestoneInjection` for the arc,
 * `renderSessionStateInjection` for the session summary under its existing
 * budget. The alternative, a settlement-only renderer, is the dual-source rot
 * the spec names: two descriptions of the same rows drift, and the one the model
 * reads is the one nobody looks at.
 *
 * The one thing assembled here rather than borrowed is the WINDOW itself, which
 * has no existing reader: a window turn is presented as its note when it has
 * one, and as truncated raw material when it is a HOLE the payload must
 * mechanically backfill (spec note-prompt-clock D7, ticket 05).
 */

/** Turns of context BEFORE the window, rendered as recall renders them. */
export const NOTE_SETTLEMENT_PRIOR_TURNS = 50;

/**
 * Raw-material budget for a hole (裁决 20's ~1000 token/turn). The model has to
 * reconstruct a note from this and nothing else, so it is the largest per-turn
 * allowance in the payload.
 */
export const NOTE_SETTLEMENT_HOLE_TOKEN_BUDGET = 1_000;

/**
 * How a window turn reaches the model (spec D7, ticket 05 — the payload is a
 * MECHANICAL backfill, not a value judgement, so this classification is a plain
 * membership test and nothing else):
 *
 *   - `noted`    it already has a note — its note is the material;
 *   - `hole`     it is still OWED one right now, by the same derived predicate
 *                `listOwedNoteTurns` reads at prompt time
 *                (`listOwedNoteTurnsInRange`), checked at DISPATCH time rather
 *                than at window-freeze time. Gets raw material and owes a
 *                reconstruction. The old "interior" / "trailing" / "trivial"
 *                split is gone — ticket 05 deletes both of the payload's
 *                former discretionary calls ("no debt row is trivial",
 *                "a trailing gap is refused"), so every gap the window still
 *                has when the payload runs gets backfilled, full stop;
 *   - `skipped`  not owed and not noted — a compact marker, `undone`, rolled
 *                back, or a turn the agent explicitly declined. Deliberately
 *                left alone: value triage is the main agent's live `skip`,
 *                never the payload's to re-litigate in hindsight.
 */
export type NoteSettlementTurnKind = "noted" | "hole" | "skipped";

export interface NoteSettlementWindowTurn {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  /** `S<session>/T<prompt>` — the only address the model ever sees (D7). */
  ref: string;
  kind: NoteSettlementTurnKind;
  note: ShadowNoteRecord | null;
  /** Truncated prompt + response; only for a `hole`. */
  rawMaterial: string | null;
  createdAtEpoch: number;
  toolCallCount: number | null;
  filesModified: string[];
  wasRolledBack: boolean;
  /** Seconds since the previous window turn — the silence signal. */
  gapSeconds: number | null;
}

export interface NoteSettlementContext {
  job: NoteSettlementJob;
  session: SessionRecord;
  windowTurns: NoteSettlementWindowTurn[];
  /** Window turns owing a reconstruction, in prompt order. */
  interiorHoles: NoteSettlementWindowTurn[];
  /** Collapsed rendering of the 50 turns preceding the window. */
  priorTurnsRendering: string;
  openSegments: SegmentRecord[];
  activeTopics: TopicRecord[];
  milestoneRendering: string;
  sessionStateRendering: string;
  /** Segment ids shown — the exposure gate for `[E<n>]` citations. */
  exposedSegmentIds: Set<number>;
  /**
   * Turn ids THIS prompt put in front of the model — window plus the rendered
   * lookback — and therefore the only turns its review may revise.
   *
   * The session-lifetime exposure ledger is deliberately not the gate here.
   * That ledger answers "was this id ever legal to cite", which is right for a
   * citation: naming an old turn in a segment body is additive. A review
   * verdict is destructive — it overwrites grade, type and tags — so an
   * address the model could only have produced from its own imagination must
   * not resolve onto a real row from some earlier window.
   */
  reviewableTurnIds: Set<number>;
  /**
   * When this context was read out of the database. The write-back compares
   * note timestamps against it to tell a note the model reviewed from one that
   * landed during the model call; `job.claimedAtEpoch` is close but not the
   * same instant, and is nullable besides.
   */
  builtAtEpoch: number;
}

export interface BuildNoteSettlementContextOptions {
  nowEpoch: number;
  priorTurns?: number;
}

/** Cut `text` to a token budget, measured with the shared estimator. */
function truncateToTokens(text: string, tokenBudget: number): string {
  if (estimateDiaryTokens(text) <= tokenBudget) {
    return text;
  }
  // Binary search on code points: the estimator weights Han above Latin, so a
  // fixed characters-per-token ratio would over-cut CJK and under-cut English.
  const codePoints = Array.from(text);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateDiaryTokens(codePoints.slice(0, mid).join("")) <= tokenBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${codePoints.slice(0, low).join("")}…`;
}

/**
 * Raw material for one turn: the user's prompt and the assistant's reply, split
 * evenly across the budget, with private-tagged content removed first (D10 —
 * the same strip the capture path applies, applied before the text leaves the
 * database rather than after it reaches a model).
 */
function buildRawMaterial(turn: TurnRecord, tokenBudget: number): string {
  const half = Math.max(1, Math.floor(tokenBudget / 2));
  const prompt = truncateToTokens(
    stripPrivateTags(turn.userPrompt ?? ""),
    half,
  );
  const response = truncateToTokens(
    stripPrivateTags(turn.assistantResponse ?? ""),
    tokenBudget - half,
  );
  const parts: string[] = [];
  if (prompt.trim()) {
    parts.push(`user: ${prompt}`);
  }
  if (response.trim()) {
    parts.push(`assistant: ${response}`);
  }
  return parts.join("\n");
}

function classifyTurn(
  hasNote: boolean,
  isOwed: boolean,
): NoteSettlementTurnKind {
  if (hasNote) {
    return "noted";
  }
  return isOwed ? "hole" : "skipped";
}

/**
 * Assemble one window's settlement context.
 *
 * Holes are a DERIVED membership test, re-run here rather than read off a
 * stored classification (ticket 05's decision 4/5): `listOwedNoteTurnsInRange`
 * is read at the moment this context is built, which for the payload is
 * DISPATCH time — so a note the main agent lands while the job sits queued
 * already reads as `noted` here, before the model ever sees the turn as a gap.
 */
export function buildNoteSettlementContext(
  db: Database,
  job: NoteSettlementJob,
  options: BuildNoteSettlementContextOptions,
): NoteSettlementContext | null {
  const session = getSession(db, job.sessionId);
  if (!session) {
    return null;
  }

  const allTurns = getTurnsForSession(db, job.sessionId);
  const windowRecords = allTurns.filter(
    (turn) =>
      turn.promptNumber >= job.windowStart && turn.promptNumber <= job.windowEnd,
  );
  const notes = new Map<number, ShadowNoteRecord | null>();
  for (const turn of windowRecords) {
    notes.set(turn.id, getShadowNote(db, turn.id));
  }
  const owedTurnIds = new Set(
    listOwedNoteTurnsInRange(
      db,
      job.sessionId,
      job.windowStart,
      job.windowEnd,
    ).map((turn) => turn.turnId),
  );

  const windowTurns: NoteSettlementWindowTurn[] = [];
  let previousCreatedAt: number | null = null;
  for (const turn of windowRecords) {
    const note = notes.get(turn.id) ?? null;
    const kind = classifyTurn(note !== null, owedTurnIds.has(turn.id));
    const tokenBudget = kind === "hole" ? NOTE_SETTLEMENT_HOLE_TOKEN_BUDGET : 0;

    windowTurns.push({
      turnId: turn.id,
      sessionId: turn.sessionId,
      promptNumber: turn.promptNumber,
      ref: formatTurnAddress(turn),
      kind,
      note,
      rawMaterial: tokenBudget > 0 ? buildRawMaterial(turn, tokenBudget) : null,
      createdAtEpoch: turn.createdAtEpoch,
      toolCallCount: turn.toolCallCount,
      filesModified: turn.filesModified,
      wasRolledBack: turn.wasRolledBack,
      gapSeconds:
        previousCreatedAt === null
          ? null
          : Math.max(0, turn.createdAtEpoch - previousCreatedAt),
    });
    previousCreatedAt = turn.createdAtEpoch;
  }

  const priorTurns = options.priorTurns ?? NOTE_SETTLEMENT_PRIOR_TURNS;
  const priorFloor = Math.max(1, job.windowStart - priorTurns);
  const priorPromptNumbers = new Set(
    allTurns
      .filter(
        (turn) =>
          turn.promptNumber >= priorFloor &&
          turn.promptNumber < job.windowStart,
      )
      .map((turn) => turn.promptNumber),
  );
  const priorTurnsRendering = buildCollapsedTurnsForSession(db, job.sessionId)
    .filter((turn) => priorPromptNumbers.has(turn.promptNumber))
    .map((turn) => formatTurnCollapsed(turn, { sessionId: job.sessionId }))
    .join("\n");

  const priorTurnIds = allTurns
    .filter((turn) => priorPromptNumbers.has(turn.promptNumber))
    .map((turn) => turn.id);

  const openSegments = listOpenSegments(db);
  const context: NoteSettlementContext = {
    job,
    session,
    windowTurns,
    interiorHoles: windowTurns.filter((turn) => turn.kind === "hole"),
    priorTurnsRendering,
    openSegments,
    activeTopics: listTopics(db, "active"),
    milestoneRendering: renderSessionMilestoneInjection(db, job.sessionId),
    sessionStateRendering: renderSessionStateInjection({
      id: session.id,
      title: session.title,
      content: session.content,
      decision: session.decision,
      done: session.done,
      current: session.current,
      nextSteps: session.nextSteps,
      reference: session.reference,
    }),
    exposedSegmentIds: new Set(openSegments.map((segment) => segment.id)),
    reviewableTurnIds: new Set([
      ...windowTurns.map((turn) => turn.turnId),
      ...priorTurnIds,
    ]),
    builtAtEpoch: options.nowEpoch,
  };

  return context;
}
