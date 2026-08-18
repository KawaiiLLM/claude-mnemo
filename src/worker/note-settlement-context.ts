import type { Database } from "bun:sqlite";

import type { NoteSettlementJob } from "../db/note-settlement";
import { getTopic, listAttachedSegments } from "../db/segments";
import { getSession, type SessionRecord } from "../db/sessions";
import { getShadowNote, type ShadowNoteRecord } from "../db/shadow-notes";
import { getTurnsForSession } from "../db/turns";
import { renderSessionMilestoneInjection } from "../hooks/milestone-injection";
import { formatTurnAddress } from "../hooks/note-reminder";
import { renderMainAgentSessionInjection } from "../hooks/session-injection";
import { buildCollapsedTurnsForSession } from "../mcp/recall";
import { formatTurnCollapsed, type FormattedTurn } from "../mcp/format";

/**
 * Settlement context assembly (ownership-and-note-cadence spec, ticket 05).
 *
 * Everything the settlement call reads is rendered by the SAME builders the
 * live surfaces use — `buildCollapsedTurnsForSession` + `formatTurnCollapsed`
 * for the preceding turns AND the window turns,
 * `renderSessionMilestoneInjection` for the arc,
 * `renderMainAgentSessionInjection` for the session summary the main agent is
 * shown at SessionStart. The alternative, a settlement-only renderer, is the
 * dual-source rot the spec names: two descriptions of the same rows drift, and
 * the one the model reads is the one nobody looks at.
 *
 * TICKET 05'S CHANGE (spec "结算不读段的字段" [S15069/T906]): settlement no
 * longer reads a segment's FIELDS at all — no content/insight, no Working
 * State. What survives is the ROSTER: id/title/topic for each of the
 * session's attached segments, enough for membership correction to name a
 * target without granting settlement any visibility into a segment's own
 * body. The old `attachedSegments` field (full `SegmentRecord[]`, feeding a
 * hand-rolled renderer in worker/note-settlement-prompt.ts) is gone along
 * with `db/note-settlement-summary-flags.ts` (the summary-contradiction
 * check that field existed to feed).
 *
 * TICKET 05'S OTHER CHANGE: duty 2 (note reconstruction) retires outright, so
 * the "hole" classification that fed it — which window turns still owe a
 * note, and their raw prompt/response material — is gone too. A window turn
 * is just whatever recall would show for it; settlement has no more use for
 * a note-debt view of its own window.
 */

/** Turns of context BEFORE the window, rendered as recall renders them. */
export const NOTE_SETTLEMENT_PRIOR_TURNS = 50;

export interface NoteSettlementWindowTurn {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  /** `S<session>/T<prompt>` — the only address the model ever sees. */
  ref: string;
  note: ShadowNoteRecord | null;
  /**
   * The turn as RECALL renders it — same builder, same renderer, same
   * one-line-plus-desc shape the preceding-turns section uses.
   *
   * When the turn has a note, the note's own title and content are what that
   * view renders: for an agent-written note on an era turn they are already
   * the turn record's title/content (`promoteTurnFromNote`), and for a note
   * only `shadow_notes` carries — a reconstruction an earlier settlement pass
   * wrote, which is deliberately never promoted — substituting them is what
   * keeps that note visible without a second renderer to show it in.
   */
  collapsedRendering: string;
  createdAtEpoch: number;
  toolCallCount: number | null;
  filesModified: string[];
  wasRolledBack: boolean;
  /** Seconds since the previous window turn — the silence signal. */
  gapSeconds: number | null;
}

/**
 * The segment ROSTER (spec "结算不读段的字段", [S15069/T912]) — id/title/topic
 * for one of the session's ATTACHED segments, never its content/insight/
 * Working State. Enough for membership correction to name a target by; not
 * enough to judge what the segment is ABOUT beyond its title and topic.
 */
export interface NoteSettlementSegmentRosterEntry {
  id: number;
  title: string;
  topic: string | null;
}

