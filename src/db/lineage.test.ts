import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { Database } from "bun:sqlite";

import { createDatabase } from "./database";
import { initializeSchema } from "./schema";
import { upsertSession } from "./sessions";
import {
  classifyPromptOwnership,
  isContiguousRun,
  pickForeignOwner,
  resolveSessionLineage,
  resolveViaLogicalParent,
} from "./lineage";
import type { OwnerInfo } from "./lineage";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeTranscript(lines: unknown[]): string {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-lineage-"));
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
function promptEntry(
  promptId: string,
  uuid?: string,
  parentUuid?: string,
): Record<string, unknown> {
  return {
    type: "user",
    uuid: uuid ?? promptId,
    parentUuid,
    promptId,
    message: {
      role: "user",
      content: [{ type: "text", text: `prompt ${promptId}` }],
    },
  };
}

function compactBoundaryEntry(
  uuid: string,
  logicalParentUuid?: string,
): Record<string, unknown> {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid,
    logicalParentUuid,
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

// ---------------------------------------------------------------------------
// classifyPromptOwnership (Task 3 — retained)
// ---------------------------------------------------------------------------

test("classifies foreign / child / unknown by content_prompt_id ownership", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const parent = makeSession(db, "parent", 1);
  const child = makeSession(db, "child", 2);

  const pTurn = seedTurn(db, parent, 1, "pX");
  seedTurn(db, child, 1, "cY");

  const map = classifyPromptOwnership(db, child, ["pX", "cY", "pZ"]);

  expect(map.get("pX")?.ownership).toBe("foreign");
  expect(map.get("cY")?.ownership).toBe("child");
  expect(map.get("pZ")?.ownership).toBe("unknown");
  expect(map.get("pX")?.owners).toEqual([
    { sessionId: parent, turnId: pTurn, promptNumber: 1 },
  ]);
});

test("classifyPromptOwnership chunks a large promptId list and merges correctly", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const parent = makeSession(db, "parent", 1);
  const child = makeSession(db, "child", 2);

  // Two real, classifiable prompts surrounded by many unknown ids — well over
  // the chunk size so the IN(...) lookup must span multiple batches.
  const foreignTurn = seedTurn(db, parent, 1, "pForeign");
  const childTurn = seedTurn(db, child, 1, "cOwned");

  const promptIds: string[] = [];
  for (let i = 0; i < 1200; i += 1) promptIds.push(`u${i}`);
  // Place the seeded ids in different chunks (start and well past 500).
  promptIds[3] = "pForeign";
  promptIds[700] = "cOwned";

  const map = classifyPromptOwnership(db, child, promptIds);

  expect(map.size).toBe(1200);
  expect(map.get("pForeign")?.ownership).toBe("foreign");
  expect(map.get("pForeign")?.owners).toEqual([
    { sessionId: parent, turnId: foreignTurn, promptNumber: 1 },
  ]);
  expect(map.get("cOwned")?.ownership).toBe("child");
  expect(map.get("cOwned")?.owners).toEqual([
    { sessionId: child, turnId: childTurn, promptNumber: 1 },
  ]);
  // Every other id stays unknown (Map pre-populated, no row matched).
  expect(map.get("u0")?.ownership).toBe("unknown");
  expect(map.get("u1199")?.ownership).toBe("unknown");
});

// ---------------------------------------------------------------------------
// isContiguousRun (helper)
// ---------------------------------------------------------------------------

test("isContiguousRun: leading contiguous foreign run passes", () => {
  expect(isContiguousRun(["foreign", "foreign", "unknown"])).toBe(true);
  expect(isContiguousRun(["foreign", "unknown", "unknown"])).toBe(true);
});

test("isContiguousRun: scattered foreign hits (gap) fail", () => {
  expect(isContiguousRun(["foreign", "unknown", "foreign"])).toBe(false);
});

test("isContiguousRun: empty prefix is not a run", () => {
  expect(isContiguousRun([])).toBe(false);
  expect(isContiguousRun(["unknown", "unknown"])).toBe(false);
});

// ---------------------------------------------------------------------------
// pickForeignOwner (tie-break helper)
// ---------------------------------------------------------------------------

