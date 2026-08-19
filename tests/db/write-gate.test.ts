import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  checkFieldGate,
  claimWriterId,
  clearReadGrantsForWriter,
  formatWriterForDisplay,
  getFieldStamp,
  nextWriteGateSequence,
  recordReadGrant,
  recordReadGrants,
  sessionWriterId,
  stampField,
  sweepReadGrantsForCompletedSessions,
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
    recordReadGrant(db, "session:1", "segment", 1, 200);

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
    );
    expect(checkFieldGate(db, "session:1", "segment", 1, "goal", "E1").ok).toBe(true);
    expect(checkFieldGate(db, "session:1", "turn", 5, "title", "S1/T5").ok).toBe(true);
  });

  test("re-reading refreshes the same row rather than accumulating rows", () => {
    recordReadGrant(db, "session:1", "segment", 1, 100);
    recordReadGrant(db, "session:1", "segment", 1, 200);
    const rows = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM write_gate_reads WHERE writer = 'session:1' AND entity_id = 1",
      )
      .get();
    expect(rows?.count).toBe(1);
  });

  test("clearReadGrantsForWriter drops every grant that writer holds, and only that writer's", () => {
    recordReadGrant(db, "session:1", "segment", 1, 100);
    recordReadGrant(db, "session:1", "turn", 2, 100);
    recordReadGrant(db, "session:2", "segment", 1, 100);

    const cleared = clearReadGrantsForWriter(db, "session:1");
    expect(cleared).toBe(2);
    expect(checkFieldGate(db, "session:2", "segment", 1, "goal", "E1").ok).toBe(true);
  });
});

describe("janitor backstop", () => {
  function seedSession(contentId: string, completedAtEpoch: number | null): number {
    return upsertSession(db, {
      contentSessionId: contentId,
      project: "/tmp/p",
      title: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch,
    }).id;
  }

  test("sweeps grants belonging to already-completed sessions", () => {
    const completed = seedSession("done", 500);
    const live = seedSession("live", null);
    recordReadGrant(db, sessionWriterId(completed), "segment", 1, 100);
    recordReadGrant(db, sessionWriterId(live), "segment", 2, 100);

    const swept = sweepReadGrantsForCompletedSessions(db, 100);

    expect(swept).toBe(1);
    expect(checkFieldGate(db, sessionWriterId(live), "segment", 2, "goal", "E2").ok).toBe(true);
    // The live session's OWN grant on segment 2 is untouched.
    stampField(db, "segment", 2, "goal", "session:999", 50);
    recordReadGrant(db, sessionWriterId(live), "segment", 2, 60);
    expect(checkFieldGate(db, sessionWriterId(live), "segment", 2, "goal", "E2").ok).toBe(true);
  });

  test("is idempotent and self-heals a session whose own cleanup call was missed", () => {
    const completed = seedSession("crashed", 500);
    recordReadGrant(db, sessionWriterId(completed), "segment", 1, 100);

    expect(sweepReadGrantsForCompletedSessions(db, 100)).toBe(1);
    expect(sweepReadGrantsForCompletedSessions(db, 100)).toBe(0);
  });

  test("bounds its own work with limit", () => {
    for (let i = 0; i < 5; i += 1) {
      const id = seedSession(`s${i}`, 500);
      recordReadGrant(db, sessionWriterId(id), "segment", i + 1, 100);
    }
    const swept = sweepReadGrantsForCompletedSessions(db, 2);
    expect(swept).toBeLessThanOrEqual(2);
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
    recordReadGrant(db, "session:1", "segment", 1, 100);
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
    recordReadGrant(db, "session:1", "segment", 1, 200);
    expect(checkFieldGate(db, "session:1", "segment", 1, "goal", "E1").ok).toBe(true);
  });

  test("self-writes never go stale relative to a grant, however old the grant is", () => {
    recordReadGrant(db, "session:1", "segment", 1, 100);
    stampField(db, "segment", 1, "goal", "session:1", 500);
    expect(checkFieldGate(db, "session:1", "segment", 1, "goal", "E1").ok).toBe(true);
  });

  test("never-read and stale are distinguishable by message text", () => {
    stampField(db, "segment", 1, "goal", "session:9", 100);
    const neverRead = checkFieldGate(db, "session:1", "segment", 1, "goal", "E1");

    recordReadGrant(db, "session:2", "segment", 2, 50);
    stampField(db, "segment", 2, "goal", "session:9", 100);
    const stale = checkFieldGate(db, "session:2", "segment", 2, "goal", "E2");

    expect(neverRead.ok).toBe(false);
    expect(stale.ok).toBe(false);
    if (!neverRead.ok && !stale.ok) {
      expect(neverRead.reason).not.toBe(stale.reason);
    }
  });
});
