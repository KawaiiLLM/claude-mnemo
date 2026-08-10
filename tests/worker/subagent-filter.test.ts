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
  parseReplayTranscript,
  readAllTranscriptEntries,
} from "../../src/shared/transcript-parser";
import {
  detectAndCleanSubagentTurns,
  detectAndCleanSubagentTurnsFromParsed,
} from "../../src/worker/subagent-filter";

function writeTranscript(lines: unknown[]): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-subagent-"));
  const path = join(directory, "session.jsonl");

  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );

  return { directory, path };
}

interface SubagentTarget {
  sessionId: number;
  turnId: number;
  observationId: number;
}

function createSubagentTarget(
  db: Database,
  contentSessionId: string,
): SubagentTarget {
  const sessionId = upsertSession(db, {
    contentSessionId,
    project: "/tmp/project",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: 1,
    completedAtEpoch: null,
  }).id;
  const turnId = db
    .query<{ id: number }, [number]>(
      `
        INSERT INTO turns (
          session_id, prompt_number, content_prompt_id, status, user_prompt, assistant_response, title, content, insight, created_at_epoch, updated_at_epoch
        ) VALUES (?, 1, 'p1', 'extracted', 'Draft approach', 'Discarded branch', 'Draft branch', 'Temporary content', '- temporary', 100, 100)
        RETURNING id
      `,
    )
    .get(sessionId)!.id;
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
  db.query(
    `
      INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
      VALUES ('turn-stop', ?, ?, 120), ('obs', ?, ?, 121)
    `,
  ).run(turnId, sessionId, observation.id, sessionId);

  return { sessionId, turnId, observationId: observation.id };
}

function summarizeSubagentTarget(db: Database, target: SubagentTarget) {
  const turn = getTurnById(db, target.turnId);
  return {
    turn: turn
      ? {
          status: turn.status,
          tags: turn.tags,
          updatedAtEpoch: turn.updatedAtEpoch,
          title: turn.title,
          content: turn.content,
          insight: turn.insight,
        }
      : null,
    observationCount:
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM observations WHERE turn_id = ?",
        )
        .get(target.turnId)?.count ?? 0,
    queueCount:
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM pending_queue WHERE session_db_id = ?",
        )
        .get(target.sessionId)?.count ?? 0,
    turnFtsCount:
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'turn' AND source_id = ?",
        )
        .get(target.turnId)?.count ?? 0,
    observationFtsCount:
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'observation' AND source_id = ?",
        )
        .get(target.observationId)?.count ?? 0,
  };
}

describe("worker subagent filter helpers", () => {
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

  test("detectAndCleanSubagentTurns clears observations and marks subagent pending", () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "subagent-helper",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnId = db
      .query<{ id: number }, [number]>(
        `
          INSERT INTO turns (
            session_id, prompt_number, content_prompt_id, status, user_prompt, assistant_response, title, content, insight, created_at_epoch, updated_at_epoch
          ) VALUES (?, 1, 'p1', 'extracted', 'Draft approach', 'Discarded branch', 'Draft branch', 'Temporary content', '- temporary', 100, 100)
          RETURNING id
        `,
      )
      .get(sessionId)!.id;
    indexTurnToFTS(db, {
      id: turnId,
      title: "Draft branch",
      content: "Temporary content",
      insight: "- temporary",
    });
    createObservation(db, {
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

    expect(detectAndCleanSubagentTurns(db, sessionId, transcript.path, 500)).toEqual([1]);
    expect(getTurnById(db, turnId)?.status).toBe("undone");
    expect(getTurnById(db, turnId)?.tags).toContain("subagent:pending");
  });

  test("detectAndCleanSubagentTurnsFromParsed matches the path wrapper", () => {
    const pathTarget = createSubagentTarget(db, "subagent-path-helper");
    const parsedTarget = createSubagentTarget(db, "subagent-parsed-helper");
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

    expect(
      detectAndCleanSubagentTurns(
        db,
        pathTarget.sessionId,
        transcript.path,
        500,
      ),
    ).toEqual([1]);
    expect(
      detectAndCleanSubagentTurnsFromParsed(
        db,
        parsedTarget.sessionId,
        parseReplayTranscript(
          transcript.path,
          readAllTranscriptEntries(transcript.path),
        ),
        500,
      ),
    ).toEqual([1]);

    expect(summarizeSubagentTarget(db, parsedTarget)).toEqual(
      summarizeSubagentTarget(db, pathTarget),
    );
  });

  test("detectAndCleanSubagentTurns wrapper uses the retrying write transaction", () => {
    const target = createSubagentTarget(db, "subagent-retry-wrapper");
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
    const transactionRunner = mock((runnerDb: Database, fn: () => number[]) => {
      expect(runnerDb).toBe(db);
      return fn();
    });

    expect(
      detectAndCleanSubagentTurns(
        db,
        target.sessionId,
        transcript.path,
        500,
        { runWriteTransaction: transactionRunner },
      ),
    ).toEqual([1]);

    expect(transactionRunner).toHaveBeenCalledTimes(1);
  });

  test("detectAndCleanSubagentTurnsFromParsed can run inside an outer transaction", () => {
    const target = createSubagentTarget(db, "subagent-outer-transaction");
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
    const entries = readAllTranscriptEntries(transcript.path);
    const parsedTurns = parseReplayTranscript(transcript.path, entries);

    const cleaned = db.transaction(() =>
      detectAndCleanSubagentTurnsFromParsed(
        db,
        target.sessionId,
        parsedTurns,
        500,
      ),
    )();

    expect(cleaned).toEqual([1]);
    expect(summarizeSubagentTarget(db, target).queueCount).toBe(0);
  });
});
