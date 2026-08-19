import type { Database } from "bun:sqlite";

import type { NoteSettlementJob } from "../db/note-settlement";
import { getTopic, listAttachedSegments } from "../db/segments";
import { getSession, type SessionRecord } from "../db/sessions";
import { getShadowNote, type ShadowNoteRecord } from "../db/shadow-notes";
import { getTurnsForSession } from "../db/turns";
import { claimWriterId, recordReadGrants, type ReadGrantEntry } from "../db/write-gate";
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
 *
 * TICKET 04'S CHANGE ([S15069/T963]): the lookback/window split that used to
 * exist at the RENDERING layer is gone — `priorTurns` and `windowTurns` are
 * now the SAME shape (`NoteSettlementWindowTurn[]`), built by one shared pass
 * over both ranges. For the model there is no difference between a prior
 * turn and a window turn (unified rendering, unified correctability —
 * rendering IS authorization, isomorphic with the write gate); the split
 * that remains is job accounting only (`job.windowStart`/`windowEnd`, read by
 * the caller and stated in the prompt's own header), not a prompt-side
 * rendering boundary. Lookback size now SCALES with the window: it defaults
 * to the window's own turn count rather than a fixed constant.
 */

export interface NoteSettlementWindowTurn {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  /** `S<session>/T<prompt>` — the only address the model ever sees. */
  ref: string;
  note: ShadowNoteRecord | null;
  /**
   * The turn as RECALL renders it — same builder, same renderer, one
   * one-line-plus-desc shape whether this turn is lookback or window
   * (ticket 04: the two are rendered identically).
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
  /** This job's OWN window (ticket 04: job accounting only, not a render boundary). */
  windowTurns: NoteSettlementWindowTurn[];
  /**
   * The lookback turns immediately preceding the window, same shape as
   * `windowTurns` and rendered exactly the same way (ticket 04, [S15069/T963]:
   * "统一渲染、统一可纠" — no difference for the model between a prior turn
   * and a window turn). Count defaults to the window's own size; see
   * `BuildNoteSettlementContextOptions.priorTurns`.
   */
  priorTurns: NoteSettlementWindowTurn[];
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
  /**
   * Ticket 08 (edge-ownership-impl): `segmentRoster`, projected down to bare
   * ids — the legal DOMAIN for a membership correction
   * (`SettlementTurnFacadeContext.attachedSegmentIds`). Kept alongside the
   * rendered roster rather than derived by each reader, same split
   * `reviewableTurnIds` already has against its own rendered lookback.
   */
  attachedSegmentIds: Set<number>;
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
  /**
   * Lookback turn count. Defaults to the window's OWN size (ticket 04,
   * [S15069/T963]: "前序注入数量=本窗口 turn 数") — a 25-turn window renders
   * 25 preceding turns, a 50-turn window renders 50 — rather than the old
   * fixed 50-turn constant.
   */
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

  // Lookback defaults to the window's OWN size (ticket 04: "前序注入数量=本
  // 窗口 turn 数") — a 25-turn window renders 25 preceding turns, a 50-turn
  // window renders 50.
  const priorTurnsCount =
    options.priorTurns ?? job.windowEnd - job.windowStart + 1;
  const priorFloor = Math.max(1, job.windowStart - priorTurnsCount);

  const priorRecords = allTurns.filter(
    (turn) =>
      turn.promptNumber >= priorFloor && turn.promptNumber < job.windowStart,
  );
  const windowRecords = allTurns.filter(
    (turn) =>
      turn.promptNumber >= job.windowStart && turn.promptNumber <= job.windowEnd,
  );
  // Ascending by construction: both filters walk `allTurns` (itself ascending
  // by prompt number) and every prior record's prompt number is, by the
  // filters above, strictly less than every window record's.
  const combinedRecords = [...priorRecords, ...windowRecords];

  const notes = new Map<number, ShadowNoteRecord | null>();
  for (const turn of combinedRecords) {
    notes.set(turn.id, getShadowNote(db, turn.id));
  }

  // ONE collapsed build for the whole session: recall's own builder, feeding
  // both groups below. Two calls would be two reads of the same rows at two
  // instants — and, more to the point, ticket 04 unifies the two groups into
  // one rendering, so there is only one function left to feed.
  const collapsedTurns = new Map<number, FormattedTurn>(
    buildCollapsedTurnsForSession(db, job.sessionId).map((turn) => [
      turn.promptNumber,
      turn,
    ]),
  );

  // ONE pass over prior turns THEN window turns, so the gap signal carries
  // across the boundary between them (ticket 04: no rendering distinction
  // between the two groups, so the silence signal should not reset at the
  // boundary either) — then split back into the two exposed fields, which
  // remain separate ONLY because `windowTurns` still answers "does this job's
  // own window have anything to settle" for the dispatch/facade layer.
  const renderedTurns: NoteSettlementWindowTurn[] = [];
  let previousCreatedAt: number | null = null;
  for (const turn of combinedRecords) {
    const note = notes.get(turn.id) ?? null;
    const collapsedView = collapsedTurns.get(turn.promptNumber);

    renderedTurns.push({
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

  const priorTurns = renderedTurns.filter(
    (turn) => turn.promptNumber < job.windowStart,
  );
  const windowTurns = renderedTurns.filter(
    (turn) => turn.promptNumber >= job.windowStart,
  );

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
    priorTurns,
    segmentRoster,
    attachedSegmentIds: new Set(segmentRoster.map((segment) => segment.id)),
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
    reviewableTurnIds: new Set(renderedTurns.map((turn) => turn.turnId)),
    builtAtEpoch: options.nowEpoch,
  };

  // Ticket 05 (read-write-contract spec: "结算 context 构建记录读授权 for
  // EVERY rendered turn (prior + window uniformly)... under the claim writer
  // identity — the recording seam from ticket 01"). Rendering IS
  // authorization (spec: "渲染即授权"), the same rule every other render path
  // (recall/timeline) already follows via `recordReadGrants` — this is
  // settlement's own render pass calling the identical seam, under its own
  // per-claim writer identity rather than a session's. Recorded for every
  // turn THIS prompt showed (`renderedTurns` = priorTurns + windowTurns,
  // ticket 04's unified rendering), one batch, one sequence snapshot — the
  // write gate's own `checkFieldGate` is what a settlement write later
  // consumes this grant against (worker/note-settlement-turn-facade.ts).
  if (renderedTurns.length > 0) {
    const writer = claimWriterId(job.id, job.claimGeneration);
    const entries: ReadGrantEntry[] = renderedTurns.map((turn) => ({
      entityType: "turn",
      entityId: turn.turnId,
    }));
    recordReadGrants(db, writer, entries, options.nowEpoch);
  }

  return context;
}
