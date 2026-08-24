import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  bumpWriterEpoch,
  checkFieldGate,
  checkRelationsGate,
  claimWriterId,
  clearReadGrantsForWriter,
  formatWriterForDisplay,
  getFieldCompleteness,
  getFieldStamp,
  nextWriteGateSequence,
  recordFieldCompleteness,
  recordReadGrant,
  recordReadGrants,
  RELATIONS_GATE_FIELD,
  snapshotWriteGateSequence,
  sessionWriterId,
  stampField,
  stampTurnRelationsRevision,
  STALE_READ_GRANT_AGE_SECONDS,
  sweepStaleReadGrants,
} from "../../src/db/write-gate";

/**
 * The read-write contract's gate (ticket 01): the read-grant ledger, the
 * field stamp table, the shared monotonic sequence, and the three-judgment
 * check every managed writer consumes. `.scratch/read-write-contract/spec.md`
 * "门(写面)".
 */

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => db.close());

describe("writer identity", () => {
  test("session writer id and its display form round-trip", () => {
    expect(sessionWriterId(15069)).toBe("session:15069");
    expect(formatWriterForDisplay("session:15069")).toBe("S15069");
  });

  test("claim writer id is job+generation, not session-shaped", () => {
    expect(claimWriterId(7, 2)).toBe("claim:7:2");
    expect(formatWriterForDisplay("claim:7:2")).toBe("claim:7:2");
  });
});

describe("monotonic sequence", () => {
  test("self-seeds and is strictly increasing across calls", () => {
    const first = nextWriteGateSequence(db);
    const second = nextWriteGateSequence(db);
    const third = nextWriteGateSequence(db);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  test("two stamps in the same wall-clock second are still ordered by sequence", () => {
    const nowEpoch = 1_000;
    const a = stampField(db, "segment", 1, "goal", "session:1", nowEpoch);
    const b = stampField(db, "segment", 1, "decisions", "session:2", nowEpoch);
    expect(b.writeSequence).toBeGreaterThan(a.writeSequence);
  });
});

describe("field stamps", () => {
  test("an unwritten field has no stamp", () => {
    expect(getFieldStamp(db, "segment", 1, "goal")).toBeNull();
  });

  test("stamping records writer, sequence and time; re-stamping overwrites in place", () => {
    stampField(db, "segment", 1, "goal", "session:1", 100);
    const second = stampField(db, "segment", 1, "goal", "session:2", 200);

    expect(getFieldStamp(db, "segment", 1, "goal")).toEqual(second);
    expect(second.writer).toBe("session:2");
  });

  test("a null-clear is a write like any other — the field is 'written', not 'never written'", () => {
    // stampField has no notion of the value itself; a caller stamps a clear
    // the same way it stamps any other write. Confirms the stamp alone (not
    // the underlying column) is what "written" means to the gate.
    stampField(db, "segment", 1, "reference", "session:1", 100);
    expect(getFieldStamp(db, "segment", 1, "reference")).not.toBeNull();
  });
});

describe("read grants", () => {
  test("recordReadGrant then a fresh checkFieldGate call sees it granted", () => {
    // Someone else wrote the field long ago; a grant recorded AFTER that
    // write covers it (rule 1).
    stampField(db, "segment", 1, "goal", "session:9", 100);
    recordReadGrant(db, "session:1", "segment", 1, 200, snapshotWriteGateSequence(db));

    const verdict = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1");
    expect(verdict.ok).toBe(true);
  });

  test("recordReadGrants batches several entities under one sequence snapshot", () => {
    recordReadGrants(
      db,
      "session:1",
      [
        { entityType: "segment", entityId: 1 },
        { entityType: "turn", entityId: 5 },
      ],
      100,
      snapshotWriteGateSequence(db),
    );
    expect(checkFieldGate(db, "session:1", "segment", 1, "goal", "E1").ok).toBe(true);
    expect(checkFieldGate(db, "session:1", "turn", 5, "title", "S1/T5").ok).toBe(true);
  });

  test("re-reading refreshes the same row rather than accumulating rows", () => {
    recordReadGrant(db, "session:1", "segment", 1, 100, snapshotWriteGateSequence(db));
    recordReadGrant(db, "session:1", "segment", 1, 200, snapshotWriteGateSequence(db));
    const rows = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM write_gate_reads WHERE writer = 'session:1' AND entity_id = 1",
      )
      .get();
    expect(rows?.count).toBe(1);
  });

  test("clearReadGrantsForWriter drops every grant that writer holds, and only that writer's", () => {
    recordReadGrant(db, "session:1", "segment", 1, 100, snapshotWriteGateSequence(db));
    recordReadGrant(db, "session:1", "turn", 2, 100, snapshotWriteGateSequence(db));
    recordReadGrant(db, "session:2", "segment", 1, 100, snapshotWriteGateSequence(db));

    const cleared = clearReadGrantsForWriter(db, "session:1");
    expect(cleared).toBe(2);
    expect(checkFieldGate(db, "session:2", "segment", 1, "goal", "E1").ok).toBe(true);
  });

  // Ticket 14 (P1-3 fix, spec "授权序列渲染前快照"): a render pass must
  // snapshot the sequence at its own START, not have `recordReadGrant` look
  // it up lazily at record time — otherwise a foreign write landing in the
  // gap between "the render actually read this row" and "the render pass
  // finally calls recordReadGrant" would bump the sequence the grant gets
  // stamped with, making a render that in truth predates the foreign write
  // look like it postdates it.
  test("a sequence snapshotted at render-START, not at record-time, is correctly judged stale by a write that lands in between", () => {
    // The render pass begins: it snapshots the sequence BEFORE reading
    // anything else.
    const renderStartSequence = snapshotWriteGateSequence(db);

    // A foreign write lands in the gap between render-start and this render
    // pass's own (deferred) record call.
    stampField(db, "segment", 1, "goal", "session:9", 150);

    // Only now does the render pass finish and record its grant — using the
    // sequence it captured at its own start, not a fresh lookup.
    recordReadGrant(db, "session:1", "segment", 1, 200, renderStartSequence);

    const verdict = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("stale");
    }

    // The contrast: recording with a sequence taken AFTER the foreign write
    // (the bug this fix closes) would have made the same render look fresh.
    recordReadGrant(db, "session:2", "segment", 1, 200, snapshotWriteGateSequence(db));
    expect(checkFieldGate(db, "session:2", "segment", 1, "goal", "E1").ok).toBe(true);
  });

  test("the BATCH form honors the caller's render-start snapshot the same way (a record-time re-lookup would survive the singular test alone)", () => {
    const renderStartSequence = snapshotWriteGateSequence(db);

    stampField(db, "segment", 2, "goal", "session:9", 150);

    recordReadGrants(
      db,
      "session:1",
      [{ entityType: "segment", entityId: 2 }],
      200,
      renderStartSequence,
    );

    const verdict = checkFieldGate(db, "session:1", "segment", 2, "goal", "E2");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("stale");
    }
  });
});

