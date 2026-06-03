import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import {
  linkIntraSessionChain,
  relinkSessionLineage,
} from "../../src/db/lineage";

test("Step A chains turns by prompt_number, skips first turn, idempotent", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const s = upsertSession(db, {
    contentSessionId: "s",
    project: "p",
    title: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  }).id;

  const insert = db.query<{ id: number }, [number, number]>(
    `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
     VALUES (?, ?, 'active', 1000)
     RETURNING id`,
  );

  const t1 = insert.get(s, 1)!.id;
  const t2 = insert.get(s, 2)!.id;
  const t3 = insert.get(s, 3)!.id;

  linkIntraSessionChain(db, s);

  expect(getTurnById(db, t1)!.parentTurnId).toBeNull();  // first turn untouched
  expect(getTurnById(db, t2)!.parentTurnId).toBe(t1);
  expect(getTurnById(db, t3)!.parentTurnId).toBe(t2);

  const t4 = insert.get(s, 4)!.id;
  linkIntraSessionChain(db, s);                          // re-run after append

  expect(getTurnById(db, t4)!.parentTurnId).toBe(t3);

  // idempotent: re-running doesn't change existing links
  linkIntraSessionChain(db, s);
  expect(getTurnById(db, t2)!.parentTurnId).toBe(t1);
  expect(getTurnById(db, t3)!.parentTurnId).toBe(t2);
  expect(getTurnById(db, t4)!.parentTurnId).toBe(t3);

  // first turn stays null across all re-runs
  expect(getTurnById(db, t1)!.parentTurnId).toBeNull();
});

// ===========================================================================
// relinkSessionLineage — orchestrator (Step A + Step B, 4-state lineage_status)
// ===========================================================================

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeTranscript(lines: unknown[]): string {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-relink-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );
  return path;
}

// A promptId-bearing user entry for the child transcript.
function promptEntry(promptId: string): Record<string, unknown> {
  return {
    type: "user",
    uuid: promptId,
    promptId,
    message: {
      role: "user",
      content: [{ type: "text", text: `prompt ${promptId}` }],
    },
  };
}

function compactBoundaryEntry(uuid: string): Record<string, unknown> {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid,
  };
}

function makeSession(
  db: Database,
  contentSessionId: string,
  createdAtEpoch: number,
): number {
  return upsertSession(db, {
    contentSessionId,
    project: "p",
    title: null,
    insight: null,
    createdAtEpoch,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  }).id;
}

const insertTurnSql = `INSERT INTO turns (session_id, prompt_number, status, assistant_response, title, content, created_at_epoch)
   VALUES (?, ?, 'active', 'r', NULL, NULL, 1000)
   RETURNING id`;

// Seed a turn with a content_prompt_id; returns its turn id.
function seedTurn(
  db: Database,
  sessionId: number,
  promptNumber: number,
  contentPromptId: string,
): number {
  const id = db
    .query<{ id: number }, [number, number]>(insertTurnSql)
    .get(sessionId, promptNumber)!.id;
  db.query("UPDATE turns SET content_prompt_id = ? WHERE id = ?").run(
    contentPromptId,
    id,
  );
  return id;
}

const NOW = 9999;

// 1. resolved -------------------------------------------------------------

test("relink resolved: writes first-turn edge + parent + status atomically", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const parent = makeSession(db, "parent", 1);
  const child = makeSession(db, "child", 2);

  // Parent owns the inherited prefix prompts; latest-in-prefix is the fork turn.
  seedTurn(db, parent, 14, "pA");
  const forkTurn = seedTurn(db, parent, 15, "pB");
  // Child's own first turn.
  const childFirst = seedTurn(db, child, 1, "cC");

  const path = writeTranscript([
    promptEntry("pA"),
    promptEntry("pB"),
    promptEntry("cC"),
  ]);

  relinkSessionLineage(db, child, path, NOW);

  expect(getTurnById(db, childFirst)!.parentTurnId).toBe(forkTurn);
  const session = getSession(db, child)!;
  expect(session.parentSessionId).toBe(parent);
  expect(session.lineageStatus).toBe("resolved");
});

// 2. root -----------------------------------------------------------------

test("relink root: clean start → root, parent null, first-turn parent null", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const child = makeSession(db, "child", 2);
  const childFirst = seedTurn(db, child, 1, "c1");
  seedTurn(db, child, 2, "c2");

  const path = writeTranscript([promptEntry("c1"), promptEntry("c2")]);

  relinkSessionLineage(db, child, path, NOW);

  const session = getSession(db, child)!;
  expect(session.lineageStatus).toBe("root");
  expect(session.parentSessionId).toBeNull();
  expect(getTurnById(db, childFirst)!.parentTurnId).toBeNull();
});

// 3. unresolved + retry ---------------------------------------------------

