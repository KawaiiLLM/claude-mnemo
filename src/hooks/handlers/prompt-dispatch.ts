import type { Database } from "bun:sqlite";

import { createLogger } from "../../shared/logger";
import {
  createUserPromptSubmitDispatcher,
  type PreToolUseDispatcherDependencies,
} from "../../rules/pretooluse-dispatcher";
import { createNoteBacklogReliefHandler } from "./note-relief";
import type { HookHandler, HookResult, NormalizedHookInput } from "../types";

/**
 * The `prompt-dispatch` UserPromptSubmit entry: the rule-digest tips and the
 * backlog-relief valve, the two context sections that need rule state or the
 * debt ledger.
 *
 * UserPromptSubmit keeps exactly two registrations: `session-init` owns the
 * turn row and emits the current-turn address line (裁决 25 — it is the only
 * process that knows the new turn's number without racing); this one carries
 * everything else. The per-debt reminder that used to live here is abolished:
 * a note is written during its own turn against the injected address, so
 * there is nothing to remind about until a backlog has actually formed —
 * which is the relief valve's gate, not a per-prompt list.
 *
 * PostToolUse and PreToolUse return no context at all. Claude Code renders
 * their `additionalContext` as a floating attachment that is re-rendered at
 * request assembly, which rewrites the previous turn's tail and destroys the
 * message-side cache breakpoint; prompt-time context is written into the user
 * message once and stays put.
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
  const { db, now, logger: injectedLogger, ...dispatcherDependencies } = dependencies;
  const ruleDispatcher = createUserPromptSubmitDispatcher(dispatcherDependencies);
  // The production wiring passes a database and nothing else, so the default is
  // what every warning below actually runs through. It is the log file rather
  // than `console`: a hook that returns successfully has its stderr discarded,
  // so a console warning here would be written nowhere anyone can read it.
  const logger = injectedLogger ?? createLogger("HOOK");
  const backlogRelief = db
    ? createNoteBacklogReliefHandler({ db, now, logger })
    : undefined;

  /**
   * Several features share one process, so they must not share one fate: the
   * rule digest is pure file/rule state, while the notes paths touch a database
   * a concurrent `session-init` process may hold. An uncaught throw would reach
   * runHookCommand's catch-all, which answers with a bare non-blocking exit and
   * would silently drop the rule output that shipped long before notes existed.
   */
  async function section<Result extends HookResult>(
    name: string,
    run: () => Result | Promise<Result>,
    input: NormalizedHookInput,
  ): Promise<Result | null> {
    try {
      return await run();
    } catch (error) {
      logger.warn?.("prompt-dispatch section failed", {
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
    if (rules?.hookSpecificOutput) {
      sections.push(rules.hookSpecificOutput);
    }

    // The relief valve is the only pending-notes text left (裁决 25): current
    // turns carry their own address line from `session-init`, so a list is
    // warranted only once a backlog has formed and several finished turns have
    // failed to drain it — which is exactly the valve's gate.
    let notes: string | null = null;
    if (backlogRelief) {
      const relief = await section(
        "note-relief",
        () => backlogRelief(input),
        input,
      );
      notes = relief?.hookSpecificOutput ?? null;
    }
    if (notes) {
      sections.push(notes);
    }

    return sections.length > 0
      ? { continue: true, hookSpecificOutput: sections.join("\n\n") }
      : { continue: true };
  };
}
