import type { Database } from "bun:sqlite";
import { join } from "node:path";

import {
  getSessionByContentId,
  setSessionTranscriptPathIfAbsent,
  upsertSession,
} from "../../db/sessions";
import {
  ATTACHED_SEGMENT_BLOCK_SLOTS,
  renderRubricBlock,
  renderSegmentRosterBlock,
} from "../session-composition";
import { listAttachedSegmentsByActivity } from "../../db/segments";
import { resolveEraCutoff } from "../../db/era";
import { parseMarkdownSections } from "../../shared/markdown-sections";
import type { HookResult, NormalizedHookInput } from "../types";
import { recoverStrandedTurns } from "../../db/recover-stranded";
import type { DreamMemoryStore } from "../../diary/memory-store";
import { renderSessionStartPersonaInjection } from "../../diary/persona-render";
import { markSessionRunStart } from "../../db/session-run";
import { bumpWriterEpoch, sessionWriterId } from "../../db/write-gate";
import {
  notifyWorkerTrigger,
  type WorkerClientDeps,
} from "../../worker/client";

export interface ReadOnlyContextHandlerDependencies {
  memoryStore?: Pick<
    DreamMemoryStore,
    "dataRoot" | "readInjectionDocuments"
  >;
}

export interface ContextHandlerDependencies
  extends ReadOnlyContextHandlerDependencies {
  db: Database;
  workerClientDeps?: WorkerClientDeps;
  workerEnv?: NodeJS.ProcessEnv;
  enableSessionEnvCapture?: boolean;
  /**
   * P2 era boundary (spec D11), read once at handler construction. The stranded
   * recovery below needs it to tell a turn whose record is the main agent's own
   * note from one whose extraction fields it may reset. Omitted, it comes from
   * config, whose default (`null`) makes every turn legacy.
   */
  eraCutoffEpoch?: number | null;
}

/**
 * The SessionStart injection surface, in full (lane-model-v12 ticket 16, spec
 * D3f). Five slots survive and this union names three of them; the other two
 * are the fixed segment-block pool's `segment<n>-fields` /
 * `segment<n>-milestones` (`handlers/context-segments.ts`).
 *
 * `roster` is this file's own bare-`context` section. It was called `sessions`
 * until this ticket, back when it rendered a recent-session list; ticket 14
 * rebuilt its contents into a segment roster without renaming it, so the name
 * had been sending readers to look for a session list that no longer existed.
 *
 * Three sections retired in this batch and none of them may come back as a
 * differently-named slot: `notes` (ticket 12 — a call contract belongs on the
 * tool description, not in an injected block), `proposals` (ticket 15 — it
 * retired with the `propose` verb that filled it), and `digest` (this ticket —
 * rules are not injected here, and self-evolution will not reuse that ledger).
 * `tests/hooks/injection-slot-retirement.test.ts` pins all three.
 */
export type ContextSection = "roster" | "persona" | "rubric";
export type ReadOnlyContextSection = Exclude<ContextSection, "roster">;

function hasDocumentBody(document: string): boolean {
  return parseMarkdownSections(document).some((section) =>
    section.bodyLines.some((line) => line.trim().length > 0)
  );
}

async function readPersonaContext(
  memoryStore: Pick<DreamMemoryStore, "dataRoot" | "readInjectionDocuments">,
): Promise<string | undefined> {
  try {
    const memory = await memoryStore.readInjectionDocuments();
    if (!hasDocumentBody(memory.userProfile)) {
      return undefined;
    }
    return renderSessionStartPersonaInjection({
      userProfile: memory.userProfile,
      path: join(memoryStore.dataRoot, "memory", "user-profile.md"),
    });
  } catch {
    return undefined;
  }
}

function hasSessionRunStart(db: Database, sessionId: number): boolean {
  return db.query<{ present: number }, [number]>(
    "SELECT 1 AS present FROM session_run_state WHERE session_db_id = ?",
  ).get(sessionId) !== null;
}

