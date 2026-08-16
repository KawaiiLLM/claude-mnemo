import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { initializeSchema } from "../../src/db/schema";

/**
 * A small sandbox database for the P1 metrics tools.
 *
 * Written with raw SQL on purpose: the fixture has to be able to express states
 * the production writers would refuse (a debt already aged, a note whose debt
 * row was never opened), and going through the writers would make the fixture a
 * test of the writers instead of the readers under test. Always a fresh temp
 * file — nothing here can reach ~/.claude-mnemo.
 */

export const LONG_RESPONSE =
  "Ran the migration against the staging copy, then compared row counts per table " +
  "before promoting anything: the diff is empty and the checksum matches the source.";
export const PREFIX_SOURCE =
  "Traced the stall to the watchdog reading a frozen timestamp, so it classified " +
  "an idle connection as a stall and resumed the session in an unbounded loop here.";
export const PREFIX_TRUNCATED = PREFIX_SOURCE.slice(0, 100);
export const OTHER_RESPONSE =
  "Read the four candidate files and none of them registers the hook, so the entry " +
  "point must be somewhere in the plugin manifest instead of the source tree.";

export const DUPLICATE_LEGACY_TITLE = "fix+watchdog: stall classification corrected";
export const DUPLICATE_LEGACY_CONTENT =
  "The frozen-timestamp watchdog misread an idle connection as a stall, which drove " +
  "an unbounded resume loop; replaced with an activity watchdog and a hard-exit timer.";

export const SHADOW_TITLE_A = "measure+note-routing: fallback share 32% to 4%";
export const SHADOW_CONTENT_A =
  "User correction: turns without a tool batch queue for a later one instead of " +
  "falling back to the subagent [S1/T3]. Measured on 10,174 turns.\n\nDeferral wins.";
export const LEGACY_TITLE_A = "note routing decision";
export const LEGACY_CONTENT_A =
  "- decided to queue turns without a tool batch\n- rejected the subagent fallback\n" +
  "- see [T3] for the measurement that settled it";

export const SHADOW_TITLE_B = "implement+ledger: debt rows close on note write";
export const SHADOW_CONTENT_B =
  "Closing a debt is idempotent because the ledger keys on turn_id, so a repeated " +
  "reconcile is a no-op rather than a second row; rejected a status column on turns.";
export const LEGACY_TITLE_B = "ledger implementation";
export const LEGACY_CONTENT_B =
  "Added note_debt with turn_id as the primary key so reconciliation is idempotent " +
  "and the legacy pipeline keeps sole ownership of the turns table and its status.";

export interface FixtureIds {
  path: string;
  sessionA: number;
  sessionB: number;
  sessionC: number;
  turns: Record<string, number>;
}

interface TurnInput {
  session: number;
  promptNumber: number;
  userPrompt?: string;
  assistantResponse?: string | null;
  title?: string | null;
  content?: string | null;
  wasRolledBack?: boolean;
  wasInterrupted?: boolean;
  tools?: { name: string; excluded?: boolean }[];
}

