import type { Database } from "bun:sqlite";

import {
  createUserPromptSubmitDispatcher,
  type PreToolUseDispatcherDependencies,
} from "../../rules/pretooluse-dispatcher";
import { createNoteBacklogReliefHandler } from "./note-relief";
import type { HookHandler, HookResult, NormalizedHookInput } from "../types";

/**
 * The `prompt-dispatch` UserPromptSubmit entry: everything that answers a new
 * user prompt with text for the model.
 *
 * UserPromptSubmit keeps exactly two registrations, split by response shape
 * rather than by feature — the same rule PostToolUse follows (R1#11/R2#P2-6).
 * `session-init` owns the turn row and returns no context; this one returns
 * `additionalContext` and writes nothing but its own claim. A third
 * registration would buy nothing and cost another process on every prompt the
 * user types, so the rule-digest tips and the note backlog relief share this
 * one.
 */

export interface PromptDispatchDependencies
  extends PreToolUseDispatcherDependencies {
  db?: Database;
  now?: () => number;
  logger?: Pick<Console, "warn">;
}

export function createPromptDispatchHandler(
  dependencies: PromptDispatchDependencies = {},
): HookHandler {
  const { db, now, logger, ...dispatcherDependencies } = dependencies;
  const ruleDispatcher = createUserPromptSubmitDispatcher(dispatcherDependencies);
  const backlogRelief = db
    ? createNoteBacklogReliefHandler({ db, now, logger })
    : undefined;

  /**
   * Two features share one process, so they must not share one fate: the rule
   * digest is pure file/rule state, while the relief touches a database a
   * concurrent `session-init` process may hold. An uncaught throw would reach
   * runHookCommand's catch-all, which answers with a bare non-blocking exit and
   * would silently drop the rule output that shipped long before notes existed.
   */
  async function section(
    name: string,
    run: () => HookResult | Promise<HookResult>,
    input: NormalizedHookInput,
  ): Promise<string | null> {
    try {
      return (await run()).hookSpecificOutput ?? null;
    } catch (error) {
      (logger ?? console).warn?.("prompt-dispatch section failed", {
        sessionId: input.sessionId ?? null,
        reasonCode: name,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return async function handlePromptDispatch(
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

    if (backlogRelief) {
      const relief = await section(
        "note-relief",
        () => backlogRelief(input),
        input,
      );
      if (relief) {
        sections.push(relief);
      }
    }

    return sections.length > 0
      ? { continue: true, hookSpecificOutput: sections.join("\n\n") }
      : { continue: true };
  };
}
