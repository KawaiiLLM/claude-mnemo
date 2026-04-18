import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  detectAndCleanSubagentTurns,
  getPendingSubagentTurns,
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
    expect(getPendingSubagentTurns(db, sessionId).map((turn) => turn.promptNumber)).toEqual([1]);
  });
});
