import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import {
  captureConsultedMemories,
  deriveConsultedAddresses,
  getConsultedMemories,
  recordConsultedMemories,
} from "../../src/db/consulted-memories";
import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";

describe("consulted memories capture", () => {
  let db: Database;
  let sessionId: number;
  let rideTurnId: number;

  function addTurn(promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, ?, 'active', 100)
         RETURNING id`,
      )
      .get(sessionId, promptNumber)!.id;
  }

  function addObservation(turnId: number): number {
    return db
      .query<{ id: number }, [number]>(
        `INSERT INTO observations (turn_id, tool_name, created_at_epoch)
         VALUES (?, 'Read', 100)
         RETURNING id`,
      )
      .get(turnId)!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-consulted",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    rideTurnId = addTurn(1);
  });

  afterEach(() => {
    db.close();
  });

  describe("derivation", () => {
    test("a collapsed recall marks its result hits weak", () => {
      const addresses = deriveConsultedAddresses({
        toolName: "mcp__plugin_claude-mnemo_mnemo__recall",
        toolInput: '{"query":"retry watchdog"}',
        toolResult: "S12/T3 fix the watchdog\nS12/T9 measure the retries",
      });

      expect(addresses).toEqual([
        { kind: "turn", sessionId: 12, promptNumber: 3, strength: "weak" },
        { kind: "turn", sessionId: 12, promptNumber: 9, strength: "weak" },
      ]);
    });

    test("an id named in the selector is a strong hit", () => {
      const addresses = deriveConsultedAddresses({
        toolName: "mcp__mnemo__recall",
        toolInput: '{"id":"S12/T3"}',
        toolResult: "S12/T3 fix the watchdog",
      });

      expect(addresses[0]).toEqual({
        kind: "turn",
        sessionId: 12,
        promptNumber: 3,
        strength: "strong",
      });
    });

    test("an expanded read makes even the result hits strong", () => {
      const addresses = deriveConsultedAddresses({
        toolName: "mcp__mnemo__recall",
        toolInput: '{"query":"watchdog","depth":"expanded"}',
        toolResult: "S12/T3 fix the watchdog",
      });

      expect(addresses).toEqual([
        { kind: "turn", sessionId: 12, promptNumber: 3, strength: "strong" },
      ]);
    });

    test("session and observation addresses keep their own layer", () => {
      const addresses = deriveConsultedAddresses({
        toolName: "mcp__mnemo__timeline",
        toolInput: '{"id":"S12"}',
        toolResult: "S12/T3/O77 Bash",
      });

      expect(addresses).toEqual([
        { kind: "session", sessionId: 12, strength: "strong" },
        { kind: "observation", observationId: 77, strength: "weak" },
      ]);
    });

    test("a replay read through the bundled CLI is a strong raw-level hit", () => {
      const addresses = deriveConsultedAddresses({
        toolName: "Bash",
        toolInput:
          '{"command":"\\"$CLAUDE_PLUGIN_ROOT/scripts/turn-detail.sh\\" S12 3 --full"}',
        toolResult: "{\"turn\": {}}",
      });

      expect(addresses).toEqual([
        { kind: "turn", sessionId: 12, promptNumber: 3, strength: "strong" },
      ]);
    });

    test("unrelated tool calls record nothing", () => {
      expect(
        deriveConsultedAddresses({
          toolName: "Bash",
          toolInput: '{"command":"grep -rn S12/T3 src/"}',
          toolResult: "src/foo.ts: S12/T3",
        }),
      ).toEqual([]);
      expect(
        deriveConsultedAddresses({
          toolName: "mcp__mnemo__remember",
          toolInput: '{"id":"T3"}',
          toolResult: "ok",
        }),
      ).toEqual([]);
    });
  });

  describe("recording", () => {
    test("resolves addresses to type-prefixed ids", () => {
      const cited = addTurn(2);
      const observationId = addObservation(cited);

      recordConsultedMemories(db, rideTurnId, [
        { kind: "turn", sessionId, promptNumber: 2, strength: "weak" },
        { kind: "session", sessionId, strength: "weak" },
        { kind: "observation", observationId, strength: "strong" },
      ]);

      expect(getConsultedMemories(db, rideTurnId)).toEqual([
        { ref: `obs:${observationId}`, strength: "strong" },
        { ref: `session:${sessionId}`, strength: "weak" },
        { ref: `turn:${cited}`, strength: "weak" },
      ]);
    });

    test("merges across calls and only ever upgrades strength", () => {
      const cited = addTurn(2);

      captureConsultedMemories(db, rideTurnId, {
        toolName: "mcp__mnemo__recall",
        toolInput: '{"query":"x"}',
        toolResult: `S${sessionId}/T2 something`,
      });
      expect(getConsultedMemories(db, rideTurnId)).toEqual([
        { ref: `turn:${cited}`, strength: "weak" },
      ]);

      captureConsultedMemories(db, rideTurnId, {
        toolName: "mcp__mnemo__recall",
        toolInput: `{"id":"S${sessionId}/T2","depth":"expanded"}`,
        toolResult: `S${sessionId}/T2 something`,
      });
      expect(getConsultedMemories(db, rideTurnId)).toEqual([
        { ref: `turn:${cited}`, strength: "strong" },
      ]);

      // A later collapsed list must not demote a turn that was read in full.
      captureConsultedMemories(db, rideTurnId, {
        toolName: "mcp__mnemo__recall",
        toolInput: '{"query":"x"}',
        toolResult: `S${sessionId}/T2 something`,
      });
      expect(getConsultedMemories(db, rideTurnId)).toEqual([
        { ref: `turn:${cited}`, strength: "strong" },
      ]);
    });

    test("drops unresolvable ids and never records a self-consultation", () => {
      captureConsultedMemories(db, rideTurnId, {
        toolName: "mcp__mnemo__recall",
        toolInput: '{"query":"x"}',
        toolResult: `S9999/T1 gone\nS${sessionId}/T1 this very turn`,
      });

      expect(getConsultedMemories(db, rideTurnId)).toEqual([]);
      expect(
        db
          .query<{ value: string | null }, [number]>(
            "SELECT consulted_memories AS value FROM turns WHERE id = ?",
          )
          .get(rideTurnId)?.value,
      ).toBeNull();
    });

    test("leaves the turn's updated_at clock alone", () => {
      const cited = addTurn(2);
      db.query("UPDATE turns SET updated_at_epoch = 500 WHERE id = ?").run(rideTurnId);

      recordConsultedMemories(db, rideTurnId, [
        { kind: "turn", sessionId, promptNumber: 2, strength: "weak" },
      ]);

      expect(
        db
          .query<{ updatedAtEpoch: number | null }, [number]>(
            "SELECT updated_at_epoch AS updatedAtEpoch FROM turns WHERE id = ?",
          )
          .get(rideTurnId)?.updatedAtEpoch,
      ).toBe(500);
      expect(getConsultedMemories(db, rideTurnId)).toEqual([
        { ref: `turn:${cited}`, strength: "weak" },
      ]);
    });
  });
});
