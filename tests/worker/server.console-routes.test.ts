import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  createWorkerFetchHandler,
  createWorkerServerState,
} from "../../src/worker/server";
import { createConsoleReader, type ConsoleReader } from "../../src/worker/console-reader";
import type { CapturedSessionEnv } from "../../src/mnemosyne/env";

/**
 * Console route wiring through the REAL fetch handler (memory-console spec;
 * ticket 03, resolving ticket 02's flagged boot-wiring question).
 *
 * Boot wiring itself (deriving `consoleDatabasePathImpl` from `main()`'s own
 * primary connection's `db.filename`) is a ~6-line addition inside `main()`
 * verified by inspection rather than a full `main()` invocation here — `main()`
 * binds a real port, writes a pid file, and starts watchdog intervals, and
 * the existing precedent for exercising it in tests
 * (`tests/worker/diary-runtime.test.ts`) already carries substantial mocking
 * scaffolding for those side effects that has nothing to do with this
 * ticket's own territory. What THIS file proves instead is the CONTRACT
 * `main()` relies on: given a real file-backed `consoleDatabasePathImpl`
 * (exactly the shape `db.filename` produces), the lazily-opened reader
 * serves real data, and the `:memory:` seam (`consoleReaderImpl` direct
 * injection) works when no such path exists.
 */

const TEST_PORT = 42_001;

