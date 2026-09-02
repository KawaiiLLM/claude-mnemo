import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  checkRelationsGate,
  RELATIONS_GATE_FIELD,
  stampTurnRelationsRevision,
} from "../../src/db/write-gate";
import { recallMemory } from "../../src/mcp/recall";

/**
 * Settlement-read-once ticket 00, spec D0 — DELIVERED, NOT DELIVERED WHOLE
 * (USER RULING T2404).
 *
 * `checkRelationsGate` used to demand `complete = true`. A settlement run whose
 * `relations` field the budget shortened by one atom therefore paid a whole
 * round trip to re-read a set it had already looked at — while the ledger
 * could not tell that case apart from the one that genuinely licenses nothing,
 * because the recorder wrote `complete = false` for BOTH a shortened field and
 * a field the render never reached.
 *
 * So the gate and the recorder move together, and this file is where the four
 * states are held apart. Each is asserted through the real `recall` route, not
 * by writing ledger rows by hand: the states are properties of what the
 * RENDERER did, and a fixture that stipulates the row would pass over a
 * renderer that never produces it.
 *
 *   `complete`   — delivered whole                        → row, grants
 *   `cut`        — atoms shown, the budget stopped the rest → row, GRANTS
 *   empty set    — evaluated, and there was nothing to show → row, grants
 *   `dropped`    — the ladder never reached the field       → NO row, refuses
 *
 * The asymmetry is the point. A reader who saw eighteen of twenty atoms has
 * seen a set and can judge whether its edge belongs in it; a reader who saw
 * the `- relations:` header and a truncation marker has seen a label.
 */