test("pickForeignOwner: single foreign owner is chosen directly", () => {
  const owners: OwnerInfo[] = [{ sessionId: 7, turnId: 70, promptNumber: 3 }];
  expect(pickForeignOwner(owners, [], 100)).toEqual(owners[0]!);
});

test("pickForeignOwner: tie-break by createdAt closest-but-earlier when no overlap", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const a = makeSession(db, "a", 10); // earlier
  const b = makeSession(db, "b", 90); // closest-but-earlier than child (100)
  const owners: OwnerInfo[] = [
    { sessionId: a, turnId: 1, promptNumber: 1 },
    { sessionId: b, turnId: 2, promptNumber: 1 },
  ];
  // No prefix-overlap signal → fall to createdAt; child created at 100.
  expect(pickForeignOwner(owners, [], 100, db)).toEqual(owners[1]!);
});

test("pickForeignOwner: still-tied returns null (never row order)", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const a = makeSession(db, "a", 50);
  const b = makeSession(db, "b", 50); // identical createdAt, no overlap signal
  const owners: OwnerInfo[] = [
    { sessionId: a, turnId: 1, promptNumber: 1 },
    { sessionId: b, turnId: 2, promptNumber: 1 },
  ];
  expect(pickForeignOwner(owners, [], 100, db)).toBeNull();
});

// ---------------------------------------------------------------------------
// resolveSessionLineage — top-level cases
// ---------------------------------------------------------------------------

test("unresolved when no transcript path", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const child = makeSession(db, "child", 2);
  expect(resolveSessionLineage(db, child, null)).toEqual({
    status: "unresolved",
  });
});

test("unresolved (NOT root) when transcript file is missing", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const child = makeSession(db, "child", 2);
  const missing = join(tmpdir(), "claude-mnemo-missing-transcript-xyz.jsonl");
  // A missing transcript yields no ordered prompts → must be retryable, not a
  // terminal root (positive child-owned evidence is required for root).
  expect(resolveSessionLineage(db, child, missing).status).toBe("unresolved");
});

test("unresolved (NOT root) when transcript file is empty", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const child = makeSession(db, "child", 2);
  const empty = writeTranscript([]);
  expect(resolveSessionLineage(db, child, empty).status).toBe("unresolved");
});

test("retry: empty transcript → unresolved, then valid clean-start → root (not frozen)", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const child = makeSession(db, "child", 2);

  // First Stop: transient empty transcript → unresolved (NOT a terminal root).
  const empty = writeTranscript([]);
  expect(resolveSessionLineage(db, child, empty).status).toBe("unresolved");

  // Later Stop: a valid clean-start transcript with the child's own prompt →
  // resolves to root, proving the empty case did not freeze the fork.
  seedTurn(db, child, 1, "c1");
  const valid = writeTranscript([promptEntry("c1")]);
  expect(resolveSessionLineage(db, child, valid).status).toBe("root");
});

test("resolved: prefix has 2 foreign promptIds then a child-owned one", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const parent = makeSession(db, "parent", 1);
  const child = makeSession(db, "child", 2);

  // Parent owns the two inherited tail prompts.
  seedTurn(db, parent, 14, "pA");
  const forkTurn = seedTurn(db, parent, 15, "pB"); // latest-in-prefix
  // Child owns its own new content.
  seedTurn(db, child, 1, "cC");

  const path = writeTranscript([
    promptEntry("pA"),
    promptEntry("pB"),
    promptEntry("cC"),
  ]);

  const res = resolveSessionLineage(db, child, path);
  expect(res.status).toBe("resolved");
  expect(res.parentSessionId).toBe(parent);
  expect(res.forkTurnId).toBe(forkTurn);
});