function buildContextOutput(
  db: Database,
  input: NormalizedHookInput,
  eraCutoffEpoch: number | null,
): string | undefined {
  if (input.sessionId && !getSessionByContentId(db, input.sessionId)) {
    upsertSession(db, {
      contentSessionId: input.sessionId,
      project: input.cwd ?? "",
      transcriptPath: input.transcriptPath ?? null,
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: Math.floor(Date.now() / 1000),
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
  }

  const currentSession = input.sessionId
    ? getSessionByContentId(db, input.sessionId)
    : null;
  // Registration path #1. Covers the already-registered case too (resume of a
  // session whose row predates the column), and the IS NULL guard keeps it
  // first-non-NULL: a resume from a different cwd cannot move the path.
  if (currentSession && input.transcriptPath) {
    setSessionTranscriptPathIfAbsent(
      db,
      currentSession.id,
      input.transcriptPath,
    );
  }
  if (currentSession) {
    recoverStrandedTurns(
      db,
      currentSession.id,
      Math.floor(Date.now() / 1000),
      eraCutoffEpoch,
    );
  }

  // Ticket 10 (ADR-0006): the bare `context` command's body is the segment
  // roster now — the session's own seven semantic fields retired in 0.11.x
  // (ticket 09), so there is no more per-session state to render here.
  // Deliberately NOT source-gated (review overturned the implementer's
  // resume|compact gate): the roster's whole job is letting a session see
  // every segment's title + facets so it can pick what to attach, and the
  // session with nothing attached yet — a cold start — is its primary
  // audience. The attached-segment blocks (context-segments.ts) DO keep a
  // resume|compact gate: a cold session cannot have attachments to render.
  // Two sets from one query, answering two different questions (lane-model-v12
  // ticket 18). `attachedSegmentIds` is every segment this session is attached
  // to — those rows expand their lane vocabulary, because those are the lanes
  // this session may actually write. `overflowAttachedSegmentIds` is the
  // SUBSET past the block-slot pool — those rows additionally carry a recall
  // pointer, because no `segment<n>-fields` block will render them.
  const attachedSegments = currentSession
    ? listAttachedSegmentsByActivity(
        db,
        currentSession.id,
        Number.MAX_SAFE_INTEGER,
      )
    : [];
  const attachedSegmentIds = currentSession
    ? new Set(attachedSegments.map((segment) => segment.id))
    : undefined;
  const overflowAttachedSegmentIds = currentSession
    ? new Set(
        attachedSegments
          .slice(ATTACHED_SEGMENT_BLOCK_SLOTS)
          .map((segment) => segment.id),
      )
    : undefined;

  // Ticket 14 (roster rebuild): the roster is a unified-renderer segment
  // listing that records its own read grants under the current session's
  // writer identity. The rubric ships through its OWN hook slot
  // (`SessionStart:rubric`) rather than concatenated here: Claude Code
  // persists a single hook output past ~10K chars to a file with a 2KB
  // preview ([S1730/T931] measured 25KB → 2KB; MAX_INJECTED_BLOCK_CHARS'
  // own doc comment), so two blocks sharing one slot would collapse
  // TOGETHER exactly when the roster grows to its full page budget.
  return renderSegmentRosterBlock(db, {
    attachedSegmentIds,
    overflowAttachedSegmentIds,
    readerId: currentSession ? sessionWriterId(currentSession.id) : null,
  });
}

export function createReadOnlyContextHandler(
  dependencies: ReadOnlyContextHandlerDependencies,
  section: ReadOnlyContextSection,
) {
  return async function handleReadOnlyContextHook(
    _input: NormalizedHookInput,
  ): Promise<HookResult> {
    // The Memory Rubric's own slot — pure prose, no db, no gating; its own
    // ~10K hook budget so the roster's growth can never collapse it (or be
    // collapsed by it) into Claude Code's 2KB persisted preview.
    if (section === "rubric") {
      return { continue: true, hookSpecificOutput: renderRubricBlock() };
    }

    // "persona" is the only section left here that reads anything, and what it
    // reads is a file. NO read-only section opens a database any more: ticket
    // 10 removed "recent", and ticket 16 removed "digest" — the last one that
    // did — so the whole `db` dependency left this factory with it.
    if (!dependencies.memoryStore) {
      return { continue: true };
    }
    const hookSpecificOutput = await readPersonaContext(
      dependencies.memoryStore,
    );
    return hookSpecificOutput
      ? { continue: true, hookSpecificOutput }
      : { continue: true };
  };
}

export function createContextHandler(
  dependencies: ContextHandlerDependencies,
  section: ContextSection = "roster",
) {
  if (section !== "roster") {
    return createReadOnlyContextHandler(dependencies, section);
  }

  const eraCutoffEpoch =
    dependencies.eraCutoffEpoch !== undefined
      ? dependencies.eraCutoffEpoch
      : resolveEraCutoff(dependencies.db);

  return async function handleContextHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (dependencies.enableSessionEnvCapture && input.sessionId) {
      void notifyWorkerTrigger(
        {
          action: "capture",
          contentSessionId: input.sessionId,
          sessionDbId: getSessionByContentId(dependencies.db, input.sessionId)?.id,
        },
        dependencies.workerClientDeps,
        dependencies.workerEnv,
      );
    }
    // Write gate (light-review-repairs 04, P1): the crash backstop for
    // PreCompact's own epoch bump (`hooks/handlers/compact.ts`). Bumping
    // AGAIN here, unconditionally on source=compact and strictly BEFORE
    // `buildContextOutput` below records the segment roster's new grants,
    // means that even if PreCompact's bump failed (it is best-effort there),
    // this one still lands before anything can be granted under this
    // writer's post-compact identity — so no grant earned before compact
    // survives either way. A double bump is harmless: nothing is granted
    // between the two calls, so every pre-compact row is equally dead
    // whether the writer's current epoch ends up one or two past it. Kept
    // best-effort and non-fatal for the same reason PreCompact's own bump
    // is: a failure here must never cost the session its SessionStart
    // injection.
    if (input.sessionId && input.source === "compact") {
      const compactingSession = getSessionByContentId(
        dependencies.db,
        input.sessionId,
      );
      if (compactingSession) {
        try {
          bumpWriterEpoch(dependencies.db, sessionWriterId(compactingSession.id));
        } catch (error) {
          process.stderr.write(
            `[claude-mnemo] SessionStart(compact) write-gate epoch re-bump failed for session ${
              compactingSession.id
            }: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    }

    const hookSpecificOutput = buildContextOutput(
      dependencies.db,
      input,
      eraCutoffEpoch,
    );
    if (input.sessionId) {
      const session = getSessionByContentId(dependencies.db, input.sessionId);
      // compact belongs to the current Claude run. Ensure a missing marker,
      // but never move an existing run boundary past turns created in that run.
      if (
        session &&
        (
          input.source !== "compact" ||
          !hasSessionRunStart(dependencies.db, session.id)
        )
      ) {
        markSessionRunStart(dependencies.db, session.id);
      }
    }
    return hookSpecificOutput
      ? { continue: true, hookSpecificOutput }
      : { continue: true };
  };
}
