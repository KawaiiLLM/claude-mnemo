import type { Database } from "bun:sqlite";
import { join } from "node:path";

import {
  getSessionByContentId,
  setSessionTranscriptPathIfAbsent,
  upsertSession,
} from "../../db/sessions";
import {
  ATTACHED_SEGMENT_BLOCK_SLOTS,
  renderSegmentRoster,
} from "../session-composition";
import { listAttachedSegmentsByActivity } from "../../db/segments";
import { resolveEraCutoff } from "../../db/era";
import { parseMarkdownSections } from "../../shared/markdown-sections";
import type { HookResult, NormalizedHookInput } from "../types";
import { recoverStrandedTurns } from "../../db/recover-stranded";
import type { DreamMemoryStore } from "../../diary/memory-store";
import { renderSessionStartPersonaInjection } from "../../diary/persona-render";
import { markSessionRunStart } from "../../db/session-run";
import { createRuleStore } from "../../db/rules";
import { renderRuleDigest } from "../../rules/digest";
import {
  notifyWorkerTrigger,
  type WorkerClientDeps,
} from "../../worker/client";

export interface ReadOnlyContextHandlerDependencies {
  db?: Database;
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

export type ContextSection = "sessions" | "persona" | "digest";
export type ReadOnlyContextSection = Exclude<ContextSection, "sessions">;

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

function readRuleDigestContext(
  db: Database,
  input: NormalizedHookInput,
): string | undefined {
  try {
    return renderRuleDigest({
      rules: createRuleStore(db).list(),
      project: input.cwd ?? undefined,
    }) || undefined;
  } catch {
    return undefined;
  }
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
  const overflowAttachedSegmentIds = currentSession
    ? new Set(
        listAttachedSegmentsByActivity(
          db,
          currentSession.id,
          Number.MAX_SAFE_INTEGER,
        )
          .slice(ATTACHED_SEGMENT_BLOCK_SLOTS)
          .map((segment) => segment.id),
      )
    : undefined;

  return renderSegmentRoster(db, { eraCutoffEpoch, overflowAttachedSegmentIds });
}

export function createReadOnlyContextHandler(
  dependencies: ReadOnlyContextHandlerDependencies,
  section: ReadOnlyContextSection,
) {
  return async function handleReadOnlyContextHook(
    _input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (section === "persona") {
      if (!dependencies.memoryStore) {
        return { continue: true };
      }
      const hookSpecificOutput = await readPersonaContext(
        dependencies.memoryStore,
      );
      return hookSpecificOutput
        ? { continue: true, hookSpecificOutput }
        : { continue: true };
    }

    if (!dependencies.db) {
      return { continue: true };
    }
    // Only "digest" is left in this union (ticket 10 removed "recent" —
    // RecentSessions and the diary index no longer render at SessionStart).
    const hookSpecificOutput = readRuleDigestContext(
      dependencies.db,
      _input,
    );
    return hookSpecificOutput
      ? { continue: true, hookSpecificOutput }
      : { continue: true };
  };
}

export function createContextHandler(
  dependencies: ContextHandlerDependencies,
  section: ContextSection = "sessions",
) {
  if (section !== "sessions") {
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