describe("janitor sweep — age-keyed (ticket 01, re-keyed from 'session completed')", () => {
  test("30-day-stale rows go; a completed-but-recent writer's grants survive another writer's sweep", () => {
    // A foreign write on each field, so checkFieldGate actually exercises
    // the grant below (rule 3 would otherwise admit an unwritten field
    // regardless of grant state).
    stampField(db, "segment", 1, "goal", "session:9999", 0);
    stampField(db, "segment", 2, "goal", "session:9999", 0);
    // Exactly 30 days old at sweep time — "30-day-stale" is inclusive of the
    // boundary itself.
    recordReadGrant(db, sessionWriterId(1), "segment", 1, 0, snapshotWriteGateSequence(db));
    // One second short of 30 days old — recent, must survive.
    recordReadGrant(
      db,
      sessionWriterId(2),
      "segment",
      2,
      STALE_READ_GRANT_AGE_SECONDS - 1,
      snapshotWriteGateSequence(db),
    );

    const swept = sweepStaleReadGrants(db, STALE_READ_GRANT_AGE_SECONDS, 100);

    expect(swept).toBe(1);
    expect(checkFieldGate(db, sessionWriterId(1), "segment", 1, "goal", "E1").ok).toBe(false);
    expect(checkFieldGate(db, sessionWriterId(2), "segment", 2, "goal", "E2").ok).toBe(true);
  });

  test("session completion no longer decides anything — a completed session's fresh grant survives, a live session's aged one does not", () => {
    const completed = upsertSession(db, {
      contentSessionId: "done",
      project: "/tmp/p",
      title: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: 500,
    }).id;
    const live = upsertSession(db, {
      contentSessionId: "live",
      project: "/tmp/p",
      title: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    stampField(db, "segment", 1, "goal", "session:9999", 0);
    stampField(db, "segment", 2, "goal", "session:9999", 0);
    // The completed session's grant is FRESH.
    recordReadGrant(
      db,
      sessionWriterId(completed),
      "segment",
      1,
      STALE_READ_GRANT_AGE_SECONDS,
      snapshotWriteGateSequence(db),
    );
    // The live session's grant is AGED OUT.
    recordReadGrant(db, sessionWriterId(live), "segment", 2, 0, snapshotWriteGateSequence(db));

    const swept = sweepStaleReadGrants(db, STALE_READ_GRANT_AGE_SECONDS, 100);

    expect(swept).toBe(1);
    expect(checkFieldGate(db, sessionWriterId(completed), "segment", 1, "goal", "E1").ok).toBe(
      true,
    );
    expect(checkFieldGate(db, sessionWriterId(live), "segment", 2, "goal", "E2").ok).toBe(false);
  });

  test("sweeps a stale completeness row independent of its grant row's own age", () => {
    recordFieldCompleteness(
      db,
      "session:1",
      [{ entityType: "segment", entityId: 1, field: "goal", complete: true }],
      0,
      snapshotWriteGateSequence(db),
    );
    // The grant for the SAME writer/entity is fresh — only the completeness
    // row's own timestamp decides its fate; a stale completeness row without
    // its grant is as dead as the reverse.
    recordReadGrant(
      db,
      "session:1",
      "segment",
      1,
      STALE_READ_GRANT_AGE_SECONDS,
      snapshotWriteGateSequence(db),
    );

    const swept = sweepStaleReadGrants(db, STALE_READ_GRANT_AGE_SECONDS, 100);

    expect(swept).toBe(1);
    expect(getFieldCompleteness(db, "session:1", "segment", 1, "goal")).toBeNull();
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM write_gate_reads WHERE writer = 'session:1'",
        )
        .get()?.count,
    ).toBe(1);
  });

  test("is idempotent — a row swept once is gone on the next pass", () => {
    recordReadGrant(db, "session:1", "segment", 1, 0, snapshotWriteGateSequence(db));

    expect(sweepStaleReadGrants(db, STALE_READ_GRANT_AGE_SECONDS, 100)).toBe(1);
    expect(sweepStaleReadGrants(db, STALE_READ_GRANT_AGE_SECONDS, 100)).toBe(0);
  });

  test("bounds its own work with limit, per table", () => {
    for (let i = 0; i < 5; i += 1) {
      recordReadGrant(db, `session:${i}`, "segment", i + 1, 0, snapshotWriteGateSequence(db));
    }
    const swept = sweepStaleReadGrants(db, STALE_READ_GRANT_AGE_SECONDS, 2);
    expect(swept).toBeLessThanOrEqual(2);
  });
});

