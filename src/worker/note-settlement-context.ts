import type { Database } from "bun:sqlite";

import { listLanesForSegment } from "../db/lanes";
import type { NoteSettlementJob } from "../db/note-settlement";
import { listAttachedSegments } from "../db/segments";
import { getSession, type SessionRecord } from "../db/sessions";
import { getTurnById, getTurnsForSession } from "../db/turns";
import {
  claimWriterId,
  recordReadGrant,
  snapshotWriteGateSequence,
} from "../db/write-gate";
import { renderSessionMilestoneInjection } from "../hooks/milestone-injection";
import { formatTurnAddress } from "../hooks/note-reminder";
import { recallMemory } from "../mcp/recall";

/**
 * Settlement context assembly (ownership-and-note-cadence spec, ticket 05).
 *
 * Everything the settlement call reads is rendered by the SAME builders the
 * live surfaces use — `buildCollapsedTurnsForSession` + `formatTurnCompact`
 * for the preceding turns AND the window turns,
 * `renderSessionMilestoneInjection` for the arc, and `recallMemory` itself —
 * the unified renderer — for the session summary (read-write-contract spec,
 * the stitch closing ticket 07's deferred half). The alternative, a
 * settlement-only renderer, is the dual-source rot the spec names: two
 * descriptions of the same rows drift, and the one the model reads is the
 * one nobody looks at.
 *
 * TICKET 05'S CHANGE (spec "结算不读段的字段" [S15069/T906]): settlement no
 * longer reads a segment's FIELDS at all — no content/insight, no Working
 * State. What survives is the ROSTER: id/title for each of the session's
 * attached segments, enough for membership correction to name a target
 * without granting settlement any visibility into a segment's own body
 * (ticket 15 dropped the roster's own `topic` column along with the
 * registry it named). The old `attachedSegments` field (full `SegmentRecord[]`, feeding a
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
 *
 * TAG-MANDATE TICKET 06'S PULL TURN (spec "Settlement surface", ruling
 * [S15069/T1452]): this module no longer builds a RENDERING of anything but
 * the session narrative. Gone with the prompt's `## Turns` section:
 * `buildCollapsedTurnsForSession` + `formatTurnCompact` over every window and
 * lookback turn, the per-turn shadow-note read that fed it, and — the part
 * that is a CONTRACT change rather than a saving — the read grants and
 * field-completeness facts that render used to record.
 *
 * Why the grants had to go with it: "rendering IS authorization" was a rule
 * about a render the AGENT could see. Under pull the agent reads through its
 * own `recall` calls, which record grants at the identical seam under the
 * identical `claimWriterId` identity, so a grant left behind here would
 * license a whole-field overwrite of text this run never actually looked at
 * — precisely the failure `requireCompleteRead` exists to prevent. The
 * session-summary render is the ONE survivor, and it is deliberately narrowed
 * (`readerId: null` plus one explicit grant below) so that it licenses the
 * session narrative it actually shows in full and NOTHING else: left
 * unnarrowed, a 200K-budget `recallMemory("S<n>")` records a
 * `complete: true` fact for every turn row it lists, which is the same
 * unearned licence by another route.
 *
 * `NoteSettlementWindowTurn` keeps only what the remaining readers need — the
 * writable-set address list (`resolveSettlementWritableSet`), the dispatch's
 * "is this window empty" check, and `reviewableTurnIds`.
 */

export interface NoteSettlementWindowTurn {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  /** `S<session>/T<prompt>` — the only address the model ever sees. */
  ref: string;
}

/**
 * The segment ROSTER (spec "结算不读段的字段", [S15069/T912]) — id/title/tag
 * for one of the session's ATTACHED segments, never its content/insight/
 * Working State. Enough for membership correction to name a target by AND to
 * write it; not enough to judge what the segment is ABOUT beyond its title
 * (the topic-registry ticket retired the roster's own `topic` field along with
 * the registry that named it).
 */
