import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../src/db/database";
import { createObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { indexTurnToFTS } from "../../src/db/search";
import { getTurnById } from "../../src/db/turns";
import { upsertSession } from "../../src/db/sessions";
import {
  detectAndCleanSidechainTurns,
  getPendingRollbackPromptNumbers,
} from "../../src/worker/rollback";
import { createWorkerCore } from "../../src/worker/server";
import type { WorkerQuerySession } from "../../src/worker/query-session";

function writeTranscript(lines: unknown[]): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-rollback-"));
  const path = join(directory, "session.jsonl");

  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );

  return { directory, path };
}

function insertTurn(db: Database, args: {
  sessionId: number;
  promptNumber: number;
  contentPromptId?: string | null;
  status?: string;
  userPrompt: string;
  assistantResponse?: string | null;
  title?: string | null;
  content?: string | null;
  insight?: string | null;
  tags?: string[];
  createdAtEpoch?: number;
  updatedAtEpoch?: number | null;
}): number {
  const inserted = db
    .query<{ id: number }, [number, number, string | null, string, string, string | null, string | null, string | null, string, number, number | null]>(
      `
        INSERT INTO turns (
          session_id,
          prompt_number,
          content_prompt_id,
          status,
          user_prompt,
          assistant_response,
          title,
          content,
          insight,
          tags,
          created_at_epoch,
          updated_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `,
    )
    .get(
      args.sessionId,
      args.promptNumber,
      args.contentPromptId ?? null,
      args.status ?? "extracted",
      args.userPrompt,
      args.assistantResponse ?? null,
      args.title ?? null,
      args.content ?? null,
      args.insight ?? null,
      JSON.stringify(args.tags ?? []),
      args.createdAtEpoch ?? 100,
      args.updatedAtEpoch ?? 100,
    );

  if (!inserted) {
    throw new Error("Failed to insert turn.");
  }

  return inserted.id;
}

function queueObs(
  db: Database,
  sessionId: number,
  observationId: number,
  enqueuedAtEpoch: number,
): void {
  db.query(
    `
      INSERT INTO pending_queue (kind, target_id, session_db_id, claimed_at_epoch, enqueued_at_epoch)
      VALUES ('obs', ?, ?, NULL, ?)
    `,
  ).run(observationId, sessionId, enqueuedAtEpoch);
}

function queueTurnStop(
  db: Database,
  sessionId: number,
  turnId: number,
  enqueuedAtEpoch: number,
): void {
  db.query(
    `
      INSERT INTO pending_queue (kind, target_id, session_db_id, claimed_at_epoch, enqueued_at_epoch)
      VALUES ('turn-stop', ?, ?, NULL, ?)
    `,
  ).run(turnId, sessionId, enqueuedAtEpoch);
}

