import type { Database } from "bun:sqlite";

import {
  getNoteSettlementJob,
  type NoteSettlementStage,
} from "../db/note-settlement";

/**
 * The settlement agent's Stop hook (originally ticket 06, read-write-contract
 * spec "Stop hook 重实现"; made STAGE-AWARE AND BOUNDED by
 * settlement-execution-repair spec Rev 5, "Stop hook, stage-aware and
 * bounded" — that spec's own ticket 06).
 *
 * Direct write (ticket 05) made every `note`/`remember` call durable the
 * instant it lands — nothing is discarded when the process exits any more,
 * which is what retires the old staged-commit-preview design entirely
 * (ticket 11's `previewCommit`/`SettlementCommitPreview`, and the
 * connection-level busy_timeout dance that existed only to make THAT
 * preview's own gate re-check answer inside a Stop hook's short budget —
 * gone with it, because there is no gate re-check left to run here). What
 * survives losing `commit` is exactly one fact the job row itself already
 * states: the job's TERMINAL call for whichever stage it is currently on
 * never ran, so the job is still `claimed` under this run's own generation,
 * not `done`. THAT is the probe (spec: "直写模式的完整性探针=「job 已认领未终态」
 * (staged 计数已无意义)") — a plain `SELECT`, no write, no busy-timeout budget
 * to protect.
 *
 * STAGE-AWARE NAMING (settlement-execution-repair ticket 06). The unified run
 * (ticket 03) carries ONE hook closure across BOTH stages of a single SDK
 * session: stage `topics` owes `finalize`, stage `edges` owes `commit`. The
 * audited ~900K-token forced-revival episode this repairs (spec's Further
 * Notes) burned tokens partly because the OLD two-session architecture's
 * stage-1-only run was told to call a tool it did not have. The unified
 * run's own mirror-image bug (ticket 03's finding, closed here): the hook
 * stayed pinned to whatever stage its CONSTRUCTOR was given, so a run that
 * transitioned mid-session kept being judged against the stage it started
 * on, not the stage its own `finalize` call had already moved the row to.
 * The fix: every stop reads `job.stage` FRESH off the same row
 * `probeJobOpen` already fetches to answer "claimed but not done" — no
 * separate, possibly-stale stage value is trusted.
 *
 * The hook still BLOCKS on an open window, but now at most ONCE per run
 * (down from the old "at most twice", spec G2) — a second stop without the
 * stage's terminal call is accepted as the run's answer, not overridden a
 * second time: `note-settlement-dispatch.ts`'s own re-read of the row
 * (ticket 04) is what turns "run ended, job still not done" into
 * deterministic-failure accounting, composing `last_error` from the stage, a
 * mechanical conclusion, and this run's own final assistant text
 * (`composeSettlementDiagnosis`) — never discarding a correct diagnosis (like
 * the T41 wall's) for a generic reason. Past the bound, or once the job has
 * moved (committed by this run, or reclaimed out from under it), the stop is
 * let through — the scheduler's dispatch layer is what turns that into
 * accounting, not this hook.
 *
 * The declarative blocked-duty escape hatch the process audit sketched
 * (`finalize(blocked=[...])`) stays REJECTED (spec §Out of Scope): a gate an
 * agent can declare its way past is not a gate; unsatisfiable gates are bugs,
 * and the bounded hook plus the preserved diagnosis caps the spin cost at one
 * nudge.
 */

/**
 * The once-per-run nudge bound (settlement-execution-repair spec "Stop hook,
 * stage-aware and bounded"). Down from read-write-contract's earlier "at
 * most twice" (spec G2) — a second stop is now the run's own answer, not an
 * error to override again.
 */
export const NOTE_SETTLEMENT_MAX_STOP_BLOCKS = 1;