describe("field completeness (write-mode-edit-semantics ticket 04, spec D8 — the RECORD half only)", () => {
  test("an untruncated field render is recorded complete", () => {
    recordFieldCompleteness(
      db,
      "session:1",
      [{ entityType: "segment", entityId: 1, field: "goal", complete: true }],
      100,
      snapshotWriteGateSequence(db),
    );
    const record = getFieldCompleteness(db, "session:1", "segment", 1, "goal");
    expect(record).not.toBeNull();
    expect(record!.complete).toBe(true);
  });

  test("a truncated field render is recorded incomplete — a positive fact, not simply absent", () => {
    recordFieldCompleteness(
      db,
      "session:1",
      [{ entityType: "segment", entityId: 1, field: "content", complete: false }],
      100,
      snapshotWriteGateSequence(db),
    );
    const record = getFieldCompleteness(db, "session:1", "segment", 1, "content");
    expect(record).not.toBeNull();
    expect(record!.complete).toBe(false);
  });

  test("a field never shown by any render has no completeness record at all", () => {
    expect(getFieldCompleteness(db, "session:1", "segment", 1, "goal")).toBeNull();
  });

  test("one long field truncated and one short field complete on the SAME entity are recorded independently — the long field's truncation does not connect the short one", () => {
    recordFieldCompleteness(
      db,
      "session:1",
      [
        { entityType: "segment", entityId: 1, field: "content", complete: false },
        { entityType: "segment", entityId: 1, field: "goal", complete: true },
      ],
      100,
      snapshotWriteGateSequence(db),
    );
    expect(getFieldCompleteness(db, "session:1", "segment", 1, "content")!.complete).toBe(false);
    expect(getFieldCompleteness(db, "session:1", "segment", 1, "goal")!.complete).toBe(true);
  });

  test("a field read truncated once and complete the next is recorded complete — the later render wins, never a permanent disqualification from the first", () => {
    recordFieldCompleteness(
      db,
      "session:1",
      [{ entityType: "segment", entityId: 1, field: "goal", complete: false }],
      100,
      snapshotWriteGateSequence(db),
    );
    expect(getFieldCompleteness(db, "session:1", "segment", 1, "goal")!.complete).toBe(false);

    recordFieldCompleteness(
      db,
      "session:1",
      [{ entityType: "segment", entityId: 1, field: "goal", complete: true }],
      200,
      snapshotWriteGateSequence(db),
    );
    expect(getFieldCompleteness(db, "session:1", "segment", 1, "goal")!.complete).toBe(true);

    // Refreshes the same row rather than accumulating a second one — same
    // discipline `recordReadGrant` itself already follows.
    const rows = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM write_gate_field_completeness WHERE writer = 'session:1' AND entity_id = 1 AND field = 'goal'",
      )
      .get();
    expect(rows?.count).toBe(1);
  });

  test("two different writers' completeness facts for the same field never collide", () => {
    recordFieldCompleteness(
      db,
      "session:1",
      [{ entityType: "segment", entityId: 1, field: "goal", complete: true }],
      100,
      snapshotWriteGateSequence(db),
    );
    recordFieldCompleteness(
      db,
      "session:2",
      [{ entityType: "segment", entityId: 1, field: "goal", complete: false }],
      100,
      snapshotWriteGateSequence(db),
    );
    expect(getFieldCompleteness(db, "session:1", "segment", 1, "goal")!.complete).toBe(true);
    expect(getFieldCompleteness(db, "session:2", "segment", 1, "goal")!.complete).toBe(false);
  });

  test("recordFieldCompleteness is a no-op on an empty entries list", () => {
    expect(() => recordFieldCompleteness(db, "session:1", [], 100, snapshotWriteGateSequence(db))).not.toThrow();
    expect(getFieldCompleteness(db, "session:1", "segment", 1, "goal")).toBeNull();
  });

  test("clearReadGrantsForWriter also sweeps that writer's own completeness rows, and only that writer's", () => {
    recordFieldCompleteness(
      db,
      "session:1",
      [{ entityType: "segment", entityId: 1, field: "goal", complete: true }],
      100,
      snapshotWriteGateSequence(db),
    );
    recordFieldCompleteness(
      db,
      "session:2",
      [{ entityType: "segment", entityId: 1, field: "goal", complete: true }],
      100,
      snapshotWriteGateSequence(db),
    );

    clearReadGrantsForWriter(db, "session:1");

    expect(getFieldCompleteness(db, "session:1", "segment", 1, "goal")).toBeNull();
    expect(getFieldCompleteness(db, "session:2", "segment", 1, "goal")).not.toBeNull();
  });
});

