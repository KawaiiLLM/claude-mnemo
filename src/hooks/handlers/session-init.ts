import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import { upsertProcessSessionMap } from "../../db/process-session-map";
import { getSessionByContentId, upsertSession } from "../../db/sessions";
import { reindexTurnFromDb } from "../../db/search";
import { getMaxPromptNumber } from "../../db/turns";
import {
  countUserPromptsInEntries,
  parseReplayTranscript,
  readAllTranscriptEntries,
} from "../../shared/transcript-parser";
import {
  applyInvalidationSets,
  computeInvalidationSets,
} from "../../worker/invalidation";
import { detectAndCleanSubagentTurnsFromParsed } from "../../worker/subagent-filter";
import {
  applyCaptureRepair,
  type CaptureRepairLog,
} from "../capture-repair";
import {
  scanTranscriptIncrementally,
  DEFAULT_SCAN_MAX_LINES,
} from "../transcript-scan";
import type { HookResult, NormalizedHookInput } from "../types";

export interface SessionInitDependencies {
  db: Database;
  now?: () => number;
  runHookWriteTransaction?: typeof runHookWriteTransaction;
  captureRepairLog?: CaptureRepairLog;
  captureRepairMaxLines?: number;
  /** Injected for tests; defaults to the real process environment. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Names the OS process's session (spec D1's investigation) — distinct from
 * `input.sessionId`, the hook payload's content session id this handler keys
 * everything else on. Only a hook or MCP process can read it; it is not part
 * of any hook payload.
 */
const PROCESS_SESSION_ID_ENV_KEY = "CLAUDE_CODE_SESSION_ID";

function createPendingTurn(
  db: Database,
  sessionId: number,
  promptNumber: number,
  prompt: string,
  createdAtEpoch: number,
  isSidechain: boolean,
): void {
  // A sidechain prompt's row is born already marked — status `undone` with the
  // pending tag — instead of waiting for the next root prompt's transcript scan
  // to find it. The scan stays as the retroactive path for rows created before
  // the hook knew the agent id; for rows created WITH it, pre-marking is what
  // keeps the root session's newest live turn ITS OWN turn: an active sidechain
  // row would sit at the top of the prompt order for the whole delegation
  // window, and the note tool's current-turn check (裁决 25) would reject the
  // root turn's own note against it.
  const inserted = db
    .query<{ id: number }, [number, number, string, string, string, number]>(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        tags,
        user_prompt,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id`,
    )
    .get(
      sessionId,
      promptNumber,
      isSidechain ? "undone" : "active",
      isSidechain ? '["subagent:pending"]' : "[]",
      prompt,
      createdAtEpoch,
    );

  // Index at mechanical capture (spec D11): the user's own wording is the most
  // memorable handle on a turn, and waiting for an extraction to index it left
  // every in-flight or skipped turn unsearchable by the words that created it.
  if (inserted) {
    reindexTurnFromDb(db, inserted.id);
  }
}

export function createSessionInitHandler(
  dependencies: SessionInitDependencies,
) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const writeTransaction = dependencies.runHookWriteTransaction ?? runHookWriteTransaction;
  const env = dependencies.env ?? process.env;

  return async function handleSessionInitHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (!input.sessionId || !input.cwd || !input.prompt) {
      return {
        continue: true,
        suppressOutput: true,
      };
    }

    // A subagent prompt still lands a turn row (liveness owns its fate), but it
    // gets no current-turn line: a subagent has no authority over the root
    // session's notes, and telling it an address is telling it to write one.
    const isSubagent = input.agentId !== undefined;

    const epoch = now();
    const contentSessionId = input.sessionId;
    const project = input.cwd;
    const prompt = input.prompt;
    const existingSession = getSessionByContentId(dependencies.db, contentSessionId);
    const transcriptEntries = input.transcriptPath
      ? readAllTranscriptEntries(input.transcriptPath)
      : null;
    const invalidationSets = transcriptEntries
      ? computeInvalidationSets(transcriptEntries)
      : null;
    const parsedTurns = transcriptEntries
      ? parseReplayTranscript(input.transcriptPath ?? "", transcriptEntries)
      : null;
    const transcriptPromptCount = transcriptEntries
      ? countUserPromptsInEntries(transcriptEntries)
      : null;

    // Capture repair (spec §F) — the file read happens OUTSIDE the write
    // transaction; only the claims/links/cursor commit inside it. The scan
    // resumes from the session's persisted byte cursor, so its cost tracks new
    // bytes rather than transcript size.
    const repairCursor = {
      byteOffset: existingSession?.scanCursorByteOffset ?? 0,
      lineNumber: existingSession?.scanCursorLine ?? 0,
    };
    const repairScan = input.transcriptPath
      ? scanTranscriptIncrementally(input.transcriptPath, repairCursor, {
          maxLines: dependencies.captureRepairMaxLines ?? DEFAULT_SCAN_MAX_LINES,
          log: dependencies.captureRepairLog,
        })
      : null;

    const created = writeTransaction(dependencies.db, () => {
      const session = upsertSession(dependencies.db, {
        contentSessionId,
        project,
        // Registration path #2. First-non-NULL inside upsertSession, so a
        // prompt submitted after a `cd` updates project but never the path.
        transcriptPath: input.transcriptPath ?? null,
        title: existingSession?.title ?? null,
        content: existingSession?.content ?? null,
        insight: existingSession?.insight ?? null,
        createdAtEpoch: existingSession?.createdAtEpoch ?? epoch,
        updatedAtEpoch: epoch,
        completedAtEpoch: existingSession?.completedAtEpoch ?? null,
      });

      // D1: refreshed every turn, not just at session start — resume/compact
      // mint a new process id mid-session, and a mapping written once at
      // SessionStart would point at whichever process id happened to be
      // first. Missing entirely is a supported, silent case — the
      // investigation found no guaranteed write site for this var on every
      // Claude Code build — so this just skips the write, and identity
      // resolves as "unknown" downstream.
      const processSessionId = env[PROCESS_SESSION_ID_ENV_KEY];
      if (processSessionId) {
        upsertProcessSessionMap(dependencies.db, processSessionId, session.id, epoch);
      }

      if (transcriptEntries && invalidationSets && parsedTurns) {
        applyInvalidationSets(
          dependencies.db,
          session.id,
          invalidationSets,
          epoch,
        );
        detectAndCleanSubagentTurnsFromParsed(
          dependencies.db,
          session.id,
          parsedTurns,
          epoch,
        );
      }

      // Runs BEFORE the new pending turn exists: a marker minted here takes a
      // prompt number lower than this prompt's, which is the true order (the
      // compact happened before the user typed).
      if (
        repairScan &&
        (repairScan.entries.length > 0 ||
          repairScan.restarted ||
          repairScan.nextCursor.byteOffset !== repairCursor.byteOffset)
      ) {
        applyCaptureRepair(dependencies.db, session.id, repairScan, repairCursor, {
          nowEpoch: epoch,
          log: dependencies.captureRepairLog,
        });
      }

      const dbMaxPromptNumber = getMaxPromptNumber(dependencies.db, session.id);
      const promptNumber = dbMaxPromptNumber !== null
        ? dbMaxPromptNumber + 1
        : transcriptPromptCount !== null
          ? transcriptPromptCount + 1
          : 1;

      createPendingTurn(
        dependencies.db,
        session.id,
        promptNumber,
        prompt,
        epoch,
        isSubagent,
      );

      return { sessionDbId: session.id, promptNumber };
    });

    if (isSubagent) {
      return {
        continue: true,
        suppressOutput: true,
      };
    }

    // The current-turn address (裁决 25) — the one piece of context this entry
    // emits, and the reason it CAN: this process just created the turn row
    // inside its own transaction, so the number is exact where any other
    // UserPromptSubmit process would be racing it. Data only; the protocol for
    // what to do with the address lives in the session-start framework text.
    return {
      continue: true,
      hookSpecificOutput: `mnemo current turn: S${created.sessionDbId}/T${created.promptNumber}`,
    };
  };
}