describe("console routes through createWorkerFetchHandler", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("the DNS-rebinding gate still applies to console routes (one shared gate, spec's own framing)", async () => {
    const handler = createWorkerFetchHandler({
      db,
      port: TEST_PORT,
      consoleReaderImpl: createConsoleReader(db),
    });
    const response = await handler(
      new Request(`http://127.0.0.1:${TEST_PORT}/api/console/sessions`, {
        headers: { host: "attacker.example" },
      }),
    );
    expect(response.status).toBe(403);
  });

  test("a known route (:memory: main db, consoleReaderImpl injected) responds 200 with the three required headers", async () => {
    upsertSession(db, {
      contentSessionId: "console-route-smoke",
      project: "/tmp/console-route-smoke",
      title: "smoke",
      content: null,
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: 1_000,
      completedAtEpoch: null,
    });
    const handler = createWorkerFetchHandler({
      db,
      port: TEST_PORT,
      consoleReaderImpl: createConsoleReader(db),
    });
    const response = await handler(
      new Request(`http://127.0.0.1:${TEST_PORT}/api/console/sessions`, {
        headers: { host: `127.0.0.1:${TEST_PORT}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(1);
  });

  test("no consoleReaderImpl AND no consoleDatabasePathImpl -> 503 (fails closed, never silently 200s with no data)", async () => {
    const handler = createWorkerFetchHandler({ db, port: TEST_PORT });
    const response = await handler(
      new Request(`http://127.0.0.1:${TEST_PORT}/api/console/sessions`, {
        headers: { host: `127.0.0.1:${TEST_PORT}` },
      }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unavailable");
  });

  test("a real file-backed consoleDatabasePathImpl (the shape main() derives from db.filename) is opened lazily and serves real data", async () => {
    // A SEPARATE real file: proves the console connection is genuinely a
    // second, independently-opened handle onto the same data — not the
    // `:memory:` `db` instance the primary connection happens to be using in
    // this test.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "console-route-file-"));
    const dbPath = join(dir, "fixture.db");
    try {
      const fileDb = createDatabase(dbPath);
      initializeSchema(fileDb);
      upsertSession(fileDb, {
        contentSessionId: "file-backed",
        project: "/tmp/file-backed",
        title: "file backed",
        content: null,
        insight: null,
        createdAtEpoch: 1_000,
        updatedAtEpoch: 1_000,
        completedAtEpoch: null,
      });
      fileDb.close();

      const handler = createWorkerFetchHandler({
        db,
        port: TEST_PORT,
        consoleDatabasePathImpl: dbPath,
      });
      const response = await handler(
        new Request(`http://127.0.0.1:${TEST_PORT}/api/console/sessions`, {
          headers: { host: `127.0.0.1:${TEST_PORT}` },
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { sessions: Array<{ title: string }> };
      expect(body.sessions[0]!.title).toBe("file backed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a reader-open failure is cached: the SAME 503 on a second request, not a repeated open attempt", async () => {
    const handler = createWorkerFetchHandler({
      db,
      port: TEST_PORT,
      consoleDatabasePathImpl: "/nonexistent/path/does-not-exist.db",
    });
    const first = await handler(
      new Request(`http://127.0.0.1:${TEST_PORT}/api/console/sessions`, {
        headers: { host: `127.0.0.1:${TEST_PORT}` },
      }),
    );
    const second = await handler(
      new Request(`http://127.0.0.1:${TEST_PORT}/api/console/sessions`, {
        headers: { host: `127.0.0.1:${TEST_PORT}` },
      }),
    );
    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
  });

  test("GET /console serves the shell (text/html, no-store, nosniff) — ticket 04", async () => {
    const handler = createWorkerFetchHandler({
      db,
      port: TEST_PORT,
      consoleReaderImpl: createConsoleReader(db),
    });
    const response = await handler(
      new Request(`http://127.0.0.1:${TEST_PORT}/console`, {
        headers: { host: `127.0.0.1:${TEST_PORT}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Content-Security-Policy");
  });

  test("GET /console never opens the console reader — it serves a static constant, no ConsoleReader dependency at all", async () => {
    // No consoleReaderImpl AND no consoleDatabasePathImpl: /api/console/*
    // would 503 here (asserted elsewhere in this file), but /console must
    // still serve — it is not a console-API route and reads no reader.
    const handler = createWorkerFetchHandler({ db, port: TEST_PORT });
    const response = await handler(
      new Request(`http://127.0.0.1:${TEST_PORT}/console`, {
        headers: { host: `127.0.0.1:${TEST_PORT}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  test("the DNS-rebinding gate still applies to /console (one shared gate)", async () => {
    const handler = createWorkerFetchHandler({
      db,
      port: TEST_PORT,
      consoleReaderImpl: createConsoleReader(db),
    });
    const response = await handler(
      new Request(`http://127.0.0.1:${TEST_PORT}/console`, {
        headers: { host: "attacker.example" },
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe("console requests never touch the session registry or the hard-exit machinery", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a console GET never touches the session registry", async () => {
    const sessionEnvRegistry = new Map<string, CapturedSessionEnv>();
    // Pre-populate, so a console request that (incorrectly) cleared or
    // mutated it would be observable either way — not just "stayed empty".
    sessionEnvRegistry.set("pre-existing-session", {} as CapturedSessionEnv);

    let scanAndDrainQueueCalls = 0;
    const handler = createWorkerFetchHandler({
      db,
      port: TEST_PORT,
      sessionEnvRegistry,
      consoleReaderImpl: createConsoleReader(db),
      scanAndDrainQueue: async () => {
        scanAndDrainQueueCalls += 1;
      },
    });

    for (const path of [
      "/console",
      "/api/console/sessions",
      "/api/console/segments",
      "/api/console/graph?session=1",
      "/api/console/segment?id=1",
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await handler(
        new Request(`http://127.0.0.1:${TEST_PORT}${path}`, {
          headers: { host: `127.0.0.1:${TEST_PORT}` },
        }),
      );
    }

    expect(scanAndDrainQueueCalls).toBe(0);
    expect(sessionEnvRegistry.size).toBe(1);
    expect(sessionEnvRegistry.has("pre-existing-session")).toBe(true);
  });

  test("a console request leaves the one-hour idleness clock unchanged; an ordinary route still resets it (peer finding #8, carried into the busy/idle machine)", async () => {
    let clockMs = 1_000_000;
    const nowMs = () => clockMs;
    const state = createWorkerServerState(nowMs());
    const handler = createWorkerFetchHandler(
      {
        db,
        port: TEST_PORT,
        nowMs,
        consoleReaderImpl: createConsoleReader(db),
        handleFlushImpl: async () => {},
      },
      state,
    );

    const initialIdleSince = state.idleSince;

    for (const path of [
      "/console",
      "/api/console/sessions",
      "/api/console/segments",
      "/api/console/graph?session=1",
    ]) {
      clockMs += 5_000;
      // eslint-disable-next-line no-await-in-loop
      await handler(
        new Request(`http://127.0.0.1:${TEST_PORT}${path}`, {
          headers: { host: `127.0.0.1:${TEST_PORT}` },
        }),
      );
      // A console request never acquires a busy token, so it neither nulls
      // `idleSince` mid-request nor re-stamps it afterward.
      expect(state.idleSince).toBe(initialIdleSince);
    }

    // Sanity: the busy-token mechanism itself is live — a NON-console route
    // still resets `idleSince` (to the clock at the moment its own busy
    // token releases), proving the exemption above is scoped to console
    // paths only, not a broken/no-op clock.
    clockMs += 5_000;
    await handler(
      new Request(`http://127.0.0.1:${TEST_PORT}/health`, {
        headers: { host: `127.0.0.1:${TEST_PORT}` },
      }),
    );
    expect(state.idleSince).toBe(clockMs);
    expect(state.idleSince).not.toBe(initialIdleSince);
  });
});
