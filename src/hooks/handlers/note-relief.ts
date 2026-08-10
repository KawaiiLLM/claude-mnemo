import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import {
  claimNoteBacklogRelief,
  getNoteReliefState,
  listOpenNoteDebt,
  recordNoteIdExposure,
  NOTE_DEBT_AGING_TURNS,
} from "../../db/note-debt";
import { getSessionByContentId } from "../../db/sessions";
import { getLatestTurn } from "../../db/turns";
import { createLogger } from "../../shared/logger";
import {
  NOTE_REMINDER_DISPLAY_LIMIT,
  NOTE_RELIEF_DRY_TURNS,
  NOTE_RELIEF_PENDING_THRESHOLD,
  renderNoteBacklogRelief,
  selectNoteReminderItems,
  type NoteReminderView,
} from "../note-reminder";
import type { HookResult, NormalizedHookInput } from "../types";

/**
 * The backlog-relief injection (spec D2's 积压泄压批次, 裁决 21): since 裁决 25
 * the only pending-notes list mnemo has at all — the current-turn protocol
 * writes each turn's note during the turn itself, and the turns it misses
 * accumulate here.
 *
 * Authorising a dedicated batch of note calls contradicts the standing rule
 * ("never start a tool call just to write a note"), and its safety is entirely
 * in the two properties that bound it:
 *
 *  - it fires only from a state that proves the ordinary protocol has stopped
 *    keeping up (a five-deep writable backlog that five finished turns failed
 *    to drain), so a session where notes get written normally never sees it;
 *    and
 *  - the text it injects spends the exception explicitly and only on note
 *    calls, so the batch it authorises cannot become the "started a tool call
 *    for housekeeping" failure the standing rule exists to prevent.
 *
 * Ledger ownership is unchanged (R2#P2-6): this entry writes its claim and its
 * exposure rows, and no debt transition. It never lists a rolled-back debt —
 * those close silently at reconcile (裁决 25).
 */

export interface NoteBacklogReliefDependencies {
  db: Database;
  now?: () => number;
  agingTurns?: number;
  displayLimit?: number;
  pendingThreshold?: number;
  dryTurns?: number;
  runHookWriteTransaction?: typeof runHookWriteTransaction;
  logger?: Pick<Console, "warn">;
}

/**
 * Why the caller cannot read this off the rendered text: "no text" covers two
 * opposite states. `not-eligible` means the valve was shut and the ordinary
 * reminder owns the prompt; `eligible-not-claimed` means the valve was open and
 * this process lost the one-shot — the relief IS being shown, by the sibling
 * UserPromptSubmit process that won, or it will be on the next prompt. Letting
 * the reminder run there would put two contradictory lists on one prompt and,
 * worse, MARK the debts the relief is re-listing.
 */
export type NoteBacklogReliefOutcome =
  | "fired"
  | "not-eligible"
  | "eligible-not-claimed";

export interface NoteBacklogReliefResult extends HookResult {
  reliefOutcome: NoteBacklogReliefOutcome;
}

/** What the claim transaction decided, and the list it claimed if it won. */
interface NoteBacklogReliefClaim {
  outcome: NoteBacklogReliefOutcome;
  view: NoteReminderView | null;
}

