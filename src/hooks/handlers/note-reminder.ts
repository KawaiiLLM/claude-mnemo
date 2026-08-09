import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import {
  closeRolledBackNoteDebts,
  getExposedTurnIds,
  hasReminderForRideTurn,
  listOpenNoteDebt,
  recordNoteIdExposure,
  NOTE_DEBT_AGING_TURNS,
} from "../../db/note-debt";
import { getSessionByContentId } from "../../db/sessions";
import { getLatestTurn } from "../../db/turns";
import { isNoteToolName } from "../../shared/note-tool";
import {
  NOTE_REMINDER_DISPLAY_LIMIT,
  renderNoteReminder,
  selectNoteReminderItems,
  type NoteReminderView,
} from "../note-reminder";
import type { HookResult, NormalizedHookInput } from "../types";

/**
 * The synchronous half of the PostToolUse pair (spec D2, R1#11/R2#P2-6): it
 * returns the pending-notes reminder as `additionalContext` and therefore may
 * never return `asyncWork` — the hook runner emits one or the other. Everything
 * it needs about the ledger it reads; what it writes is exactly what only the
 * renderer can know — the exposure rows for the ids it just rendered, and the
 * closure of the rolled-back debts whose notice those rows record. Both are
 * best-effort: a write failure costs bookkeeping, never the reminder itself.
 *
 * The reminder rides a tool result rather than a turn boundary on purpose: a
 * pure question-and-answer turn produces no tool result, so it structurally
 * cannot be interrupted by memory housekeeping, and the agent is never nudged
 * into starting a tool call it did not need.
 */

export interface NoteReminderHandlerDependencies {
  db: Database;
  now?: () => number;
  agingTurns?: number;
  displayLimit?: number;
  runHookWriteTransaction?: typeof runHookWriteTransaction;
  logger?: Pick<Console, "warn">;
}

export function createNoteReminderHandler(
  dependencies: NoteReminderHandlerDependencies,
) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const agingTurns = dependencies.agingTurns ?? NOTE_DEBT_AGING_TURNS;
  const displayLimit = dependencies.displayLimit ?? NOTE_REMINDER_DISPLAY_LIMIT;
  const writeTransaction =
    dependencies.runHookWriteTransaction ?? runHookWriteTransaction;

  return async function handleNoteReminderHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (input.eventName !== "PostToolUse") {
      return { continue: true };
    }
    // A subagent has neither the ledger's addresses nor the authority to write
    // notes for the root session's turns.
    if (input.agentId !== undefined) {
      return { continue: true };
    }
    if (!input.sessionId || !input.toolName) {
      return { continue: true };
    }
    // Self-excitation guard (D2): the note call's own result must not carry the
    // reminder that asks for another note.
    if (isNoteToolName(input.toolName)) {
      return { continue: true };
    }

    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }

    const rideTurn = getLatestTurn(dependencies.db, session.id);
    if (!rideTurn) {
      return { continue: true };
    }

    const open = listOpenNoteDebt(dependencies.db, session.id, {
      latestPromptNumber: rideTurn.promptNumber,
      agingTurns,
    });
    if (open.length === 0) {
      return { continue: true };
    }

    if (hasReminderForRideTurn(dependencies.db, session.id, rideTurn.id)) {
      return { continue: true };
    }

    // The gate is on what this reminder would RENDER, not on the whole ledger.
    // Testing the ledger meant a backlog deeper than the display limit could
    // never be fully exposed — the sixth debt stayed unshown, "everything has
    // been shown" stayed false, and the identical five-line reminder repeated on
    // every single tool result. An item the agent has already been shown does
    // not earn a second interruption, so the reminder fires only when the lines
    // it is about to write contain at least one turn id this session has never
    // shown.
    const view: NoteReminderView = selectNoteReminderItems(open, displayLimit);
    const renderedTurnIds = [
      ...view.writable.map((debt) => debt.turnId),
      ...view.rolledBack.map((debt) => debt.turnId),
    ];
    const exposed = getExposedTurnIds(dependencies.db, session.id, "reminder");
    if (renderedTurnIds.every((turnId) => exposed.has(turnId))) {
      return { continue: true };
    }

    try {
      // A batch of parallel tool calls fires this hook in several processes at
      // once, all riding the same turn, so the at-most-once rule needs a claim
      // rather than a check: the re-read and the exposure insert run together
      // inside one immediate transaction, and the loser of that race renders
      // nothing. (The read above is only a fast path that avoids opening a write
      // transaction for a turn that plainly needs no reminder.)
      const claimed = writeTransaction(dependencies.db, () => {
        if (hasReminderForRideTurn(dependencies.db, session.id, rideTurn.id)) {
          return false;
        }

        recordNoteIdExposure(dependencies.db, {
          sessionId: session.id,
          rideTurnId: rideTurn.id,
          exposedTurnIds: renderedTurnIds,
          source: "reminder",
          nowEpoch: now(),
        });

        // A rolled-back notice is closed by the act of showing it (user story
        // 5), in the same flow rather than on some later reconcile: a session
        // that ends right after this reminder would otherwise leave the debt
        // pending permanently, with nothing left to run that could close it.
        closeRolledBackNoteDebts(
          dependencies.db,
          view.rolledBack.map((debt) => debt.turnId),
          now(),
        );
        return true;
      });

      if (!claimed) {
        return { continue: true };
      }
    } catch (error) {
      // A contended database must not cost the agent the reminder. Rendering is
      // the point; the exposure row is bookkeeping, and losing it only risks
      // showing the same line again, which is strictly better than a debt that
      // never gets mentioned. The failure is logged, never swallowed silently.
      dependencies.logger?.warn?.("note reminder exposure not recorded", {
        sessionId: input.sessionId,
        reasonCode: "exposure-write-failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      continue: true,
      hookSpecificOutput: renderNoteReminder(view),
    };
  };
}