describe("checkFieldGate — the three-judgment order", () => {
  test("rule 3: a field never written by anyone admits with no grant at all", () => {
    const verdict = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1");
    expect(verdict.ok).toBe(true);
  });

  test("rule 2: the field's own last writer may always rewrite it, ungranted", () => {
    stampField(db, "segment", 1, "goal", "session:1", 100);
    const verdict = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1");
    expect(verdict.ok).toBe(true);
  });

  test("rule 4 (never-read): another writer's field, this writer holds no grant", () => {
    stampField(db, "segment", 1, "goal", "session:9", 100);
    const verdict = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("never-read");
      expect(verdict.message).toContain("E1");
      expect(verdict.message).toContain("recall");
    }
  });

  test("rule 4 (stale): grant predates a later write by someone else", () => {
    recordReadGrant(db, "session:1", "segment", 1, 100, snapshotWriteGateSequence(db));
    stampField(db, "segment", 1, "goal", "session:9", 200);

    const verdict = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("stale");
      expect(verdict.message).toContain("goal");
      expect(verdict.message).toContain("S9");
      expect(verdict.message).toContain("recall");
      expect(verdict.message).not.toBe(
        // never-read and stale must be textually distinguishable
        `E1 has not been read this session — recall(id="E1") first, then write it.`,
      );
    }
  });

  test("rule 1: grant recorded AFTER the last write on the field admits", () => {
    stampField(db, "segment", 1, "goal", "session:9", 100);
    recordReadGrant(db, "session:1", "segment", 1, 200, snapshotWriteGateSequence(db));
    expect(checkFieldGate(db, "session:1", "segment", 1, "goal", "E1").ok).toBe(true);
  });

  test("self-writes never go stale relative to a grant, however old the grant is", () => {
    recordReadGrant(db, "session:1", "segment", 1, 100, snapshotWriteGateSequence(db));
    stampField(db, "segment", 1, "goal", "session:1", 500);
    expect(checkFieldGate(db, "session:1", "segment", 1, "goal", "E1").ok).toBe(true);
  });

  test("never-read and stale are distinguishable by message text", () => {
    stampField(db, "segment", 1, "goal", "session:9", 100);
    const neverRead = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1");

    recordReadGrant(db, "session:2", "segment", 2, 50, snapshotWriteGateSequence(db));
    stampField(db, "segment", 2, "goal", "session:9", 100);
    const stale = checkFieldGate(db, "session:2", "segment", 2, "goal", "E2");

    expect(neverRead.ok).toBe(false);
    expect(stale.ok).toBe(false);
    if (!neverRead.ok && !stale.ok) {
      expect(neverRead.reason).not.toBe(stale.reason);
    }
  });
});

