import type { SettlementStagingEngine } from "./note-settlement-staging";

/**
 * The settlement agent's Stop hook (ticket 11, spec G2's first layer).
 *
 * G2 gives completion two layers with different trust. This is the one that
 * TRUSTS THE AGENT: it fires when the agent tries to end its run, and its
 * whole job is to make sure the agent knows what stopping right now costs.
 * The second layer is `commit`'s own precondition (spec A7/G8 amended), which
 * trusts nobody and is unchanged by this file.
 *
 * WHAT IT SAYS, and why it is not a gap list. Under staged commit (spec A7)
 * nothing a settlement run does reaches a stored row until the agent's own
 * `commit` call replays it; an agent that stops without committing has
 * therefore produced literally NOTHING, and its staged work is discarded when
 * the process exits. So the message leads with that fact and names the single
 * action that changes it. The gap inventory ticket 11 originally specified is
 * demoted to a subordinate clause — it is `commit`'s own refusal, quoted, so
 * the agent can fix the gap and commit in one more step instead of committing,
 * being refused, and stopping again.
 *
 * THE CAP IS REAL (spec G2: "at most twice, to avoid a loop"). A hook that can
 * block a stop indefinitely is a hang, and this one runs against a subprocess
 * with a lease and a retry budget: the third stop is allowed through, the
 * window stays unsettled, and the job's own three-attempt policy — which
 * starts a retry from nothing, because nothing was committed — is what
 * eventually settles or abandons it. Deliberately counted here rather than
 * read off the SDK's `stop_hook_active`, which reports only "this stop follows
 * a blocked one" and so could express a cap of one, not two.
 *
 * WHEN IT DOES NOT BLOCK AT ALL: a run whose `commit` already landed (the work
 * is durable and the job is complete — there is nothing to warn about), and a
 * run whose lease has been reclaimed (no `commit` from this dispatch can ever
 * succeed again, so telling it to call one would be telling it to do the
 * impossible — the same distinction `commit`'s own refusal path draws).
 *
 * WHEN THE CHECK ITSELF CANNOT ANSWER (ticket 15 finding 5): `previewCommit`
 * can come back with `checkFailed: true` instead of a real verdict — a writer
 * lock elsewhere outlasted the preview's own bounded retry budget. Of the
 * three honest options (let the stop through, block with an "I could not
 * check" message, or retry the check again in here), this hook BLOCKS with
 * the honest message. Letting the stop through would hide exactly the
 * staged-work loss this hook exists to catch — a false "you're fine" is worse
 * than an occasional over-cautious block. Retrying again in here would just
 * repeat the wait the preview's own bounded transaction already paid out, for
 * no new information. Blocking costs the agent one more turn, capped by the
 * same `blocksIssued` counter as a genuine gap, and points it at `commit`
 * itself, which runs the ordinary, uncapped-budget write path and has a real
 * chance to succeed where the preview could not even look.
 */

/** Spec G2's "at most twice". */
export const NOTE_SETTLEMENT_MAX_STOP_BLOCKS = 2;

/**
 * The subset of the staging engine this hook reads. Narrow on purpose: the
 * hook must never be able to write, and the only write verb on the engine
 * (`commit`) is deliberately absent from this type.
 */
export type SettlementStopHookEngine = Pick<
  SettlementStagingEngine,
  "previewCommit" | "getLastCommitMetrics"
>;

export interface CreateSettlementStopHookOptions {
  engine: SettlementStopHookEngine;
  /** Spec G2's cap; injectable so a test can prove the cap rather than the constant. */
  maxBlocks?: number;
}

/**
 * What the hook decided, in the SDK's own Stop-hook vocabulary
 * (`SyncHookJSONOutput`): `decision: "block"` plus a `reason` the agent reads
 * is how a Stop hook says "do not stop yet, and here is why".
 */
export interface SettlementStopHookResult {
  continue: true;
  decision?: "block";
  reason?: string;
}

/**
 * What is about to be lost if the agent stops now — shared by every Stop-hook
 * message (ticket 15 finding 5 factors this out of `renderStopReason`, not
 * new prose).
 */
function renderStakes(staged: number): string {
  return staged === 0
    ? "You are stopping without having called `commit`, and you have staged nothing. " +
        "This run has produced NOTHING: no note, no segment, no verdict."
    : `You are stopping without having called \`commit\`. Nothing you staged is written — ` +
        `${staged} staged call${staged === 1 ? "" : "s"} ${staged === 1 ? "is" : "are"} ` +
        `discarded when this run ends, and this run will have produced NOTHING. ` +
        "`commit` is the only writer.";
}

/** The hook's own view of what is about to be lost, for the message. */
function renderStopReason(
  staged: number,
  wouldCommit: boolean,
  refusal: string | null,
): string {
  const next = wouldCommit
    ? "A `commit` right now would land this window. Call it."
    : `A \`commit\` right now would refuse — ${refusal ?? "the window is not yet complete."} ` +
      "Fill that with more `note`/`segment` calls (everything you staged is kept), then call `commit`.";

  return `${renderStakes(staged)}\n\n${next}`;
}

/**
 * Ticket 15 finding 5: the preview could not answer at all — a writer lock
 * outlasted its bounded budget, `SQLITE_BUSY` never reached the model, and
 * `previewCommit` returned `checkFailed: true` instead of a real gate
 * verdict. Deliberately NOT `renderStopReason`'s "would refuse" branch: there
 * is no gap to name, and telling the agent to stage more `note`/`segment`
 * calls would be advice for a problem this is not. The honest sentence is
 * "try `commit` yourself" — it runs the ordinary, uncapped-budget write path,
 * not this preview's bounded one, so it has a real chance to succeed (or
 * refuse for a real, nameable reason) where the preview could not even look.
 */
function renderCheckFailedStopReason(staged: number): string {
  return (
    `${renderStakes(staged)}\n\n` +
    "The completion check itself could not run just now — the database was " +
    "briefly locked by something else and the check's own bounded retry ran " +
    "out before the lock cleared. This is NOT a statement that your work is " +
    "incomplete; the check simply could not answer either way. Call `commit` " +
    "directly — it has a longer retry budget and will either land your " +
    "window or tell you exactly what is still missing."
  );
}

/**
 * Build the per-run Stop hook. The returned function is shaped for the Agent
 * SDK's `HookCallback` (`(input, toolUseID, options) => Promise<output>`) and
 * takes no argument it actually reads, so a test calls it directly.
 */
export function createSettlementStopHook(
  options: CreateSettlementStopHookOptions,
): () => Promise<SettlementStopHookResult> {
  const { engine } = options;
  const maxBlocks = options.maxBlocks ?? NOTE_SETTLEMENT_MAX_STOP_BLOCKS;
  let blocksIssued = 0;

  return async function handleSettlementStop(): Promise<SettlementStopHookResult> {
    // Committed already: the work is durable and the job is complete.
    if (engine.getLastCommitMetrics() !== null) {
      return { continue: true };
    }
    // The cap, checked BEFORE the preview: past it the answer is "let it
    // stop" regardless, and a preview costs a write transaction.
    if (blocksIssued >= maxBlocks) {
      return { continue: true };
    }

    const preview = engine.previewCommit();
    if (preview.fenceLost) {
      return { continue: true };
    }

    blocksIssued += 1;
    if (preview.checkFailed) {
      return {
        continue: true,
        decision: "block",
        reason: renderCheckFailedStopReason(preview.staged),
      };
    }
    return {
      continue: true,
      decision: "block",
      reason: renderStopReason(
        preview.staged,
        preview.wouldCommit,
        preview.refusal,
      ),
    };
  };
}
