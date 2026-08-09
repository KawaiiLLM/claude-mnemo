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
import {
  NOTE_REMINDER_DISPLAY_LIMIT,
  NOTE_RELIEF_DRY_TURNS,
  NOTE_RELIEF_PENDING_THRESHOLD,
  renderNoteBacklogRelief,
  selectNoteReminderItems,
} from "../note-reminder";
import type { HookResult, NormalizedHookInput } from "../types";

/**
 * The backlog-relief injection (spec D2's 积压泄压批次, 裁决 21): the only
 * pending-notes text that arrives at the START of a turn.
 *
 * The ordinary reminder deliberately rides a tool result. Prompting at turn
 * start was tried and ruled out — it reads as an instruction to act, and the
 * agent opens tool calls it did not need. That ruling stands; this path is a
 * narrow exception to it, and its safety is entirely in the two properties that
 * bound it:
 *
 *  - it fires only from a state that proves the piggyback channel has stopped
 *    working (a five-deep writable backlog that five finished turns failed to
 *    drain), so a session where notes get written normally never sees it; and
 *  - the text it injects spends the exception explicitly and only on note
 *    calls, so the batch it authorises cannot become the "started a tool call
 *    for housekeeping" failure the standing rule exists to prevent.
 *
 * Ledger ownership is unchanged (R2#P2-6): this entry writes exactly what the
 * PostToolUse reminder writes — its claim and its exposure rows — and no debt
 * transition. It also never lists a rolled-back debt, because announcing one is
 * what closes it, and closing is a transition this side may not perform.
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

  return async function handleNoteBacklogRelief(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (input.eventName !== "UserPromptSubmit") {
      return { continue: true };
    }
    // A subagent has neither the ledger's addresses nor the authority to write
    // notes for the root session's turns.
    if (input.agentId !== undefined) {
      return { continue: true };
    }
    if (!input.sessionId) {
      return { continue: true };
    }

    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }

    // The turn this injection rides. UserPromptSubmit hooks run in parallel, so
    // depending on which process wins, this is either the turn the user just
    // submitted (the `session-init` entry created it) or the one before it.
    // Either is a valid ride turn for the exposure rows, and either re-arms the
    // relief for at least the required number of finished turns — the race can
    // only delay the next relief by one turn, never fire one early.
    const rideTurn = getLatestTurn(dependencies.db, session.id);
    if (!rideTurn) {
      return { continue: true };
    }

    const relief = getNoteReliefState(dependencies.db, session.id);
    if (relief.dryTurns < dryTurnsThreshold) {
      return { continue: true };
    }

    // Writable debts only, on both the gate and the list. A rolled-back notice
    // would have to close its debt to avoid repeating forever, and this entry
    // does not close debts.
    const writable = listOpenNoteDebt(dependencies.db, session.id, {
      latestPromptNumber: rideTurn.promptNumber,
      agingTurns,
    }).filter((debt) => !debt.wasRolledBack);
    if (writable.length < pendingThreshold) {
      return { continue: true };
    }

    const view = selectNoteReminderItems(writable, displayLimit);
    const renderedTurnIds = view.writable.map((debt) => debt.turnId);

    try {
      const claimed = writeTransaction(dependencies.db, () => {
        // The claim and the exposure rows commit together: a relief the agent
        // was shown but that never re-armed would fire again on the next
        // prompt, and one that re-armed without being shown would silence the
        // channel for five turns for nothing.
        if (
          !claimNoteBacklogRelief(dependencies.db, {
            sessionId: session.id,
            firePromptNumber: rideTurn.promptNumber,
            nowEpoch: now(),
          })
        ) {
          return false;
        }

        recordNoteIdExposure(dependencies.db, {
          sessionId: session.id,
          rideTurnId: rideTurn.id,
          exposedTurnIds: renderedTurnIds,
          // `injection`, not `reminder`: this is prompt-time context, and the
          // reminder path's own gates read the `reminder` rows to decide what
          // it has already shown. Filing these as `reminder` would silence the
          // ordinary reminder for the rest of the turn — or not, depending on
          // which UserPromptSubmit process won the race for the ride turn.
          source: "injection",
          nowEpoch: now(),
        });
        return true;
      });

      if (!claimed) {
        return { continue: true };
      }
    } catch (error) {
      // Unlike the reminder, a failed write here costs the injection too. The
      // claim IS the one-shot: rendering without it would repeat this standing
      // authorisation on every prompt until a write finally succeeds. The
      // trigger state persists, so the next prompt tries again.
      dependencies.logger?.warn?.("note backlog relief not claimed", {
        sessionId: input.sessionId,
        reasonCode: "relief-claim-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return { continue: true };
    }

    return {
      continue: true,
      hookSpecificOutput: renderNoteBacklogRelief(view),
    };
  };
}
