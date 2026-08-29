import type { Database } from "bun:sqlite";

import {
  getNoteSettlementJob,
  type NoteSettlementStage,
} from "../db/note-settlement";

/**
 * The settlement agent's Stop hook (ticket 06, read-write-contract spec
 * "Stop hook 重实现").
 *
 * Direct write (ticket 05) made every `note`/`remember` call durable the
 * instant it lands — nothing is discarded when the process exits any more,
 * which is what retires the old staged-commit-preview design entirely
 * (ticket 11's `previewCommit`/`SettlementCommitPreview`, and the
 * connection-level busy_timeout dance that existed only to make THAT
 * preview's own gate re-check answer inside a Stop hook's short budget —
 * gone with it, because there is no gate re-check left to run here). What
 * survives losing `commit` is exactly one fact the job row itself already
 * states: `commit`'s own claim-CAS never ran, so the job is still `claimed`
 * under this run's own generation, not `done`. THAT is the probe (spec:
 * "直写模式的完整性探针=「job 已认领未终态」(staged 计数已无意义)") — a
 * plain `SELECT`, no write, no busy-timeout budget to protect.
 *
 * The hook still BLOCKS on it (spec: "拦截上限行为保留") — up to
 * `NOTE_SETTLEMENT_MAX_STOP_BLOCKS` times — because an agent that forgets
 * `commit` leaves the job stuck `claimed` until its LEASE expires, which is
 * a needless 10-minute wait for a mistake one more tool call fixes; the cap
 * is what stops that block from becoming a hang. Past the cap, or once the
 * job has moved (committed by this run, or reclaimed out from under it), the
 * stop is let through — the scheduler's own dispatch layer
 * (`note-settlement-dispatch.ts`) is what turns "run ended, job still not
 * done" into the deterministic-failure accounting this scenario now costs
 * (pinned decision: "agent stopping without commit → deterministic failure
 * accounting"), not this hook.
 */

/** Spec G2's "at most twice", carried over unchanged by ticket 06. */
export const NOTE_SETTLEMENT_MAX_STOP_BLOCKS = 2;

export interface CreateSettlementStopHookOptions {
  db: Database;
  jobId: number;
  claimGeneration: number;
  /**
   * Which stage this run is working (staged settlement). When given, the
   * probe reads the FULL ownership tuple `(job, claimGeneration, stage)`: a
   * stage-1 context stopping AFTER its own transition sees a row that has
   * moved to `edges` and is let through, because the thing this hook blocks
   * for — an uncommitted window — is no longer that context's to fix. The
   * generation alone cannot see that: it deliberately does not move at the
   * transition, so a stage-1 run's generation stays valid for the whole of
   * stage 2 and the hook would block it on somebody else's open window.
   *
   * Omitted means "any stage", which is exactly today's behaviour for the one
   * production caller — a single-stage run whose whole life is one stage.
   */
  stage?: NoteSettlementStage;
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

const STOP_WITHOUT_COMMIT_REASON =
  "You are stopping without having called `commit`. Every `note`/`remember` " +
  "call you made already landed — nothing is lost — but this job's window " +
  "stays open (not durably complete) until `commit` runs: it is the only " +
  "thing that marks the job done. Call `commit` now, even if you have " +
  "nothing further to correct — an empty-handed `commit` is a normal, " +
  "clean way to finish this window.";

/**
 * `"open"` — the probe fires (job still `claimed` under THIS run's own
 * generation): `commit` never ran. `"done"` — `commit` already landed;
 * nothing to warn about. `"lost"` — the job moved out from under this run
 * entirely (reclaimed, or no such job at all); no `commit` from here could
 * ever succeed, so blocking would be telling the agent to do the impossible.
 */
function probeJobOpen(
  db: Database,
  jobId: number,
  claimGeneration: number,
  stage?: NoteSettlementStage,
): "open" | "done" | "lost" {
  const job = getNoteSettlementJob(db, jobId);
  if (!job) {
    return "lost";
  }
  if (job.status === "done") {
    return "done";
  }
  if (job.status === "claimed" && job.claimGeneration === claimGeneration) {
    // The stage is the third fence — see `stage` on the options above.
    if (stage !== undefined && job.stage !== stage) {
      return "lost";
    }
    return "open";
  }
  return "lost";
}

/**
 * Build the per-run Stop hook. The returned function is shaped for the Agent
 * SDK's `HookCallback` (`(input, toolUseID, options) => Promise<output>`) and
 * takes no argument it actually reads, so a test calls it directly.
 */
export function createSettlementStopHook(
  options: CreateSettlementStopHookOptions,
): () => Promise<SettlementStopHookResult> {
  const { db, jobId, claimGeneration, stage } = options;
  const maxBlocks = options.maxBlocks ?? NOTE_SETTLEMENT_MAX_STOP_BLOCKS;
  let blocksIssued = 0;

  return async function handleSettlementStop(): Promise<SettlementStopHookResult> {
    if (blocksIssued >= maxBlocks) {
      return { continue: true };
    }

    const probe = probeJobOpen(db, jobId, claimGeneration, stage);
    if (probe !== "open") {
      return { continue: true };
    }

    blocksIssued += 1;
    return { continue: true, decision: "block", reason: STOP_WITHOUT_COMMIT_REASON };
  };
}
