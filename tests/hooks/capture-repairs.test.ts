import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { createObservation } from "../../src/db/observations";
import { getOrphanTurns } from "../../src/db/orphan-turns";
import { initializeSchema } from "../../src/db/schema";
import { getSessionByContentId, upsertSession } from "../../src/db/sessions";
import {
  getStrandedTurns,
  getTurnById,
  getTurnsForSession,
} from "../../src/db/turns";
import { backfillFromTranscript } from "../../src/hooks/backfill";
import { runCaptureRepair } from "../../src/hooks/capture-repair";
import { createSessionEndHandler } from "../../src/hooks/handlers/session-end";
import { createSessionInitHandler } from "../../src/hooks/handlers/session-init";
import { createContextHandler } from "../../src/hooks/handlers/context";
import { runHookCommand } from "../../src/hooks/hook-command";
import { scanTranscriptIncrementally } from "../../src/hooks/transcript-scan";
import type { HookHandler, NormalizedHookInput } from "../../src/hooks/types";

const PROJECT = "/Users/zhaoqixuan/Projects/claude-mnemo";
const CONTENT_SESSION_ID = "session-capture";

function serialize(lines: unknown[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

describe("capture repairs", () => {
  let db: Database;
  let directory: string;
  let sessionId: number;
  let logLines: string[];
  const log = (message: string) => {
    logLines.push(message);
  };

  function transcriptPathFor(name: string): string {
    return join(directory, name);
  }

  function writeTranscript(name: string, lines: unknown[]): string {
    const path = transcriptPathFor(name);
    writeFileSync(path, serialize(lines), "utf8");
    return path;
  }

  function appendTranscript(path: string, lines: unknown[]): void {
    appendFileSync(path, serialize(lines), "utf8");
  }

  function session() {
    return getSessionByContentId(db, CONTENT_SESSION_ID)!;
  }

  function repair(path: string, maxLines?: number) {
    return runCaptureRepair(db, session(), path, {
      nowEpoch: 900,
      log,
      maxLines,
    });
  }

  function insertTurn(fields: {
    promptNumber: number;
    userPrompt?: string | null;
    status?: string;
    contentPromptId?: string | null;
    transcriptLineStart?: number | null;
    createdAtEpoch?: number;
  }): number {
    db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt,
         content_prompt_id, transcript_line_start, created_at_epoch
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      fields.promptNumber,
      fields.status ?? "active",
      fields.userPrompt ?? null,
      fields.contentPromptId ?? null,
      fields.transcriptLineStart ?? null,
      fields.createdAtEpoch ?? 100,
    );
    return db
      .query<{ id: number }, []>("SELECT id FROM turns ORDER BY id DESC LIMIT 1")
      .get()!.id;
  }

  function boundary(uuid: string, preTokens: number, trigger = "manual") {
    return {
      type: "system",
      subtype: "compact_boundary",
      uuid,
      compactMetadata: { preCompactTokenCount: preTokens, trigger },
    };
  }

  function wrapper(uuid: string, parentUuid: string, promptId: string) {
    return {
      type: "user",
      uuid,
      parentUuid,
      promptId,
      message: {
        role: "user",
        content: `Continued from a previous conversation (${promptId}).`,
      },
    };
  }

  function userEntry(uuid: string, promptId: string, text: string) {
    return {
      type: "user",
      uuid,
      promptId,
      message: { role: "user", content: text },
    };
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    directory = mkdtempSync(join(tmpdir(), "claude-mnemo-capture-"));
    logLines = [];
    sessionId = upsertSession(db, {
      contentSessionId: CONTENT_SESSION_ID,
      project: PROJECT,
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    db.close();
  });

  describe("compact boundary claiming", () => {
    test("claims every unclaimed boundary in one pass and numbers new markers MAX+1", () => {
      const lines: unknown[] = [];
      for (let index = 1; index <= 9; index += 1) {
        lines.push(boundary(`boundary-${index}`, index * 100));
        lines.push(wrapper(`summary-${index}`, `boundary-${index}`, `prompt-${index}`));
      }
      const path = writeTranscript("nine.jsonl", lines);
      insertTurn({ promptNumber: 1, userPrompt: "existing work", status: "extracted" });

      const outcome = repair(path);

      expect(outcome?.compact).toEqual({
        inserted: 9,
        converted: 0,
        adopted: 0,
        skipped: 0,
      });
      const markers = getTurnsForSession(db, sessionId).filter(
        (turn) => turn.type === "compact",
      );
      expect(markers).toHaveLength(9);
      expect(markers.map((turn) => turn.promptNumber)).toEqual([
        2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      expect(markers.map((turn) => turn.compactBoundaryUuid)).toEqual([
        "boundary-1",
        "boundary-2",
        "boundary-3",
        "boundary-4",
        "boundary-5",
        "boundary-6",
        "boundary-7",
        "boundary-8",
        "boundary-9",
      ]);
      expect(markers[0]).toMatchObject({
        status: "extracted",
        title: "/compact",
        contentPromptId: "prompt-1",
        transcriptLineStart: 2,
        tags: ["compact:pre_tokens=100", "compact:trigger=manual"],
        toolCallCount: 0,
      });
    });

    test("re-scanning the same region claims nothing new (UUID idempotence)", () => {
      const path = writeTranscript("idempotent.jsonl", [
        boundary("boundary-1", 64),
        wrapper("summary-1", "boundary-1", "prompt-1"),
      ]);

      expect(repair(path)?.compact.inserted).toBe(1);

      // Force a full re-read of the same bytes, exactly as a crash between the
      // claim and the cursor commit would.
      db.query("UPDATE sessions SET scan_cursor_byte_offset = 0, scan_cursor_line = 0")
        .run();
      const second = repair(path);

      expect(second?.compact).toEqual({
        inserted: 0,
        converted: 0,
        adopted: 0,
        skipped: 1,
      });
      expect(getTurnsForSession(db, sessionId)).toHaveLength(1);
    });

    test("holds the cursor before a boundary whose wrapper has not been written yet", () => {
      const path = writeTranscript("pending.jsonl", [
        userEntry("user-1", "prompt-1", "first prompt"),
        boundary("boundary-1", 42),
      ]);

      expect(repair(path)?.compact.inserted).toBe(0);
      const heldCursor = session().scanCursorLine;
      expect(heldCursor).toBe(1);

      appendTranscript(path, [wrapper("summary-1", "boundary-1", "prompt-2")]);
      const second = repair(path);

      expect(second?.compact.inserted).toBe(1);
      expect(
        getTurnsForSession(db, sessionId).find((turn) => turn.type === "compact")
          ?.compactBoundaryUuid,
      ).toBe("boundary-1");
      expect(session().scanCursorLine).toBe(3);
    });

    test("ignores a boundary whose next entry is not its summary wrapper", () => {
      const path = writeTranscript("interleaved.jsonl", [
        boundary("boundary-1", 22),
        {
          type: "assistant",
          uuid: "assistant-1",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        },
        wrapper("summary-1", "boundary-1", "prompt-1"),
      ]);

      expect(repair(path)?.compact.inserted).toBe(0);
      expect(getTurnsForSession(db, sessionId)).toHaveLength(0);
    });

    test("adopts a legacy marker instead of rewriting it", () => {
      const path = writeTranscript("legacy.jsonl", [
        boundary("boundary-1", 128),
        wrapper("summary-1", "boundary-1", "prompt-1"),
      ]);
      db.query(
        `INSERT INTO turns (
           session_id, prompt_number, content_prompt_id, status, title, content,
           type, tags, files_read, files_modified, tool_call_count, created_at_epoch
         ) VALUES (?, 1, 'prompt-1', 'extracted', '/compact', 'legacy summary',
                   'compact', ?, '[]', '[]', 0, 100)`,
      ).run(sessionId, JSON.stringify(["compact:pre_tokens=128", "compact:trigger=auto"]));

      const outcome = repair(path);

      expect(outcome?.compact).toEqual({
        inserted: 0,
        converted: 0,
        adopted: 1,
        skipped: 0,
      });
      const turns = getTurnsForSession(db, sessionId);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        compactBoundaryUuid: "boundary-1",
        content: "legacy summary",
        tags: ["compact:pre_tokens=128", "compact:trigger=auto"],
      });
    });
  });

  describe("occupied-promptId conversion", () => {
    function seedOccupiedTurn(
      options: { citesRecorded?: boolean } = {},
    ): { turnId: number; neighbourId: number; path: string } {
      const path = writeTranscript("occupied.jsonl", [
        boundary("boundary-1", 512, "auto"),
        wrapper("summary-1", "boundary-1", "prompt-9"),
      ]);
      const neighbourId = insertTurn({
        promptNumber: 1,
        userPrompt: "a neighbouring turn",
        status: "extracted",
      });
      db.query(
        `INSERT INTO turns (
           session_id, prompt_number, content_prompt_id, transcript_line_start,
           status, user_prompt, assistant_response, assistant_transcript,
           title, content, insight, type, significance_grade, tags,
           files_read, files_modified, tool_call_count,
           was_interrupted, was_rolled_back,
           extraction_stall_attempts, extraction_stall_retry_at_ms,
           extraction_stall_retry_after_seq, extraction_stall_retry_mode,
           cites_recorded, created_at_epoch, updated_at_epoch
         ) VALUES (?, 7, 'prompt-9', 41, 'extracted', 'the real prompt',
                   'the real response', 'full narration',
                   'Real title', 'Real content', 'Real insight', 'decision', 3, ?,
                   ?, ?, 12, 1, 1, 2, 1234, 77, 'resume', ?, 700, 800)`,
      ).run(
        sessionId,
        JSON.stringify(["topic:capture"]),
        JSON.stringify(["a.ts"]),
        JSON.stringify(["b.ts"]),
        options.citesRecorded === false ? 0 : 1,
      );
      const turnId = db
        .query<{ id: number }, []>("SELECT id FROM turns ORDER BY id DESC LIMIT 1")
        .get()!.id;
      return { turnId, neighbourId, path };
    }

    function seedCitations(turnId: number, neighbourId: number): void {
      db.query(
        `INSERT INTO turn_citations
           (citing_turn_id, cited_turn_id, relation, created_at_epoch)
         VALUES (?, ?, 'builds-on', 700), (?, ?, 'evidence-for', 701)`,
      ).run(turnId, neighbourId, neighbourId, turnId);
    }

    function citationPairs(): Array<[number, number]> {
      return db
        .query<{ citing: number; cited: number }, []>(
          `SELECT citing_turn_id AS citing, cited_turn_id AS cited
           FROM turn_citations ORDER BY citing, cited`,
        )
        .all()
        .map((row) => [row.citing, row.cited] as [number, number]);
    }

    test("converts the whole row to the spec column disposition", () => {
      const { turnId, path } = seedOccupiedTurn();

      const outcome = repair(path);

      expect(outcome?.compact).toEqual({
        inserted: 0,
        converted: 1,
        adopted: 0,
        skipped: 0,
      });
      expect(getTurnsForSession(db, sessionId)).toHaveLength(2);
      expect(getTurnById(db, turnId)).toEqual({
        id: turnId,
        sessionId,
        // preserved
        promptNumber: 7,
        userPrompt: "the real prompt",
        createdAtEpoch: 700,
        contentPromptId: "prompt-9",
        // set
        type: "compact",
        status: "extracted",
        title: "/compact",
        compactBoundaryUuid: "boundary-1",
        updatedAtEpoch: 900,
        // set — the boundary's own metadata, so a converted marker renders
        // exactly like an inserted one
        tags: ["compact:pre_tokens=512", "compact:trigger=auto"],
        citesRecorded: true,
        // cleared
        content: null,
        insight: null,
        significanceGrade: null,
        assistantResponse: null,
        assistantTranscript: null,
        filesRead: [],
        filesModified: [],
        toolCallCount: null,
        wasInterrupted: false,
        wasRolledBack: false,
        extractionStallAttempts: 0,
        extractionStallRetryAtMs: null,
        extractionStallRetryAfterSeq: null,
        extractionStallRetryMode: null,
        // untouched by the disposition list
        transcriptLineStart: 41,
        parentTurnId: null,
      });
    });

    test("prunes the converted turn's outgoing citations and keeps incoming ones", () => {
      const { turnId, neighbourId, path } = seedOccupiedTurn();
      seedCitations(turnId, neighbourId);
      expect(citationPairs()).toEqual([
        [neighbourId, turnId],
        [turnId, neighbourId],
      ]);

      repair(path);

      // Outgoing edges came from the erased phantom extraction and must not keep
      // feeding in-degree; incoming edges are another turn's provenance.
      expect(citationPairs()).toEqual([[neighbourId, turnId]]);
    });

    test("makes an un-recorded row's empty citation set authoritative", () => {
      const { turnId, path } = seedOccupiedTurn({ citesRecorded: false });
      expect(getTurnById(db, turnId)?.citesRecorded).toBe(false);

      repair(path);

      expect(getTurnById(db, turnId)?.citesRecorded).toBe(true);
      expect(citationPairs()).toEqual([]);
    });

    test("a later Stop backfill cannot mutate the converted marker", () => {
      const { turnId, path } = seedOccupiedTurn();
      repair(path);
      const before = db
        .query<Record<string, unknown>, [number]>(
          "SELECT * FROM turns WHERE id = ?",
        )
        .get(turnId);

      // Conversion preserves user_prompt and clears assistant_response, which is
      // precisely the shape the Stop backfill treats as "still needs filling".
      backfillFromTranscript(
        db,
        getTurnsForSession(db, sessionId),
        path,
        "a late assistant message",
      );

      expect(
        db
          .query<Record<string, unknown>, [number]>(
            "SELECT * FROM turns WHERE id = ?",
          )
          .get(turnId),
      ).toEqual(before as Record<string, unknown>);
    });

    test("retires the converted turn's observations and queue work", () => {
      const { turnId, path } = seedOccupiedTurn();
      const pending = createObservation(db, {
        turnId,
        toolName: "Read",
        toolInput: "{}",
        toolResult: "partial",
        createdAtEpoch: 701,
      });
      db.query(
        `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
         VALUES ('obs', ?, ?, 701), ('turn-stop', ?, ?, 702)`,
      ).run(pending.id, sessionId, turnId, sessionId);

      repair(path);

      expect(
        db
          .query<{ status: string }, [number]>(
            "SELECT status FROM observations WHERE id = ?",
          )
          .get(pending.id)?.status,
      ).toBe("skipped");
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM pending_queue",
          )
          .get()?.count,
      ).toBe(0);
    });

    test("a converted marker cannot be picked up by later extraction", () => {
      const { turnId, path } = seedOccupiedTurn();

      repair(path);

      expect(getOrphanTurns(db, sessionId)).toEqual([]);
      expect(getStrandedTurns(db, sessionId)).toEqual([]);
      expect(
        db
          .query<{ count: number }, [number]>(
            "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'turn' AND source_id = ?",
          )
          .get(turnId)?.count,
      ).toBe(0);
    });
  });

  describe("link-only reconcile", () => {
    function rawRow(turnId: number): Record<string, unknown> {
      return db
        .query<Record<string, unknown>, [number]>(
          "SELECT * FROM turns WHERE id = ?",
        )
        .get(turnId) as Record<string, unknown>;
    }

    test("fills only the NULL link columns and leaves every other byte alone", () => {
      const path = writeTranscript("links.jsonl", [
        userEntry("user-1", "prompt-a", "first prompt"),
        userEntry("user-2", "prompt-b", "second prompt"),
      ]);
      const first = insertTurn({ promptNumber: 1, userPrompt: "first prompt" });
      const second = insertTurn({ promptNumber: 2, userPrompt: "second prompt" });
      db.query(
        `UPDATE turns SET status = 'extracted', title = 'T', content = 'C',
           assistant_response = 'R', tool_call_count = 3, updated_at_epoch = 500
         WHERE id IN (?, ?)`,
      ).run(first, second);
      const before = [rawRow(first), rawRow(second)];

      const outcome = repair(path);

      expect(outcome?.links).toEqual({ linked: 2, skipped: 0 });
      const after = [rawRow(first), rawRow(second)];
      for (let index = 0; index < before.length; index += 1) {
        const expectedUnchanged = { ...before[index] } as Record<string, unknown>;
        const actualUnchanged = { ...after[index] } as Record<string, unknown>;
        delete expectedUnchanged.content_prompt_id;
        delete expectedUnchanged.transcript_line_start;
        delete actualUnchanged.content_prompt_id;
        delete actualUnchanged.transcript_line_start;
        expect(actualUnchanged).toEqual(expectedUnchanged);
      }
      expect(after[0]).toMatchObject({
        content_prompt_id: "prompt-a",
        transcript_line_start: 1,
      });
      expect(after[1]).toMatchObject({
        content_prompt_id: "prompt-b",
        transcript_line_start: 2,
      });
    });

    test("fills a missing line number for a turn that already knows its promptId", () => {
      const path = writeTranscript("line-only.jsonl", [
        userEntry("user-1", "prompt-a", "only prompt"),
      ]);
      const turnId = insertTurn({
        promptNumber: 1,
        userPrompt: "only prompt",
        contentPromptId: "prompt-a",
      });

      expect(repair(path)?.links).toEqual({ linked: 1, skipped: 0 });
      expect(getTurnById(db, turnId)).toMatchObject({
        contentPromptId: "prompt-a",
        transcriptLineStart: 1,
      });
    });

    test("skips duplicate prompt text and logs it", () => {
      const path = writeTranscript("duplicate.jsonl", [
        userEntry("user-1", "prompt-a", "same text"),
        userEntry("user-2", "prompt-b", "same text"),
      ]);
      const first = insertTurn({ promptNumber: 1, userPrompt: "same text" });
      const second = insertTurn({ promptNumber: 2, userPrompt: "same text" });

      const outcome = repair(path);

      expect(outcome?.links).toEqual({ linked: 0, skipped: 2 });
      expect(getTurnById(db, first)?.contentPromptId).toBeNull();
      expect(getTurnById(db, second)?.contentPromptId).toBeNull();
      expect(logLines.filter((line) => line.includes("ambiguous prompt text"))).toHaveLength(2);
    });

    test("skips a promptId another turn already owns and logs it", () => {
      const path = writeTranscript("owned.jsonl", [
        userEntry("user-1", "prompt-a", "shared wording"),
      ]);
      insertTurn({
        promptNumber: 1,
        userPrompt: "an earlier turn",
        contentPromptId: "prompt-a",
        transcriptLineStart: 1,
      });
      const orphanLink = insertTurn({ promptNumber: 2, userPrompt: "shared wording" });

      const outcome = repair(path);

      expect(outcome?.links).toEqual({ linked: 0, skipped: 1 });
      expect(getTurnById(db, orphanLink)?.contentPromptId).toBeNull();
      expect(logLines.some((line) => line.includes("already owned"))).toBe(true);
    });

    test("logs an occupied promptId even when no NULL-link turn matches it", () => {
      const path = writeTranscript("occupied-log.jsonl", [
        userEntry("user-1", "prompt-a", "owned elsewhere"),
        userEntry("user-2", "prompt-b", "unmatched prompt"),
      ]);
      // prompt-a is owned by a turn whose text does NOT match the transcript
      // entry, so the old order (match first, ownership second) never reached
      // the ownership branch and the candidate vanished from the diagnostics.
      insertTurn({
        promptNumber: 1,
        userPrompt: "text that does not match",
        contentPromptId: "prompt-a",
        transcriptLineStart: 1,
      });
      insertTurn({ promptNumber: 2, userPrompt: "still unlinked" });

      const outcome = repair(path);

      expect(outcome?.links).toEqual({ linked: 0, skipped: 1 });
      expect(
        logLines.filter(
          (line) => line.includes("prompt-a") && line.includes("already owned"),
        ),
      ).toHaveLength(1);
    });

    test("skips an order inversion between transcript order and prompt order", () => {
      const path = writeTranscript("inverted.jsonl", [
        userEntry("user-1", "prompt-a", "later prompt"),
        userEntry("user-2", "prompt-b", "earlier prompt"),
      ]);
      const earlier = insertTurn({ promptNumber: 1, userPrompt: "earlier prompt" });
      const later = insertTurn({ promptNumber: 2, userPrompt: "later prompt" });

      const outcome = repair(path);

      expect(outcome?.links).toEqual({ linked: 1, skipped: 1 });
      expect(getTurnById(db, later)?.contentPromptId).toBe("prompt-a");
      expect(getTurnById(db, earlier)?.contentPromptId).toBeNull();
      expect(
        logLines.some((line) =>
          line.includes("transcript order and prompt order disagree"),
        ),
      ).toBe(true);
    });

    test("never creates a turn for an unmatched transcript prompt", () => {
      const path = writeTranscript("no-turns.jsonl", [
        userEntry("user-1", "prompt-a", "a prompt with no turn"),
        userEntry("user-2", "prompt-b", "another prompt with no turn"),
      ]);

      repair(path);

      expect(getTurnsForSession(db, sessionId)).toHaveLength(0);
    });

    test("ignores sidechain, interrupt-marker and system-injected entries", () => {
      const path = writeTranscript("filtered.jsonl", [
        {
          type: "user",
          uuid: "side-1",
          promptId: "prompt-side",
          isSidechain: true,
          message: { role: "user", content: "sidechain prompt" },
        },
        userEntry("int-1", "prompt-int", "[Request interrupted by user]"),
        userEntry("sys-1", "prompt-sys", "<task-notification>done</task-notification>"),
      ]);
      const sidechainTurn = insertTurn({ promptNumber: 1, userPrompt: "sidechain prompt" });
      const interruptTurn = insertTurn({
        promptNumber: 2,
        userPrompt: "[Request interrupted by user]",
      });
      const injectedTurn = insertTurn({
        promptNumber: 3,
        userPrompt: "<task-notification>done</task-notification>",
      });

      expect(repair(path)?.links).toEqual({ linked: 0, skipped: 0 });
      for (const turnId of [sidechainTurn, interruptTurn, injectedTurn]) {
        expect(getTurnById(db, turnId)?.contentPromptId).toBeNull();
      }
    });
  });

  describe("byte cursor", () => {
    test("never crosses a partial final line and picks it up once complete", () => {
      const path = transcriptPathFor("partial.jsonl");
      writeFileSync(
        path,
        `${serialize([userEntry("user-1", "prompt-a", "committed prompt")])}{"type":"user","uuid":"user-2","promptId":"prom`,
        "utf8",
      );
      const first = insertTurn({ promptNumber: 1, userPrompt: "committed prompt" });
      const second = insertTurn({ promptNumber: 2, userPrompt: "half-written prompt" });

      const firstPass = repair(path);

      expect(firstPass?.scannedEntries).toBe(1);
      expect(session().scanCursorLine).toBe(1);
      expect(getTurnById(db, second)?.contentPromptId).toBeNull();

      // The writer finishes the record; the cursor resumes exactly at its start.
      writeFileSync(
        path,
        serialize([
          userEntry("user-1", "prompt-a", "committed prompt"),
          userEntry("user-2", "prompt-b", "half-written prompt"),
        ]),
        "utf8",
      );
      repair(path);

      expect(getTurnById(db, first)?.contentPromptId).toBe("prompt-a");
      expect(getTurnById(db, second)?.contentPromptId).toBe("prompt-b");
      expect(session().scanCursorLine).toBe(2);
    });

    test("defers the remainder past the line cap to the next event", () => {
      const path = writeTranscript("capped.jsonl", [
        userEntry("user-1", "prompt-a", "prompt one"),
        userEntry("user-2", "prompt-b", "prompt two"),
        userEntry("user-3", "prompt-c", "prompt three"),
        userEntry("user-4", "prompt-d", "prompt four"),
      ]);
      const turns = [
        insertTurn({ promptNumber: 1, userPrompt: "prompt one" }),
        insertTurn({ promptNumber: 2, userPrompt: "prompt two" }),
        insertTurn({ promptNumber: 3, userPrompt: "prompt three" }),
        insertTurn({ promptNumber: 4, userPrompt: "prompt four" }),
      ];

      const firstPass = repair(path, 2);

      expect(firstPass?.truncated).toBe(true);
      expect(firstPass?.links.linked).toBe(2);
      expect(session().scanCursorLine).toBe(2);
      expect(getTurnById(db, turns[2]!)?.contentPromptId).toBeNull();

      const secondPass = repair(path, 2);

      expect(secondPass?.truncated).toBe(false);
      expect(secondPass?.links.linked).toBe(2);
      expect(session().scanCursorLine).toBe(4);
      expect(getTurnById(db, turns[3]!)?.contentPromptId).toBe("prompt-d");
    });

    test("resumes from the persisted cursor rather than rescanning", () => {
      const path = writeTranscript("resume.jsonl", [
        userEntry("user-1", "prompt-a", "prompt one"),
      ]);
      insertTurn({ promptNumber: 1, userPrompt: "prompt one" });

      repair(path);
      const cursorAfterFirst = session().scanCursorByteOffset;
      expect(cursorAfterFirst).toBeGreaterThan(0);

      appendTranscript(path, [userEntry("user-2", "prompt-b", "prompt two")]);
      const secondTurn = insertTurn({ promptNumber: 2, userPrompt: "prompt two" });

      const second = repair(path);

      expect(second?.scannedEntries).toBe(1);
      expect(getTurnById(db, secondTurn)?.transcriptLineStart).toBe(2);
    });

    test("restarts from the top when the transcript shrank below the cursor", () => {
      const path = writeTranscript("shrunk.jsonl", [
        userEntry("user-1", "prompt-a", "prompt one"),
        userEntry("user-2", "prompt-b", "prompt two"),
      ]);
      repair(path);
      expect(session().scanCursorByteOffset).toBeGreaterThan(0);

      writeTranscript("shrunk.jsonl", [userEntry("user-9", "prompt-z", "fresh")]);
      const freshTurn = insertTurn({ promptNumber: 1, userPrompt: "fresh" });

      repair(path);

      expect(getTurnById(db, freshTurn)?.transcriptLineStart).toBe(1);
      expect(session().scanCursorLine).toBe(1);
    });

    test("scanTranscriptIncrementally returns null for a missing transcript", () => {
      expect(
        scanTranscriptIncrementally(transcriptPathFor("absent.jsonl"), {
          byteOffset: 0,
          lineNumber: 0,
        }),
      ).toBeNull();
    });

    test("a stale concurrent writer cannot regress the high-water cursor", () => {
      const path = writeTranscript("race.jsonl", [
        userEntry("user-1", "prompt-a", "prompt one"),
        userEntry("user-2", "prompt-b", "prompt two"),
        userEntry("user-3", "prompt-c", "prompt three"),
      ]);
      insertTurn({ promptNumber: 1, userPrompt: "prompt one" });
      insertTurn({ promptNumber: 2, userPrompt: "prompt two" });
      insertTurn({ promptNumber: 3, userPrompt: "prompt three" });
      // Both hooks read the cursor at 0 before either committed.
      const observed = { id: sessionId, scanCursorByteOffset: 0, scanCursorLine: 0 };

      // Winner: scans the whole file and commits.
      runCaptureRepair(db, { ...observed }, path, { nowEpoch: 900, log });
      const highWaterByte = session().scanCursorByteOffset;
      const highWaterLine = session().scanCursorLine;
      expect(highWaterLine).toBe(3);

      // Loser: same stale observation, shorter window, commits afterwards.
      runCaptureRepair(db, { ...observed }, path, {
        nowEpoch: 901,
        log,
        maxLines: 1,
      });

      expect(session().scanCursorByteOffset).toBe(highWaterByte);
      expect(session().scanCursorLine).toBe(highWaterLine);
      expect(logLines.some((line) => line.includes("moved under us"))).toBe(true);
      // The stale pass' own work stayed idempotent — no duplicate turns.
      expect(getTurnsForSession(db, sessionId)).toHaveLength(3);
    });

    test("holds the cursor before a record longer than the byte cap", () => {
      const path = writeTranscript("oversized.jsonl", [
        userEntry("user-1", "prompt-a", "x".repeat(400)),
        userEntry("user-2", "prompt-b", "the next prompt"),
      ]);
      const turnId = insertTurn({ promptNumber: 1, userPrompt: "x".repeat(400) });

      // The first record alone exceeds the window, so nothing is committable.
      // The cap must NOT be silently replaced by "read the rest of the file".
      expect(
        runCaptureRepair(db, session(), path, { nowEpoch: 900, log, maxBytes: 64 }),
      ).toBeNull();
      expect(session().scanCursorByteOffset).toBe(0);
      expect(
        logLines.filter((line) => line.includes("exceeds the 64-byte window cap")),
      ).toHaveLength(1);
      expect(getTurnById(db, turnId)?.contentPromptId).toBeNull();

      // A window big enough to hold the record makes progress normally.
      runCaptureRepair(db, session(), path, { nowEpoch: 901, log, maxBytes: 4096 });
      expect(getTurnById(db, turnId)?.contentPromptId).toBe("prompt-a");
    });

    test("a multibyte character split by the byte cap survives intact", () => {
      const first = userEntry("user-1", "prompt-a", "汉字提示词一二三");
      const second = userEntry("user-2", "prompt-b", "第二条提示词");
      const path = writeTranscript("utf8.jsonl", [first, second]);
      const firstTurn = insertTurn({ promptNumber: 1, userPrompt: "汉字提示词一二三" });
      const secondTurn = insertTurn({ promptNumber: 2, userPrompt: "第二条提示词" });

      // Cut one byte INTO the first 3-byte character of line 2's content.
      const secondLine = JSON.stringify(second);
      const cjkStart = secondLine.indexOf("第");
      const maxBytes =
        Buffer.byteLength(JSON.stringify(first), "utf8") +
        1 +
        Buffer.byteLength(secondLine.slice(0, cjkStart), "utf8") +
        1;

      // The window stops at the last newline, so the split character is never
      // decoded — the committed text is byte-exact, not a replacement char.
      const window = scanTranscriptIncrementally(
        path,
        { byteOffset: 0, lineNumber: 0 },
        { maxBytes },
      );
      expect(window?.entries).toHaveLength(1);
      expect(window?.entries[0]?.content).toBe("汉字提示词一二三");
      expect(window?.nextCursor.lineNumber).toBe(1);
      expect(window?.oversizedRecord).toBe(false);

      runCaptureRepair(db, session(), path, { nowEpoch: 900, log, maxBytes });

      // Both halves link, which only holds if neither decode was corrupted (the
      // pairing is an exact full-text match against the DB prompt).
      expect(getTurnById(db, firstTurn)?.contentPromptId).toBe("prompt-a");
      expect(getTurnById(db, secondTurn)?.contentPromptId).toBe("prompt-b");
      expect(getTurnById(db, secondTurn)?.transcriptLineStart).toBe(2);
    });
  });

  describe("replayed duplicate entries", () => {
    test("merges a duplicated boundary UUID inside one window", () => {
      const path = writeTranscript("replay-boundary.jsonl", [
        boundary("boundary-1", 777, "auto"),
        // Replay-appended partial snapshot of the same entry: same uuid, no
        // compactMetadata. Read raw it would mint the marker with default tags.
        { type: "system", subtype: "compact_boundary", uuid: "boundary-1" },
        wrapper("summary-1", "boundary-1", "prompt-1"),
      ]);

      expect(repair(path)?.compact.inserted).toBe(1);

      expect(
        getTurnsForSession(db, sessionId).find((turn) => turn.type === "compact"),
      ).toMatchObject({
        compactBoundaryUuid: "boundary-1",
        tags: ["compact:pre_tokens=777", "compact:trigger=auto"],
        transcriptLineStart: 3,
      });
    });

    test("anchors a link to the first physical line of a duplicated entry", () => {
      const path = writeTranscript("replay-link.jsonl", [
        // First occurrence lacks promptId (it arrives with the re-emit).
        { type: "user", uuid: "user-1", message: { role: "user", content: "replayed prompt" } },
        userEntry("user-1", "prompt-a", "replayed prompt"),
      ]);
      const turnId = insertTurn({ promptNumber: 1, userPrompt: "replayed prompt" });

      expect(repair(path)?.links).toEqual({ linked: 1, skipped: 0 });
      expect(getTurnById(db, turnId)).toMatchObject({
        contentPromptId: "prompt-a",
        transcriptLineStart: 1,
      });
    });

    test("a duplicate replayed in a LATER window is a no-op", () => {
      const path = writeTranscript("replay-window.jsonl", [
        boundary("boundary-1", 64, "auto"),
        wrapper("summary-1", "boundary-1", "prompt-1"),
        userEntry("user-2", "prompt-b", "an ordinary prompt"),
      ]);
      const ordinary = insertTurn({ promptNumber: 1, userPrompt: "an ordinary prompt" });

      repair(path);
      const beforeReplay = db
        .query<Record<string, unknown>, []>("SELECT * FROM turns ORDER BY id")
        .all();

      // The writer replays the same three records past the cursor.
      appendTranscript(path, [
        boundary("boundary-1", 64, "auto"),
        wrapper("summary-1", "boundary-1", "prompt-1"),
        userEntry("user-2", "prompt-b", "an ordinary prompt"),
      ]);
      const second = repair(path);

      // Claiming is UUID-idempotent; linking is owned-promptId-guarded.
      expect(second?.compact).toEqual({
        inserted: 0,
        converted: 0,
        adopted: 0,
        skipped: 1,
      });
      expect(second?.links.linked).toBe(0);
      expect(
        db.query<Record<string, unknown>, []>("SELECT * FROM turns ORDER BY id").all(),
      ).toEqual(beforeReplay);
      expect(getTurnById(db, ordinary)?.transcriptLineStart).toBe(3);
    });
  });

  test("a forked session claims the same boundary UUID independently", () => {
    const path = writeTranscript("forked.jsonl", [
      boundary("boundary-1", 256, "auto"),
      wrapper("summary-1", "boundary-1", "prompt-1"),
    ]);
    // A fork/resume inherits the parent transcript prefix verbatim, so the same
    // boundary UUID legitimately appears in two sessions — uniqueness is
    // (session_id, uuid), not global.
    const forkId = upsertSession(db, {
      contentSessionId: "session-capture-fork",
      project: PROJECT,
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;

    expect(repair(path)?.compact.inserted).toBe(1);
    expect(
      runCaptureRepair(
        db,
        { id: forkId, scanCursorByteOffset: 0, scanCursorLine: 0 },
        path,
        { nowEpoch: 900, log },
      )?.compact.inserted,
    ).toBe(1);

    expect(
      db
        .query<{ sessionId: number }, [string]>(
          `SELECT session_id AS sessionId FROM turns
           WHERE compact_boundary_uuid = ? ORDER BY session_id`,
        )
        .all("boundary-1")
        .map((row) => row.sessionId),
    ).toEqual([sessionId, forkId].sort((a, b) => a - b));
  });

  describe("UserPromptSubmit integration", () => {
    function promptInput(
      overrides: Partial<NormalizedHookInput> = {},
    ): NormalizedHookInput {
      return {
        eventName: "UserPromptSubmit",
        sessionId: CONTENT_SESSION_ID,
        cwd: PROJECT,
        prompt: "next prompt",
        stopHookActive: false,
        raw: {},
        ...overrides,
      };
    }

    test("claims boundaries before minting the new pending turn", async () => {
      const path = writeTranscript("hook.jsonl", [
        boundary("boundary-1", 256, "auto"),
        wrapper("summary-1", "boundary-1", "prompt-1"),
      ]);
      insertTurn({ promptNumber: 1, userPrompt: "old prompt", status: "extracted" });
      const handler = createSessionInitHandler({
        db,
        now: () => 950,
        captureRepairLog: log,
      });

      await handler(promptInput({ transcriptPath: path }));

      const turns = getTurnsForSession(db, sessionId);
      expect(turns.map((turn) => [turn.promptNumber, turn.type])).toEqual([
        [1, null],
        [2, "compact"],
        [3, null],
      ]);
      expect(turns[2]).toMatchObject({ status: "active", userPrompt: "next prompt" });
      expect(session().scanCursorLine).toBe(2);
    });

    test("is a no-op without a transcript path", async () => {
      const handler = createSessionInitHandler({ db, now: () => 950 });

      await handler(promptInput());

      expect(getTurnsForSession(db, sessionId)).toHaveLength(1);
      expect(session().scanCursorByteOffset).toBe(0);
    });
  });

  describe("SessionEnd backstop", () => {
    async function markRunStart(): Promise<void> {
      await createContextHandler({ db, nowEpoch: () => 200 })({
        eventName: "SessionStart",
        sessionId: CONTENT_SESSION_ID,
        cwd: PROJECT,
        source: "resume",
        stopHookActive: false,
        raw: {},
      });
    }

    test("a repair-created marker does not make a glance look like a live run", async () => {
      // Orphan from a PREVIOUS run — must stay untouched.
      const orphan = insertTurn({
        promptNumber: 1,
        userPrompt: "old interrupted prompt",
        createdAtEpoch: 90,
      });
      const path = writeTranscript("session-end.jsonl", [
        boundary("boundary-1", 999, "auto"),
        wrapper("summary-1", "boundary-1", "prompt-1"),
      ]);
      await markRunStart();
      const fetchImpl = mock(async () => {
        throw new Error("worker is down");
      });
      const handler = createSessionEndHandler({
        db,
        now: () => 300,
        workerClientDeps: { fetchImpl },
        captureRepairLog: log,
      });

      const result = await handler({
        eventName: "SessionEnd",
        sessionId: CONTENT_SESSION_ID,
        cwd: PROJECT,
        transcriptPath: path,
        stopHookActive: false,
        raw: {},
      });

      expect(result.continue).toBe(true);
      // The repair ran…
      expect(
        getTurnsForSession(db, sessionId).some((turn) => turn.type === "compact"),
      ).toBe(true);
      // …but the activity snapshot predates it, so the old orphan is left alone.
      expect(
        db
          .query<{ status: string; updatedAtEpoch: number | null }, [number]>(
            "SELECT status, updated_at_epoch AS updatedAtEpoch FROM turns WHERE id = ?",
          )
          .get(orphan),
      ).toEqual({ status: "active", updatedAtEpoch: null });
    });

    test("falls back to the derived transcript path and skips silently when absent", async () => {
      await markRunStart();
      const handler = createSessionEndHandler({ db, now: () => 300, captureRepairLog: log });

      const result = await handler({
        eventName: "SessionEnd",
        sessionId: CONTENT_SESSION_ID,
        cwd: PROJECT,
        stopHookActive: false,
        raw: {},
      });

      expect(result.continue).toBe(true);
      expect(getTurnsForSession(db, sessionId)).toHaveLength(0);
      expect(session().scanCursorByteOffset).toBe(0);
    });

    test("bounds the backstop scan and defers the remainder", async () => {
      const path = writeTranscript("session-end-cap.jsonl", [
        userEntry("user-1", "prompt-a", "prompt one"),
        userEntry("user-2", "prompt-b", "prompt two"),
        userEntry("user-3", "prompt-c", "prompt three"),
      ]);
      const turns = [
        insertTurn({ promptNumber: 1, userPrompt: "prompt one" }),
        insertTurn({ promptNumber: 2, userPrompt: "prompt two" }),
        insertTurn({ promptNumber: 3, userPrompt: "prompt three" }),
      ];
      db.query("UPDATE turns SET status = 'extracted', assistant_response = 'r'").run();
      await markRunStart();
      const handler = createSessionEndHandler({
        db,
        now: () => 300,
        captureRepairMaxLines: 1,
        captureRepairLog: log,
      });

      await handler({
        eventName: "SessionEnd",
        sessionId: CONTENT_SESSION_ID,
        cwd: PROJECT,
        transcriptPath: path,
        stopHookActive: false,
        raw: {},
      });

      expect(getTurnById(db, turns[0]!)?.contentPromptId).toBe("prompt-a");
      expect(getTurnById(db, turns[1]!)?.contentPromptId).toBeNull();
      expect(logLines.some((line) => line.includes("remainder deferred"))).toBe(true);
    });

    /** Advances a fixed step per read, so any measured span is deterministic. */
    function steppingClock(startMs: number, stepMs: number): () => number {
      let current = startMs - stepMs;
      return () => {
        current += stepMs;
        return current;
      };
    }

    test("stops the repair at its wall-clock deadline and still finalizes orphans", async () => {
      const path = writeTranscript("session-end-slow.jsonl", [
        userEntry("user-1", "prompt-a", "prompt one"),
        userEntry("user-2", "prompt-b", "prompt two"),
        userEntry("user-3", "prompt-c", "prompt three"),
      ]);
      const turns = [
        insertTurn({ promptNumber: 1, userPrompt: "prompt one" }),
        insertTurn({ promptNumber: 2, userPrompt: "prompt two" }),
        insertTurn({ promptNumber: 3, userPrompt: "prompt three" }),
      ];
      db.query("UPDATE turns SET status = 'extracted', assistant_response = 'r'").run();
      await markRunStart();
      const orphan = insertTurn({
        promptNumber: 4,
        userPrompt: "interrupted work",
        createdAtEpoch: 250,
      });
      const handler = createSessionEndHandler({
        db,
        now: () => 300,
        // 100ms per clock read against a 400ms budget: the second batch's
        // pre-check lands past the deadline.
        nowMs: steppingClock(1_000, 100),
        captureRepairBatchLines: 1,
        captureRepairLog: log,
      });

      await handler({
        eventName: "SessionEnd",
        sessionId: CONTENT_SESSION_ID,
        cwd: PROJECT,
        transcriptPath: path,
        stopHookActive: false,
        raw: {},
      });

      // First batch committed, the rest deferred rather than overrunning.
      expect(getTurnById(db, turns[0]!)?.contentPromptId).toBe("prompt-a");
      expect(getTurnById(db, turns[1]!)?.contentPromptId).toBeNull();
      expect(session().scanCursorLine).toBe(1);
      expect(
        logLines.some((line) => line.includes("400ms budget") && line.includes("deferred")),
      ).toBe(true);
      // Cleanup — the whole point of the budget — still ran.
      expect(getTurnById(db, orphan)?.status).toBe("skipped");
    });

    test("skips the repair outright when the budget is already spent", async () => {
      const path = writeTranscript("session-end-spent.jsonl", [
        userEntry("user-1", "prompt-a", "prompt one"),
      ]);
      const turnId = insertTurn({ promptNumber: 1, userPrompt: "prompt one" });
      await markRunStart();
      const handler = createSessionEndHandler({
        db,
        now: () => 300,
        // One 1s step burns the entire 400ms budget before the repair starts.
        nowMs: steppingClock(1_000, 1_000),
        captureRepairLog: log,
      });

      const result = await handler({
        eventName: "SessionEnd",
        sessionId: CONTENT_SESSION_ID,
        cwd: PROJECT,
        transcriptPath: path,
        stopHookActive: false,
        raw: {},
      });

      expect(result.continue).toBe(true);
      expect(getTurnById(db, turnId)?.contentPromptId).toBeNull();
      expect(session().scanCursorByteOffset).toBe(0);
      expect(logLines.some((line) => line.includes("capture repair skipped"))).toBe(true);
    });

    test("a turn created after the snapshot is not finalized as an orphan", async () => {
      const path = writeTranscript("session-end-race.jsonl", [
        boundary("boundary-1", 128, "auto"),
        wrapper("summary-1", "boundary-1", "prompt-1"),
      ]);
      await markRunStart();
      const preExistingOrphan = insertTurn({
        promptNumber: 1,
        userPrompt: "interrupted work",
        createdAtEpoch: 250,
      });
      let racingTurn = 0;
      const handler = createSessionEndHandler({
        db,
        now: () => 300,
        captureRepairLog: log,
        // Stands in for a UserPromptSubmit committing a live turn after the
        // activity gate was read but before the orphan pass runs.
        captureRepairRunner: (database, sess, transcriptPath, options) => {
          racingTurn = insertTurn({
            promptNumber: 2,
            userPrompt: "a prompt still being answered",
            createdAtEpoch: 299,
          });
          return runCaptureRepair(database, sess, transcriptPath, options);
        },
      });

      await handler({
        eventName: "SessionEnd",
        sessionId: CONTENT_SESSION_ID,
        cwd: PROJECT,
        transcriptPath: path,
        stopHookActive: false,
        raw: {},
      });

      expect(getTurnById(db, preExistingOrphan)?.status).toBe("skipped");
      // Outside the id fence — still live, must not be marked skipped.
      expect(getTurnById(db, racingTurn)?.status).toBe("active");
      // The repair's own marker is outside the fence for the same reason.
      expect(
        getTurnsForSession(db, sessionId).find((turn) => turn.type === "compact")
          ?.status,
      ).toBe("extracted");
    });

    test("a throwing repair rolls back, still cleans up, and re-repairs later", async () => {
      const path = writeTranscript("session-end-throw.jsonl", [
        boundary("boundary-1", 32, "auto"),
        wrapper("summary-1", "boundary-1", "prompt-1"),
      ]);
      await markRunStart();
      const orphan = insertTurn({
        promptNumber: 1,
        userPrompt: "interrupted work",
        createdAtEpoch: 250,
      });
      const endInput: NormalizedHookInput = {
        eventName: "SessionEnd",
        sessionId: CONTENT_SESSION_ID,
        cwd: PROJECT,
        transcriptPath: path,
        stopHookActive: false,
        raw: {},
      };
      const failing = createSessionEndHandler({
        db,
        now: () => 300,
        captureRepairLog: log,
        // Throws AFTER the repair body ran, inside its transaction.
        captureRepairRunner: (database, sess, transcriptPath, options) =>
          runCaptureRepair(database, sess, transcriptPath, {
            ...options,
            writeTransaction: (inner, work) =>
              options.writeTransaction!(inner, () => {
                work();
                throw new Error("boom");
              }),
          }),
      });

      const result = await failing(endInput);

      expect(result.continue).toBe(true);
      // Claims, links and cursor all rolled back together.
      expect(
        getTurnsForSession(db, sessionId).some((turn) => turn.type === "compact"),
      ).toBe(false);
      expect(session().scanCursorByteOffset).toBe(0);
      expect(logLines.some((line) => line.includes("capture repair failed"))).toBe(true);
      // Subordinate, not blocking: cleanup ran anyway.
      expect(getTurnById(db, orphan)?.status).toBe("skipped");

      const healthy = createSessionEndHandler({
        db,
        now: () => 400,
        captureRepairLog: log,
      });
      await healthy(endInput);

      // The same window is repaired on re-entry — nothing was lost.
      expect(
        getTurnsForSession(db, sessionId).find((turn) => turn.type === "compact")
          ?.compactBoundaryUuid,
      ).toBe("boundary-1");
      expect(session().scanCursorLine).toBe(2);
    });
  });

  test("the post-compact subcommand no longer routes to a handler", async () => {
    const handler = mock(async () => ({ continue: true }));
    const stderr = { write: mock(() => true) };

    const exitCode = await runHookCommand({
      env: {},
      argv: ["bun", "hook-command.ts", "post-compact"],
      stdout: { write: mock(() => true) },
      stderr,
      readJsonFromStdin: () => ({}),
      handlers: { PreCompact: handler as unknown as HookHandler } as unknown as Record<
        string,
        HookHandler
      >,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
  });
});
