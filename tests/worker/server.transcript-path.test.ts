import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { encodeProjectPath, transcriptRootPath } from "../../src/shared/paths";
import { createWorkerCore } from "../../src/worker/server";
import type { WorkerQuerySession } from "../../src/worker/query-session";

/**
 * The worker's own reader seam for `sessions.transcript_path`
 * (src/worker/server.ts, `pushMessage`). The path is observable because the
 * reminder envelope's "replaced by T<n>" clause only exists when the session's
 * transcript file was actually found and its rollback topology parsed — so a
 * path that resolves to a nonexistent file silently drops the clause, which is
 * exactly the drift symptom.
 */

// A rolled-back user turn (p-dead) and the prompt that replaced it (p-live),
// both children of the same assistant message.
const ROLLBACK_TRANSCRIPT = [
  { uuid: "root", type: "system", timestamp: "2026-04-18T10:00:00.000Z" },
  {
    uuid: "u1",
    type: "user",
    role: "user",
    promptId: "p-first",
    parentUuid: "root",
    timestamp: "2026-04-18T10:00:01.000Z",
    message: { role: "user", content: "First prompt" },
  },
  {
    uuid: "a1",
    type: "assistant",
    role: "assistant",
    parentUuid: "u1",
    timestamp: "2026-04-18T10:00:02.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Answer" }] },
  },
  {
    uuid: "u-dead",
    type: "user",
    role: "user",
    promptId: "p-dead",
    parentUuid: "a1",
    timestamp: "2026-04-18T10:00:03.000Z",
    message: { role: "user", content: "Rolled-back prompt" },
  },
  {
    uuid: "u-live",
    type: "user",
    role: "user",
    promptId: "p-live",
    parentUuid: "a1",
    timestamp: "2026-04-18T10:00:04.000Z",
    message: { role: "user", content: "Replacement prompt" },
  },
  {
    uuid: "a2",
    type: "assistant",
    role: "assistant",
    parentUuid: "u-live",
    timestamp: "2026-04-18T10:00:05.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Replacement answer" }],
    },
  },
];

function writeRollbackTranscript(path: string): void {
  writeFileSync(
    path,
    ROLLBACK_TRANSCRIPT.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );
}