export interface NoteSettlementSegmentRosterEntry {
  id: number;
  title: string;
  /**
   * The segment's ONE globally unique tag (lane-model-v12 D3e), or `null` for
   * a segment nobody has named yet. Membership is DERIVED from it — a turn
   * belongs to the segment whose tag its own `tags` carry — so this is the
   * word settlement writes to correct a mis-homed turn, and a roster without
   * it names a destination the agent cannot reach.
   */
  tag: string | null;
  /**
   * This segment's DECLARED lane registry, alphabetically (peer review A5) —
   * the second closed vocabulary a turn's `tags` may draw from, and the one
   * settlement is instructed to continue before declaring a fresh lane.
   *
   * Carried HERE because nothing else can carry it. Lane tags left the segment
   * card in lane-model-v12 ticket 18 and now render only on the main agent's
   * SessionStart roster row, which settlement never sees; and a lane cannot be
   * inferred from the edges either, since a PROVISIONAL lane (0 or 1 member) is
   * legal and by definition has no edge to reveal it. Without this field
   * "continue an existing lane first" is an instruction with no readable input.
   */
  lanes: string[];
}

export interface NoteSettlementContext {
  job: NoteSettlementJob;
  session: SessionRecord;
  /** This job's OWN window (ticket 04: job accounting only, not a render boundary). */
  windowTurns: NoteSettlementWindowTurn[];
  /**
   * The lookback turns immediately preceding the window, same shape as
   * `windowTurns` and equally writable (ticket 04, [S15069/T963]: "统一渲染、
   * 统一可纠" — no difference for the model between a prior turn and a window
   * turn; tag-mandate ticket 06 kept the equality and dropped the rendering
   * both halves of it used to mean). Count defaults to the window's own size;
   * see `BuildNoteSettlementContextOptions.priorTurns`.
   */
  priorTurns: NoteSettlementWindowTurn[];
  /**
   * The session's own stored narrative, through the shared entry point both
   * surfaces call (ticket 11, spec A4).
   *
   * NO LONGER "the block the main agent is shown at SessionStart": the five
   * surviving injection slots (spec D3f) are roster / segment cards / rubric /
   * persona, and the session summary is not among them. It is rendered here as
   * ORIENTATION for judging the window's turns; lane-model-v12 ticket 15
   * retired the duty that wrote it, so nothing this prompt asks for changes it.
   */
  sessionStateRendering: string;
  /**
   * The session's currently ATTACHED segments, as a ROSTER (id/title only —
   * ticket 05, spec "结算不读段的字段"). Not a scope gate any more —
   * settlement's `assign` action retired with it — purely informational, for
   * `propose` and the model's own orientation.
   */
  segmentRoster: NoteSettlementSegmentRosterEntry[];
  milestoneRendering: string;
  /**
   * Window plus declared lookback — the BASE of this run's writable set
   * (`db/note-settlement.ts`'s `computeSettlementWritableTurnIds` closes it
   * over in-scope edges' external endpoints on top of this).
   *
   * The session-lifetime exposure ledger is deliberately not the gate here.
   * That ledger answers "was this id ever legal to cite", which is right for a
   * citation: naming an old turn in a segment body is additive. A review
   * verdict is destructive — it overwrites type and tags — so an
   * address the model could only have produced from its own imagination must
   * not resolve onto a real row from some earlier window.
   *
   * Tag-mandate ticket 06: the name is now the only trace of "rendered".
   * Nothing here is rendered any more, and the scope this set defines is a
   * WRITE scope — reading is unrestricted (Block A: "Turns outside the set may
   * be read freely whenever they help"), so a turn's absence from it bounds
   * what may be written, never what may be seen.
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
   * [S15069/T963]: "前序注入数量=本窗口 turn 数") — a 10-turn window renders
   * 10 preceding turns, a 30-turn window renders 30 — rather than the old
   * FIXED lookback constant this replaced (a flat count applied regardless
   * of the window's own size; retired history, not this codebase's own
   * `noteSettlementThresholdTurns`, which governs when a window CUTS, not
   * how far its lookback reaches).
   */
  priorTurns?: number;
}

