import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import {
  closeRolledBackNoteDebts,
  listOpenNoteDebt,
  markNoteDebtsReminded,
  recordNoteIdExposure,
  NOTE_DEBT_AGING_TURNS,
} from "../../db/note-debt";
import { getSessionByContentId } from "../../db/sessions";
import { getLatestTurn } from "../../db/turns";
import {
  NOTE_REMINDER_DISPLAY_LIMIT,
  renderNoteReminder,
  selectNoteReminderItems,
  type NoteReminderView,
} from "../note-reminder";
import type { HookResult, NormalizedHookInput } from "../types";

/**
 * The ordinary pending-notes reminder, a section of the synchronous
 * UserPromptSubmit entry (裁决 22).
 *
 * It used to ride a tool result. That placement is not merely suboptimal, it is
 * unaffordable: Claude Code renders PostToolUse `additionalContext` as a
 * floating attachment which is re-rendered every time the request is assembled,
 * so text whose bytes change as the pending list evolves rewrites the tail of
 * the previous turn at each boundary, kills the message-side cache breakpoint,
 * and re-ingests the whole conversation prefix at cache-write price. Context
 * that arrives with the user's prompt is written into the user message once and
 * never re-rendered, so it can change freely between turns.
 *
 * Moving it to turn start costs the property the old placement bought for free —
 * a question-and-answer turn produces no tool result, so it could not be
 * interrupted — and the wording is what buys it back: notes ride a batch the
 * turn was opening anyway, and a turn that needs no tools leaves the debt.
 *
 * A debt is listed AT MOST ONCE by this path, and the marker that guarantees it
 * is written in the same transaction as the emission. Letting an ask pass is
 * therefore final for this channel; the backlog relief (裁决 21) is the
 * recovery, and it is the only path allowed to ask twice.
 */

export interface NoteReminderHandlerDependencies {
  db: Database;
  now?: () => number;
  agingTurns?: number;
  displayLimit?: number;
  runHookWriteTransaction?: typeof runHookWriteTransaction;
  logger?: Pick<Console, "warn">;
}

/** 裁决 22: the ordinary path asks for a debt exactly once, ever. */
function neverAsked(debt: { remindedAtEpoch: number | null }): boolean {
  return debt.remindedAtEpoch === null;
}

function hasSomethingToSay(view: NoteReminderView): boolean {
  return view.writable.length > 0 || view.rolledBack.length > 0;
}

export function createNoteReminderHandler(
  dependencies: NoteReminderHandlerDependencies,
) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const agingTurns = dependencies.agingTurns ?? NOTE_DEBT_AGING_TURNS;
  const displayLimit = dependencies.displayLimit ?? NOTE_REMINDER_DISPLAY_LIMIT;
  const writeTransaction =
    dependencies.runHookWriteTransaction ?? runHookWriteTransaction;
  // Defaulted here rather than left optional, the way every other handler in
  // this directory treats its logger: the production wiring injects none, and
  // the failure policy below is "stay silent and warn" — without a default the
  // warn half of it does not exist where it is actually needed.
  const logger = dependencies.logger ?? console;

  return async function handleNoteReminderHook(
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

    // The turn this reminder rides. UserPromptSubmit hooks run in parallel, so
    // depending on which process wins, this is either the turn the user just
    // submitted (the `session-init` entry created it) or the one before it.
    // Either is a valid ride turn for the exposure rows, and neither changes
    // which debts are eligible — the marker does that, and it is per debt.
    const rideTurn = getLatestTurn(dependencies.db, session.id);
    if (!rideTurn) {
      return { continue: true };
    }

    // A fast path only: it decides whether opening a write transaction is worth
    // it at all. The decision itself is re-made under the write lock below.
    const open = listOpenNoteDebt(dependencies.db, session.id, {
      latestPromptNumber: rideTurn.promptNumber,
      agingTurns,
    });
    if (!hasSomethingToSay(selectNoteReminderItems(open, displayLimit, neverAsked))) {
      return { continue: true };
    }

    let claimed: NoteReminderView | null = null;
    try {
      claimed = writeTransaction(dependencies.db, (): NoteReminderView | null => {
        // The list is re-read inside the transaction and the marker is written
        // from it, so the claim and the emission cannot disagree. A second
        // process that selected the same debts finds them marked here, renders
        // nothing, and writes nothing — "one debt, one ask" holds under
        // concurrency rather than merely being likely.
        const stillOpen = listOpenNoteDebt(dependencies.db, session.id, {
          latestPromptNumber: rideTurn.promptNumber,
          agingTurns,
        });
        const view = selectNoteReminderItems(stillOpen, displayLimit, neverAsked);
        if (!hasSomethingToSay(view)) {
          return null;
        }

        // The marker and the closure commit BEFORE the text reaches stdout, so
        // a hook killed in between marks a reminder nobody saw. That ordering
        // is the deliberate one: delivery is unobservable from here — Claude
        // Code can drop this output after the write too — so the only choice is
        // which way to fail. Printing first and marking after re-asks whenever
        // the marker write fails, which breaks the at-most-once rule outright;
        // marking first loses at most one delivery, and the backlog relief
        // (which ignores the marker) and the 50-turn aging bound both recover
        // it. An unseen rolled-back closure loses only a courtesy line: closed
        // is that debt's designed end state either way.
        const nowEpoch = now();
        markNoteDebtsReminded(
          dependencies.db,
          view.writable.map((debt) => debt.turnId),
          nowEpoch,
        );
        recordNoteIdExposure(dependencies.db, {
          sessionId: session.id,
          rideTurnId: rideTurn.id,
          exposedTurnIds: [
            ...view.writable.map((debt) => debt.turnId),
            ...view.rolledBack.map((debt) => debt.turnId),
          ],
          source: "reminder",
          nowEpoch,
        });

        // A rolled-back notice is closed by the act of showing it (user story
        // 5), in the same flow rather than on some later reconcile: a session
        // that ends right after this reminder would otherwise leave the debt
        // pending permanently, with nothing left to run that could close it.
        closeRolledBackNoteDebts(
          dependencies.db,
          view.rolledBack.map((debt) => debt.turnId),
          nowEpoch,
        );
        return view;
      });
    } catch (error) {
      // A failed write now costs the reminder itself, where the PostToolUse
      // version rendered anyway and treated the exposure row as mere
      // bookkeeping. Two things changed with 裁决 22: the marker IS the
      // at-most-once rule, so text without it re-asks on the next prompt; and a
      // rolled-back notice that renders without its closure repeats on every
      // prompt until some later reconcile happens to run. Staying silent costs
      // one prompt's reminder — the debts are untouched, so the next prompt
      // tries again.
      logger.warn?.("note reminder not claimed", {
        sessionId: input.sessionId,
        reasonCode: "reminder-claim-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return { continue: true };
    }

    if (!claimed) {
      return { continue: true };
    }

    return {
      continue: true,
      hookSpecificOutput: renderNoteReminder(claimed),
    };
  };
}
