import { createLogger } from "../../shared/logger";
import {
  createUserPromptSubmitDispatcher,
  type PreToolUseDispatcherDependencies,
} from "../../rules/pretooluse-dispatcher";
import type { HookHandler, HookResult, NormalizedHookInput } from "../types";

/**
 * The `prompt-dispatch` UserPromptSubmit entry: the rule-digest tips, and
 * nothing else.
 *
 * UserPromptSubmit keeps exactly two registrations: `session-init` owns the
 * turn row and, in the same transaction, renders the current-turn address
 * line together with its owed suffix and the backlog-relief block (spec
 * D1/D3/D4/D9) — it is the only process that knows the new turn's number
 * without racing, so it is also the only process allowed to render anything
 * that depends on it. This entry carries everything else, which today is
 * only the rule digest.
 *
 * Before note-prompt-clock this file also rendered the backlog relief, with
 * its own claim and its own reading of a ride turn that could disagree with
 * `session-init`'s (裁决 21/25's dual-process race, and Codex review P2-9).
 * That entire race is gone by construction now, not resolved: a database
 * this process no longer opens cannot race anyone over what it shows.
 */

export interface PromptDispatchDependencies
  extends PreToolUseDispatcherDependencies {
  logger?: Pick<Console, "warn">;
}

export function createPromptDispatchHandler(
  dependencies: PromptDispatchDependencies = {},
): HookHandler {
  const { logger: injectedLogger, ...dispatcherDependencies } = dependencies;
  const ruleDispatcher = createUserPromptSubmitDispatcher(dispatcherDependencies);
  // The log file rather than `console`: a hook that returns successfully has
  // its stderr discarded, so a console warning here would be written nowhere
  // anyone can read it.
  const logger = injectedLogger ?? createLogger("HOOK");

  return async function handlePromptDispatch(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    let rules: HookResult | null;
    try {
      rules = await ruleDispatcher(input);
    } catch (error) {
      logger.warn?.("prompt-dispatch section failed", {
        sessionId: input.sessionId ?? null,
        reasonCode: "rule-dispatch",
        error: error instanceof Error ? error.message : String(error),
      });
      rules = null;
    }

    return rules?.hookSpecificOutput
      ? { continue: true, hookSpecificOutput: rules.hookSpecificOutput }
      : { continue: true };
  };
}
