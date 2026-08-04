import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import {
  BACKFILL_LEASE_MS,
  runTranscriptPathBackfill,
  TRANSCRIPT_PATH_BACKFILL_NAME,
  type TranscriptPathBackfillOptions,
} from "../../src/db/transcript-path-backfill";

interface LedgerRow {
  status: string;
  cursor_id: number;
  filled_count: number;
  unresolved_count: number;
  ambiguous_count: number;
  claim_generation: number;
  claimed_at_epoch: number | null;
  deferred_until_epoch: number | null;
  deferral_attempts: number;
  completed_at_epoch: number | null;
}

const LEASE_SECONDS = BACKFILL_LEASE_MS / 1000;

describe("transcript-path backfill", () => {
  let db: Database;
  let root: string;
  let logs: string[];
  let nowEpoch: number;

  const readLedger = (): LedgerRow | null =>
    db
      .query<LedgerRow, [string]>("SELECT * FROM repair_ledger WHERE name = ?")
      .get(TRANSCRIPT_PATH_BACKFILL_NAME) ?? null;

  const createSession = (contentSessionId: string, project: string): number =>
    upsertSession(db, {
      contentSessionId,
      project,
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

  const writeTranscript = (
    projectDir: string,
    contentSessionId: string,
    mtimeSeconds?: number,
  ): string => {
    const dir = join(root, projectDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${contentSessionId}.jsonl`);
    writeFileSync(path, "{}\n");
    if (mtimeSeconds !== undefined) {
      utimesSync(path, mtimeSeconds, mtimeSeconds);
    }
    return path;
  };

  // One clock drives both the ledger's epoch seconds and the claim lease, so a
  // test can walk past a lease or a deferral window by moving `nowEpoch`.
  const run = (options: TranscriptPathBackfillOptions = {}) =>
    runTranscriptPathBackfill(db, {
      transcriptRoot: root,
      log: (message) => logs.push(message),
      now: () => nowEpoch,
      nowMs: () => nowEpoch * 1000,
      ...options,
    });

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    root = mkdtempSync(join(tmpdir(), "mnemo-transcript-root-"));
    logs = [];
    nowEpoch = 1_700_000_000;
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("fills the transcript a drifted session actually writes to", () => {
    // The session started in -Users-me-alpha and later cd'ed to beta, so
    // `project` (latest cwd) no longer names the transcript's directory.
    const sessionId = createSession("uuid-drift", "/Users/me/beta");
    const path = writeTranscript("-Users-me-alpha", "uuid-drift");

    const summary = run();

    expect(getSession(db, sessionId)?.transcriptPath).toBe(path);
    expect(summary).toMatchObject({
      status: "completed",
      examined: 1,
      filled: 1,
      unresolved: 0,
      ambiguous: 0,
    });

    const ledger = readLedger();
    expect(ledger).toMatchObject({
      status: "done",
      cursor_id: sessionId,
      filled_count: 1,
      unresolved_count: 0,
      completed_at_epoch: nowEpoch,
      // The claim is released with the completion marker.
      claimed_at_epoch: null,
    });
  });

  test("leaves a session with no transcript NULL and counts it", () => {
    const sessionId = createSession("uuid-missing", "/Users/me/alpha");

    const summary = run();

    expect(getSession(db, sessionId)?.transcriptPath).toBeNull();
    expect(summary).toMatchObject({
      status: "completed",
      examined: 1,
      filled: 0,
      unresolved: 1,
    });
  });

  test("skips idempotently once complete, even for rows that arrive later", () => {
    createSession("uuid-a", "/Users/me/alpha");
    writeTranscript("-Users-me-alpha", "uuid-a");
    run();

    const laterSessionId = createSession("uuid-b", "/Users/me/alpha");
    writeTranscript("-Users-me-alpha", "uuid-b");
    logs = [];

    const second = run();

    // New rows get their path at registration; the one-time repair must not
    // re-open itself for them.
    expect(second.status).toBe("skipped");
    expect(second.examined).toBe(0);
    expect(getSession(db, laterSessionId)?.transcriptPath).toBeNull();
    expect(logs).toEqual([]);
  });

  test("resumes from the high-water cursor without re-selecting or double counting", () => {
    const firstId = createSession("uuid-zero-hit", "/Users/me/alpha");
    const secondId = createSession("uuid-second", "/Users/me/alpha");
    const secondPath = writeTranscript("-Users-me-alpha", "uuid-second");

    // The row cap stops the run right after the zero-hit batch commits.
    const first = run({ maxRows: 1 });
    expect(first).toMatchObject({
      status: "progressed",
      examined: 1,
      unresolved: 1,
      cursorId: firstId,
    });
    expect(readLedger()).toMatchObject({
      status: "running",
      cursor_id: firstId,
      unresolved_count: 1,
      completed_at_epoch: null,
    });

    // A zero-hit row still crossed the high-water mark, so the resumed run
    // starts past it: it is neither re-scanned nor counted a second time.
    const second = run();
    expect(second).toMatchObject({
      status: "completed",
      examined: 1,
      filled: 1,
      unresolved: 0,
    });
    expect(second.totals).toEqual({ filled: 1, unresolved: 1, ambiguous: 0 });
    expect(getSession(db, firstId)?.transcriptPath).toBeNull();
    expect(getSession(db, secondId)?.transcriptPath).toBe(secondPath);
  });

  test("advances across batches within one run", () => {
    const ids = ["uuid-1", "uuid-2", "uuid-3"].map((uuid) => {
      const id = createSession(uuid, "/Users/me/alpha");
      writeTranscript("-Users-me-alpha", uuid);
      return id;
    });

    const summary = run({ batchSize: 2 });

    expect(summary).toMatchObject({ status: "completed", examined: 3, filled: 3 });
    for (const id of ids) {
      expect(getSession(db, id)?.transcriptPath).not.toBeNull();
    }
  });

  test("picks the newest candidate on a multi-hit and records every candidate", () => {
    const sessionId = createSession("uuid-multi", "/Users/me/alpha");
    writeTranscript("-Users-me-alpha", "uuid-multi", 1_000);
    const newer = writeTranscript("-Users-me-beta", "uuid-multi", 2_000);

    const summary = run();

    expect(getSession(db, sessionId)?.transcriptPath).toBe(newer);
    expect(summary).toMatchObject({ filled: 1, ambiguous: 1 });

    const candidateLog = logs.find((line) => line.includes("matched 2 transcripts"));
    expect(candidateLog).toContain(join(root, "-Users-me-alpha", "uuid-multi.jsonl"));
    expect(candidateLog).toContain(newer);
    expect(candidateLog).toContain(`picked ${newer}`);
  });

  test("breaks an mtime tie by normalized absolute path ascending", () => {
    const sessionId = createSession("uuid-tie", "/Users/me/alpha");
    const alpha = writeTranscript("-Users-me-alpha", "uuid-tie", 5_000);
    writeTranscript("-Users-me-beta", "uuid-tie", 5_000);

    run();

    expect(getSession(db, sessionId)?.transcriptPath).toBe(alpha);
  });

  test("emits an auditable summary of filled / left-NULL / multi-candidate", () => {
    createSession("uuid-hit", "/Users/me/alpha");
    writeTranscript("-Users-me-alpha", "uuid-hit");
    createSession("uuid-none", "/Users/me/alpha");
    createSession("uuid-two", "/Users/me/alpha");
    writeTranscript("-Users-me-alpha", "uuid-two", 1_000);
    writeTranscript("-Users-me-beta", "uuid-two", 2_000);

    run();

    const summaryLine = logs.find((line) => line.includes("backfill completed"));
    expect(summaryLine).toContain("examined 3");
    expect(summaryLine).toContain("filled 2 (1 multi-candidate)");
    expect(summaryLine).toContain("left NULL 1");
  });

  describe("deferral backoff", () => {
    test("persists a backoff, stops re-reading the root inside it, and stays recoverable", () => {
      const sessionId = createSession("uuid-deferred", "/Users/me/alpha");
      const missing = join(root, "does-not-exist");

      const first = run({ transcriptRoot: missing });

      expect(first).toMatchObject({
        status: "deferred",
        deferralAttempts: 1,
        deferredUntilEpoch: nowEpoch + 60,
      });
      // The ledger row now exists (it is where the backoff lives) but nothing
      // is consumed: cursor 0, no counters, status never `done`.
      expect(readLedger()).toMatchObject({
        status: "running",
        cursor_id: 0,
        filled_count: 0,
        unresolved_count: 0,
        claimed_at_epoch: null,
        deferral_attempts: 1,
        deferred_until_epoch: nowEpoch + 60,
      });

      // Inside the window nothing is attempted — not even against a root that
      // has since become perfectly readable.
      const path = writeTranscript("-Users-me-alpha", "uuid-deferred");
      nowEpoch += 30;
      expect(run().status).toBe("deferred");
      expect(readLedger()).toMatchObject({
        deferral_attempts: 1,
        claim_generation: 1,
      });
      expect(getSession(db, sessionId)?.transcriptPath).toBeNull();

      // …and the one-shot repair was never burned: once the window elapses it
      // runs for real and clears the backoff.
      nowEpoch += 31;
      expect(run().status).toBe("completed");
      expect(getSession(db, sessionId)?.transcriptPath).toBe(path);
      expect(readLedger()).toMatchObject({
        status: "done",
        deferral_attempts: 0,
        deferred_until_epoch: null,
      });
    });

    test("doubles the wait on each consecutive deferral", () => {
      const missing = join(root, "does-not-exist");
      const waits: number[] = [];

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const summary = run({ transcriptRoot: missing });
        const wait = summary.deferredUntilEpoch! - nowEpoch;
        waits.push(wait);
        nowEpoch += wait;
      }

      expect(waits).toEqual([60, 120, 240, 480]);
    });

    test("an unindexable root defers rather than committing a partial index", () => {
      const sessionId = createSession("uuid-big", "/Users/me/alpha");
      writeTranscript("-Users-me-alpha", "uuid-big");
      writeTranscript("-Users-me-beta", "uuid-other");

      // A partial index would mark real sessions unresolved and push them past
      // the high-water cursor forever, so an over-budget enumeration yields no
      // index at all and the run defers exactly like an unreadable root.
      const capped = run({ maxDirEntries: 1 });
      expect(capped).toMatchObject({ status: "deferred", deferralAttempts: 1 });
      expect(getSession(db, sessionId)?.transcriptPath).toBeNull();
      expect(readLedger()).toMatchObject({ status: "running", cursor_id: 0 });

      nowEpoch += 60;
      const timedOut = run({ scanBudgetMs: 0 });
      expect(timedOut).toMatchObject({ status: "deferred", deferralAttempts: 2 });
      expect(readLedger()).toMatchObject({ status: "running", cursor_id: 0 });

      nowEpoch += 120;
      expect(run().status).toBe("completed");
      expect(getSession(db, sessionId)?.transcriptPath).not.toBeNull();
    });
  });

  describe("work budget", () => {
    test("a budget-exhausted run is a normal partial run that resumes", () => {
      const ids = ["uuid-b1", "uuid-b2", "uuid-b3"].map((uuid) => {
        const id = createSession(uuid, "/Users/me/alpha");
        writeTranscript("-Users-me-alpha", uuid);
        return id;
      });

      const first = run({ batchSize: 1, rowBudgetMs: 0 });
      expect(first).toMatchObject({
        status: "progressed",
        examined: 1,
        filled: 1,
        cursorId: ids[0],
      });
      // The claim is released, so the next tick can pick the repair straight up.
      expect(readLedger()).toMatchObject({
        status: "running",
        cursor_id: ids[0],
        claimed_at_epoch: null,
      });

      const second = run();
      expect(second).toMatchObject({ status: "completed", examined: 2, filled: 2 });
      expect(second.totals).toEqual({ filled: 3, unresolved: 0, ambiguous: 0 });
      for (const id of ids) {
        expect(getSession(db, id)?.transcriptPath).not.toBeNull();
      }
    });
  });

  describe("crash windows and competing runners", () => {
    test("a failure inside the batch transaction rolls back rows, counters and cursor", () => {
      const sessionId = createSession("uuid-crash", "/Users/me/alpha");
      writeTranscript("-Users-me-alpha", "uuid-crash");

      db.exec(
        `CREATE TRIGGER mnemo_test_boom
         BEFORE UPDATE OF transcript_path ON sessions
         BEGIN SELECT RAISE(ABORT, 'injected crash'); END`,
      );

      expect(() => run()).toThrow();
      db.exec("DROP TRIGGER mnemo_test_boom");

      expect(getSession(db, sessionId)?.transcriptPath).toBeNull();
      expect(readLedger()).toMatchObject({
        status: "running",
        cursor_id: 0,
        filled_count: 0,
        unresolved_count: 0,
        completed_at_epoch: null,
      });

      // The dead runner never released its claim; the repair becomes claimable
      // again only once that lease ages out, and then it completes normally.
      expect(run().status).toBe("busy");
      nowEpoch += LEASE_SECONDS + 1;
      expect(run()).toMatchObject({ status: "completed", examined: 1, filled: 1 });
    });

    test("a crash between the final batch commit and the completion marker completes idempotently", () => {
      const firstId = createSession("uuid-c1", "/Users/me/alpha");
      const secondId = createSession("uuid-c2", "/Users/me/alpha");
      writeTranscript("-Users-me-alpha", "uuid-c1");
      writeTranscript("-Users-me-alpha", "uuid-c2");

      db.exec(
        `CREATE TRIGGER mnemo_test_no_done
         BEFORE UPDATE OF status ON repair_ledger
         WHEN NEW.status = 'done'
         BEGIN SELECT RAISE(ABORT, 'injected crash'); END`,
      );

      expect(() => run()).toThrow();
      db.exec("DROP TRIGGER mnemo_test_no_done");

      // Every batch committed; only the completion marker is missing.
      expect(readLedger()).toMatchObject({
        status: "running",
        cursor_id: secondId,
        filled_count: 2,
        completed_at_epoch: null,
      });
      expect(getSession(db, firstId)?.transcriptPath).not.toBeNull();
      expect(getSession(db, secondId)?.transcriptPath).not.toBeNull();

      nowEpoch += LEASE_SECONDS + 1;
      const resumed = run();

      // Nothing left above the cursor: the resumed run observes exhaustion and
      // marks the repair done without re-counting a single row.
      expect(resumed).toMatchObject({
        status: "completed",
        examined: 0,
        filled: 0,
        unresolved: 0,
      });
      expect(resumed.totals).toEqual({ filled: 2, unresolved: 0, ambiguous: 0 });
      expect(readLedger()).toMatchObject({ status: "done", filled_count: 2 });
    });

    test("a live claim from another runner is a clean no-op", () => {
      const sessionId = createSession("uuid-claimed", "/Users/me/alpha");
      writeTranscript("-Users-me-alpha", "uuid-claimed");

      db.query<unknown, [string, number, number]>(
        `INSERT INTO repair_ledger
           (name, status, started_at_epoch, claim_generation, claimed_at_epoch)
         VALUES (?, 'running', ?, 1, ?)`,
      ).run(TRANSCRIPT_PATH_BACKFILL_NAME, nowEpoch, nowEpoch);

      const summary = run();

      expect(summary).toMatchObject({
        status: "busy",
        examined: 0,
        filled: 0,
        unresolved: 0,
        cursorId: 0,
      });
      expect(getSession(db, sessionId)?.transcriptPath).toBeNull();
      // The loser did not even bump the generation, let alone a counter.
      expect(readLedger()).toMatchObject({
        claim_generation: 1,
        cursor_id: 0,
        filled_count: 0,
        unresolved_count: 0,
      });
    });

    test("a runner whose claim was taken over commits nothing and counts nothing", () => {
      const sessionId = createSession("uuid-raced", "/Users/me/alpha");
      writeTranscript("-Users-me-alpha", "uuid-raced");

      // Stands in for a second runner claiming the ledger between this run's
      // row selection and its batch commit.
      db.exec(
        `CREATE TRIGGER mnemo_test_steal_claim
         BEFORE UPDATE OF transcript_path ON sessions
         BEGIN
           UPDATE repair_ledger
           SET claim_generation = claim_generation + 1
           WHERE name = '${TRANSCRIPT_PATH_BACKFILL_NAME}';
         END`,
      );

      const summary = run();
      db.exec("DROP TRIGGER mnemo_test_steal_claim");

      expect(summary).toMatchObject({
        status: "busy",
        examined: 0,
        filled: 0,
        unresolved: 0,
      });
      // The fenced ledger write rolled the whole batch back — session row
      // included — so nothing is half-applied and nothing is counted.
      expect(getSession(db, sessionId)?.transcriptPath).toBeNull();
      expect(readLedger()).toMatchObject({
        status: "running",
        cursor_id: 0,
        filled_count: 0,
        unresolved_count: 0,
        claim_generation: 1,
      });
    });

    test("a stale cursor never regresses one another runner already advanced", () => {
      const sessionId = createSession("uuid-regress", "/Users/me/alpha");
      writeTranscript("-Users-me-alpha", "uuid-regress");

      db.exec(
        `CREATE TRIGGER mnemo_test_jump_cursor
         BEFORE UPDATE OF transcript_path ON sessions
         BEGIN
           UPDATE repair_ledger SET cursor_id = 999
           WHERE name = '${TRANSCRIPT_PATH_BACKFILL_NAME}';
         END`,
      );

      run();
      db.exec("DROP TRIGGER mnemo_test_jump_cursor");

      expect(readLedger()?.cursor_id).toBe(999);
      expect(getSession(db, sessionId)?.transcriptPath).not.toBeNull();
    });

    test("a guarded UPDATE that changes zero rows is not counted as filled", () => {
      const firstId = createSession("uuid-g1", "/Users/me/alpha");
      const secondId = createSession("uuid-g2", "/Users/me/alpha");
      writeTranscript("-Users-me-alpha", "uuid-g1");
      writeTranscript("-Users-me-alpha", "uuid-g2");

      // Stands in for a concurrent registration writing the authoritative path
      // for the second row after this run selected it: the guarded UPDATE then
      // matches nothing, and the counter must follow the write, not the pick.
      db.exec(
        `CREATE TRIGGER mnemo_test_preempt
         BEFORE UPDATE OF transcript_path ON sessions
         WHEN NEW.id = ${firstId}
         BEGIN
           UPDATE sessions SET transcript_path = '/elsewhere/preempted.jsonl'
           WHERE id = ${secondId};
         END`,
      );

      const summary = run({ batchSize: 2 });
      db.exec("DROP TRIGGER mnemo_test_preempt");

      expect(summary).toMatchObject({
        status: "completed",
        examined: 2,
        filled: 1,
        unresolved: 0,
      });
      expect(summary.totals).toEqual({ filled: 1, unresolved: 0, ambiguous: 0 });
      expect(getSession(db, secondId)?.transcriptPath).toBe(
        "/elsewhere/preempted.jsonl",
      );
      // Both rows still crossed the high-water mark.
      expect(readLedger()).toMatchObject({ status: "done", cursor_id: secondId });
    });
  });
});