export interface CreateSettlementStopHookOptions {
  db: Database;
  jobId: number;
  claimGeneration: number;
  /** Spec's "at most once"; injectable so a test can prove the bound rather than the constant. */
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

const STOP_WITHOUT_COMMIT_REASON =
  "You are stopping without having called `commit`. Every `note`/`remember` " +
  "call you made already landed — nothing is lost — but this job's window " +
  "stays open (not durably complete) until `commit` runs: it is the only " +
  "thing that marks the job done. Call `commit` now, even if you have " +
  "nothing further to correct — an empty-handed `commit` is a normal, " +
  "clean way to finish this window.";

const STOP_WITHOUT_FINALIZE_REASON =
  "You are stopping without having called `finalize`. Every `note`/`remember` " +
  "call you made already landed — nothing is lost — but this window's topic " +
  "pass stays open until `finalize` runs: it is what closes the topic pass " +
  "and hands you into the edge pass. Call `finalize` now, even if you have " +
  "nothing further to correct — an empty-handed `finalize` is a normal, " +
  "clean way to move this window forward.";

type StopProbe =
  | { readonly state: "open"; readonly stage: NoteSettlementStage }
  | { readonly state: "done" }
  | { readonly state: "lost" };

/**
 * `"open"` (carrying the row's own CURRENT `stage`) — the probe fires (job
 * still `claimed` under THIS run's own generation): that stage's terminal
 * call never ran. `"done"` — the terminal call already landed; nothing to
 * warn about. `"lost"` — the job moved out from under this run entirely
 * (reclaimed, or no such job at all); no terminal call from here could ever
 * succeed, so blocking would be telling the agent to do the impossible.
 *
 * Ownership is `(status, claimGeneration)` alone — no stage component. A
 * stage MISMATCH used to mean "a different session now owns this window"
 * under read-write-contract's two-session architecture: a stale stage-1
 * child that outlived its own transition was let through because stage 2 was
 * a DIFFERENT dispatch's job (`createNoteSettlementStageOneSdkQuery`, now
 * retired). The unified run (settlement-execution-repair ticket 03) is ONE
 * closure across both stages, so a stage that has moved since this hook was
 * constructed is still THIS run's own window — the probe, and the name it
 * teaches, follow the row, never the value this closure started with.
 */
function probeJobOpen(
  db: Database,
  jobId: number,
  claimGeneration: number,
): StopProbe {
  const job = getNoteSettlementJob(db, jobId);
  if (!job) {
    return { state: "lost" };
  }
  if (job.status === "done") {
    return { state: "done" };
  }
  if (job.status === "claimed" && job.claimGeneration === claimGeneration) {
    return { state: "open", stage: job.stage };
  }
  return { state: "lost" };
}

/**
 * Build the per-run Stop hook. The returned function is shaped for the Agent
 * SDK's `HookCallback` (`(input, toolUseID, options) => Promise<output>`) and
 * takes no argument it actually reads, so a test calls it directly.
 *
 * `blocksIssued` lives in THIS closure, constructed fresh per dispatch (both
 * `createNoteSettlementSdkQuery` and `createUnifiedNoteSettlementSdkQuery`
 * build a new hook per call) — the once-per-run bound resets per claim,
 * never per process, exactly as the spec requires, with no change needed to
 * either call site.
 */
export function createSettlementStopHook(
  options: CreateSettlementStopHookOptions,
): () => Promise<SettlementStopHookResult> {
  const { db, jobId, claimGeneration } = options;
  const maxBlocks = options.maxBlocks ?? NOTE_SETTLEMENT_MAX_STOP_BLOCKS;
  let blocksIssued = 0;

  return async function handleSettlementStop(): Promise<SettlementStopHookResult> {
    if (blocksIssued >= maxBlocks) {
      return { continue: true };
    }

    const probe = probeJobOpen(db, jobId, claimGeneration);
    if (probe.state !== "open") {
      return { continue: true };
    }

    blocksIssued += 1;
    return {
      continue: true,
      decision: "block",
      reason:
        probe.stage === "topics"
          ? STOP_WITHOUT_FINALIZE_REASON
          : STOP_WITHOUT_COMMIT_REASON,
    };
  };
}