/**
 * Ticket 06 (write-mode-edit-semantics spec D2/D5/D6): the read requirement
 * is the ONLY difference between the two write modes. Both run the three
 * judgments above unchanged; a `write` landing over content another writer
 * put there additionally needs its grant to have come from a render that
 * showed that field WHOLE (ticket 04's completeness records).
 * `requireCompleteRead` is the caller's own answer to "is this a write, and
 * is there existing content to lose" — the gate never guesses either.
 */
describe("checkFieldGate — `write` over existing content also requires a complete read (ticket 06)", () => {
  /** A foreign writer's content plus this writer's grant recorded after it. */
  function foreignContentThenGrant(field: string, writer = "session:1"): void {
    stampField(db, "segment", 1, field, "session:9", 100);
    recordReadGrant(db, writer, "segment", 1, 200, snapshotWriteGateSequence(db));
  }

  function recordCompleteness(field: string, complete: boolean, writer = "session:1"): void {
    recordFieldCompleteness(
      db,
      writer,
      [{ entityType: "segment", entityId: 1, field, complete }],
      200,
      snapshotWriteGateSequence(db),
    );
  }

  test("a grant from a TRUNCATED render refuses the write and the message names the field", () => {
    foreignContentThenGrant("goal");
    recordCompleteness("goal", false);

    const verdict = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1", {
      requireCompleteRead: true,
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("incomplete-read");
      expect(verdict.message).toContain("goal");
      expect(verdict.message).toContain("E1");
    }
  });

  test("a grant from a COMPLETE render admits the same write", () => {
    foreignContentThenGrant("goal");
    recordCompleteness("goal", true);

    expect(
      checkFieldGate(db, "session:1", "segment", 1, "goal", "E1", { requireCompleteRead: true }).ok,
    ).toBe(true);
  });

  test("no completeness record at all is refused too — a field the granting render never showed was not read in full either", () => {
    foreignContentThenGrant("goal");

    const verdict = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1", {
      requireCompleteRead: true,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("incomplete-read");
    }
  });

  test("under that SAME truncated authorization an `edit` is admitted — the read requirement is the only difference between the modes", () => {
    foreignContentThenGrant("goal");
    recordCompleteness("goal", false);

    // `edit` passes no requirement of its own; every other judgment is identical.
    expect(checkFieldGate(db, "session:1", "segment", 1, "goal", "E1").ok).toBe(true);
  });

  test("a field never written by anyone is exempt — the create path has no old content to lose", () => {
    recordCompleteness("goal", false);
    expect(
      checkFieldGate(db, "session:1", "segment", 1, "goal", "E1", { requireCompleteRead: true }).ok,
    ).toBe(true);
  });

  test("the field's own last writer is exempt in BOTH modes — writing is reading", () => {
    stampField(db, "segment", 1, "goal", "session:1", 100);
    recordCompleteness("goal", false);

    expect(
      checkFieldGate(db, "session:1", "segment", 1, "goal", "E1", { requireCompleteRead: true }).ok,
    ).toBe(true);
    expect(checkFieldGate(db, "session:1", "segment", 1, "goal", "E1").ok).toBe(true);
  });

  test("staleness outranks the read requirement: a foreign write after the grant rejects BOTH modes, as stale", () => {
    recordReadGrant(db, "session:1", "segment", 1, 100, snapshotWriteGateSequence(db));
    recordCompleteness("goal", true);
    stampField(db, "segment", 1, "goal", "session:9", 300);

    const asWrite = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1", {
      requireCompleteRead: true,
    });
    const asEdit = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1");

    expect(asWrite.ok).toBe(false);
    expect(asEdit.ok).toBe(false);
    if (!asWrite.ok && !asEdit.ok) {
      expect(asWrite.reason).toBe("stale");
      expect(asEdit.reason).toBe("stale");
      // A complete read does not license a write onto a field that moved
      // since: "看见" and "内容一致" are two premises, not one.
      expect(asWrite.message).toContain("S9");
    }
  });

  test("the three rejections are distinct reasons AND distinct text", () => {
    // session:2's grant is taken BEFORE the foreign write (that is what makes
    // it stale); session:3's after it, but truncated.
    const beforeForeignWrite = snapshotWriteGateSequence(db);
    stampField(db, "segment", 1, "goal", "session:9", 100);

    const neverRead = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1", {
      requireCompleteRead: true,
    });

    recordReadGrant(db, "session:2", "segment", 1, 50, beforeForeignWrite);
    const stale = checkFieldGate(db, "session:2", "segment", 1, "goal", "E1", {
      requireCompleteRead: true,
    });

    recordReadGrant(db, "session:3", "segment", 1, 200, snapshotWriteGateSequence(db));
    recordCompleteness("goal", false, "session:3");
    const incomplete = checkFieldGate(db, "session:3", "segment", 1, "goal", "E1", {
      requireCompleteRead: true,
    });

    expect(neverRead.ok).toBe(false);
    expect(stale.ok).toBe(false);
    expect(incomplete.ok).toBe(false);
    if (!neverRead.ok && !stale.ok && !incomplete.ok) {
      const reasons = [neverRead.reason, stale.reason, incomplete.reason];
      expect(new Set(reasons).size).toBe(3);
      const messages = [neverRead.message, stale.message, incomplete.message];
      expect(new Set(messages).size).toBe(3);
    }
  });

  test("one long field's truncation does not block a short field's write on the SAME entity", () => {
    stampField(db, "segment", 1, "content", "session:9", 100);
    stampField(db, "segment", 1, "goal", "session:9", 100);
    recordReadGrant(db, "session:1", "segment", 1, 200, snapshotWriteGateSequence(db));
    recordFieldCompleteness(
      db,
      "session:1",
      [
        { entityType: "segment", entityId: 1, field: "content", complete: false },
        { entityType: "segment", entityId: 1, field: "goal", complete: true },
      ],
      200,
      snapshotWriteGateSequence(db),
    );

    expect(
      checkFieldGate(db, "session:1", "segment", 1, "goal", "E1", { requireCompleteRead: true }).ok,
    ).toBe(true);
    expect(
      checkFieldGate(db, "session:1", "segment", 1, "content", "E1", { requireCompleteRead: true })
        .ok,
    ).toBe(false);
  });

  test("the caller's own remedy clause is what the message tells the writer to do", () => {
    foreignContentThenGrant("goal");
    recordCompleteness("goal", false);

    const withRemedy = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1", {
      requireCompleteRead: true,
      completeReadRemedy: 're-read it whole with recall(id="E1", pageBudget=4000),',
    });
    const withoutRemedy = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1", {
      requireCompleteRead: true,
    });

    expect(withRemedy.ok).toBe(false);
    expect(withoutRemedy.ok).toBe(false);
    if (!withRemedy.ok && !withoutRemedy.ok) {
      expect(withRemedy.message).toContain("pageBudget=4000");
      // Both still say what the remedy is FOR — the fallback never leaves a
      // writer without a next action.
      expect(withoutRemedy.message).toContain("bigger budget");
      expect(withRemedy.message).toContain("edit");
    }
  });
});