export function createFixtureDatabase(): FixtureIds {
  const directory = mkdtempSync(join(tmpdir(), "p1-metrics-"));
  const path = join(directory, "memory.db");
  const db = new Database(path, { create: true });
  initializeSchema(db);

  const insertSession = (contentSessionId: string): number =>
    db
      .query<{ id: number }, [string]>(
        `INSERT INTO sessions (content_session_id, project, created_at_epoch)
         VALUES (?, 'p1-fixture', 1000) RETURNING id`,
      )
      .get(contentSessionId)!.id;

  const sessionA = insertSession("sess-a");
  const sessionB = insertSession("sess-b");
  const sessionC = insertSession("sess-c");

  const turns: Record<string, number> = {};

  const addTurn = (key: string, input: TurnInput): number => {
    const id = db
      .query<
        { id: number },
        [number, number, string, string | null, string | null, string | null, number, number]
      >(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           title, content, was_rolled_back, was_interrupted, created_at_epoch
         ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, 1000)
         RETURNING id`,
      )
      .get(
        input.session,
        input.promptNumber,
        input.userPrompt ?? `prompt ${input.promptNumber}`,
        input.assistantResponse ?? null,
        input.title ?? null,
        input.content ?? null,
        input.wasRolledBack ? 1 : 0,
        input.wasInterrupted ? 1 : 0,
      )!.id;

    for (const tool of input.tools ?? []) {
      db.query<unknown, [number, string, number]>(
        `INSERT INTO observations (
           turn_id, tool_name, status, excluded_from_extraction, created_at_epoch
         ) VALUES (?, ?, 'pending', ?, 1000)`,
      ).run(id, tool.name, tool.excluded ? 1 : 0);
    }

    turns[key] = id;
    return id;
  };

  const addNote = (
    turnId: number,
    note: {
      title: string;
      content: string;
      insight?: string | null;
      writerModel?: string | null;
      rideTurnId?: number | null;
    },
  ): void => {
    db.query<unknown, [number, string, string, string | null, string | null, number | null]>(
      `INSERT INTO shadow_notes (
         turn_id, title, content, insight, writer_model, ride_turn_id,
         created_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, ?, ?, ?, 1000, 1000)`,
    ).run(
      turnId,
      note.title,
      note.content,
      note.insight ?? null,
      note.writerModel ?? null,
      note.rideTurnId ?? null,
    );
  };

  const addDebt = (
    turnId: number,
    sessionId: number,
    promptNumber: number,
    status: "pending" | "noted" | "skipped",
    reason?: "aged" | "rolled-back",
  ): void => {
    db.query<unknown, [number, number, number, string, string | null]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status, reason,
         opened_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, ?, ?, 1000, 1000)`,
    ).run(turnId, sessionId, promptNumber, status, reason ?? null);
  };

  const expose = (
    sessionId: number,
    rideTurnId: number,
    exposedTurnId: number,
  ): void => {
    // Epoch 2000, strictly AFTER every turn (all seeded at 1000). This
    // fixture models the reminder era, where the ledger is the only exposure
    // signal, so every one of its turns must sit before the ledger's freeze —
    // otherwise `wasExposed` reads them as post-freeze and `unreached`, the
    // outcome three of these tests exist to exercise, becomes unreachable.
    // The whole fixture previously shared one epoch, which made that
    // distinction invisible rather than merely wrong.
    db.query<unknown, [number, number, number]>(
      `INSERT INTO note_id_exposures (
         session_id, ride_turn_id, exposed_turn_id, source, created_at_epoch
       ) VALUES (?, ?, ?, 'reminder', 2000)`,
    ).run(sessionId, rideTurnId, exposedTurnId);
  };

  // ---- session A: every debt outcome, 7 turns -----------------------------
  const a1 = addTurn("a1", {
    session: sessionA,
    promptNumber: 1,
    title: LEGACY_TITLE_A,
    content: LEGACY_CONTENT_A,
    tools: [
      { name: "Read" },
      { name: "Edit" },
      { name: "Bash" },
      { name: "mcp__plugin_claude-mnemo_mnemo__note", excluded: true },
    ],
  });
  const a2 = addTurn("a2", {
    session: sessionA,
    promptNumber: 2,
    tools: [{ name: "Read" }],
  });
  const a3 = addTurn("a3", {
    session: sessionA,
    promptNumber: 3,
    title: DUPLICATE_LEGACY_TITLE,
    content: DUPLICATE_LEGACY_CONTENT,
    tools: Array.from({ length: 8 }, () => ({ name: "Bash" })),
  });
  const a4 = addTurn("a4", {
    session: sessionA,
    promptNumber: 4,
    title: DUPLICATE_LEGACY_TITLE,
    content: DUPLICATE_LEGACY_CONTENT,
    tools: [{ name: "Read" }, { name: "Grep" }],
  });
  const a5 = addTurn("a5", {
    session: sessionA,
    promptNumber: 5,
    wasRolledBack: true,
    tools: [{ name: "Bash" }],
  });
  const a6 = addTurn("a6", { session: sessionA, promptNumber: 6 });
  const a7 = addTurn("a7", {
    session: sessionA,
    promptNumber: 7,
    title: "ops+cleanup: pruned the stale worktrees",
    content: null,
    tools: [{ name: "Read" }],
  });

  addNote(a1, {
    title: SHADOW_TITLE_A,
    content: SHADOW_CONTENT_A,
    insight: "readonly URI beats a careful query habit",
    writerModel: "claude-opus-5",
    rideTurnId: a2,
  });
  addNote(a6, { title: "chat+status: answered without tools", content: "No tools ran." });
  addNote(a7, {
    title: "ops+cleanup: pruned the stale worktrees",
    content: "Removed three worktrees whose branches were merged.",
    rideTurnId: a7,
  });

  addDebt(a1, sessionA, 1, "noted");
  addDebt(a2, sessionA, 2, "pending");
  addDebt(a3, sessionA, 3, "skipped", "aged");
  addDebt(a4, sessionA, 4, "skipped", "aged");
  addDebt(a5, sessionA, 5, "skipped", "rolled-back");
  addDebt(a7, sessionA, 7, "noted");

  expose(sessionA, a2, a1);
  expose(sessionA, a3, a2);
  expose(sessionA, a5, a3);

  // ---- session B: 30 turns, the duplicate-text cases ----------------------
  const b1 = addTurn("b1", {
    session: sessionB,
    promptNumber: 1,
    title: LEGACY_TITLE_B,
    content: LEGACY_CONTENT_B,
    tools: [{ name: "Read" }, { name: "Edit" }],
  });
  const b2 = addTurn("b2", { session: sessionB, promptNumber: 2 });

  for (let promptNumber = 3; promptNumber <= 30; promptNumber += 1) {
    const key = `b${promptNumber}`;
    if (promptNumber === 10) {
      addTurn(key, {
        session: sessionB,
        promptNumber,
        assistantResponse: LONG_RESPONSE,
      });
    } else if (promptNumber === 11) {
      addTurn(key, {
        session: sessionB,
        promptNumber,
        assistantResponse: LONG_RESPONSE,
        wasRolledBack: true,
      });
    } else if (promptNumber === 20) {
      addTurn(key, {
        session: sessionB,
        promptNumber,
        assistantResponse: PREFIX_SOURCE,
      });
    } else if (promptNumber === 21) {
      addTurn(key, {
        session: sessionB,
        promptNumber,
        assistantResponse: PREFIX_TRUNCATED,
      });
    } else if (promptNumber === 22) {
      addTurn(key, {
        session: sessionB,
        promptNumber,
        assistantResponse: OTHER_RESPONSE,
      });
    } else {
      addTurn(key, { session: sessionB, promptNumber });
    }
  }

  addNote(b1, {
    title: SHADOW_TITLE_B,
    content: SHADOW_CONTENT_B,
    writerModel: "claude-sonnet-5",
    rideTurnId: b2,
  });
  addDebt(b1, sessionB, 1, "noted");

  // ---- session C: a debt past the aging bound, still marked pending -------
  const c1 = addTurn("c1", {
    session: sessionC,
    promptNumber: 1,
    tools: [{ name: "Read" }],
  });
  const c60 = addTurn("c60", { session: sessionC, promptNumber: 60 });
  addDebt(c1, sessionC, 1, "pending");
  expose(sessionC, c60, c1);

  db.close();

  return { path, sessionA, sessionB, sessionC, turns };
}
