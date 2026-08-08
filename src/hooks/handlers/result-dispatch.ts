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
  logger?: Pick<Console, "warn">;
}

export function createResultDispatchHandler(
  dependencies: ResultDispatchDependencies = {},
): HookHandler {
  const { db, now, logger, ...dispatcherDependencies } = dependencies;
  const ruleDispatcher = createPostToolUseDispatcher(dispatcherDependencies);
  const noteReminder = db
    ? createNoteReminderHandler({ db, now, logger })
    : undefined;

  /**
   * Two features share one process, so they must not share one fate. The rule
   * digest is pure file/rule state; the reminder touches a database that a
   * concurrent `tool-use` process may hold. Letting either throw would reach
   * runHookCommand's catch-all, which answers with a bare non-blocking exit —
   * and that would silently regress the rule output this entry shipped with
   * long before the reminder existed. Each section is therefore attempted
   * independently and a failure costs only its own section.
   */
  async function section(
    name: string,
    run: () => HookResult | Promise<HookResult>,
    input: NormalizedHookInput,
  ): Promise<string | null> {
    try {
      return (await run()).hookSpecificOutput ?? null;
    } catch (error) {
      (logger ?? console).warn?.("result-dispatch section failed", {
        sessionId: input.sessionId ?? null,
        reasonCode: name,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return async function handleResultDispatch(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    const sections: string[] = [];

    const rules = await section(
      "rule-dispatch",
      () => ruleDispatcher(input),
      input,
    );
    if (rules) {
      sections.push(rules);
    }

    if (noteReminder) {
      const reminder = await section(
        "note-reminder",
        () => noteReminder(input),
        input,
      );
      if (reminder) {
        sections.push(reminder);
      }
    }

    return sections.length > 0
      ? { continue: true, hookSpecificOutput: sections.join("\n\n") }
      : { continue: true };
  };
}
