import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase, runWriteTransaction } from "../../src/db/database";
import { loadEndpointLaneFacts } from "../../src/db/edge-side-resolution";
import { clearLane, insertLane, mergeLaneTag } from "../../src/db/lanes";
import { normalizeIncidentAttribution } from "../../src/db/normalize-incident-attribution";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment, writeMembershipTags } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { getFieldStamp } from "../../src/db/write-gate";

/**
 * THE ONE POST-NORMALISATION SEAM (main-agent-edges spec D2, pinned decision
 * P2). "A stored side means the endpoint is in several lanes" is an INVARIANT,
 * so every verb that moves an endpoint's lane set re-resolves what it touched,
 * atomically with the move.
 */
describe("normalizeIncidentAttribution", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;
  const NOW = 500;

  const addTurn = (promptNumber: number, tags: string[]): number =>
    db
      .query<{ id: number }, [number, number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', ?, '[]', ?)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, 100 + promptNumber, JSON.stringify(tags))!.id;

  const addEdge = (citingId: number, citedId: number, tailTag: string, headTag: string): number => {
    const row = db
      .query<{ id: number }, [number, number, string, string]>(
        `INSERT INTO memory_edges
           (citing_kind, citing_id, cited_kind, cited_id, relation, provenance,
            tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
         VALUES ('turn', ?, 'turn', ?, 'extends', 'asserted', ?, ?, 'use', '', 400)
         RETURNING id`,
      )
      .get(citingId, citedId, tailTag, headTag)!;
    for (const [side, tag] of [["tail", tailTag], ["head", headTag]] as const) {
      if (tag !== "") {
        db.query(
          `INSERT OR IGNORE INTO memory_edge_side_tags (edge_row_id, side, tag) VALUES (?, ?, ?)`,
        ).run(row.id, side, tag);
      }
    }
    return row.id;
  };

  const edgeRow = (id: number) =>
    db
      .query<{ tailTag: string; headTag: string }, [number]>(
        "SELECT tail_tag AS tailTag, head_tag AS headTag FROM memory_edges WHERE id = ?",
      )
      .get(id);
  const sideIndexRows = (id: number) =>
    db
      .query<{ side: string; tag: string }, [number]>(
        "SELECT side, tag FROM memory_edge_side_tags WHERE edge_row_id = ? ORDER BY side",
      )
      .all(id);
  const receipts = () =>
    db
      .query<{ action: string; side: string; edgeRowId: number; writer: string }, []>(
        "SELECT action, side, edge_row_id AS edgeRowId, writer FROM edge_attribution_receipts ORDER BY id",
      )
      .all();
  const setTags = (turnId: number, tags: string[]) =>
    db.query("UPDATE turns SET tags = ? WHERE id = ?").run(JSON.stringify(tags), turnId);

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "normalize",
      project: "normalize",
      title: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, { title: "Task", tags: ["the-task"], nowEpoch: 10 }).id;
    insertLane(db, segmentId, "alpha", 10);
    insertLane(db, segmentId, "beta", 10);
  });
  afterEach(() => db.close());

  test("a declaration whose endpoint is now down to ONE lane is cleared as redundant — 'stored means several lanes' stays true", () => {
    const citing = addTurn(1, ["the-task", "alpha", "beta"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited, "alpha", "");

    // `beta` goes: the tail is uniquely laned now, so the declaration says
    // nothing the derivation would not.
    setTags(citing, ["the-task", "alpha"]);
    const result = normalizeIncidentAttribution(db, [citing], { writer: "lane:clear", nowEpoch: NOW });

    expect(edgeRow(edgeId)).toEqual({ tailTag: "", headTag: "" });
    expect(result.clearedDeclarations).toEqual([
      { edgeId, side: "tail", clearedTag: "alpha", reason: "redundant" },
    ]);
    expect(sideIndexRows(edgeId)).toEqual([]);
    expect(receipts()).toEqual([
      { action: "clear-declaration", side: "tail", edgeRowId: edgeId, writer: "lane:clear" },
    ]);
  });

  test("a declaration no longer among the endpoint's tags is cleared as INVALID, and reported as its own reason", () => {
    const citing = addTurn(1, ["the-task", "alpha", "beta"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited, "alpha", "");

    // `alpha` is not among the endpoint's tags any more, and what IS there is
    // a single lane — so the declaration is `invalid` (never `derived`, which
    // is the whole point of that outcome) and the side derives afterwards.
    setTags(citing, ["the-task", "beta"]);
    const result = normalizeIncidentAttribution(db, [citing], { writer: "lane:retag", nowEpoch: NOW });
    expect(result.clearedDeclarations[0]!.reason).toBe("invalid");
    expect(edgeRow(edgeId)!.tailTag).toBe("");
  });

  test("a LIVE declaration on a genuinely ambiguous endpoint is left alone — that is what a stored side is for", () => {
    const citing = addTurn(1, ["the-task", "alpha", "beta"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited, "alpha", "");

    const result = normalizeIncidentAttribution(db, [citing], { writer: "lane:clear", nowEpoch: NOW });
    expect(edgeRow(edgeId)!.tailTag).toBe("alpha");
    expect(result.clearedDeclarations).toEqual([]);
    expect(result.deletedEdges).toEqual([]);
  });

  test("a side that resolves AMBIGUOUS after the clears is deleted and receipted — the default `onAmbiguous`", () => {
    const citing = addTurn(1, ["the-task", "alpha"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited, "", "");

    // The citing turn joins a second lane: nobody ever said which one the
    // edge is in, and now nobody can.
    setTags(citing, ["the-task", "alpha", "beta"]);
    const result = normalizeIncidentAttribution(db, [citing], { writer: "note:tags", nowEpoch: NOW });

    expect(edgeRow(edgeId)).toBeNull();
    expect(result.deletedEdges).toEqual([{ edgeId, citingId: citing, citedId: cited, side: "tail" }]);
    expect(receipts()).toEqual([
      { action: "delete-edge", side: "tail", edgeRowId: edgeId, writer: "note:tags" },
    ]);
  });

  test("`ctx.onAmbiguous` can answer `keep` — the seam ships DELETE, ticket 04 puts a live-job branch in front of it", () => {
    const citing = addTurn(1, ["the-task", "alpha"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited, "", "");
    setTags(citing, ["the-task", "alpha", "beta"]);

    const seen: string[] = [];
    const result = normalizeIncidentAttribution(db, [citing], {
      writer: "note:tags",
      nowEpoch: NOW,
      onAmbiguous: (edge, side) => {
        seen.push(`${edge.id}:${side}`);
        return "keep";
      },
    });
    expect(seen).toEqual([`${edgeId}:tail`]);
    expect(edgeRow(edgeId)).not.toBeNull();
    expect(result.deletedEdges).toEqual([]);
  });

  test("only sides whose OWN endpoint moved are re-judged — one lane's change never touches another lane's edge", () => {
    const citing = addTurn(1, ["the-task", "alpha", "beta"]);
    const cited = addTurn(2, ["the-task", "alpha", "beta"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited, "alpha", "beta");

    // Only the CITED turn is named. Its head declaration goes redundant; the
    // tail's stays, because nothing said the citing turn moved.
    setTags(cited, ["the-task", "beta"]);
    normalizeIncidentAttribution(db, [cited], { writer: "lane:clear", nowEpoch: NOW });
    expect(edgeRow(edgeId)).toEqual({ tailTag: "alpha", headTag: "" });
  });

  test("every changed citer's relations revision is stamped ONCE, under the VERB's id", () => {
    const citing = addTurn(1, ["the-task", "alpha", "beta"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const third = addTurn(3, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [third], 10);
    addEdge(citing, cited, "alpha", "");
    addEdge(citing, third, "beta", ""); // a second row from the same citer

    setTags(citing, ["the-task", "alpha"]);
    const result = normalizeIncidentAttribution(db, [citing], {
      writer: "lane:clear",
      nowEpoch: NOW,
    });
    expect(result.stampedCiterIds).toEqual([citing]);
    expect(getFieldStamp(db, "turn", citing, "relations")?.writer).toBe("lane:clear");
  });

  test("OLD and NEW qualified lanes are both recorded as touched when the caller captured a pre-state", () => {
    const other = createSegment(db, { title: "Other", nowEpoch: 10 });
    insertLane(db, other.id, "alpha", 10);
    const citing = addTurn(1, ["the-task", "alpha"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    addEdge(citing, cited, "", "");

    const previousLaneFacts = loadEndpointLaneFacts(db, [citing]);
    // The turn moves task: `E1/#alpha` -> `E2/#alpha`, two different lanes.
    db.query("DELETE FROM segment_members WHERE turn_id = ?").run(citing);
    addSegmentMembers(db, other.id, [citing], 10);

    const result = normalizeIncidentAttribution(db, [citing], {
      writer: "task:move",
      nowEpoch: NOW,
      previousLaneFacts,
    });
    expect(result.touchedLanes).toEqual([
      { segmentId, tag: "alpha" },
      { segmentId: other.id, tag: "alpha" },
    ]);
  });

  test("an empty id list, and an id set no edge touches, both do nothing at all", () => {
    expect(normalizeIncidentAttribution(db, [], { writer: "x", nowEpoch: NOW }).deletedEdges).toEqual([]);
    const lonely = addTurn(9, ["the-task", "alpha"]);
    expect(
      normalizeIncidentAttribution(db, [lonely], { writer: "x", nowEpoch: NOW }).clearedDeclarations,
    ).toEqual([]);
  });
});

/**
 * THE VERBS. `clearLane` and `mergeLaneTag` mutate ATTRIBUTION and nothing
 * else now — the edge is a fact about two nodes, and un-homing a turn does not
 * unmake it.
 */
describe("lane lifecycle verbs go through the seam", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;

  const addTurn = (promptNumber: number, tags: string[]): number =>
    db
      .query<{ id: number }, [number, number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', ?, '[]', ?)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, 100 + promptNumber, JSON.stringify(tags))!.id;

  const addEdge = (citingId: number, citedId: number, tailTag: string, headTag: string): number =>
    db
      .query<{ id: number }, [number, number, string, string]>(
        `INSERT INTO memory_edges
           (citing_kind, citing_id, cited_kind, cited_id, relation, provenance,
            tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
         VALUES ('turn', ?, 'turn', ?, 'extends', 'asserted', ?, ?, 'use', '', 400)
         RETURNING id`,
      )
      .get(citingId, citedId, tailTag, headTag)!.id;

  const edgeCount = () =>
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_edges").get()!.n;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "verbs",
      project: "verbs",
      title: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, { title: "Task", tags: ["the-task"], nowEpoch: 10 }).id;
  });
  afterEach(() => db.close());

  test("`clearLane` keeps the NODE FACT: the members are un-homed, the edge survives with no lane", () => {
    insertLane(db, segmentId, "doomed", 10);
    const citing = addTurn(1, ["the-task", "doomed"]);
    const cited = addTurn(2, ["the-task", "doomed"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited, "doomed", "doomed");

    const outcome = runWriteTransaction(db, () => clearLane(db, segmentId, "doomed", 900));
    expect(outcome.kind).toBe("cleared");
    if (outcome.kind !== "cleared") return;
    expect(outcome.receipt.turnsCleared).toBe(2);
    // THE INVERSION: this used to be `edgesDeleted: 1`.
    expect(outcome.receipt.edgesDeleted).toBe(0);
    expect(outcome.receipt.declarationsCleared).toBe(2);
    expect(edgeCount()).toBe(1);
    expect(
      db
        .query<{ tailTag: string; headTag: string }, [number]>(
          "SELECT tail_tag AS tailTag, head_tag AS headTag FROM memory_edges WHERE id = ?",
        )
        .get(edgeId),
    ).toEqual({ tailTag: "", headTag: "" });
  });

  test("`clearLane` deletes only what it makes UNATTRIBUTABLE — a member still in another lane loses its edge", () => {
    insertLane(db, segmentId, "doomed", 10);
    insertLane(db, segmentId, "kept", 10);
    insertLane(db, segmentId, "third", 10);
    // The citer stays in TWO lanes after the clear, with no declaration left.
    const citing = addTurn(1, ["the-task", "doomed", "kept", "third"]);
    const cited = addTurn(2, ["the-task", "doomed"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    addEdge(citing, cited, "doomed", "doomed");

    const outcome = runWriteTransaction(db, () => clearLane(db, segmentId, "doomed", 900));
    expect(outcome.kind).toBe("cleared");
    if (outcome.kind !== "cleared") return;
    expect(outcome.receipt.edgesDeleted).toBe(1);
    expect(edgeCount()).toBe(0);
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM edge_attribution_receipts WHERE action = 'delete-edge'",
        )
        .get()!.n,
    ).toBe(1);
  });

  test("`clearLane` takes no `force` and never blocks: there is no destructive outcome left to gate", () => {
    expect(clearLane).toHaveLength(4);
    insertLane(db, segmentId, "doomed", 10);
    const citing = addTurn(1, ["the-task", "doomed"]);
    const cited = addTurn(2, ["the-task"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    // A HALF-SETTLED row — one of the two shapes that used to refuse.
    addEdge(citing, cited, "doomed", "");
    const outcome = runWriteTransaction(db, () => clearLane(db, segmentId, "doomed", 900));
    expect(outcome.kind).toBe("cleared");
    expect(edgeCount()).toBe(1);
  });

  test("`mergeLaneTag` carries the attribution across FIRST, then normalises — the folded declaration is not destroyed mid-way", () => {
    insertLane(db, segmentId, "from", 10);
    insertLane(db, segmentId, "into", 10);
    insertLane(db, segmentId, "spare", 10);
    // Both endpoints stay in TWO lanes after the fold, so a declaration is
    // still meaningful and must survive as `into`.
    const citing = addTurn(1, ["the-task", "from", "spare"]);
    const cited = addTurn(2, ["the-task", "from", "spare"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited, "from", "from");

    runWriteTransaction(db, () => mergeLaneTag(db, segmentId, "from", "into", 900));
    expect(
      db
        .query<{ tailTag: string; headTag: string }, [number]>(
          "SELECT tail_tag AS tailTag, head_tag AS headTag FROM memory_edges WHERE id = ?",
        )
        .get(edgeId),
    ).toEqual({ tailTag: "into", headTag: "into" });
  });

  test("`writeMembershipTags` runs the seam itself, so every path that moves membership is covered", () => {
    insertLane(db, segmentId, "alpha", 10);
    insertLane(db, segmentId, "beta", 10);
    const citing = addTurn(1, ["the-task", "alpha", "beta"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited, "alpha", "");

    const written = runWriteTransaction(db, () =>
      writeMembershipTags(db, {
        operation: "normal",
        writes: [{ turnId: citing, tags: ["the-task", "alpha"] }],
        nowEpoch: 900,
      }),
    );
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.attribution?.clearedDeclarations).toEqual([
      { edgeId, side: "tail", clearedTag: "alpha", reason: "redundant" },
    ]);
  });

  test("`callerNormalizesAttribution` defers it — the one opt-out, for a caller mid-way through a compound change", () => {
    insertLane(db, segmentId, "alpha", 10);
    insertLane(db, segmentId, "beta", 10);
    const citing = addTurn(1, ["the-task", "alpha", "beta"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited, "alpha", "");

    const written = runWriteTransaction(db, () =>
      writeMembershipTags(db, {
        operation: "normal",
        writes: [{ turnId: citing, tags: ["the-task", "alpha"] }],
        nowEpoch: 900,
        callerNormalizesAttribution: true,
      }),
    );
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.attribution).toBeUndefined();
    expect(
      db
        .query<{ tailTag: string }, [number]>("SELECT tail_tag AS tailTag FROM memory_edges WHERE id = ?")
        .get(edgeId)!.tailTag,
    ).toBe("alpha");
  });
});
