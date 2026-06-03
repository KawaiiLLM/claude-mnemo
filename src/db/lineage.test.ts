import { expect, test } from "bun:test";

import { createDatabase } from "./database";
import { initializeSchema } from "./schema";
import { upsertSession } from "./sessions";
import { classifyPromptOwnership } from "./lineage";

test("classifies foreign / child / unknown by content_prompt_id ownership", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const parent = upsertSession(db, {
    contentSessionId: "parent",
    project: "p",
    title: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  }).id;

  const child = upsertSession(db, {
    contentSessionId: "child",
    project: "p",
    title: null,
    insight: null,
    createdAtEpoch: 2,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  }).id;

  const insert = db.query<
    { id: number },
    [number, number, string, string | null, string | null, string | null]
  >(
    `INSERT INTO turns (session_id, prompt_number, status, assistant_response, title, content, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, 1000)
     RETURNING id`,
  );

  // Turn in parent session with content_prompt_id = "pX"
  const pTurn = insert.get(parent, 1, "active", "r", null, null)!.id;
  db.query("UPDATE turns SET content_prompt_id = 'pX' WHERE id = ?").run(pTurn);

  // Turn in child session with content_prompt_id = "cY"
  const cTurn = insert.get(child, 1, "active", "r", null, null)!.id;
  db.query("UPDATE turns SET content_prompt_id = 'cY' WHERE id = ?").run(cTurn);

  const map = classifyPromptOwnership(db, child, ["pX", "cY", "pZ"]);

  expect(map.get("pX")?.ownership).toBe("foreign");
  expect(map.get("cY")?.ownership).toBe("child");
  expect(map.get("pZ")?.ownership).toBe("unknown");
  expect(map.get("pX")?.owners).toEqual([
    { sessionId: parent, turnId: pTurn, promptNumber: 1 },
  ]);
});