export function createNoteBacklogReliefHandler(
  dependencies: NoteBacklogReliefDependencies,
) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const agingTurns = dependencies.agingTurns ?? NOTE_DEBT_AGING_TURNS;
  const displayLimit = dependencies.displayLimit ?? NOTE_REMINDER_DISPLAY_LIMIT;
  const pendingThreshold =
    dependencies.pendingThreshold ?? NOTE_RELIEF_PENDING_THRESHOLD;
  const dryTurnsThreshold = dependencies.dryTurns ?? NOTE_RELIEF_DRY_TURNS;
  const writeTransaction =
    dependencies.runHookWriteTransaction ?? runHookWriteTransaction;
  // Defaulted here rather than left optional, the way every other handler in
  // this directory treats its logger: the production wiring injects none, and
  // the failure policy below is "stay silent and warn" — without a default the
  // warn half of it does not exist where it is actually needed. The log file,
  // not `console`: this hook returns successfully after a lost claim, and a
  // successful hook's stderr is discarded unread.
  const logger = dependencies.logger ?? createLogger("HOOK");

  return async function handleNoteBacklogRelief(
    input: NormalizedHookInput,
  ): Promise<NoteBacklogReliefResult> {
    if (input.eventName !== "UserPromptSubmit") {
      return { continue: true, reliefOutcome: "not-eligible" };
    }
    // A subagent has neither the ledger's addresses nor the authority to write
    // notes for the root session's turns.
    if (input.agentId !== undefined) {
      return { continue: true, reliefOutcome: "not-eligible" };
    }
    if (!input.sessionId) {
      return { continue: true, reliefOutcome: "not-eligible" };
    }

    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true, reliefOutcome: "not-eligible" };
    }

    // The turn this injection rides. UserPromptSubmit hooks run in parallel, so
    // depending on which process wins, this is either the turn the user just
    // submitted (the `session-init` entry created it) or the one before it.
    // Either is a valid ride turn for the exposure rows, and either re-arms the
    // relief for at least the required number of finished turns — the race can
    // only delay the next relief by one turn, never fire one early.
    const rideTurn = getLatestTurn(dependencies.db, session.id);
    if (!rideTurn) {
      return { continue: true, reliefOutcome: "not-eligible" };
    }

    // Everything from here to the transaction is a fast path: it decides
    // whether opening a write transaction is worth it at all, and it reads the
    // watermark the claim will swap on. It decides nothing on its own — two
    // parallel processes both pass these gates, which is exactly the race the
    // transaction below settles.
    const relief = getNoteReliefState(dependencies.db, session.id);
    if (relief.dryTurns < dryTurnsThreshold) {
      return { continue: true, reliefOutcome: "not-eligible" };
    }

    // Writable debts only, on both the gate and the list. A rolled-back notice
    // would have to close its debt to avoid repeating forever, and this entry
    // does not close debts.
    const writable = listOpenNoteDebt(dependencies.db, session.id, {
      latestPromptNumber: rideTurn.promptNumber,
      agingTurns,
    }).filter((debt) => !debt.wasRolledBack);
    if (writable.length < pendingThreshold) {
      return { continue: true, reliefOutcome: "not-eligible" };
    }

    let claimed: NoteBacklogReliefClaim;
    try {
      claimed = writeTransaction(dependencies.db, (): NoteBacklogReliefClaim => {
        // Both gates are re-read here, under the write lock, and the claim
        // swaps on the watermark the fast path saw. That is what makes one
        // relief per streak true rather than likely: two UserPromptSubmit
        // processes can be looking at different ride turns (the one the user
        // just submitted, or the one before it, depending on whether
        // `session-init` had created the row yet), so nothing about the value
        // each carries distinguishes the winner from the loser. Re-deciding
        // inside the transaction does: the first to commit moves the relief
        // watermark to its own ride turn, which is at or past every finished
        // turn, so the second finds a dry streak of zero and stands down.
        const settled = getNoteReliefState(dependencies.db, session.id);
        // A watermark that moved says the streak was spent by someone else, and
        // that is a lost claim, not a shut valve — read the watermark rather
        // than the dry streak it feeds, because a note written concurrently
        // also collapses the streak and that one really is "not eligible".
        if (settled.lastReliefPromptNumber > relief.lastReliefPromptNumber) {
          return { outcome: "eligible-not-claimed", view: null };
        }
        if (settled.dryTurns < dryTurnsThreshold) {
          return { outcome: "not-eligible", view: null };
        }

        const stillOpen = listOpenNoteDebt(dependencies.db, session.id, {
          latestPromptNumber: rideTurn.promptNumber,
          agingTurns,
        }).filter((debt) => !debt.wasRolledBack);
        if (stillOpen.length < pendingThreshold) {
          return { outcome: "not-eligible", view: null };
        }

        // The claim and the exposure rows commit together: a relief the agent
        // was shown but that never re-armed would fire again on the next
        // prompt, and one that re-armed without being shown would silence the
        // channel for five turns for nothing.
        if (
          !claimNoteBacklogRelief(dependencies.db, {
            sessionId: session.id,
            firePromptNumber: rideTurn.promptNumber,
            previousReliefPromptNumber: relief.lastReliefPromptNumber,
            nowEpoch: now(),
          })
        ) {
          return { outcome: "eligible-not-claimed", view: null };
        }

        const view = selectNoteReminderItems(stillOpen, displayLimit);
        recordNoteIdExposure(dependencies.db, {
          sessionId: session.id,
          rideTurnId: rideTurn.id,
          exposedTurnIds: view.writable.map((debt) => debt.turnId),
          // `injection`, not `reminder`: this is prompt-time context, and the
          // reminder path's own gates read the `reminder` rows to decide what
          // it has already shown. Filing these as `reminder` would silence the
          // ordinary reminder for the rest of the turn — or not, depending on
          // which UserPromptSubmit process won the race for the ride turn.
          source: "injection",
          nowEpoch: now(),
        });
        return { outcome: "fired", view };
      });
    } catch (error) {
      // Unlike the reminder, a failed write here costs the injection too. The
      // claim IS the one-shot: rendering without it would repeat this standing
      // authorisation on every prompt until a write finally succeeds. The
      // trigger state persists, so the next prompt tries again.
      logger.warn?.("note backlog relief not claimed", {
        sessionId: input.sessionId,
        reasonCode: "relief-claim-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      // Both gates were open when this process looked, so the caller must treat
      // the prompt as the relief's: a busy timeout here says nothing about
      // whether a sibling process is showing the list.
      return { continue: true, reliefOutcome: "eligible-not-claimed" };
    }

    if (!claimed.view) {
      return { continue: true, reliefOutcome: claimed.outcome };
    }

    return {
      continue: true,
      reliefOutcome: "fired",
      hookSpecificOutput: renderNoteBacklogRelief(claimed.view),
    };
  };
}
