import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import { listAttachedSegmentsByActivity } from "../../db/segments";
import { getSessionByContentId } from "../../db/sessions";
import { bumpWriterEpoch, sessionWriterId } from "../../db/write-gate";
import { notifyWorkerCompact, type WorkerClientDeps } from "../../worker/client";
import type { HookResult, NormalizedHookInput } from "../types";

/**
 * Ticket 12 (compact-dedup-guidance), USER RULING S15069/T2017: ONE simple
 * sentence, no category enumeration, no carve-outs — rule minimalism is the
 * ruling's own requirement. Names the mechanism (segment cards re-inject
 * after compact via `context-segments.ts`'s SessionStart(resume|compact)
 * blocks) so the summarizer knows what NOT to re-derive, and spends the rest
 * of its budget elsewhere instead of restating it.
 */
const COMPACT_GUIDANCE_SENTENCE =
  "Your attached segment cards re-inject automatically right after this compact, so the summary does not need to restate what they already carry — spend that budget on the other details.";

export interface CompactHandlerDependencies {
  db: Database;
  workerClientDeps?: WorkerClientDeps;
  workerEnv?: NodeJS.ProcessEnv;
  /** Seam for the write-gate wipe's own transaction (default `runHookWriteTransaction`). */
  runHookWriteTransaction?: typeof runHookWriteTransaction;
}

export function createCompactHandler(dependencies: CompactHandlerDependencies) {
  const writeTransaction =
    dependencies.runHookWriteTransaction ?? runHookWriteTransaction;

  return async function handleCompactHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (!input.sessionId) {
      return { continue: true };
    }

    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }

    // Write gate (ticket 01, read-write-contract spec "compact后才清空一次
    // 授权"; light-review-repairs 04 P1 repair): PreCompact is the event
    // that actually destroys the context this writer's read grants were
    // earned on (a plain resume reloads the full transcript; a compacted one
    // does not) — so the invalidation lives HERE, not in SessionEnd. Bumps
    // this writer's context epoch (`bumpWriterEpoch`) instead of physically
    // DELETEing its grant and completeness rows: every row recorded under
    // the OLD epoch becomes invisible to `checkFieldGate`/`checkRelationsGate`
    // the instant this commits (they only honor the writer's CURRENT epoch),
    // which is also what makes `checkRelationsGate` demand a fresh relations
    // read post-compact — its completeness check reads through the same
    // epoch-gated table this bump invalidates. A single-row UPSERT, not two
    // unbounded DELETEs: if this fails, `hooks/handlers/context.ts`'s
    // SessionStart(source=compact) re-bump is the crash backstop — it lands
    // before that hook records the roster's new grants, so no pre-compact
    // grant survives either way. Best-effort here regardless: a failure must
    // never stop the compact notification below, which is what keeps the
    // worker's own state in sync with the transcript boundary.
    try {
      writeTransaction(dependencies.db, () => {
        bumpWriterEpoch(dependencies.db, sessionWriterId(session.id));
      });
    } catch (error) {
      process.stderr.write(
        `[claude-mnemo] pre-compact write-gate epoch bump failed for session ${session.id}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }

    await notifyWorkerCompact(
      session.id,
      session.contentSessionId,
      input.transcriptPath,
      dependencies.workerClientDeps,
      dependencies.workerEnv,
    );

    // Guidance only when something will actually re-inject: the sentence
    // names segment cards re-injecting, and for a session with no attachment
    // nothing does (`context-segments.ts` renders nothing for slot 1 either),
    // so the sentence would be false. Same existence query that handler uses
    // (limit 1 — only presence matters here, not which segment or how many).
    const hasAttachedSegment =
      listAttachedSegmentsByActivity(dependencies.db, session.id, 1).length > 0;

    return hasAttachedSegment
      ? { continue: true, hookSpecificOutput: COMPACT_GUIDANCE_SENTENCE }
      : { continue: true };
  };
}
