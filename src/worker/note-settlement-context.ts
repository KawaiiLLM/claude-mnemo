import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import { getNoteDebt, recordNoteIdExposure } from "../db/note-debt";
import type { NoteDebtReason, NoteDebtStatus } from "../db/note-debt";
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
import { draftTypeFromTitle, UNKNOWN_TYPE } from "../shared/type-vocabulary";
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
 * one, and as truncated raw material when it does not (trivial turns, and the
 * interior holes 裁决 20 requires be reconstructed).
 */

/** Turns of context BEFORE the window, rendered as recall renders them. */
export const NOTE_SETTLEMENT_PRIOR_TURNS = 50;

/**
 * Raw-material budget for an interior hole (裁决 20's ~1000 token/turn). The
 * model has to reconstruct a note from this and nothing else, so it is the
 * largest per-turn allowance in the payload.
 */
export const NOTE_SETTLEMENT_HOLE_TOKEN_BUDGET = 1_000;

/**
 * Raw-material budget for a trivial turn (spec D11's "琐碎 turn 以截断原文注入").
 * A trivial turn owes no note and gets no reconstruction — its text is here only
 * so the segment body can account for a conversational stretch, which needs far
 * less than a reconstruction does.
 */
export const NOTE_SETTLEMENT_TRIVIAL_TOKEN_BUDGET = 300;

/**
 * How a window turn reaches the model.
 *
 *   - `noted`          its note is the material;
 *   - `interior-hole`  debt written off at residual claim time, but a LATER turn
 *                      in the same window was noted, so the arc reads as broken
 *                      without it. Gets raw material and owes a reconstruction;
 *   - `trailing-hole`  same write-off with nothing noted after it. Gets neither:
 *                      no member depends on it, the arc simply ends early;
 *   - `skipped`        aged or rolled back. Deliberately left alone — filling
 *                      aged holes would dissolve the reminder's authority;
 *   - `trivial`        no ledger row at all (no substantive tool call).
 */
export type NoteSettlementTurnKind =
  | "noted"
  | "interior-hole"
  | "trailing-hole"
  | "skipped"
  | "trivial";

export interface NoteSettlementWindowTurn {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  /** `S<session>/T<prompt>` — the only address the model ever sees (D7). */
  ref: string;
  kind: NoteSettlementTurnKind;
  debtStatus: NoteDebtStatus | null;
  debtReason: NoteDebtReason | null;
  note: ShadowNoteRecord | null;
  /** Truncated prompt + response; only for `trivial` and `interior-hole`. */
  rawMaterial: string | null;
  createdAtEpoch: number;
  toolCallCount: number | null;
  filesModified: string[];
  wasRolledBack: boolean;
  /** Mechanical prior the model only CONFIRMS (spec D9's last discipline). */
  typeDraft: string;
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
}

export interface BuildNoteSettlementContextOptions {
  nowEpoch: number;
  priorTurns?: number;
  /**
   * Record the rendered turn ids in the exposure ledger. On by default: a
   * citation may only name an id its writer was shown (D7), and this render IS
   * the showing. Tests that only inspect the payload turn it off.
   */
  recordExposure?: boolean;
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
  debt: { status: NoteDebtStatus; reason: NoteDebtReason | null } | null,
  hasNote: boolean,
  hasLaterNotedTurn: boolean,
): NoteSettlementTurnKind {
  if (hasNote) {
    return "noted";
  }
  if (debt === null) {
    return "trivial";
  }
  if (debt.status === "skipped" && debt.reason === "closed") {
    return hasLaterNotedTurn ? "interior-hole" : "trailing-hole";
  }
  // A still-pending debt cannot occur in a frozen decided window; if one ever
  // does (a hand-edited ledger), it reads as skipped rather than as a hole —
  // reconstructing a turn the agent may still write up would duplicate the note.
  return "skipped";
}

/**
 * Assemble one window's settlement context.
 *
 * Interior holes are DERIVED here and stored nowhere (ticket 05's decision 5):
 * "was written off but something after it was noted" is a fact about the window,
 * and a window is frozen, so the derivation is stable across retries without a
 * column to keep in sync.
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

  const windowTurns: NoteSettlementWindowTurn[] = [];
  let previousCreatedAt: number | null = null;
  for (let index = 0; index < windowRecords.length; index += 1) {
    const turn = windowRecords[index]!;
    const note = notes.get(turn.id) ?? null;
    const debt = getNoteDebt(db, turn.id);
    const hasLaterNotedTurn = windowRecords
      .slice(index + 1)
      .some((later) => notes.get(later.id) != null);
    const kind = classifyTurn(debt, note !== null, hasLaterNotedTurn);
    const tokenBudget =
      kind === "interior-hole"
        ? NOTE_SETTLEMENT_HOLE_TOKEN_BUDGET
        : kind === "trivial"
          ? NOTE_SETTLEMENT_TRIVIAL_TOKEN_BUDGET
          : 0;
    const draft = draftTypeFromTitle(note?.title ?? turn.title ?? "");

    windowTurns.push({
      turnId: turn.id,
      sessionId: turn.sessionId,
      promptNumber: turn.promptNumber,
      ref: formatTurnAddress(turn),
      kind,
      debtStatus: debt?.status ?? null,
      debtReason: debt?.reason ?? null,
      note,
      rawMaterial: tokenBudget > 0 ? buildRawMaterial(turn, tokenBudget) : null,
      createdAtEpoch: turn.createdAtEpoch,
      toolCallCount: turn.toolCallCount,
      filesModified: turn.filesModified,
      wasRolledBack: turn.wasRolledBack,
      typeDraft: draft === UNKNOWN_TYPE ? UNKNOWN_TYPE : draft,
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

  const openSegments = listOpenSegments(db);
  const context: NoteSettlementContext = {
    job,
    session,
    windowTurns,
    interiorHoles: windowTurns.filter((turn) => turn.kind === "interior-hole"),
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
  };

  if (options.recordExposure !== false && windowTurns.length > 0) {
    // The ride turn is the window's last turn: settlement has no turn of its
    // own, and the window's end is the point in the session's history at which
    // these ids were put in front of a writer.
    const rideTurnId = windowTurns[windowTurns.length - 1]!.turnId;
    const exposedTurnIds = [
      ...windowTurns.map((turn) => turn.turnId),
      ...allTurns
        .filter((turn) => priorPromptNumbers.has(turn.promptNumber))
        .map((turn) => turn.id),
    ];
    runWriteTransaction(db, () =>
      recordNoteIdExposure(db, {
        sessionId: job.sessionId,
        rideTurnId,
        exposedTurnIds,
        source: "injection",
        nowEpoch: options.nowEpoch,
      }),
    );
  }

  return context;
}