test("relink unresolved then retry transitions to resolved with edge written", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const child = makeSession(db, "child", 5);
  const childFirst = seedTurn(db, child, 1, "cC");

  // Prefix is all-unknown (parent turns not seeded yet) + a boundary present.
  const path = writeTranscript([
    compactBoundaryEntry("b1"),
    promptEntry("pA"),
    promptEntry("pB"),
    promptEntry("cC"),
  ]);

  relinkSessionLineage(db, child, path, NOW);

  // First pass: unresolved, no edge, no parent.
  expect(getSession(db, child)!.lineageStatus).toBe("unresolved");
  expect(getSession(db, child)!.parentSessionId).toBeNull();
  expect(getTurnById(db, childFirst)!.parentTurnId).toBeNull();

  // Now the parent gets ingested.
  const parent = makeSession(db, "parent", 1);
  seedTurn(db, parent, 14, "pA");
  const forkTurn = seedTurn(db, parent, 15, "pB");

  // Retry: unresolved is retryable → transitions to resolved.
  relinkSessionLineage(db, child, path, NOW + 1);

  const session = getSession(db, child)!;
  expect(session.lineageStatus).toBe("resolved");
  expect(session.parentSessionId).toBe(parent);
  expect(getTurnById(db, childFirst)!.parentTurnId).toBe(forkTurn);
});

// 4. terminal -------------------------------------------------------------

test("relink terminal: once resolved, a later call does not re-resolve", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const parent = makeSession(db, "parent", 1);
  const child = makeSession(db, "child", 2);

  seedTurn(db, parent, 14, "pA");
  const forkTurn = seedTurn(db, parent, 15, "pB");
  const childFirst = seedTurn(db, child, 1, "cC");

  const path = writeTranscript([
    promptEntry("pA"),
    promptEntry("pB"),
    promptEntry("cC"),
  ]);

  relinkSessionLineage(db, child, path, NOW);
  expect(getSession(db, child)!.lineageStatus).toBe("resolved");
  expect(getSession(db, child)!.parentSessionId).toBe(parent);

  // A different parent is now seeded; transcript arg points at a DIFFERENT
  // foreign prefix. A terminal session must NOT re-resolve.
  const otherParent = makeSession(db, "other", 3);
  seedTurn(db, otherParent, 99, "oA");
  const otherPath = writeTranscript([promptEntry("oA"), promptEntry("cC")]);

  relinkSessionLineage(db, child, otherPath, NOW + 1);

  // parentSessionId stays pinned to the original parent; status stays resolved.
  expect(getSession(db, child)!.parentSessionId).toBe(parent);
  expect(getSession(db, child)!.lineageStatus).toBe("resolved");
  expect(getTurnById(db, childFirst)!.parentTurnId).toBe(forkTurn);
});

test("relink terminal: once root, a later call does not re-resolve", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const child = makeSession(db, "child", 2);
  const childFirst = seedTurn(db, child, 1, "c1");

  const cleanPath = writeTranscript([promptEntry("c1")]);
  relinkSessionLineage(db, child, cleanPath, NOW);
  expect(getSession(db, child)!.lineageStatus).toBe("root");

  // A foreign prefix now exists; root is terminal so it must not flip.
  const parent = makeSession(db, "parent", 1);
  seedTurn(db, parent, 9, "pA");
  const forkPath = writeTranscript([promptEntry("pA"), promptEntry("c1")]);
  relinkSessionLineage(db, child, forkPath, NOW + 1);

  const session = getSession(db, child)!;
  expect(session.lineageStatus).toBe("root");
  expect(session.parentSessionId).toBeNull();
  expect(getTurnById(db, childFirst)!.parentTurnId).toBeNull();
});

// 5. atomic ---------------------------------------------------------------

test("relink atomic: resolved outcome writes all three together", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const parent = makeSession(db, "parent", 1);
  const child = makeSession(db, "child", 2);

  const forkTurn = seedTurn(db, parent, 15, "pB");
  const childFirst = seedTurn(db, child, 1, "cC");

  const path = writeTranscript([promptEntry("pB"), promptEntry("cC")]);

  relinkSessionLineage(db, child, path, NOW);

  const session = getSession(db, child)!;
  const first = getTurnById(db, childFirst)!;

  const edgeWritten = first.parentTurnId === forkTurn;
  const parentWritten = session.parentSessionId === parent;
  const statusResolved = session.lineageStatus === "resolved";

  expect(edgeWritten).toBe(true);
  expect(parentWritten).toBe(true);
  expect(statusResolved).toBe(true);

  // Invariant: resolved ⇒ all three present; never edge-without-parent or
  // parent-without-status.
  if (statusResolved) {
    expect(parentWritten).toBe(true);
    expect(edgeWritten).toBe(true);
  }
});
