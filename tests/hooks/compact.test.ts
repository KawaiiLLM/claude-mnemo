import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { attachSegmentToSession, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import {
  checkFieldGate,
  checkRelationsGate,
  recordFieldCompleteness,
  recordReadGrant,
  RELATIONS_GATE_FIELD,
  sessionWriterId,
  snapshotWriteGateSequence,
  stampField,
  stampTurnRelationsRevision,
} from "../../src/db/write-gate";
import { createCompactHandler } from "../../src/hooks/handlers/compact";
import { createContextHandler } from "../../src/hooks/handlers/context";
import type { NormalizedHookInput } from "../../src/hooks/types";

function createInput(
  overrides: Partial<NormalizedHookInput> = {},
): NormalizedHookInput {
  return {
    eventName: "PreCompact",
    sessionId: "session-compact",
    cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

describe("handleCompactHook", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "session-compact",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Compact session",
      content: "Compact hook coverage",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("sends a synchronous compact request for the resolved session", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createCompactHandler({
      db,
      workerClientDeps: { fetchImpl },
      workerEnv: {},
    });

    const result = await handler(
      createInput({
        transcriptPath: "/tmp/session.jsonl",
      }),
    );

    expect(result).toEqual({ continue: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:37778/health");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://127.0.0.1:37778/trigger");
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      action: "compact",
      content_session_id: "session-compact",
      session_id: sessionId,
      transcript_path: "/tmp/session.jsonl",
      env: {},
    });
  });

  test("continues without contacting the worker when the session is missing", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createCompactHandler({
      db,
      workerClientDeps: { fetchImpl },
    });

    const result = await handler(
      createInput({
        sessionId: "missing-session",
      }),
    );

    expect(result).toEqual({ continue: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ticket 12 (compact-dedup-guidance), USER RULING S15069/T2017: the PreCompact
// hook's ONE-sentence guidance to the summarizer — segment cards re-inject
// after compact already, so the summary need not restate what they carry.
// Emitted only when a segment is actually attached (nothing re-injects
// otherwise, so the sentence would be false); the channel is bare stdout
// text, wired in `hook-command.ts`'s PreCompact branch, not this codebase's
// usual `hookSpecificOutput` JSON envelope (see that file's comment).
// ---------------------------------------------------------------------------

describe("handleCompactHook — compact guidance sentence", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "session-compact",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Compact session",
      content: "Compact hook coverage",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("a session with an attached segment gets the one-sentence guidance, naming segment cards re-injecting after compact", async () => {
    const segment = createSegment(db, { title: "Some task", nowEpoch: 100 });
    attachSegmentToSession(db, sessionId, segment.id, 100);

    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createCompactHandler({ db, workerClientDeps: { fetchImpl }, workerEnv: {} });

    const result = await handler(createInput());

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput).toContain("segment cards");
    expect(result.hookSpecificOutput).toContain("re-inject");
    expect(result.hookSpecificOutput).toContain("compact");
    // One sentence: exactly one terminal period, at the end.
    const sentence = result.hookSpecificOutput as string;
    expect(sentence.match(/\./g)?.length).toBe(1);
    expect(sentence.endsWith(".")).toBe(true);
  });

  test("a session with NO attached segment gets no guidance — nothing re-injects for it, so the sentence would be false", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createCompactHandler({ db, workerClientDeps: { fetchImpl }, workerEnv: {} });

    const result = await handler(createInput());

    expect(result).toEqual({ continue: true });
  });
});

// ---------------------------------------------------------------------------
// Write gate — grant lifecycle (ticket 01, read-write-contract spec "compact
// 后才清空一次授权"): PreCompact is the event that destroys the context a
// read grant was earned on, so the wipe moved here from SessionEnd (see
// tests/hooks/session-end.test.ts for the SessionEnd side of the change).
// ---------------------------------------------------------------------------

describe("handleCompactHook — write gate grant wipe", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "session-compact",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Compact session",
      content: "Compact hook coverage",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("wipes the session writer's grants AND field completeness through the real PreCompact handler", async () => {
    const writer = sessionWriterId(sessionId);
    stampField(db, "segment", 1, "goal", "session:9999", 100);
    recordReadGrant(db, writer, "segment", 1, 150, snapshotWriteGateSequence(db));
    recordFieldCompleteness(
      db,
      writer,
      [{ entityType: "segment", entityId: 1, field: "goal", complete: true }],
      150,
      snapshotWriteGateSequence(db),
    );
    expect(
      checkFieldGate(db, writer, "segment", 1, "goal", "E1", { requireCompleteRead: true }).ok,
    ).toBe(true);

    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createCompactHandler({ db, workerClientDeps: { fetchImpl }, workerEnv: {} });

    await handler(createInput());

    const verdict = checkFieldGate(db, writer, "segment", 1, "goal", "E1");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("never-read");
    }
  });

  test("relations gate consistency: post-compact, an edge write without a fresh relations read refuses — pre-compact-earned relations completeness does not survive the wipe", async () => {
    const writer = sessionWriterId(sessionId);
    const turnId = 42;
    // Another writer's edge mutation is the turn's current relations
    // revision; this writer read the set whole before compact.
    stampTurnRelationsRevision(db, turnId, "session:9999", 100);
    recordReadGrant(db, writer, "turn", turnId, 150, snapshotWriteGateSequence(db));
    recordFieldCompleteness(
      db,
      writer,
      [{ entityType: "turn", entityId: turnId, field: RELATIONS_GATE_FIELD, complete: true }],
      150,
      snapshotWriteGateSequence(db),
    );
    expect(checkRelationsGate(db, writer, turnId, "T42").ok).toBe(true);

    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createCompactHandler({ db, workerClientDeps: { fetchImpl }, workerEnv: {} });

    await handler(createInput());

    const verdict = checkRelationsGate(db, writer, turnId, "T42");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("incomplete-read");
    }
  });

  test("a failed wipe does not block the compact notification (best-effort, same discipline as SessionEnd)", async () => {
    const writer = sessionWriterId(sessionId);
    recordReadGrant(db, writer, "segment", 1, 150, snapshotWriteGateSequence(db));
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const failingTransaction = () => {
      throw new Error("simulated busy database");
    };
    const handler = createCompactHandler({
      db,
      workerClientDeps: { fetchImpl },
      workerEnv: {},
      runHookWriteTransaction: failingTransaction as never,
    });

    const result = await handler(createInput());

    expect(result).toEqual({ continue: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Light-review-repairs 04 (P1): the soundness counterpart to the
  // notify-survives test above. That test proves a failed epoch bump never
  // blocks the compact notification; THIS one proves the crash backstop
  // actually catches what the failed bump dropped — SessionStart(source=
  // compact)'s own idempotent re-bump (hooks/handlers/context.ts, fired
  // BEFORE the roster records any new grants) still invalidates every grant
  // and completeness row this writer earned before compact, even though
  // PreCompact's own bump never landed.
  // -------------------------------------------------------------------------

  function sessionStartCompactInput(): NormalizedHookInput {
    return {
      eventName: "SessionStart",
      source: "compact",
      sessionId: "session-compact",
      cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
      stopHookActive: false,
      raw: {},
    };
  }

  test("the PreCompact-failure fixture (field gate): PreCompact's bump forced to fail → the grant survives that alone, but SessionStart(compact)'s bump alone still invalidates it", async () => {
    const writer = sessionWriterId(sessionId);
    stampField(db, "segment", 1, "goal", "session:9999", 100);
    recordReadGrant(db, writer, "segment", 1, 150, snapshotWriteGateSequence(db));
    recordFieldCompleteness(
      db,
      writer,
      [{ entityType: "segment", entityId: 1, field: "goal", complete: true }],
      150,
      snapshotWriteGateSequence(db),
    );
    expect(
      checkFieldGate(db, writer, "segment", 1, "goal", "E1", { requireCompleteRead: true }).ok,
    ).toBe(true);

    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const failingTransaction = () => {
      throw new Error("simulated busy database");
    };
    const compactHandler = createCompactHandler({
      db,
      workerClientDeps: { fetchImpl },
      workerEnv: {},
      runHookWriteTransaction: failingTransaction as never,
    });
    await compactHandler(createInput());

    // PreCompact's own bump never landed — on its own, the pre-compact grant
    // is still authorized.
    expect(checkFieldGate(db, writer, "segment", 1, "goal", "E1").ok).toBe(true);

    // SessionStart(source=compact) fires next, on a REAL (non-failing)
    // transaction. Its own re-bump is the crash backstop.
    const contextHandler = createContextHandler({ db, workerClientDeps: { fetchImpl } });
    await contextHandler(sessionStartCompactInput());

    const verdict = checkFieldGate(db, writer, "segment", 1, "goal", "E1");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("never-read");
    }
  });

  test("the PreCompact-failure fixture (relations gate): the same failed-then-backstopped bump also invalidates a pre-compact relations read", async () => {
    const writer = sessionWriterId(sessionId);
    const turnId = 42;
    stampTurnRelationsRevision(db, turnId, "session:9999", 100);
    recordReadGrant(db, writer, "turn", turnId, 150, snapshotWriteGateSequence(db));
    recordFieldCompleteness(
      db,
      writer,
      [{ entityType: "turn", entityId: turnId, field: RELATIONS_GATE_FIELD, complete: true }],
      150,
      snapshotWriteGateSequence(db),
    );
    expect(checkRelationsGate(db, writer, turnId, "T42").ok).toBe(true);

    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const failingTransaction = () => {
      throw new Error("simulated busy database");
    };
    const compactHandler = createCompactHandler({
      db,
      workerClientDeps: { fetchImpl },
      workerEnv: {},
      runHookWriteTransaction: failingTransaction as never,
    });
    await compactHandler(createInput());

    expect(checkRelationsGate(db, writer, turnId, "T42").ok).toBe(true);

    const contextHandler = createContextHandler({ db, workerClientDeps: { fetchImpl } });
    await contextHandler(sessionStartCompactInput());

    const verdict = checkRelationsGate(db, writer, turnId, "T42");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("incomplete-read");
    }
  });
});
