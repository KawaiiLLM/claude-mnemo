import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { RELATIONS_FIELD_LEGEND } from "../../src/mcp/relations-view";
import { recallMemory, recallMemoryDelivery } from "../../src/mcp/recall";
import { saveTurnFixture as saveTurn } from "../support/turn-fixtures";

/**
 * Settlement-read-once spec D8's OUTER assembly. The renderer's own job ends
 * at one turn's lines; three facts about a whole RESPONSE are this layer's:
 *
 *   1. one session header per session GROUP, however many addresses named
 *      turns of that session;
 *   2. the `relations` legend once per response, never once per turn block;
 *   3. every per-turn ledger end-offset preserved — the grouped list credits
 *      exactly the turns a comma list of the same addresses credited when it
 *      rendered them one at a time, and an envelope cut mid-list still
 *      credits only the blocks that survived it.
 *
 * (3) is the one with teeth: grouping moves bytes, and a ledger that marked
 * per ITEM instead of per TURN would silently start granting a turn whose
 * block the envelope removed.
 */
describe("the relations response is assembled once (spec D8 outer assembly)", () => {
  let db: Database;
  let sessionA: number;
  let sessionB: number;

  const NOW = 810_000;
  const FIELDS = ["title", "relations"] as const;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionA = upsertSession(db, {
      contentSessionId: "outer-a",
      project: "claude-mnemo",
      title: "session A",
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    sessionB = upsertSession(db, {
      contentSessionId: "outer-b",
      project: "claude-mnemo",
      title: "session B",
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    for (const [session, prompts] of [
      [sessionA, [1, 2, 3]],
      [sessionB, [7]],
    ] as const) {
      for (const promptNumber of prompts) {
        saveTurn(db, {
          sessionId: session,
          promptNumber,
          userPrompt: `p${promptNumber}`,
          assistantResponse: `r${promptNumber}`,
          title: `turn ${promptNumber}`,
          content: `c${promptNumber}`,
          insight: null,
          type: "decision",
          tags: [],
          filesRead: [],
          filesModified: [],
          createdAtEpoch: NOW + promptNumber,
          updatedAtEpoch: NOW + promptNumber,
          observations: [],
        });
      }
    }

    // main-agent-edges D2: a stored side tag resolves against the endpoint's
    // OWN lanes, so the fixture declares the lane and places both endpoints in
    // it — otherwise the two declarations would read as `invalid`, which is a
    // different test's subject.
    const taskId = createSegment(db, { title: "outer task", nowEpoch: NOW }).id;
    insertLane(db, taskId, "lane-a", NOW);
    insertLane(db, taskId, "lane-b", NOW);
    for (const promptNumber of [1, 3]) {
      const turnId = getTurn(db, sessionA, promptNumber)!.id;
      addSegmentMembers(db, taskId, [turnId], NOW);
      db.query("UPDATE turns SET tags = ? WHERE id = ?").run('["lane-a","lane-b"]', turnId);
    }

    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: getTurn(db, sessionA, 3)!.id },
          cited: { kind: "turn", id: getTurn(db, sessionA, 1)!.id },
          relation: "extends",
          provenance: "asserted",
          tailTag: "lane-a",
          headTag: "lane-a",
        },
      ],
      NOW,
    );
  });

  afterEach(() => {
    db.close();
  });

  const listId = () => `S${sessionA}/T1, S${sessionA}/T3, S${sessionB}/T7`;

  function grantedTurnIds(reader: string): number[] {
    return db
      .query<{ entityId: number }, [string]>(
        `SELECT DISTINCT entity_id AS entityId FROM write_gate_reads
         WHERE writer = ? AND entity_type = 'turn' ORDER BY entity_id ASC`,
      )
      .all(reader)
      .map((row) => row.entityId);
  }

  test("a three-address list prints one header per SESSION GROUP, not one per address", () => {
    const output = recallMemory(db, { id: listId(), filter: { fields: [...FIELDS] } });

    const headerLines = output
      .split("\n")
      .filter((line) => /^S\d+ session [AB]$/.test(line));
    expect(headerLines).toEqual([`S${sessionA} session A`, `S${sessionB} session B`]);
    // Both of session A's turns sit under that one header.
    expect(output).toContain("T1 turn 1");
    expect(output).toContain("T3 turn 3");
    expect(output).toContain("T7 turn 7");
  });

  test("the relations legend renders once for the whole response", () => {
    const output = recallMemory(db, { id: listId(), filter: { fields: [...FIELDS] } });

    expect(output.split(RELATIONS_FIELD_LEGEND)).toHaveLength(2);
    expect(output).toContain("use -> T1 (#lane-a declared)");
  });

  test("a response that did NOT select relations carries no legend", () => {
    const output = recallMemory(db, { id: listId(), filter: { fields: ["title"] } });
    expect(output).not.toContain("relations legend:");
  });

  test("an empty edge set still carries the legend — the caller asked what the field means", () => {
    const output = recallMemory(db, {
      id: `S${sessionB}/T7`,
      filter: { fields: [...FIELDS] },
    });
    expect(output).toContain("relations legend:");
  });

  test("a parameter error names no field and gets no legend", () => {
    const output = recallMemory(db, { id: "S1/T1, E9", filter: { fields: [...FIELDS] } });
    expect(output).toContain("mixed id kinds");
    expect(output).not.toContain("relations legend:");
  });

  // The before/after equality the ticket's outer-assembly box asks for. The
  // pre-D8 assembly rendered each address through its OWN `renderRoutedId`
  // call and shifted that item's offsets — which is exactly what three
  // separate single-address recalls still do. So the grants a per-item
  // assembly would record are the grants those three calls record, and the
  // grouped list must match them.
  test("grants after the grouping equal the grants the per-address reads earn", () => {
    for (const address of [`S${sessionA}/T1`, `S${sessionA}/T3`, `S${sessionB}/T7`]) {
      const perItem = recallMemoryDelivery(db, {
        id: address,
        filter: { fields: [...FIELDS] },
        readerId: "per-item",
        now: () => NOW,
      });
      perItem.commitDelivered(perItem.text.length);
    }

    const grouped = recallMemoryDelivery(db, {
      id: listId(),
      filter: { fields: [...FIELDS] },
      readerId: "grouped",
      now: () => NOW,
    });
    grouped.commitDelivered(grouped.text.length);

    expect(grantedTurnIds("grouped")).toEqual(grantedTurnIds("per-item"));
    expect(grantedTurnIds("grouped")).toHaveLength(3);
  });

  test("an envelope cut mid-list credits exactly the turn blocks that survived it", () => {
    const delivery = recallMemoryDelivery(db, {
      id: listId(),
      filter: { fields: [...FIELDS] },
      readerId: "cut",
      now: () => NOW,
    });
    // Cut at the start of session B's header: session A's two turn blocks are
    // whole inside the prefix, session B's turn is not.
    const cutAt = delivery.text.indexOf(`S${sessionB} session B`);
    expect(cutAt).toBeGreaterThan(0);
    delivery.commitDelivered(cutAt);

    expect(grantedTurnIds("cut")).toEqual([
      getTurn(db, sessionA, 1)!.id,
      getTurn(db, sessionA, 3)!.id,
    ]);
  });

  test("an address named twice is one block and one grant, not two", () => {
    const delivery = recallMemoryDelivery(db, {
      id: `S${sessionA}/T1, S${sessionA}/T1`,
      filter: { fields: [...FIELDS] },
      readerId: "dupe",
      now: () => NOW,
    });
    delivery.commitDelivered(delivery.text.length);

    expect(delivery.text.split("T1 turn 1")).toHaveLength(2);
    expect(grantedTurnIds("dupe")).toEqual([getTurn(db, sessionA, 1)!.id]);
  });
});
