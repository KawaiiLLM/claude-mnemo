import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import { listOwedNoteTurns } from "../../db/note-debt";
import {
  deriveProcessIdentityKeys,
  upsertProcessSessionMap,
} from "../../db/process-session-map";
import { countTurnsAfterTurnId, getSessionByContentId, upsertSession } from "../../db/sessions";
import { reindexTurnFromDb } from "../../db/search";
import { getMaxPromptNumber } from "../../db/turns";
import {
  isRememberReminderDue,
  NOTE_RELIEF_PENDING_THRESHOLD,
  renderNoteBacklogRelief,
  renderRememberReminder,
} from "../note-reminder";
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

function createPendingTurn(
  db: Database,
  sessionId: number,
  promptNumber: number,
  prompt: string,
  createdAtEpoch: number,
  isSidechain: boolean,
): number | null {
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

  return inserted?.id ?? null;
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

      // D1: every key this environment yields is recorded, all pointing at the
      // same session, because the process that reads them is running on a
      // DIFFERENT environment — the snapshot the MCP server took when it was
      // spawned, which on a resumed session disagrees about the session id and
      // agrees only on the messaging socket. Writing one key would be betting on
      // which variable the reader happens to share; writing all of them costs a
      // row each and lets the reader find whichever one they both hold. The
      // hook's own environment is authoritative here precisely because a hook is
      // spawned per invocation, so its values are current.
      //
      // Refreshed every prompt rather than once at SessionStart, and deriving
      // nothing writes nothing: no variable here is guaranteed on every Claude
      // Code build, and identity then resolves as "unknown" downstream, which
      // admits.
      for (const identityKey of deriveProcessIdentityKeys(env)) {
        upsertProcessSessionMap(dependencies.db, identityKey, session.id, epoch);
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

      const turnId = createPendingTurn(
        dependencies.db,
        session.id,
        promptNumber,
        prompt,
        epoch,
        isSubagent,
      );

      // The backlog-relief block (spec note-prompt-clock D3/D4/D9, ticket 03)
      // — computed and injected in this SAME transaction, against the
      // promptNumber this call just took. A subagent gets none of this: it
      // has no authority over the root session's notes (see the
      // suppressOutput branch below), so showing it a relief block would be
      // an instruction it cannot act on.
      //
      // Ticket 03 (note-cadence-backlog): the current-turn line's owed SUFFIX
      // is retired — `listOwedNoteTurns` defines "ended" as "a later prompt
      // exists", and the contract forbids noting a turn still in progress, so
      // the immediately-preceding turn is STRUCTURALLY always owed the
      // instant this line renders (measured: shift-0 occurs 0 times across
      // the whole database). A suffix that fires every single time restates
      // the contract rather than informing anything — the address below is
      // for the CURRENT turn's own ownership/edge bookkeeping, not a debt
      // ledger.
      let reliefText: string | null = null;
      // Ticket 13 (spec "节奏与建段指导"): the universal `remember` check —
      // every session, attached to a segment or not, every 20 turns since its
      // last successful `remember` call (any verb). Computed in the SAME
      // transaction as the relief block above, for the identical reason: this
      // is the one process that knows the turn count without racing.
      let rememberReminderText: string | null = null;
      if (!isSubagent && turnId !== null) {
        const owed = listOwedNoteTurns(dependencies.db, session.id, promptNumber);

        if (owed.length >= NOTE_RELIEF_PENDING_THRESHOLD) {
          reliefText = renderNoteBacklogRelief(owed);
        }

        // `session.lastRememberTurnId` is untouched by `upsertSession` (never
        // in its SET list — see sessions.ts) so it reads back the anchor
        // `mcp/remember.ts`'s `touchSessionRememberActivity` last stamped, or
        // NULL if this session has never called `remember` at all — anchor 0
        // then, which counts every turn. A turn ROW ID orders exactly against
        // the call (0.12.1, peer round 2): the old epoch anchor let
        // same-second turns escape its strict comparison, and its
        // never-called fallback needed a createdAtEpoch-minus-one dance
        // because session creation shares its second with turn 1. Both
        // hazards die with id ordering.
        const turnsSinceRemember = countTurnsAfterTurnId(
          dependencies.db,
          session.id,
          session.lastRememberTurnId ?? 0,
        );
        if (isRememberReminderDue(turnsSinceRemember)) {
          rememberReminderText = renderRememberReminder(turnsSinceRemember);
        }
      }

      return { sessionDbId: session.id, promptNumber, reliefText, rememberReminderText };
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
    //
    // The backlog-relief block (spec D3/D9) rides the same line and the same
    // process: `prompt-dispatch`, the sibling UserPromptSubmit entry, renders
    // none of this any more, so there is exactly one writer. Ticket 03
    // retired the owed SUFFIX this line used to carry — see the comment above
    // `reliefText`'s computation for why it was structurally always present
    // and therefore zero-information.
    const sections = [
      `mnemo current turn: S${created.sessionDbId}/T${created.promptNumber}`,
    ];
    if (created.reliefText) {
      sections.push(created.reliefText);
    }
    if (created.rememberReminderText) {
      sections.push(created.rememberReminderText);
    }

    return {
      continue: true,
      hookSpecificOutput: sections.join("\n\n"),
    };
  };
}