describe("worker rollback helpers", () => {
  let db: Database;
  const transcriptDirectories: string[] = [];

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    for (const directory of transcriptDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
    db.close();
  });

  test("detectAndCleanSidechainTurns clears observations and FTS and marks rollback pending", () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "rollback-helper",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnId = insertTurn(db, {
      sessionId,
      promptNumber: 1,
      contentPromptId: "p1",
      userPrompt: "Draft approach",
      assistantResponse: "Discarded branch",
      title: "Draft branch",
      content: "Temporary content",
      insight: "- temporary",
    });
    indexTurnToFTS(db, {
      id: turnId,
      title: "Draft branch",
      content: "Temporary content",
      insight: "- temporary",
    });
    const observation = createObservation(db, {
      turnId,
      toolName: "Read",
      toolInput: '{"file_path":"src/draft.ts"}',
      toolResult: "draft result",
      status: "extracted",
      title: "Read draft code",
      content: "Temporary observation",
      createdAtEpoch: 110,
    });

    const transcript = writeTranscript([
      {
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        isSidechain: true,
        content: [{ type: "text", text: "Draft approach" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [{ type: "text", text: "Discarded branch" }],
      },
    ]);
    transcriptDirectories.push(transcript.directory);

    expect(detectAndCleanSidechainTurns(db, sessionId, transcript.path, 500)).toEqual([1]);
    expect(getTurnById(db, turnId)?.status).toBe("undone");
    expect(getTurnById(db, turnId)?.tags).toContain("rollback:pending");
    expect(
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM observations WHERE turn_id = ?",
        )
        .get(turnId)?.count,
    ).toBe(0);
    expect(
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'turn' AND source_id = ?",
        )
        .get(turnId)?.count,
    ).toBe(0);
    expect(
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'observation' AND source_id = ?",
        )
        .get(observation.id)?.count,
    ).toBe(0);
  });

  test("detectAndCleanSidechainTurns deletes pending_queue rows by kind without touching colliding normal obs ids", () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "rollback-queue-cleanup",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const normalTurnId = insertTurn(db, {
      sessionId,
      promptNumber: 1,
      contentPromptId: "p1",
      userPrompt: "Final approach",
      assistantResponse: "Kept branch",
    });
    const sidechainTurnId = insertTurn(db, {
      sessionId,
      promptNumber: 2,
      contentPromptId: "p2",
      userPrompt: "Draft approach",
      assistantResponse: "Discarded branch",
    });

    const sidechainObservation = createObservation(db, {
      turnId: sidechainTurnId,
      toolName: "Read",
      toolInput: '{"file_path":"src/draft.ts"}',
      toolResult: "draft result",
      status: "pending",
      createdAtEpoch: 120,
    });
    const normalObservation = createObservation(db, {
      turnId: normalTurnId,
      toolName: "Read",
      toolInput: '{"file_path":"src/final.ts"}',
      toolResult: "final result",
      status: "pending",
      createdAtEpoch: 121,
    });

    expect(normalObservation.id).toBe(sidechainTurnId);

    queueTurnStop(db, sessionId, sidechainTurnId, 200);
    queueObs(db, sessionId, normalObservation.id, 201);
    queueObs(db, sessionId, sidechainObservation.id, 202);

    const transcript = writeTranscript([
      {
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        content: [{ type: "text", text: "Final approach" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Kept branch" }],
      },
      {
        role: "user",
        promptId: "p2",
        permissionMode: "default",
        isSidechain: true,
        content: [{ type: "text", text: "Draft approach" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [{ type: "text", text: "Discarded branch" }],
      },
    ]);
    transcriptDirectories.push(transcript.directory);

    detectAndCleanSidechainTurns(db, sessionId, transcript.path, 500);

    expect(
      db
        .query<{ kind: string; targetId: number }, []>(
          `
            SELECT kind, target_id AS targetId
            FROM pending_queue
            ORDER BY seq ASC
          `,
        )
        .all(),
    ).toEqual([
      {
        kind: "obs",
        targetId: normalObservation.id,
      },
    ]);
  });

  test("detectAndCleanSidechainTurns only cleans the newest sidechain chain", () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "rollback-newest-chain",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const olderSidechainTurnId = insertTurn(db, {
      sessionId,
      promptNumber: 1,
      contentPromptId: "p1",
      userPrompt: "Old discarded branch",
      assistantResponse: "Old discarded answer",
    });
    const keptTurnId = insertTurn(db, {
      sessionId,
      promptNumber: 2,
      contentPromptId: "p2",
      userPrompt: "Kept prompt",
      assistantResponse: "Kept answer",
    });
    const newestSidechainTurnId = insertTurn(db, {
      sessionId,
      promptNumber: 3,
      contentPromptId: "p3",
      userPrompt: "Newest discarded branch",
      assistantResponse: "Newest discarded answer",
    });

    const transcript = writeTranscript([
      {
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        isSidechain: true,
        content: [{ type: "text", text: "Old discarded branch" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [{ type: "text", text: "Old discarded answer" }],
      },
      {
        role: "user",
        promptId: "p2",
        permissionMode: "default",
        content: [{ type: "text", text: "Kept prompt" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Kept answer" }],
      },
      {
        role: "user",
        promptId: "p3",
        permissionMode: "default",
        isSidechain: true,
        content: [{ type: "text", text: "Newest discarded branch" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [{ type: "text", text: "Newest discarded answer" }],
      },
    ]);
    transcriptDirectories.push(transcript.directory);

    expect(detectAndCleanSidechainTurns(db, sessionId, transcript.path, 500)).toEqual([3]);
    expect(getTurnById(db, olderSidechainTurnId)?.status).toBe("extracted");
    expect(getTurnById(db, keptTurnId)?.status).toBe("extracted");
    expect(getTurnById(db, newestSidechainTurnId)?.status).toBe("undone");
  });

  test("worker batch prompts include rollback envelope and mark turns notified after success", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "rollback-prompt",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    insertTurn(db, {
      sessionId,
      promptNumber: 1,
      status: "undone",
      userPrompt: "Draft approach",
      tags: ["rollback:pending"],
    });
    const activeTurnId = insertTurn(db, {
      sessionId,
      promptNumber: 2,
      status: "active",
      userPrompt: "Final approach",
    });
    const observation = createObservation(db, {
      turnId: activeTurnId,
      toolName: "Read",
      toolInput: '{"file_path":"src/final.ts"}',
      toolResult: "final result",
      status: "pending",
      createdAtEpoch: 130,
    });
    queueObs(db, sessionId, observation.id, 131);
    queueTurnStop(db, sessionId, activeTurnId, 132);

    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      now: () => 500,
      processBatchImpl: async (state) => {
        await state.pushMessage("<batch><obs id=\"O1\"/><turn id=\"T2\"/></batch>");
      },
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            sentPrompts.push(prompt);
            return { session_id: "worker-query" };
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
    });

    await core.scanAndDrainQueue();

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain("<rollback>");
    expect(sentPrompts[0]).toContain("T1");
    expect(getPendingRollbackPromptNumbers(db, sessionId)).toEqual([]);
    expect(
      getTurnById(db, 1)?.tags.includes("rollback:notified"),
    ).toBe(true);
  });

  test("failed worker prompt keeps rollback turns pending", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "rollback-prompt-fail",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    insertTurn(db, {
      sessionId,
      promptNumber: 1,
      status: "undone",
      userPrompt: "Draft approach",
      tags: ["rollback:pending"],
    });
    const activeTurnId = insertTurn(db, {
      sessionId,
      promptNumber: 2,
      status: "active",
      userPrompt: "Final approach",
    });
    const observation = createObservation(db, {
      turnId: activeTurnId,
      toolName: "Read",
      toolInput: '{"file_path":"src/final.ts"}',
      toolResult: "final result",
      status: "pending",
      createdAtEpoch: 130,
    });
    queueObs(db, sessionId, observation.id, 131);
    queueTurnStop(db, sessionId, activeTurnId, 132);

    const core = createWorkerCore({
      db,
      now: () => 500,
      processBatchImpl: async (state) => {
        await state.pushMessage("<batch><obs id=\"O1\"/><turn id=\"T2\"/></batch>");
      },
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            throw new Error("send failed");
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
    });

    await core.scanAndDrainQueue();

    expect(getPendingRollbackPromptNumbers(db, sessionId)).toEqual([1]);
    expect(getTurnById(db, 1)?.tags.includes("rollback:notified")).toBe(false);
  });
});
