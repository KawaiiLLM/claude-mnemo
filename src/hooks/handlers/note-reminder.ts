import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import {
  getExposedTurnIds,
  hasReminderForRideTurn,
  listOpenNoteDebt,
  recordNoteIdExposure,
  NOTE_DEBT_AGING_TURNS,
} from "../../db/note-debt";
import { getSessionByContentId } from "../../db/sessions";
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
 * it needs about the ledger it reads; the only rows it writes are exposure rows,
 * which record what it just rendered and are the fact nobody else can observe.
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

function getLatestTurn(
  db: Database,
  sessionDbId: number,
): { id: number; promptNumber: number } | null {
  return (
    db
      .query<{ id: number; promptNumber: number }, [number]>(
        `SELECT id, prompt_number AS promptNumber FROM turns
         WHERE session_id = ? ORDER BY prompt_number DESC LIMIT 1`,
      )
      .get(sessionDbId) ?? null
  );
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

    let view: NoteReminderView | null = null;
    try {
      view = writeTransaction(dependencies.db, () => {
        if (hasReminderForRideTurn(dependencies.db, session.id, rideTurn.id)) {
          return null;
        }

        // "Only when the list grew": an item the agent has already been shown
        // does not earn a second interruption. Skipping costs another reminder
        // only once a new debt appears.
        const exposed = getExposedTurnIds(dependencies.db, session.id, "reminder");
        if (open.every((debt) => exposed.has(debt.turnId))) {
          return null;
        }

        const selected = selectNoteReminderItems(open, displayLimit);
        recordNoteIdExposure(dependencies.db, {
          sessionId: session.id,
          rideTurnId: rideTurn.id,
          exposedTurnIds: [
            ...selected.writable.map((debt) => debt.turnId),
            ...selected.rolledBack.map((debt) => debt.turnId),
          ],
          source: "reminder",
          nowEpoch: now(),
        });

        return selected;
      });
    } catch (error) {
      // A contended database must not fail the tool call; the next tool result
      // carries the reminder instead.
      dependencies.logger?.warn?.("note reminder skipped", {
        sessionId: input.sessionId,
        reasonCode: "exposure-write-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return { continue: true };
    }

    if (!view) {
      return { continue: true };
    }

    return {
      continue: true,
      hookSpecificOutput: renderNoteReminder(view),
    };
  };
}