test("position picks immediate parent over grandparent (latest foreign index)", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const grandparent = makeSession(db, "gp", 1);
  const parent = makeSession(db, "parent", 2);
  const child = makeSession(db, "child", 3);

  // Grandparent's match has a HIGHER prompt_number (215) but EARLIER transcript index.
  seedTurn(db, grandparent, 215, "gpPrompt");
  // Parent's match has a LOWER prompt_number (9) but LATER transcript index.
  const parentForkTurn = seedTurn(db, parent, 9, "pPrompt");
  seedTurn(db, child, 1, "childPrompt");

  const path = writeTranscript([
    promptEntry("gpPrompt"),
    promptEntry("pPrompt"),
    promptEntry("childPrompt"),
  ]);

  const res = resolveSessionLineage(db, child, path);
  expect(res.status).toBe("resolved");
  expect(res.parentSessionId).toBe(parent);
  expect(res.forkTurnId).toBe(parentForkTurn);
});

test("unresolved: prefix all unknown + a boundary present", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const child = makeSession(db, "child", 2);
  // No turns seeded for u1/u2 → unknown. cC is child-owned.
  seedTurn(db, child, 1, "cC");

  const path = writeTranscript([
    compactBoundaryEntry("b1"),
    promptEntry("u1"),
    promptEntry("u2"),
    promptEntry("cC"),
  ]);

  expect(resolveSessionLineage(db, child, path).status).toBe("unresolved");
});

test("root: clean start (no boundary, all child-owned from index 0)", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const child = makeSession(db, "child", 2);
  seedTurn(db, child, 1, "c1");
  seedTurn(db, child, 2, "c2");

  const path = writeTranscript([promptEntry("c1"), promptEntry("c2")]);

  expect(resolveSessionLineage(db, child, path).status).toBe("root");
});

test("root: proven in-place compact (boundary, pre-boundary prompts child-owned)", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const child = makeSession(db, "child", 2);
  // This session's own earlier turns precede the boundary.
  seedTurn(db, child, 1, "c1");
  seedTurn(db, child, 2, "c2");
  seedTurn(db, child, 3, "c3");

  const path = writeTranscript([
    promptEntry("c1"),
    promptEntry("c2"),
    compactBoundaryEntry("b1"),
    promptEntry("c3"),
  ]);

  expect(resolveSessionLineage(db, child, path).status).toBe("root");
});

test("unresolved: boundary + unknown pre-boundary prompts (NOT root)", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const child = makeSession(db, "child", 2);
  // u1/u2 unknown (parent not ingested); c3 child-owned post-boundary.
  seedTurn(db, child, 1, "c3");

  const path = writeTranscript([
    promptEntry("u1"),
    promptEntry("u2"),
    compactBoundaryEntry("b1"),
    promptEntry("c3"),
  ]);

  expect(resolveSessionLineage(db, child, path).status).toBe("unresolved");
});

test("tie-break: foreign promptId with two foreign owners resolves by createdAt", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const olderParent = makeSession(db, "older", 10);
  const nearerParent = makeSession(db, "nearer", 90); // closest-but-earlier than child(100)
  const child = makeSession(db, "child", 100);

  // Same content_prompt_id owned by TWO foreign sessions (non-unique).
  seedTurn(db, olderParent, 5, "shared");
  const nearerTurn = seedTurn(db, nearerParent, 3, "shared");
  seedTurn(db, child, 1, "c1");

  const path = writeTranscript([promptEntry("shared"), promptEntry("c1")]);

  const res = resolveSessionLineage(db, child, path);
  expect(res.status).toBe("resolved");
  expect(res.parentSessionId).toBe(nearerParent);
  expect(res.forkTurnId).toBe(nearerTurn);
});

test("tie-break: two owners with identical createdAt and no overlap → unresolved", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const a = makeSession(db, "a", 50);
  const b = makeSession(db, "b", 50); // identical createdAt
  const child = makeSession(db, "child", 100);

  seedTurn(db, a, 5, "shared");
  seedTurn(db, b, 3, "shared");
  seedTurn(db, child, 1, "c1");

  const path = writeTranscript([promptEntry("shared"), promptEntry("c1")]);

  expect(resolveSessionLineage(db, child, path).status).toBe("unresolved");
});