/**
 * Light-review-repairs 04 (P1 repair to grant-lifecycle ticket 01): the
 * writer-context-epoch soundness boundary that replaces PreCompact's
 * two-table DELETE. `bumpWriterEpoch` makes every read grant and
 * completeness row a writer earned under an OLDER epoch invisible to both
 * gates, without physically touching either row — a bump-only unit-level
 * counterpart to the hook-level fixtures in tests/hooks/compact.test.ts.
 */
describe("writer context epoch (light-review-repairs 04)", () => {
  test("a fresh writer nobody has ever bumped behaves exactly as before this ticket — every earlier test in this file already assumes epoch 0", () => {
    stampField(db, "segment", 1, "goal", "session:9", 100);
    recordReadGrant(db, "session:1", "segment", 1, 200, snapshotWriteGateSequence(db));
    expect(checkFieldGate(db, "session:1", "segment", 1, "goal", "E1").ok).toBe(true);
  });

  test("bumping the writer's epoch turns a granted field gate back into never-read, without deleting the row", () => {
    stampField(db, "segment", 1, "goal", "session:9", 100);
    recordReadGrant(db, "session:1", "segment", 1, 200, snapshotWriteGateSequence(db));
    expect(checkFieldGate(db, "session:1", "segment", 1, "goal", "E1").ok).toBe(true);

    bumpWriterEpoch(db, "session:1");

    const verdict = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("never-read");
    }
    // The row is still physically there — a bump invalidates, it does not delete.
    const rows = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM write_gate_reads WHERE writer = 'session:1' AND entity_id = 1",
      )
      .get();
    expect(rows?.count).toBe(1);
  });

  test("bumping also turns a complete-read authorization back into incomplete-read, without deleting the completeness row", () => {
    stampField(db, "segment", 1, "goal", "session:9", 100);
    recordReadGrant(db, "session:1", "segment", 1, 200, snapshotWriteGateSequence(db));
    recordFieldCompleteness(
      db,
      "session:1",
      [{ entityType: "segment", entityId: 1, field: "goal", complete: true }],
      200,
      snapshotWriteGateSequence(db),
    );
    expect(
      checkFieldGate(db, "session:1", "segment", 1, "goal", "E1", { requireCompleteRead: true })
        .ok,
    ).toBe(true);

    bumpWriterEpoch(db, "session:1");

    const verdict = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1", {
      requireCompleteRead: true,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      // The grant died first (never-read outranks incomplete-read as a
      // rejection reason here, since getReadGrant itself now returns null).
      expect(verdict.reason).toBe("never-read");
    }
    const rows = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM write_gate_field_completeness WHERE writer = 'session:1' AND entity_id = 1",
      )
      .get();
    expect(rows?.count).toBe(1);
  });

  test("bumping invalidates the relations gate identically — a pre-bump complete relations read no longer authorizes an edge write", () => {
    const turnId = 7;
    stampTurnRelationsRevision(db, turnId, "session:9", 100);
    recordReadGrant(db, "session:1", "turn", turnId, 200, snapshotWriteGateSequence(db));
    recordFieldCompleteness(
      db,
      "session:1",
      [{ entityType: "turn", entityId: turnId, field: RELATIONS_GATE_FIELD, complete: true }],
      200,
      snapshotWriteGateSequence(db),
    );
    expect(checkRelationsGate(db, "session:1", turnId, "T7").ok).toBe(true);

    bumpWriterEpoch(db, "session:1");

    const verdict = checkRelationsGate(db, "session:1", turnId, "T7");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("incomplete-read");
    }
  });

  test("bumping one writer never invalidates another writer's grant on the same entity", () => {
    stampField(db, "segment", 1, "goal", "session:9", 100);
    recordReadGrant(db, "session:1", "segment", 1, 200, snapshotWriteGateSequence(db));
    recordReadGrant(db, "session:2", "segment", 1, 200, snapshotWriteGateSequence(db));

    bumpWriterEpoch(db, "session:1");

    expect(checkFieldGate(db, "session:1", "segment", 1, "goal", "E1").ok).toBe(false);
    expect(checkFieldGate(db, "session:2", "segment", 1, "goal", "E1").ok).toBe(true);
  });

  test("a bump is not a dead end — a fresh read recorded AFTER the bump is granted under the writer's new epoch", () => {
    stampField(db, "segment", 1, "goal", "session:9", 100);
    recordReadGrant(db, "session:1", "segment", 1, 200, snapshotWriteGateSequence(db));
    bumpWriterEpoch(db, "session:1");
    expect(checkFieldGate(db, "session:1", "segment", 1, "goal", "E1").ok).toBe(false);

    recordReadGrant(db, "session:1", "segment", 1, 300, snapshotWriteGateSequence(db));
    expect(checkFieldGate(db, "session:1", "segment", 1, "goal", "E1").ok).toBe(true);
  });

  test("a double bump (the SessionStart(compact) idempotent re-bump backstop) is harmless — nothing granted between the two bumps stays granted, and nothing changes that the first bump did not already decide", () => {
    stampField(db, "segment", 1, "goal", "session:9", 100);
    recordReadGrant(db, "session:1", "segment", 1, 200, snapshotWriteGateSequence(db));

    const afterFirstBump = bumpWriterEpoch(db, "session:1");
    const afterSecondBump = bumpWriterEpoch(db, "session:1");

    expect(afterSecondBump).toBe(afterFirstBump + 1);
    const verdict = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("never-read");
    }
  });
});