/**
 * Assemble one window's settlement context.
 */
/**
 * Sole-writer full-document budget for the session-summary render: far above
 * any legal narrative size (content guidance ~200 tokens; this is 1000×), so
 * neither the page/turn token caps nor the per-field char cuts ever bite in
 * practice — "practically whole", with the receipt's post-write totals as the
 * drift alarm, per the spec's own residual-risk note.
 */
export const SETTLEMENT_FULL_RENDER_BUDGET = 200_000;

export function buildNoteSettlementContext(
  db: Database,
  job: NoteSettlementJob,
  options: BuildNoteSettlementContextOptions,
): NoteSettlementContext | null {
  // Ticket 14 (P1-3 fix, spec "授权序列渲染前快照"): captured before this
  // context build reads a single turn — the explicit grant block at the
  // bottom of this function uses THIS value, never a fresh lookup at record
  // time (this build does substantial work — turn/note reads, the session
  // narrative render — between here and that call).
  const sequence = snapshotWriteGateSequence(db);

  const session = getSession(db, job.sessionId);
  if (!session) {
    return null;
  }

  const allTurns = getTurnsForSession(db, job.sessionId);

  // Lookback defaults to the window's OWN size (ticket 04: "前序注入数量=本
  // 窗口 turn 数") — a 10-turn window renders 10 preceding turns, a 30-turn
  // window renders 30.
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

  // Tag-mandate ticket 06: an ADDRESS list, nothing more. The collapsed
  // build, the per-turn shadow-note read, the truncation signal and the gap
  // computation all retired with the `## Turns` section they existed to
  // render — a settlement context is a scope declaration now, and every fact
  // about a turn reaches the agent through its own `recall`.
  const renderedTurns: NoteSettlementWindowTurn[] = combinedRecords.map((turn) => ({
    turnId: turn.id,
    sessionId: turn.sessionId,
    promptNumber: turn.promptNumber,
    ref: formatTurnAddress(turn),
  }));

  const priorTurns = renderedTurns.filter(
    (turn) => turn.promptNumber < job.windowStart,
  );
  const windowTurns = renderedTurns.filter(
    (turn) => turn.promptNumber >= job.windowStart,
  );

  // The session's own attachment rows — never a global recency window —
  // projected down to the roster shape (id/title/tag, ticket 05: "结算不读段
  // 的字段"; the topic-registry ticket dropped `topic` along with the registry
  // it named). Lane-model-v12 ticket 15 added the TAG: a segment is one
  // globally unique tag now, `tags[0]` is where it lives, and it is the only
  // thing settlement can write to move a turn between containers.
  const segmentRoster: NoteSettlementSegmentRosterEntry[] = listAttachedSegments(
    db,
    job.sessionId,
  ).map((segment) => ({
    id: segment.id,
    title: segment.title,
    tag: segment.tags[0] ?? null,
    // Peer review A5: the declared lane registry, in the registry's own
    // alphabetical order (`listLanesForSegment`) — a word LIST to pick from,
    // not an activity feed, same ordering the main agent's roster row uses.
    lanes: listLanesForSegment(db, segment.id).map((lane) => lane.tag),
  }));

  const context: NoteSettlementContext = {
    job,
    session,
    windowTurns,
    priorTurns,
    segmentRoster,
    milestoneRendering: renderSessionMilestoneInjection(db, job.sessionId),
    // The UNIFIED renderer, sole-writer-sees-the-whole-document budgets
    // (read-write-contract spec: "结算消费方传大 turn 预算(全文可见)").
    // Settlement is the session narrative's only writer, so its prompt must
    // carry the FULL current title/content — a truncated prefix plus a
    // whole-overwrite is the tail-loss path the peer review named. Ticket 11
    // retired the two char knobs (`truncate`/`truncateCap`) that used to
    // need raising alongside `turn` (C's finding: `turn` alone left the
    // per-field char cut underneath) — every field-level char cap is gone
    // now, so `turn` (the one surviving token budget, applied uniformly to
    // every rendered node kind — see `format.ts`'s `renderNode`) is the only
    // knife left to raise.
    //
    // `readerId: null` (tag-mandate ticket 06) — deliberately NOT the claim
    // writer. This render's licence is recorded by hand below, for the SESSION
    // entity alone. Handing recall the writer id instead would additionally
    // grant, and mark `complete: true`, every TURN row this session card
    // lists, at the 200K budget: an unearned whole-field write licence over
    // turns this run has not read, which is exactly the push-channel grant
    // this ticket retires. Recall's own seam skips session entities
    // (read-write-contract ticket 01: no main-agent session writer exists), so
    // nothing is lost by silencing it here.
    sessionStateRendering: recallMemory(db, {
      id: `S${job.sessionId}`,
      turn: SETTLEMENT_FULL_RENDER_BUDGET,
      readerId: null,
      now: () => options.nowEpoch,
    }),
    reviewableTurnIds: new Set(renderedTurns.map((turn) => turn.turnId)),
    builtAtEpoch: options.nowEpoch,
  };

  // THE ONE SURVIVING GRANT (tag-mandate ticket 06). Ticket 05's
  // "记录读授权 for EVERY rendered turn" batch is GONE with the rendering it
  // licensed, and so is ticket 04's per-field completeness flush: under pull
  // this build shows the agent no turn, so it may license no turn write.
  // What remains is the SESSION entity, whose narrative this build genuinely
  // does render in full, at the sole-writer budget, straight into the prompt
  // — duty 3's `note(session=…)` write consumes exactly this grant
  // (`worker/note-settlement-turn-facade.ts`, `checkFieldGate` on
  // entity_type='session'), and nothing else in the system records it,
  // because recall's own seam deliberately skips session entities.
  //
  // No completeness fact accompanies it, and none is needed: the session
  // write path calls `checkFieldGate` WITHOUT `requireCompleteRead`, so the
  // grant alone is the whole licence. Adding one would be inventing a
  // requirement no caller checks.
  //
  // MUTATION-CHECKED, both directions: deleting this call refuses every
  // session-narrative write with "has not been read this session"; widening
  // it back to the turn ids re-opens the unearned-overwrite hole the pull
  // turn closed.
  recordReadGrant(
    db,
    claimWriterId(job.id, job.claimGeneration),
    "session",
    job.sessionId,
    options.nowEpoch,
    sequence,
  );

  return context;
}