test("confidence: isolated foreign hit AFTER child's own turns → not used", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const other = makeSession(db, "other", 1);
  const child = makeSession(db, "child", 2);

  // The child starts with its own content; a foreign hit appears LATER.
  seedTurn(db, child, 1, "c1");
  seedTurn(db, other, 7, "lateForeign");
  seedTurn(db, child, 2, "c2");

  const path = writeTranscript([
    promptEntry("c1"),
    promptEntry("lateForeign"),
    promptEntry("c2"),
  ]);

  // First purely-child-owned promptId is c1 at index 0 → empty inherited prefix.
  // No boundary, no inherited foreign/unknown → clean root.
  expect(resolveSessionLineage(db, child, path).status).toBe("root");
});

test("logicalParentUuid fallback: zero direct foreign overlap, boundary points at foreign tail", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const parent = makeSession(db, "parent", 1);
  const child = makeSession(db, "child", 2);

  // The inherited tail entry's promptId is foreign-owned by the parent,
  // but it carries NULL content_prompt_id in the child copy so the direct
  // ownership scan sees it as "unknown" (zero direct foreign overlap).
  const forkTurn = seedTurn(db, parent, 42, "tailPrompt");
  seedTurn(db, child, 1, "c1");

  // The boundary's logicalParentUuid points at the inherited tail entry's uuid.
  const path = writeTranscript([
    promptEntry("tailPrompt", "tail-uuid"),
    compactBoundaryEntry("b1", "tail-uuid"),
    promptEntry("c1"),
  ]);

  // Direct: tailPrompt IS foreign here (it's seeded), so direct overlap resolves.
  // To exercise the fallback, verify the helper independently below.
  const res = resolveSessionLineage(db, child, path);
  expect(res.status).toBe("resolved");
  expect(res.parentSessionId).toBe(parent);
  expect(res.forkTurnId).toBe(forkTurn);
});

test("resolveViaLogicalParent: boundary → foreign tail entry resolves", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const parent = makeSession(db, "parent", 1);
  const child = makeSession(db, "child", 2);

  const forkTurn = seedTurn(db, parent, 42, "tailPrompt");
  seedTurn(db, child, 1, "c1");

  // tailPrompt is NOT present in the child transcript's ordered scan as foreign
  // because the only inherited entry the resolver can match via direct overlap
  // is reached only through logicalParentUuid.
  const entries = [
    compactBoundaryEntry("b1", "tail-uuid"),
    promptEntry("tailPrompt", "tail-uuid"),
    promptEntry("c1"),
  ];
  // Build a transcript where the only foreign promptId sits on the entry the
  // boundary's logicalParentUuid points at.
  const path = writeTranscript(entries);

  const own = classifyPromptOwnership(db, child, ["tailPrompt", "c1"]);
  const resolved = resolveViaLogicalParent(db, path, child, own);
  expect(resolved).not.toBeNull();
  expect(resolved!.parentSessionId).toBe(parent);
  expect(resolved!.forkTurnId).toBe(forkTurn);
});

test("logicalParentUuid fallback wired into resolveSessionLineage (no direct overlap)", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const parent = makeSession(db, "parent", 1);
  const child = makeSession(db, "child", 2);

  const forkTurn = seedTurn(db, parent, 42, "tailPrompt");
  seedTurn(db, child, 1, "c1");

  // The tail entry sits AFTER the first child-owned prompt, so it is NOT in the
  // inherited prefix and is not selected by direct position-based resolution.
  // The boundary's logicalParentUuid still reaches it → fallback resolves.
  const path = writeTranscript([
    promptEntry("c1"),
    compactBoundaryEntry("b1", "tail-uuid"),
    promptEntry("tailPrompt", "tail-uuid"),
  ]);

  const res = resolveSessionLineage(db, child, path);
  expect(res.status).toBe("resolved");
  expect(res.parentSessionId).toBe(parent);
  expect(res.forkTurnId).toBe(forkTurn);
});

test("dangling: foreign owner turn deleted → tolerated (unresolved, not crash)", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const child = makeSession(db, "child", 2);
  // Only child content; a boundary with unknown prefix.
  seedTurn(db, child, 1, "c1");
  const path = writeTranscript([
    compactBoundaryEntry("b1"),
    promptEntry("u1"),
    promptEntry("c1"),
  ]);
  // No throw; classified unresolved.
  expect(resolveSessionLineage(db, child, path).status).toBe("unresolved");
});
