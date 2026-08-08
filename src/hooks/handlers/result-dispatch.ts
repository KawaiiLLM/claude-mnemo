import type { Database } from "bun:sqlite";

import {
  createPostToolUseDispatcher,
  type PreToolUseDispatcherDependencies,
} from "../../rules/pretooluse-dispatcher";
import { createNoteReminderHandler } from "./note-reminder";
import type { HookHandler, HookResult, NormalizedHookInput } from "../types";

/**
 * The `result-dispatch` PostToolUse entry: everything that answers a tool result
 * with text for the model.
 *
 * PostToolUse has exactly two registrations and they divide by response shape,
 * not by feature (R2#P2-6): this one returns `additionalContext` and never wakes
 * the worker, `tool-use` wakes the worker and never returns context. A third
 * registration would not fix the exclusivity — the runner emits `asyncWork` or
 * `additionalContext` per handler — it would only add another process per tool
 * call, so the rule-digest tips and the pending-notes reminder share this one.
 */

export interface ResultDispatchDependencies
  extends PreToolUseDispatcherDependencies {
  db?: Database;
  now?: () => number;
}

export function createResultDispatchHandler(
  dependencies: ResultDispatchDependencies = {},
): HookHandler {
  const { db, now, ...dispatcherDependencies } = dependencies;
  const ruleDispatcher = createPostToolUseDispatcher(dispatcherDependencies);
  const noteReminder = db
    ? createNoteReminderHandler({ db, now })
    : undefined;

  return async function handleResultDispatch(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    const sections: string[] = [];

    const rules = await ruleDispatcher(input);
    if (rules.hookSpecificOutput) {
      sections.push(rules.hookSpecificOutput);
    }

    if (noteReminder) {
      const reminder = await noteReminder(input);
      if (reminder.hookSpecificOutput) {
        sections.push(reminder.hookSpecificOutput);
      }
    }

    return sections.length > 0
      ? { continue: true, hookSpecificOutput: sections.join("\n\n") }
      : { continue: true };
  };
}