describe("the relations gate asks for DELIVERY, and the recorder draws the line (spec D0)", () => {
  const NOW = 1_800_000_000;

  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "relations-delivery",
      project: "/tmp/relations-delivery",
      title: "delivery session",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 1_000,
      updatedAtEpoch: NOW - 1_000,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => db.close());

  function seedTurn(promptNumber: number, content: string | null): number {
    return db
      .query<{ id: number }, [number, number, string | null]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           title, content, tool_call_count, created_at_epoch, type, tags
         ) VALUES (?, ?, 'extracted', 'a prompt', 'an answer', 'a title', ?, 0, ${NOW}, '[]', '[]')
         RETURNING id`,
      )
      .get(sessionId, promptNumber, content)!.id;
  }

  /** A citing turn carrying `count` outgoing atoms — the set the field renders. */
  function seedCiterWithEdges(count: number, content: string | null = "short content"): number {
    const citing = seedTurn(1, content);
    for (let index = 0; index < count; index += 1) {
      const cited = seedTurn(2 + index, "x");
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation: "extends" as never,
            provenance: "asserted",
            tailTag: "",
            headTag: "",
          },
        ],
        NOW,
      );
    }
    return citing;
  }

  function relationsRow(
    reader: string,
    turnId: number,
  ): { complete: number } | null {
    return (
      db
        .query<{ complete: number }, [string, number, string]>(
          `SELECT complete FROM write_gate_field_completeness
            WHERE writer = ? AND entity_type = 'turn' AND entity_id = ? AND field = ?`,
        )
        .get(reader, turnId, RELATIONS_GATE_FIELD) ?? null
    );
  }

  function read(
    reader: string,
    options: { turn?: number; relationsBudget?: number } = {},
  ): string {
    return recallMemory(db, {
      id: `S${sessionId}/T1`,
      filter: {
        fields: ["title", "content", "relations"],
        ...(options.relationsBudget !== undefined
          ? { fieldBudgets: { relations: options.relationsBudget } }
          : {}),
      },
      ...(options.turn !== undefined ? { turn: options.turn } : {}),
      readerId: reader,
      now: () => NOW,
    });
  }

  test("complete: a whole relations render records a row and grants", () => {
    const citing = seedCiterWithEdges(5);
    const reader = "session:1";

    const output = read(reader);

    expect(output).toContain("- relations:");
    expect(relationsRow(reader, citing)?.complete).toBe(1);
    expect(checkRelationsGate(db, reader, citing, "S1/T1").ok).toBe(true);
  });

  test("cut: the field's own budget stops after two atoms — the row says incomplete, and it GRANTS", () => {
    const citing = seedCiterWithEdges(5);
    const reader = "session:2";

    const output = read(reader, { relationsBudget: 12 });

    // Some atoms reached the reader, and some did not: that is `cut`.
    expect(output).toContain("- relations:");
    expect(output).toContain("extends ->");
    expect(output).toContain("…");
    const row = relationsRow(reader, citing);
    expect(row?.complete).toBe(0);
    // The relaxation: `complete` is recorded, and the gate does not read it.
    expect(checkRelationsGate(db, reader, citing, "S1/T1").ok).toBe(true);
  });

  test("dropped: the whole-turn ladder never reaches an atom — NO row, and the write is refused", () => {
    const citing = seedCiterWithEdges(5);
    const reader = "session:3";

    // Settlement-read-once ticket 01: the turn budget now pays for the
    // worst-case `truncated:` footer before the body ladder runs (spec D2),
    // so the number that lands the ladder ON the relations header — the state
    // this test pins — moved up by that reserve. The state itself is
    // unchanged: header rendered, not one atom, no row, write refused.
    const output = read(reader, { turn: 33 });

    // The header line survives; not one atom does. A label is not a set.
    expect(output).toContain("- relations:");
    expect(output).not.toContain("extends ->");
    expect(relationsRow(reader, citing)).toBeNull();

    const verdict = checkRelationsGate(db, reader, citing, "S1/T1");
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("incomplete-read");
    expect(!verdict.ok && verdict.message).toContain("not delivered to this run");
  });

  test("empty: a zero-edge turn's set was evaluated and there was nothing to show — it grants", () => {
    const citing = seedTurn(1, "short content");
    const reader = "session:4";

    read(reader);

    expect(relationsRow(reader, citing)?.complete).toBe(1);
    expect(checkRelationsGate(db, reader, citing, "S1/T1").ok).toBe(true);
  });

  // DELETED (main-agent-edges D3, the read-once 00 addendum): "empty AND the
  // ladder cut before the end: the reader never reached the field, so nothing
  // grants". It seeded a ZERO-EDGE turn with a body too long for a tiny turn
  // budget, and demanded a refusal because a reader who saw a truncation
  // marker cannot tell an empty set from a set it never reached.
  //
  // `checkRelationsGate` now admits a citing turn with ZERO outgoing rows
  // carrying a relation UNCONDITIONALLY — writer-agnostic, checked before the
  // completeness lookup — so this state is exactly the one the exception
  // exists for: there is nothing on such a turn a writer could have failed to
  // read, and demanding a re-read bought a round trip for an empty set. The
  // state is not adapted with a seeded edge because that case is already the
  // "dropped" test above, which is the same ladder-never-reached refusal on a
  // turn that HAS a set to miss.

  test("cut, then another writer stamps: staleness is unchanged by the relaxation", () => {
    const citing = seedCiterWithEdges(5);
    const reader = "session:6";

    read(reader, { relationsBudget: 12 });
    expect(checkRelationsGate(db, reader, citing, "S1/T1").ok).toBe(true);

    stampTurnRelationsRevision(db, citing, "session:9999", NOW + 1);

    const verdict = checkRelationsGate(db, reader, citing, "S1/T1");
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("stale");
    expect(!verdict.ok && verdict.reason === "stale" && verdict.staleWriter).toBe(
      "session:9999",
    );
  });

  test("an older post-stamp row is NOT withdrawn by a later drop — the run did see the set", () => {
    const citing = seedCiterWithEdges(5);
    const reader = "session:7";

    read(reader);
    expect(checkRelationsGate(db, reader, citing, "S1/T1").ok).toBe(true);

    // A second, tighter read of the same turn drops the field. That says
    // nothing about the first read, which delivered it — so the recorder must
    // write no row rather than overwrite the standing one with a drop.
    read(reader, { turn: 20 });

    expect(relationsRow(reader, citing)?.complete).toBe(1);
    expect(checkRelationsGate(db, reader, citing, "S1/T1").ok).toBe(true);
  });

  test("a read that does not SELECT relations still grants nothing — delivery is not a free pass", () => {
    const citing = seedCiterWithEdges(5);
    const reader = "session:8";

    recallMemory(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title", "content"] },
      readerId: reader,
      now: () => NOW,
    });

    expect(relationsRow(reader, citing)).toBeNull();
    expect(checkRelationsGate(db, reader, citing, "S1/T1").ok).toBe(false);
  });
});