describe("worker transcript-path reader seam", () => {
  let db: Database;
  const cleanup: string[] = [];

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
    for (const path of cleanup.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  function seed(options: {
    contentSessionId: string;
    project: string;
    transcriptPath?: string | null;
  }): { sessionId: number; deadTurnId: number; liveTurnId: number; flushTurnId: number } {
    const sessionId = upsertSession(db, {
      contentSessionId: options.contentSessionId,
      project: options.project,
      transcriptPath: options.transcriptPath ?? null,
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    const insertTurn = (
      promptNumber: number,
      promptId: string | null,
      status: string,
      wasRolledBack: 0 | 1,
      tags: string[],
    ): number =>
      db
        .query<{ id: number }, [number, number, string | null, string, number, string]>(
          `INSERT INTO turns (
             session_id, prompt_number, content_prompt_id, status, user_prompt,
             title, content, was_interrupted, was_rolled_back, tags,
             created_at_epoch, updated_at_epoch
           ) VALUES (?, ?, ?, ?, 'Prompt', 'Title', 'Content', 0, ?, ?, 100, 101)
           RETURNING id`,
        )
        .get(sessionId, promptNumber, promptId, status, wasRolledBack, JSON.stringify(tags))!
        .id;

    const deadTurnId = insertTurn(1, "p-dead", "extracted", 1, [
      "invalidated:notify-pending:rollback",
    ]);
    const liveTurnId = insertTurn(2, "p-live", "extracted", 0, []);
    const flushTurnId = insertTurn(3, "p-next", "active", 0, []);

    return { sessionId, deadTurnId, liveTurnId, flushTurnId };
  }

  async function flushAndCapture(
    sessionId: number,
    flushTurnId: number,
  ): Promise<string[]> {
    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      processBatchImpl: async (state) => {
        await state.pushMessage(`<batch><turn id="T${flushTurnId}"/></batch>`);
      },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        const deps = (args.length === 2 ? args[1] : args[3]) as
          | {
              onMessage?: (message: { session_id?: string }) => void;
              onRemember?: (id: string) => void;
            }
          | undefined;
        return {
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            sentPrompts.push(prompt);
            deps?.onMessage?.({ session_id: "worker-query" });
            for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
              deps?.onRemember?.(`T${match[1]}`);
            }
            return { session_id: "worker-query" };
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    await core.processClaimedItem({
      seq: 1,
      kind: "turn-stop",
      targetId: flushTurnId,
      sessionDbId: sessionId,
      claimedAtEpoch: 1,
      enqueuedAtEpoch: 1,
    });
    await core.flushSession(sessionId);

    // The hydrated state is what pushMessage reads from.
    expect(core.sessions.get(sessionId)).toBeDefined();
    return sentPrompts;
  }

  test("uses the recorded transcript path for a session whose cwd drifted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mnemo-worker-transcript-"));
    cleanup.push(directory);
    const recorded = join(directory, "started-here.jsonl");
    writeRollbackTranscript(recorded);

    // `project` is the LATEST cwd, and its derived path does not exist. Only
    // the recorded path finds the file.
    const seeded = seed({
      contentSessionId: "worker-drifted",
      project: "/Users/me/cd-ed-away",
      transcriptPath: recorded,
    });

    const [prompt] = await flushAndCapture(seeded.sessionId, seeded.flushTurnId);

    expect(prompt).toContain("<reminder>");
    expect(prompt).toContain(`T${seeded.deadTurnId} (was_rolled_back`);
    expect(prompt).toContain(`replaced by T${seeded.liveTurnId}`);
  });

  test("falls back to the cwd derivation when no transcript path is recorded", async () => {
    const project = "/Users/me/legacy-project";
    const contentSessionId = "worker-legacy";
    const derivedDirectory = join(
      transcriptRootPath(),
      encodeProjectPath(project),
    );
    mkdirSync(derivedDirectory, { recursive: true });
    cleanup.push(derivedDirectory);
    writeRollbackTranscript(join(derivedDirectory, `${contentSessionId}.jsonl`));

    const seeded = seed({ contentSessionId, project, transcriptPath: null });

    const [prompt] = await flushAndCapture(seeded.sessionId, seeded.flushTurnId);

    expect(prompt).toContain(`replaced by T${seeded.liveTurnId}`);
  });

  test("hosts the one-time repair on the watchdog tick and retires it once done", () => {
    // Off startup and off every request path: the tick is the only caller, and
    // it stops calling as soon as the ledger says there is nothing left.
    mkdirSync(transcriptRootPath(), { recursive: true });
    const core = createWorkerCore({
      db,
      logger: { warn() {}, error() {} },
      isProcessAliveImpl: () => false,
    });
    const ledger = () =>
      db
        .query<{ status: string }, []>(
          "SELECT status FROM repair_ledger WHERE name = 'transcript-path-backfill-v1'",
        )
        .get() ?? null;

    core.runTranscriptRepairTick();
    expect(ledger()?.status).toBe("done");

    // Wiping the ledger proves the latch rather than the ledger's own skip:
    // a retired tick does not touch the database again at all.
    db.exec("DELETE FROM repair_ledger");
    core.runTranscriptRepairTick();
    expect(ledger()).toBeNull();
  });

  test("resolves to nothing (no throw) when neither source names a real file", async () => {
    const seeded = seed({
      contentSessionId: "worker-unresolvable",
      project: "/Users/me/nowhere",
      transcriptPath: null,
    });

    const [prompt] = await flushAndCapture(seeded.sessionId, seeded.flushTurnId);

    // The reminder still fires; only the replacement clause is unavailable.
    expect(prompt).toContain(`T${seeded.deadTurnId} (was_rolled_back`);
    expect(prompt).not.toContain("replaced by T");
  });
});