describe("janitor sweep — epoch-keyed (light-review-repairs 04, P1)", () => {
  test("sweeps a row recorded under an old epoch even though it is NOT aged", () => {
    recordReadGrant(db, "session:1", "segment", 1, 999_999, snapshotWriteGateSequence(db));
    bumpWriterEpoch(db, "session:1");

    // The row is brand new by the clock — an age-only sweep would leave it.
    const swept = sweepStaleReadGrants(db, 999_999, 100);

    expect(swept).toBe(1);
    const rows = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM write_gate_reads WHERE writer = 'session:1'",
      )
      .get();
    expect(rows?.count).toBe(0);
  });

  test("sweeps a stale-by-epoch completeness row the same way", () => {
    recordFieldCompleteness(
      db,
      "session:1",
      [{ entityType: "segment", entityId: 1, field: "goal", complete: true }],
      999_999,
      snapshotWriteGateSequence(db),
    );
    bumpWriterEpoch(db, "session:1");

    const swept = sweepStaleReadGrants(db, 999_999, 100);

    expect(swept).toBe(1);
    expect(getFieldCompleteness(db, "session:1", "segment", 1, "goal")).toBeNull();
  });

  test("a row recorded AFTER the bump (the writer's current epoch) survives the epoch sweep", () => {
    bumpWriterEpoch(db, "session:1");
    recordReadGrant(db, "session:1", "segment", 1, 999_999, snapshotWriteGateSequence(db));

    const swept = sweepStaleReadGrants(db, 999_999, 100);

    expect(swept).toBe(0);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM write_gate_reads WHERE writer = 'session:1'",
        )
        .get()?.count,
    ).toBe(1);
  });

  test("a writer nobody ever bumped contributes nothing to the epoch sweep — only aged rows go", () => {
    recordReadGrant(db, "session:1", "segment", 1, 999_999, snapshotWriteGateSequence(db));
    const swept = sweepStaleReadGrants(db, 999_999, 100);
    expect(swept).toBe(0);
  });
});

describe("janitor sweep — indexed scan (light-review-repairs 04, P2)", () => {
  function planDetail(sql: string): string {
    return db
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((row) => row.detail)
      .join(" | ");
  }

  test("the age scan over write_gate_reads uses the new timestamp index, not a table scan", () => {
    const detail = planDetail(
      "SELECT rowid FROM write_gate_reads WHERE read_at_epoch <= 1000 LIMIT 10",
    );
    expect(detail).toContain("idx_write_gate_reads_read_at");
    expect(detail).not.toContain("SCAN write_gate_reads");
  });

  test("the age scan over write_gate_field_completeness uses its own timestamp index, not a table scan", () => {
    const detail = planDetail(
      "SELECT rowid FROM write_gate_field_completeness WHERE recorded_at_epoch <= 1000 LIMIT 10",
    );
    expect(detail).toContain("idx_write_gate_field_completeness_recorded_at");
    expect(detail).not.toContain("SCAN write_gate_field_completeness");
  });
});