/**
 * The IMMUTABLE WRITABLE SET, resolved from turn ids to the ADDRESSES the
 * prompt declares and every write call takes (tag-mandate ticket 06).
 *
 * Two groups, because the prompt labels two: this job's own WINDOW, and the
 * declared LOOKBACK — everything else the set holds. That remainder is the
 * rendered-lookback turns plus `computeSettlementWritableTurnIds`' own
 * deadlock-guard closure (the external endpoints of in-scope anchored edges),
 * deliberately NOT split further: from the agent's side the two are one
 * "equally writable" region, and a third label would invite the reading that
 * one of them is somehow less writable than the other.
 *
 * Closure ids are the only ones needing a database lookup — they are, by
 * definition, turns this context never listed. A row that has vanished
 * between the closure computation and this call degrades to `turn #<id>`
 * rather than dropping out of the printed set: a set that silently printed
 * fewer addresses than the gate enforces would be the exact fork the spec's
 * "immutable and declared" clause forbids.
 */
export interface SettlementWritableSet {
  /** This job's own window turns, ascending by prompt number. */
  window: string[];
  /** Everything else in the writable set, ascending by [session, prompt]. */
  lookback: string[];
}

export function resolveSettlementWritableSet(
  db: Database,
  context: NoteSettlementContext,
  writableTurnIds: ReadonlySet<number>,
): SettlementWritableSet {
  const windowIds = new Set(context.windowTurns.map((turn) => turn.turnId));
  const known = new Map<number, NoteSettlementWindowTurn>(
    [...context.priorTurns, ...context.windowTurns].map((turn) => [turn.turnId, turn]),
  );

  const window = context.windowTurns
    .filter((turn) => writableTurnIds.has(turn.turnId))
    .map((turn) => turn.ref);

  const lookback = [...writableTurnIds]
    .filter((id) => !windowIds.has(id))
    .map((id) => {
      const rendered = known.get(id);
      if (rendered) {
        return { sessionId: rendered.sessionId, promptNumber: rendered.promptNumber, ref: rendered.ref };
      }
      const turn = getTurnById(db, id);
      return turn
        ? { sessionId: turn.sessionId, promptNumber: turn.promptNumber, ref: formatTurnAddress(turn) }
        : { sessionId: Number.MAX_SAFE_INTEGER, promptNumber: id, ref: `turn #${id}` };
    })
    .sort((a, b) => a.sessionId - b.sessionId || a.promptNumber - b.promptNumber)
    .map((entry) => entry.ref);

  return { window, lookback };
}