export interface NoteSettlementContext {
  job: NoteSettlementJob;
  session: SessionRecord;
  windowTurns: NoteSettlementWindowTurn[];
  /** Collapsed rendering of the 50 turns preceding the window. */
  priorTurnsRendering: string;
  /**
   * The session summary as the MAIN agent is shown it at SessionStart, from
   * the shared entry point both surfaces call (ticket 11, spec A4).
   */
  sessionStateRendering: string;
  /**
   * The session's currently ATTACHED segments, as a ROSTER (id/title/topic
   * only — ticket 05, spec "结算不读段的字段"). Not a scope gate any more —
   * settlement's `assign` action retired with it — purely informational, for
   * `propose` and the model's own orientation.
   */
  segmentRoster: NoteSettlementSegmentRosterEntry[];
  milestoneRendering: string;
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

/**
 * Assemble one window's settlement context.
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

  // ONE collapsed build for the whole session: recall's own builder, feeding
  // both the window turns below and the preceding-turns rendering further
  // down. Two calls would be two reads of the same rows at two instants —
  // and, more to the point, the window's turns are rendered by the same
  // function as everything else on this prompt.
  const collapsedTurns = new Map<number, FormattedTurn>(
    buildCollapsedTurnsForSession(db, job.sessionId).map((turn) => [
      turn.promptNumber,
      turn,
    ]),
  );

  const windowTurns: NoteSettlementWindowTurn[] = [];
  let previousCreatedAt: number | null = null;
  for (const turn of windowRecords) {
    const note = notes.get(turn.id) ?? null;
    const collapsedView = collapsedTurns.get(turn.promptNumber);

    windowTurns.push({
      turnId: turn.id,
      sessionId: turn.sessionId,
      promptNumber: turn.promptNumber,
      ref: formatTurnAddress(turn),
      note,
      collapsedRendering: collapsedView
        ? formatTurnCollapsed(
            note
              ? { ...collapsedView, title: note.title, content: note.content }
              : collapsedView,
            { sessionId: job.sessionId },
          )
        : "",
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
  const priorTurnsRendering = [...collapsedTurns.values()]
    .filter((turn) => priorPromptNumbers.has(turn.promptNumber))
    .map((turn) => formatTurnCollapsed(turn, { sessionId: job.sessionId }))
    .join("\n");

  const priorTurnIds = allTurns
    .filter((turn) => priorPromptNumbers.has(turn.promptNumber))
    .map((turn) => turn.id);

  // The session's own attachment rows — never a global recency window —
  // projected down to the roster shape (id/title/topic, ticket 05: "结算不
  // 读段的字段"). `getTopic` resolves the topic NAME from `topicId`; a
  // segment with no topic renders `topic: null`.
  const segmentRoster: NoteSettlementSegmentRosterEntry[] = listAttachedSegments(
    db,
    job.sessionId,
  ).map((segment) => ({
    id: segment.id,
    title: segment.title,
    topic: segment.topicId !== null ? (getTopic(db, segment.topicId)?.name ?? null) : null,
  }));

  const context: NoteSettlementContext = {
    job,
    session,
    windowTurns,
    priorTurnsRendering,
    segmentRoster,
    milestoneRendering: renderSessionMilestoneInjection(db, job.sessionId),
    // The SAME entry point the SessionStart hook calls, minus the corpus
    // header — the settlement agent has recall and timeline and no skills,
    // so the header's replay pointer would name a capability it does not
    // have. The global-view group only (user ruling, S15069/T759).
    // Settlement needs the arc, not the resuming session's event stream.
    sessionStateRendering: renderMainAgentSessionInjection(db, {
      session,
      fields: "global-view",
    }),
    reviewableTurnIds: new Set([
      ...windowTurns.map((turn) => turn.turnId),
      ...priorTurnIds,
    ]),
    builtAtEpoch: options.nowEpoch,
  };

  return context;
}
