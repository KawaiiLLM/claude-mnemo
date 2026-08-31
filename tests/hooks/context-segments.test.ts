import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  attachSegmentToSession,
  createSegment,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import {
  createSegmentBlockContextHandler,
} from "../../src/hooks/handlers/context-segments";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
} from "../../src/db/note-settlement";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";
import type { NormalizedHookInput } from "../../src/hooks/types";
import { insertLane } from "../../src/db/lanes";
import { TASK_CAUSALITY_ERA_CUTOFF_EPOCH } from "../../src/task-causality-era";

function input(overrides: Partial<NormalizedHookInput> = {}): NormalizedHookInput {
  return {
    eventName: "SessionStart",
    source: "resume",
    sessionId: "segment-slot-session",
    cwd: "/projects/segment-slots",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

describe("createSegmentBlockContextHandler", () => {
  test("slot k renders the k-th most-recently-active attached segment's block", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const session = upsertSession(db, {
      contentSessionId: "segment-slot-session",
      project: "/projects/segment-slots",
      title: "Slots",
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const older = createSegment(db, { title: "Older lane", nowEpoch: 1_001 });
    const newer = createSegment(db, { title: "Newer lane", nowEpoch: 1_002 });
    attachSegmentToSession(db, session.id, older.id, 1_001);
    attachSegmentToSession(db, session.id, newer.id, 1_002);

    const slot1 = await createSegmentBlockContextHandler({ db }, 1, "fields")(input());
    const slot2 = await createSegmentBlockContextHandler({ db }, 2, "fields")(input());
    const slot3 = await createSegmentBlockContextHandler({ db }, 3, "fields")(input());

    expect(slot1.hookSpecificOutput).toContain(`[E${newer.id}] · fields`);
    expect(slot2.hookSpecificOutput).toContain(`[E${older.id}] · fields`);
    // Slot 3 has no third attached segment — silent, not an empty block.
    expect(slot3).toEqual({ continue: true });
    db.close();
  });

  test("gated to resume|compact — startup/clear stay silent even with attachments", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const session = upsertSession(db, {
      contentSessionId: "segment-slot-session",
      project: "/projects/segment-slots",
      title: "Slots",
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const segment = createSegment(db, { title: "Gated lane", nowEpoch: 1_000 });
    attachSegmentToSession(db, session.id, segment.id, 1_000);

    for (const source of ["startup", "clear"] as const) {
      const result = await createSegmentBlockContextHandler({ db }, 1, "fields")(
        input({ source }),
      );
      expect(result).toEqual({ continue: true });
    }
    db.close();
  });

  test("a segment with members renders its milestones block too", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const session = upsertSession(db, {
      contentSessionId: "segment-slot-session",
      project: "/projects/segment-slots",
      title: "Slots",
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const segment = createSegment(db, { title: "Milestone lane", nowEpoch: 1_000 });
    const turn = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
          session_id, prompt_number, status, user_prompt, assistant_response,
          title, type, created_at_epoch
        ) VALUES (?, 1, 'extracted', 'ship it', 'shipped',
          'Ship the milestone', '["implement"]', 1000)
        RETURNING id`,
      )
      .get(session.id)!;
    addSegmentMembers(db, segment.id, [turn.id], 1_000);
    attachSegmentToSession(db, session.id, segment.id, 1_000);

    const result = await createSegmentBlockContextHandler({ db }, 1, "milestones")(input());
    expect(result.hookSpecificOutput).toContain(`[E${segment.id}] · milestones`);
    db.close();
  });

  // frontier-injection ticket 02 (flipping ticket 09's old-composer fixture):
  // the SAME slot, SAME hook plumbing, new producer — the injected milestones
  // block is the per-lane FRONTIER SECTION now. End-to-end through the hook
  // handler: a declared lane whose settled members carry the lane tag renders
  // a digest line plus elected rows.
  test("frontier ticket 02: the injected milestones block renders the frontier section — lane digest plus elected rows — end to end through the hook handler", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const session = upsertSession(db, {
      contentSessionId: "segment-slot-session",
      project: "/projects/segment-slots",
      title: "Slots",
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const segment = createSegment(db, {
      title: "Edge-signal lane",
      tags: ["frontier-slot"],
      nowEpoch: 1_000,
    });
    insertLane(db, segment.id, "slot-lane", 1_000);

    const modernEpoch = TASK_CAUSALITY_ERA_CUTOFF_EPOCH + 100;
    const makeMemberTurn = (promptNumber: number, title: string): number =>
      db
        .query<{ id: number }, [number, number, string, number]>(
          `INSERT INTO turns (session_id, prompt_number, status, user_prompt, assistant_response, title, type, tags, created_at_epoch)
           VALUES (?, ?, 'extracted', 'p', 'r', ?, '[]', '["slot-lane"]', ?)
           RETURNING id`,
        )
        .get(session.id, promptNumber, title, modernEpoch + promptNumber)!.id;

    const first = makeMemberTurn(1, "admitted member");
    const second = makeMemberTurn(2, "overridden member");
    addSegmentMembers(db, segment.id, [first, second], modernEpoch);
    attachSegmentToSession(db, session.id, segment.id, modernEpoch);
    // Settlement coverage IS the settled truth (never edge presence): commit
    // a window over both prompts so both members are electable.
    db.query(
      `INSERT INTO note_settlement_jobs (
         session_id, window_start, window_end, trigger_type,
         status, attempts, retry_at_epoch, created_at_epoch, updated_at_epoch
       ) VALUES (?, 1, 2, 'consecutive', 'done', 1, 0, ?, ?)`,
    ).run(session.id, modernEpoch, modernEpoch);

    const result = await createSegmentBlockContextHandler({ db }, 1, "milestones")(input());
    expect(result.hookSpecificOutput).toContain(`E${segment.id} #frontier-slot`);
    expect(result.hookSpecificOutput).toContain("#slot-lane · 2 settled · 0 edges · islands 0+2");
    expect(result.hookSpecificOutput).toContain("admitted member");
    expect(result.hookSpecificOutput).toContain("overridden member");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Ticket 01 regression: the live 0.12.1 outage. Every fixture above uses a
// WRITABLE in-memory database and passes no readerId — structurally unable
// to reproduce the bug (a writer identity reaching a readonly connection's
// grant INSERT). This block is the one place in the suite that opens a
// REAL readonly, FILE-BACKED handle, which is the only way the throw the
// production hook path hit is observable at all.
// ---------------------------------------------------------------------------

describe("createSegmentBlockContextHandler — readonly file-backed DB (ticket 01 regression)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Seeds a schema + one attached segment (with a member turn, so the
   * milestones block has real content to render) on a WRITABLE file-backed
   * connection, then reopens the SAME file readonly — the exact shape of
   * the production `getDefaultSegmentBlockContextHandler` connection
   * (`hooks/hook-command.ts` ~187-218). `journal_mode = DELETE` is set
   * before closing the writable handle: a readonly connection to a
   * WAL-mode database fails to open unless the -wal/-shm sidecar files are
   * still present, which is not the shape under test here.
   */
  function seedReadonlyFileDatabase(): { db: Database; segmentId: number } {
    const dir = mkdtempSync(join(tmpdir(), "context-segments-readonly-"));
    tempDirs.push(dir);
    const path = join(dir, "readonly-fixture.db");

    const writable = new Database(path, { create: true });
    initializeSchema(writable);
    const session = upsertSession(writable, {
      contentSessionId: "readonly-fixture-session",
      project: "/projects/readonly-fixture",
      title: "Readonly fixture",
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const segment = createSegment(writable, {
      title: "Readonly fixture lane",
      nowEpoch: 1_000,
    });
    const turn = writable
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
          session_id, prompt_number, status, user_prompt, assistant_response,
          title, type, created_at_epoch
        ) VALUES (?, 1, 'extracted', 'ship it readonly', 'shipped readonly',
          'Ship the readonly regression', '["implement"]', 1000)
        RETURNING id`,
      )
      .get(session.id)!;
    addSegmentMembers(writable, segment.id, [turn.id], 1_000);
    attachSegmentToSession(writable, session.id, segment.id, 1_000);
    writable.exec("PRAGMA journal_mode = DELETE;");
    writable.close();

    const db = new Database(path, { readonly: true, create: false });
    return { db, segmentId: segment.id };
  }

  test("the fields block renders real content, not a readonly-write error, and records no read grant", async () => {
    const { db, segmentId } = seedReadonlyFileDatabase();

    const result = await createSegmentBlockContextHandler({ db }, 1, "fields")(
      input({ sessionId: "readonly-fixture-session" }),
    );

    expect(result.hookSpecificOutput).toContain(`[E${segmentId}] · fields`);
    expect(result.hookSpecificOutput).not.toContain("readonly database");
    expect(result.hookSpecificOutput).not.toContain("timeline error");

    const grants = db
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM write_gate_reads`)
      .get()!;
    expect(grants.count).toBe(0);
    db.close();
  });

  test("the milestones block renders real content, not a readonly-write error, and records no read grant", async () => {
    const { db, segmentId } = seedReadonlyFileDatabase();

    const result = await createSegmentBlockContextHandler({ db }, 1, "milestones")(
      input({ sessionId: "readonly-fixture-session" }),
    );

    expect(result.hookSpecificOutput).toContain(`[E${segmentId}] · milestones`);
    expect(result.hookSpecificOutput).not.toContain("readonly database");
    expect(result.hookSpecificOutput).not.toContain("timeline error");

    const grants = db
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM write_gate_reads`)
      .get()!;
    expect(grants.count).toBe(0);
    db.close();
  });

  test("mutation check: reintroducing a writer identity on this connection reproduces the outage — proves the fixture actually exercises the readonly failure mode", async () => {
    const { db, segmentId } = seedReadonlyFileDatabase();
    const { renderAttachedSegmentBlock } = await import("../../src/hooks/session-composition");

    expect(() =>
      renderAttachedSegmentBlock(db, "fields", { id: segmentId }, null, "session:1"),
    ).toThrow(/readonly database/i);

    db.close();
  });
});