/**
 * The writable set's ERROR PROVENANCE (settlement-ergonomics ticket 04, spec
 * D0) — the SAME flat `writableTurnIds` `resolveSettlementWritableSet` above
 * collapses into one `lookback` list, carved instead into three FROZEN,
 * MUTUALLY EXCLUSIVE id sets: this job's own `window`, the DECLARED
 * `baseLookback` (`context.priorTurns` — the rendered lookback), and
 * `closureOnly` (everything `computeSettlementWritableTurnIds`' deadlock-
 * guard closure added that reaches neither bucket above).
 *
 * THIS DOES NOT REOPEN THE COLLAPSE ABOVE. `resolveSettlementWritableSet`'s
 * ruling stands untouched, in its own words: from the agent's side the
 * rendered lookback and the closure endpoints are one "equally writable"
 * region, and a third label would invite the reading that one of them is
 * somehow less writable than the other — that reading is still wrong, and
 * nothing here changes what may be written, how much, or (yet) how it is
 * rendered. What this function adds is a DIFFERENT AXIS: ERROR ORIGIN, for a
 * report that needs to say WHERE a finding anchors (its own window, its
 * declared lookback, or a closure-only endpoint dragged in by an edge), not
 * to re-grade how writable that turn is. Reading a three-way writability
 * split back into this set would be exactly the regression the collapse's
 * own comment warns against — writability is uniform across all three
 * buckets; only their PROVENANCE differs.
 *
 * PRECEDENCE `window > baseLookback > closureOnly`: a turn that sits in the
 * declared lookback AND is also an in-scope edge's external endpoint is
 * classified by the EARLIER rule alone — it was already reachable by
 * lookback, so filing it under `closureOnly` would misstate why it is
 * writable. The loop below checks `window` first, then `baseLookback`, and
 * only falls through to `closureOnly` for an id neither bucket claims; every
 * id in `writableTurnIds` lands in EXACTLY one of the three sets, so their
 * union is `writableTurnIds` itself and no two of them overlap.
 */
export interface SettlementScopeProvenance {
  /** This job's own window (a subset of `writableTurnIds`, by construction all of it). */
  window: Set<number>;
  /** The declared lookback (`context.priorTurns`), minus anything already claimed by `window`. */
  baseLookback: Set<number>;
  /** The deadlock-guard closure's own additions — everything neither `window` nor `baseLookback` claims. */
  closureOnly: Set<number>;
}

export function resolveSettlementScopeProvenance(
  context: NoteSettlementContext,
  writableTurnIds: ReadonlySet<number>,
): SettlementScopeProvenance {
  const windowIds = new Set(context.windowTurns.map((turn) => turn.turnId));
  const lookbackIds = new Set(context.priorTurns.map((turn) => turn.turnId));

  const window = new Set<number>();
  const baseLookback = new Set<number>();
  const closureOnly = new Set<number>();

  for (const id of writableTurnIds) {
    if (windowIds.has(id)) {
      window.add(id);
    } else if (lookbackIds.has(id)) {
      baseLookback.add(id);
    } else {
      closureOnly.add(id);
    }
  }

  return { window, baseLookback, closureOnly };
}
