import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  edgeSideAttributesTo,
  loadEndpointLaneFacts,
  resolveEdgeSide,
  resolveEdgeSides,
  type EndpointLaneFacts,
} from "../../src/db/edge-side-resolution";
import { insertLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

/**
 * THE FIVE OUTCOMES (main-agent-edges spec D2). A lane side is an
 * ATTRIBUTION, resolved at read time from the endpoint's own membership —
 * declared where the writer declared, DERIVED where the endpoint is in
 * exactly one lane, and refused an answer where it is in several.
 */
describe("resolveEdgeSide — five outcomes over supplied endpoint facts", () => {
  const facts = (entries: Record<number, EndpointLaneFacts>) =>
    new Map<number, EndpointLaneFacts>(Object.entries(entries).map(([id, f]) => [Number(id), f]));
  const edge = (tailTag: string, headTag: string) => ({
    citingId: 1,
    citedId: 2,
    tailTag,
    headTag,
  });

  test("`declared` — a stored tag that IS among the endpoint's current lane tags", () => {
    const resolved = resolveEdgeSide(
      edge("alpha", ""),
      "tail",
      facts({ 1: { segmentId: 7, lanes: ["alpha", "beta"] } }),
    );
    expect(resolved.outcome).toBe("declared");
    expect(resolved.lane).toEqual({ segmentId: 7, tag: "alpha" });
    expect(resolved.laneCardinality).toBe(2);
  });

  test("`derived` — no stored tag, exactly one lane: 69% of production reaches its lane with no writer having said so", () => {
    const resolved = resolveEdgeSide(
      edge("", ""),
      "tail",
      facts({ 1: { segmentId: 7, lanes: ["alpha"] } }),
    );
    expect(resolved.outcome).toBe("derived");
    expect(resolved.lane).toEqual({ segmentId: 7, tag: "alpha" });
  });

  test("`ambiguous` — no stored tag, two or more lanes: nobody can say which, and the resolver refuses to guess", () => {
    const resolved = resolveEdgeSide(
      edge("", ""),
      "tail",
      facts({ 1: { segmentId: 7, lanes: ["alpha", "beta"] } }),
    );
    expect(resolved.outcome).toBe("ambiguous");
    expect(resolved.lane).toBeNull();
  });

  test("`none` — no stored tag, no lane at all: legal, and never a finding", () => {
    const resolved = resolveEdgeSide(
      edge("", ""),
      "tail",
      facts({ 1: { segmentId: 7, lanes: [] } }),
    );
    expect(resolved.outcome).toBe("none");
    expect(resolved.lane).toBeNull();
  });

  test("`invalid` NEVER falls back to `derived`, even when the endpoint has exactly one lane now", () => {
    // THE MUTATION for this rule: make `invalid` fall through to the
    // cardinality arm and this expectation reads `derived`.
    const resolved = resolveEdgeSide(
      edge("gone", ""),
      "tail",
      facts({ 1: { segmentId: 7, lanes: ["alpha"] } }),
    );
    expect(resolved.outcome).toBe("invalid");
    expect(resolved.lane).toBeNull();
    expect(resolved.storedTag).toBe("gone");
  });

  test("a HOMELESS endpoint is in no lane: a declaration on it is `invalid`, a blank side is `none`", () => {
    const homeless = facts({ 1: { segmentId: null, lanes: [] } });
    expect(resolveEdgeSide(edge("alpha", ""), "tail", homeless).outcome).toBe("invalid");
    expect(resolveEdgeSide(edge("", ""), "tail", homeless).outcome).toBe("none");
  });

  test("an endpoint the caller loaded no facts for resolves as homeless — a reader never invents a membership", () => {
    expect(resolveEdgeSide(edge("", ""), "tail", facts({})).outcome).toBe("none");
  });

  test("the TAIL is the citing turn's side and the HEAD the cited turn's — pointing either at the other endpoint is the mutation", () => {
    const both = resolveEdgeSides(
      { citingId: 1, citedId: 2, tailTag: "", headTag: "" },
      facts({
        1: { segmentId: 7, lanes: ["alpha"] },
        2: { segmentId: 8, lanes: ["beta", "gamma"] },
      }),
    );
    expect(both.tail.endpointId).toBe(1);
    expect(both.tail.lane).toEqual({ segmentId: 7, tag: "alpha" });
    expect(both.head.endpointId).toBe(2);
    expect(both.head.outcome).toBe("ambiguous");
  });

  test("lanes are QUALIFIED: the same tag word under two tasks is two lanes", () => {
    const twoTasks = facts({
      1: { segmentId: 7, lanes: ["shared"] },
      2: { segmentId: 8, lanes: ["shared"] },
    });
    const row = { citingId: 1, citedId: 2, tailTag: "", headTag: "" };
    expect(edgeSideAttributesTo(row, "tail", { segmentId: 7, tag: "shared" }, twoTasks)).toBe(true);
    expect(edgeSideAttributesTo(row, "head", { segmentId: 7, tag: "shared" }, twoTasks)).toBe(false);
    expect(edgeSideAttributesTo(row, "head", { segmentId: 8, tag: "shared" }, twoTasks)).toBe(true);
  });

  test("only `declared` and `derived` attribute to a lane — `ambiguous`, `none` and `invalid` attribute to none", () => {
    const row = { citingId: 1, citedId: 2, tailTag: "", headTag: "" };
    for (const lanes of [[], ["a", "b"]]) {
      expect(
        edgeSideAttributesTo(row, "tail", { segmentId: 7, tag: "a" }, facts({ 1: { segmentId: 7, lanes } })),
      ).toBe(false);
    }
    expect(
      edgeSideAttributesTo(
        { citingId: 1, citedId: 2, tailTag: "gone", headTag: "" },
        "tail",
        { segmentId: 7, tag: "a" },
        facts({ 1: { segmentId: 7, lanes: ["a"] } }),
      ),
    ).toBe(false);
  });
});

describe("loadEndpointLaneFacts — the one shared load", () => {
  let db: Database;
  let sessionId: number;

  const addTurn = (promptNumber: number, tags: string[]): number =>
    db
      .query<{ id: number }, [number, number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', ?, '[]', ?)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, 100 + promptNumber, JSON.stringify(tags))!.id;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "resolution",
      project: "resolution",
      title: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
  });
  afterEach(() => db.close());

  test("a turn's lanes are its stored tags INTERSECTED with the lanes its owning task declares", () => {
    const segment = createSegment(db, { title: "Task", nowEpoch: 10 });
    insertLane(db, segment.id, "alpha", 10);
    // `beta` is carried but never declared: not a lane, so not a membership.
    const turnId = addTurn(1, ["alpha", "beta"]);
    addSegmentMembers(db, segment.id, [turnId], 10);

    const facts = loadEndpointLaneFacts(db, [turnId]);
    expect(facts.get(turnId)).toEqual({ segmentId: segment.id, lanes: ["alpha"] });
  });

  test("a turn owned by NO task is homeless — no owning segment, no lanes, whatever its tags say", () => {
    const turnId = addTurn(1, ["alpha"]);
    expect(loadEndpointLaneFacts(db, [turnId])).toEqual(
      new Map([[turnId, { segmentId: null, lanes: [] }]]),
    );
  });

  test("a turn in TWO tasks takes the lowest segment id — the same `MIN(segment_id)` tie-break every other owning-segment reader uses", () => {
    const first = createSegment(db, { title: "A", nowEpoch: 10 });
    const second = createSegment(db, { title: "B", nowEpoch: 10 });
    insertLane(db, first.id, "shared", 10);
    insertLane(db, second.id, "shared", 10);
    const turnId = addTurn(1, ["shared"]);
    addSegmentMembers(db, second.id, [turnId], 10);
    addSegmentMembers(db, first.id, [turnId], 10);

    expect(loadEndpointLaneFacts(db, [turnId]).get(turnId)!.segmentId).toBe(
      Math.min(first.id, second.id),
    );
  });

  test("an id with no `turns` row still gets an entry, so a caller's stale id is homeless rather than absent", () => {
    expect(loadEndpointLaneFacts(db, [99_999]).get(99_999)).toEqual({ segmentId: null, lanes: [] });
  });

  test("malformed stored tags read as no tags — a read path never throws on the stock the cutover has not normalised", () => {
    const segment = createSegment(db, { title: "Task", nowEpoch: 10 });
    insertLane(db, segment.id, "alpha", 10);
    const turnId = addTurn(1, []);
    addSegmentMembers(db, segment.id, [turnId], 10);
    db.query("UPDATE turns SET tags = ? WHERE id = ?").run("{not json", turnId);
    expect(loadEndpointLaneFacts(db, [turnId]).get(turnId)!.lanes).toEqual([]);
  });

  test("an empty id list costs no query at all", () => {
    expect(loadEndpointLaneFacts(db, [])).toEqual(new Map());
  });
});
