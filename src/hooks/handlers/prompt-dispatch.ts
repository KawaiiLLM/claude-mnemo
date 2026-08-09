import type { Database } from "bun:sqlite";

import {
  createUserPromptSubmitDispatcher,
  type PreToolUseDispatcherDependencies,
} from "../../rules/pretooluse-dispatcher";
import {
  createNoteBacklogReliefHandler,
  type NoteBacklogReliefOutcome,
} from "./note-relief";
import { createNoteReminderHandler } from "./note-reminder";
import type { HookHandler, HookResult, NormalizedHookInput } from "../types";

/**
 * The `prompt-dispatch` UserPromptSubmit entry: everything that answers a new
 * user prompt with text for the model — and, since 裁决 22, the ONLY entry
 * mnemo has that returns `additionalContext` at all.
 *
 * UserPromptSubmit keeps exactly two registrations, split by response shape
 * rather than by feature: `session-init` owns the turn row and returns no
 * context; this one returns `additionalContext` and writes nothing but its own
 * claims. A third registration would buy nothing and cost another process on
 * every prompt the user types, so the rule-digest tips and both pending-notes
 * paths share this one.
 *
 * PostToolUse and PreToolUse now return no context at all. Claude Code renders
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
  // what every warning below actually runs through.
  const logger = injectedLogger ?? console;
  const backlogRelief = db
    ? createNoteBacklogReliefHandler({ db, now, logger })
    : undefined;
  const noteReminder = db
    ? createNoteReminderHandler({ db, now, logger })
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

    // One pending-notes paragraph per prompt, and the relief valve outranks the
    // ordinary reminder. Both would otherwise fire on the same prompt — the
    // valve opens precisely when the backlog is deep, which is also when new
    // debts keep arriving — and the agent would read two overlapping lists with
    // contradictory closing lines, one authorising a dedicated batch and one
    // forbidding it.
    //
    // The reminder is not merely suppressed but never RUN, which is what keeps
    // the suppressed debts unmarked: they are still owed an ask of their own, so
    // they surface on a later prompt instead of being silently spent here.
    //
    // Precedence reads the relief's own verdict, never its text. A relief that
    // was eligible and lost its claim renders nothing, and the sibling process
    // that won is showing the list right now — treating that silence as "shut"
    // would run the reminder and MARK the very debts being re-listed, spending
    // an ask nobody made. Only `not-eligible` hands the prompt over; a section
    // that threw is `null`, i.e. no verdict at all, and the reminder runs
    // because the same fault will silence it too.
    let notes: string | null = null;
    let reliefOutcome: NoteBacklogReliefOutcome = "not-eligible";
    if (backlogRelief) {
      const relief = await section(
        "note-relief",
        () => backlogRelief(input),
        input,
      );
      notes = relief?.hookSpecificOutput ?? null;
      reliefOutcome = relief?.reliefOutcome ?? "not-eligible";
    }
    if (reliefOutcome === "not-eligible" && noteReminder) {
      notes =
        (await section("note-reminder", () => noteReminder(input), input))
          ?.hookSpecificOutput ?? null;
    }
    if (notes) {
      sections.push(notes);
    }

    return sections.length > 0
      ? { continue: true, hookSpecificOutput: sections.join("\n\n") }
      : { continue: true };
  };
}
