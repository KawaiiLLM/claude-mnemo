import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  buildTurnDirectRelationLines,
  buildTurnRelationTreeLines,
} from "../../src/mcp/relations-view";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { timelineQuery } from "../../src/mcp/timeline";
import { wordEdgeClass } from "../support/edge-row-fixtures";

/**
 * The `timeline(id="S<n>/T<m>")` NODE SELECTOR (island-view spec, ticket 13
 * decision 5) — the one surviving surface of that spec's timeline work. The
 * per-island lane TREES this file used to pin (`walkIslandSpine`,
 * `islandCoverage`, the shared node budget, `chooseContinuation`) were
 * DELETED with the greedy spine when frontier-injection ticket 04 replaced
 * the lane route's render with the ruled adjacency table — see
 * `tests/mcp/timeline.lane-adjacency.test.ts` for the successor coverage.
 */

const NOW = 1_755_000_000;

let db: Database;

function seedSession(label = "island-view"): number {
  return upsertSession(db, {
    contentSessionId: `${label}-${Math.random()}`,
    project: `/tmp/${label}`,
    title: label,
    content: null,
    insight: null,
    createdAtEpoch: NOW,
    updatedAtEpoch: NOW,
    completedAtEpoch: null,
  }).id;
}

function insertTurn(sessionId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, tags
       ) VALUES (?, ?, 'active', 'p', 'r', 1, ?, '["design"]', '[]')
       RETURNING id`,
    )
    .get(sessionId, promptNumber, NOW + promptNumber)!.id;
}

function tagEdge(citingId: number, citedId: number, relation: string, tags: readonly string[]): void {
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: citingId },
        cited: { kind: "turn", id: citedId },
        ...wordEdgeClass(relation),
        provenance: "asserted",
        ...deriveSideTags(tags),
      },
    ],
    NOW,
  );
}

beforeEach(() => {
  process.env.TZ = "UTC";
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

describe("timeline node selector (ticket 13 decision 5)", () => {
  test('timeline(id="S<n>/T<m>") keeps the 3-hop tree that left recall\'s relations field (spec D8, user story 17)', () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    const t3 = insertTurn(sessionId, 3);
    db.query<unknown, [string, number]>("UPDATE turns SET title = ? WHERE id = ?").run("root turn", t3);
    tagEdge(t3, t2, "extends", []);
    tagEdge(t2, t1, "narrows", []);

    const turn = getTurn(db, sessionId, 3)!;
    const expectedTreeLines = buildTurnRelationTreeLines(db, { id: turn.id, sessionId, promptNumber: 3 });

    const nodeOutput = timelineQuery(db, { id: `S${sessionId}/T3` });
    const bodyLines = nodeOutput.split("\n");
    // Header row: `S<n>/T<m> MM-DD <emoji> <title>` (unbracketed since ticket
    // 11, USER RULING S15069/T2016).
    expect(bodyLines[0]).toMatch(new RegExp(`^S${sessionId}/T3 \\d{2}-\\d{2} .+ root turn$`));
    // Everything after the header is exactly the TREE — modulo the header,
    // byte-identical to `buildTurnRelationTreeLines`.
    const treeBody = bodyLines.slice(1).join("\n");
    expect(treeBody).toBe(expectedTreeLines.join("\n"));
    // The tree's own two capabilities, both still here: the labelled arrow
    // and the transitive hop past the root's immediate target.
    // main-agent-edges ticket 07: the label is the row's CLASS, on the tree
    // exactly as in `recall`'s own field.
    expect(treeBody).toContain("-use-> T2");
    expect(treeBody).toContain("-correct(partial)-> T1");

    // Settlement-read-once spec D8: `recall`'s `relations` field on the SAME
    // turn is now the DIRECT set — one row, the immediate out-edge, in the
    // other grammar. The two surfaces diverged deliberately; a change that
    // re-pointed either one at the other's builder would land here.
    const direct = buildTurnDirectRelationLines(db, { id: turn.id, sessionId, promptNumber: 3 });
    expect(direct).toEqual(["use -> T2 (none)"]);
    expect(treeBody).not.toBe(direct.join("\n"));
  });

  test("an invalid turn address still errors with the existing id-grammar message shape", () => {
    const sessionId = seedSession();
    insertTurn(sessionId, 1);
    // Malformed grammar (not the clean `S<n>/T<m>` the node selector matches)
    // falls through to the pre-existing route and its established error.
    const malformed = timelineQuery(db, { id: `S${sessionId}/Tabc` });
    expect(malformed).toContain("timeline error:");
    expect(malformed).toContain("range syntax not recognized");
  });

  test("a syntactically legal but nonexistent turn address errors clearly, not silently", () => {
    const sessionId = seedSession();
    insertTurn(sessionId, 1);
    const missing = timelineQuery(db, { id: `S${sessionId}/T999` });
    expect(missing).toContain("timeline error:");
    expect(missing).toContain("not found");
  });
});
