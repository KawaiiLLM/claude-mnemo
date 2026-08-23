import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  checkLanes,
  DEFAULT_SEGMENT,
  type LaneEdgeInput,
  type LaneTurnInput,
} from "../../src/shared/lane-checker";
import { renderLaneCheckerReports } from "../../src/shared/lane-checker-render";

const design = (id: number, type: string[] = ["design"]): LaneTurnInput => ({ id, type });
const edge = (
  citingId: number,
  relation: string,
  citedId: number,
  tags: string[] = [],
): LaneEdgeInput => ({ citingId, relation, citedId, tags });

const tagSetSignature = (tags: readonly string[]) => [...new Set(tags)].sort().join("\u0001");

function findLaneStats(result: ReturnType<typeof checkLanes>, tagSet: string[]) {
  const signature = tagSetSignature(tagSet);
  return result.lanes.find((lane) => tagSetSignature(lane.key.tagSet) === signature);
}
function findComponent(result: ReturnType<typeof checkLanes>, tagSet: string[]) {
  const signature = tagSetSignature(tagSet);
  return result.components.find((c) => tagSetSignature(c.key.tagSet) === signature);
}
function findPath(result: ReturnType<typeof checkLanes>, tagSet: string[]) {
  const signature = tagSetSignature(tagSet);
  return result.paths.find((p) => tagSetSignature(p.key.tagSet) === signature);
}

// ---------------------------------------------------------------- golden fixture

interface FixtureTurn {
  id: number;
  type: string[];
  tags: string[];
  title: string;
}
interface FixtureEdge {
  citingId: number;
  relation: string;
  citedId: number;
  tags: string[];
  simulated?: boolean;
}
interface Fixture {
  meta: { window: [number, number] };
  lanes: { tag: string; kind: string; members: number[] }[];
  turns: FixtureTurn[];
  edges: FixtureEdge[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), ".scratch/rubric-v10/fixtures/t900-1001-lane-sim.json"),
    "utf8",
  ),
);
const fixtureTurns: LaneTurnInput[] = fixture.turns.map((t) => ({ id: t.id, type: t.type }));
const fixtureEdges: LaneEdgeInput[] = fixture.edges.map((e) => ({
  citingId: e.citingId,
  relation: e.relation,
  citedId: e.citedId,
  tags: e.tags,
}));
const declaredLaneTags = fixture.lanes.map((l) => l.tag).filter((tag) => tag !== "write-gate");

describe("golden fixture — S15069 T900-1001 lane simulation (12 lanes, hand-judged)", () => {
  const result = checkLanes(fixtureTurns, fixtureEdges);

  test("every declared lane has component count 1 and (unfolded) path count 1", () => {
    expect(declaredLaneTags.length).toBe(11);
    for (const tag of declaredLaneTags) {
      const stats = findLaneStats(result, [tag]);
      const component = findComponent(result, [tag]);
      const path = findPath(result, [tag]);
      expect(stats?.declaration.state).toBe("declared");
      expect(component?.componentCount).toBe(1);
      expect(path?.status).toBe("ok");
      expect(path?.pathCount).toBe(1);
    }
  });

  // Round-4 review #3 corrected the fold direction (see lane-checker.ts's
  // module header): the folded count now sums `countPaths` from EVERY
  // zero-indegree node in the merged graph (the terminus AND each external
  // citer), not the terminus alone — so an external `grounds` citation into
  // a MID-CHAIN member (which keeps the terminus its own independent,
  // still-zero-indegree root) GROWS the count, while one that lands
  // directly ON THE TERMINUS itself (giving the terminus an incoming edge,
  // so it stops being a source and the citer's own count subsumes it)
  // leaves the total unchanged. Recomputed by running the real
  // implementation against the fixture (`/tmp/dump-golden.ts`-style probe),
  // not hand-guessed:
  //   - cadence (citers 985->978, 989->978 mid-chain; 992->981 terminus
  //     itself): 1 -> 3
  //   - ownership (citers 936->910, 946->912, both mid-chain): 1 -> 3
  //   - relation-vocabulary (citers 940/942/945, mid-chain): 1 -> 3
  //   - turn-edge-mechanism (citer 930->929, lands ON the terminus): stays 1
  //   - view-spec (citer 923->922, lands ON the terminus): stays 1
  //   - every lane with no external grounds citer at all (contract-repair,
  //     contract-verify, rewind-marking, segment-audit, settlement-scope,
  //     spec-design): stays 1 (folded === base when there is nothing to fold)
  //
  // Round-5 review #11 shifted ONE of these again, further: `ownership`
  // 3 -> 4. Citer 946 (external, grounds member 912 mid-chain) is ITSELF a
  // member of the `{contract-verify}` lane (946 --consume--> 945, tagged
  // `contract-verify`) — the fix now folds that lane's own structural edge
  // in too, not just 946's bare grounds entry point. 945 has no further
  // tagged path edge, so it becomes a second zero-indegree "start" reachable
  // only through 946, and 946 itself gains a SECOND outgoing edge in the
  // merged graph (946->912 the grounds fold, 946->945 contract-verify's own
  // edge) — a fork at 946, contributing two independent routes
  // (946->912->910->900 and 946->945) instead of one. Every other lane's
  // external citer (936 for ownership; 985/989/992 for cadence; 940/942/945
  // for relation-vocabulary; 930 for turn-edge-mechanism; 923 for view-spec)
  // is NOT itself a tagged member of any other lane, so their folded counts
  // are unaffected by this batch. Recomputed by running the real
  // implementation against the fixture, not hand-guessed.
  test("folded path counts recomputed under the corrected fold semantics (round-4 review #3, round-5 review #11)", () => {
    const expectedFolded: Record<string, number> = {
      "spec-design": 1,
      "settlement-scope": 1,
      ownership: 4,
      "rewind-marking": 1,
      "view-spec": 1,
      "turn-edge-mechanism": 1,
      "relation-vocabulary": 3,
      cadence: 3,
      "segment-audit": 1,
      "contract-repair": 1,
      "contract-verify": 1,
    };
    expect(Object.keys(expectedFolded).sort()).toEqual([...declaredLaneTags].sort());
    for (const tag of declaredLaneTags) {
      const path = findPath(result, [tag]);
      expect(path?.folded?.pathCount).toBe(expectedFolded[tag]);
    }
  });

  test("{write-gate} reports undeclared — no `indexes` ever tagged write-gate, only a same-tag override of its latest structural node", () => {
    const stats = findLaneStats(result, ["write-gate"]);
    expect(stats?.declaration.state).toBe("undeclared");
    expect(stats?.declaration.terminus).toBe(null);
    expect(stats?.declaration.latestEventTurn).toBe(958); // T958's override of T957
    expect(stats?.members.find((m) => m.id === 957)?.dead).toBe(true);
    const path = findPath(result, ["write-gate"]);
    expect(path?.status).toBe("skipped");
    expect(path?.skipReason).toBe("undeclared");
  });

  test("report 3 yields EXACTLY two multi-lane components (7-lane and 4-lane groups)", () => {
    expect(result.multiLaneComponents.length).toBe(2);
    const sizes = result.multiLaneComponents.map((c) => c.lanes.length).sort((a, b) => a - b);
    expect(sizes).toEqual([4, 7]);
  });

  test("{ownership}'s cited-ness shows MID-MEMBER grounds (T936->T910, T946->T912) — a terminus-only reading would show none, since nothing cites T913 directly", () => {
    const stats = findLaneStats(result, ["ownership"]);
    const pairs = stats?.citedness.groundsFromNonMembers.map((f) => `${f.citingId}->${f.citedId}`).sort();
    expect(pairs).toEqual(["936->910", "946->912"]);
    // Confirm the terminus itself really is never directly cited — the
    // lane-wide reading is doing real work here, not just being permissive.
    const directlyOnTerminus = stats?.citedness.groundsFromNonMembers.some((f) => f.citedId === 913);
    expect(directlyOnTerminus).toBe(false);
  });

  test("{ownership}'s phases include delivery too (T900 is typed design+ops — ops is delivery-phase), edge counts by word tally the lane's own 7 tagged edges", () => {
    const stats = findLaneStats(result, ["ownership"]);
    // Not a single "decision" phase: T900 carries both design (decision) and
    // ops (delivery) types, and phases are unioned across ALL members
    // (dead included) — a real anomaly signal report 1 is meant to surface,
    // not a bug in this test's expectation.
    expect(stats?.phases.slice().sort()).toEqual(["decision", "delivery"]);
    const total = Object.values(stats?.edgeCountsByRelation ?? {}).reduce((a, b) => a + b, 0);
    expect(total).toBe(7);
    expect(stats?.edgeCountsByRelation).toEqual({ extends: 3, indexes: 3, narrows: 1 });
  });

  test("input is whole for the fixture — coverage never reports partial when every referenced turn is present", () => {
    for (const lane of result.lanes) {
      expect(lane.coverage.status).toBe("whole");
      expect(lane.coverage.missingTurnIds).toEqual([]);
    }
  });

  // rubric-v10 ticket 08 — recomputed by running the real implementation
  // against the fixture (`/tmp/dump-golden-08.ts`-style probe), not
  // hand-guessed, the same methodology the folded-path goldens above use.
  test("report 4a golden — inter-lane interface pairs", () => {
    const pairs = result.interfaces
      .map((pair) => `${pair.laneA.tagSet.join(",")}<->${pair.laneB.tagSet.join(",")}:${pair.count}`)
      .sort();
    expect(pairs).toEqual([
      "cadence<->segment-audit:1",
      "contract-verify<->ownership:1",
      "contract-verify<->relation-vocabulary:1",
    ]);
  });

  test("report 4a golden — per-declared-lane bypass counts (write-gate is undeclared and never appears)", () => {
    const counts: Record<string, number> = {};
    for (const report of result.bypass) {
      counts[report.key.tagSet.join(",")] = report.count;
    }
    expect(counts).toEqual({
      cadence: 2,
      "contract-repair": 1,
      "contract-verify": 0,
      ownership: 5,
      "relation-vocabulary": 1,
      "rewind-marking": 0,
      "segment-audit": 1,
      "settlement-scope": 3,
      "spec-design": 3,
      "turn-edge-mechanism": 0,
      "view-spec": 0,
    });
    expect(Object.keys(counts).sort()).toEqual([...declaredLaneTags].sort());
    expect(result.bypass.some((report) => report.key.tagSet.join(",") === "write-gate")).toBe(false);
  });

  // The 900-heavy shared root: T900 is a member of THREE lanes at once
  // (spec-design, settlement-scope, ownership all narrow/extend/consume it)
  // and is never any of their own termini, so every OTHER lane's own
  // structural edge touching T900 registers as bypass for whichever lane(s)
  // count it a member — a real, intended finding this fixture surfaces, not
  // a double-counting bug (each such edge is excluded from ITS OWN lane's
  // bypass count, since a same-tag edge structurally makes its citing turn
  // a member of that lane).
  test("ownership's 5 bypass edges are exactly the non-ownership-tagged edges landing on T900 (mid-member) plus T910/T912 (mid-members)", () => {
    const ownershipBypass = result.bypass.find((report) => report.key.tagSet.join(",") === "ownership");
    const pairs = ownershipBypass?.edges.map((e) => `${e.citingId}->${e.citedId}`).sort();
    expect(pairs).toEqual(["901->900", "902->900", "906->900", "936->910", "946->912"]);
  });

  test("report 4c golden — no time-order violations: the fixture has no cross-session or forward edges", () => {
    expect(result.timeOrderViolations).toEqual([]);
  });

  // milestone-election ticket 04 — recomputed by running the real
  // implementation (`deriveLaneStates` via `checkLanes`) against the
  // fixture, not hand-guessed, the same methodology every other golden test
  // in this block uses. All 11 declared lanes read closed-valid (the spec's
  // own measured baseline: "All 11 closed lanes are valid on this window").
  // {write-gate} is the one undeclared lane — open, no declarer at all.
  test("report 1 golden — every declared lane's state is closed-valid; {write-gate} is open with no declarer", () => {
    for (const tag of declaredLaneTags) {
      const stats = findLaneStats(result, [tag]);
      expect(stats?.state.closure).toBe("closed");
      expect(stats?.state.validity).toBe("valid");
      expect(stats?.state.lastDeclarer).toBe(stats?.declaration.terminus);
    }
    const writeGate = findLaneStats(result, ["write-gate"]);
    expect(writeGate?.state).toEqual({
      key: writeGate!.key,
      closure: "open",
      validity: null,
      terminus: null,
      lastDeclarer: null,
    });
  });

  // T1351 trap fix — external CONSUME citations the fixture actually
  // carries (`python3` probe over the fixture JSON, not hand-guessed):
  // {ownership} is used by 902->900, {segment-audit} by 991->990 and
  // 992->989. None of these are grounds/testimony, so the OLD report (no
  // `used[]`) rendered these lanes' "cited from outside" line as if they
  // were never cited by consume at all.
  test("report 1 golden — used[] lists the fixture's real external consume citations", () => {
    const ownership = findLaneStats(result, ["ownership"]);
    expect(ownership?.citedness.usedFromNonMembers).toEqual([{ citingId: 902, citedId: 900 }]);
    const segmentAudit = findLaneStats(result, ["segment-audit"]);
    const pairs = segmentAudit?.citedness.usedFromNonMembers
      .map((f) => `${f.citingId}->${f.citedId}`)
      .sort();
    expect(pairs).toEqual(["991->990", "992->989"]);
  });
});

// ---------------------------------------------------------------- synthetic checks

describe("cited-ness self-cite exclusion", () => {
  test("a self-grounds edge (settlement+implementer turn) never inflates its own lane's cited-ness", () => {
    const turns = [design(501, ["design", "implement"]), design(502)];
    const edges = [
      edge(502, "extends", 501, ["s"]),
      edge(502, "indexes", 501, ["s"]),
      edge(501, "grounds", 501, []), // self-cite: citer IS a member
    ];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, ["s"]);
    expect(stats?.citedness.groundsFromNonMembers).toEqual([]);
  });
});

// -------------------------------- semantic-conformance ticket 02: vocabulary conformance

describe("vocabulary conformance — reported, never enforced (semantic-conformance ticket 02)", () => {
  test("a legacy-typed turn (a word outside MEMORY_TYPES) is reported with its id and the offending word", () => {
    const turns = [design(700, ["bugfix"]), design(701)];
    const edges = [edge(701, "extends", 700, ["vc1"]), edge(701, "indexes", 700, ["vc1"])];
    const result = checkLanes(turns, edges);
    expect(result.vocabularyConformance.typeViolations).toEqual({
      count: 1,
      entries: [{ id: 700, types: ["bugfix"], outsideVocabulary: ["bugfix"] }],
    });
  });

  test("an empty-typed turn is reported with its id and no offending word", () => {
    const turns = [design(710, []), design(711)];
    const edges = [edge(711, "extends", 710, ["vc2"]), edge(711, "indexes", 710, ["vc2"])];
    const result = checkLanes(turns, edges);
    expect(result.vocabularyConformance.typeViolations).toEqual({
      count: 1,
      entries: [{ id: 710, types: [], outsideVocabulary: [] }],
    });
  });

  test("a partially-legacy turn (one recognized word, one not) reports only the offending word in outsideVocabulary", () => {
    const turns = [design(715, ["design", "chat"]), design(716)];
    const edges = [edge(716, "extends", 715, ["vc2b"]), edge(716, "indexes", 715, ["vc2b"])];
    const result = checkLanes(turns, edges);
    const entry = result.vocabularyConformance.typeViolations.entries.find((v) => v.id === 715);
    expect(entry).toEqual({ id: 715, types: ["design", "chat"], outsideVocabulary: ["chat"] });
  });

  test("a supersedes edge is reported by citing/cited/relation and never enters the lane's own graph facts", () => {
    const turns = [design(720), design(721)];
    const edges = [
      edge(721, "extends", 720, ["vc3"]),
      edge(721, "indexes", 720, ["vc3"]),
      edge(721, "supersedes", 720, []),
    ];
    const result = checkLanes(turns, edges);
    expect(result.vocabularyConformance.outOfVocabularyEdges).toEqual({
      count: 1,
      entries: [{ citingId: 721, citedId: 720, relation: "supersedes" }],
    });
    // Never admitted: report 1's own edge tally for the lane excludes it
    // entirely (not even an `edgeCountsByRelation.supersedes` key), and
    // report 4's path graph is unaffected (still exactly the extends+indexes
    // shape) — proof this is reported, not folded into any graph computation.
    const stats = findLaneStats(result, ["vc3"]);
    expect(stats?.edgeCountsByRelation).toEqual({ extends: 1, indexes: 1 });
    const path = findPath(result, ["vc3"]);
    expect(path?.pathCount).toBe(1);
  });

  // A supersedes edge that (hypothetically) carried the SAME tag set as a
  // real lane would, if admitted, be silently absorbed into that lane's own
  // `taggedEdges`/membership by `deriveLaneInterpretation`'s tag-only
  // grouping (module header, "no per-word special case") — proving the
  // partition in `checkLanes` runs BEFORE that grouping, not merely that an
  // untagged supersedes edge happens to fall outside every other filter.
  test("a TAGGED supersedes edge still never joins the lane it would otherwise tag into", () => {
    const turns = [design(722), design(723), design(724)];
    const edges = [
      edge(723, "extends", 722, ["vc3b"]),
      edge(723, "indexes", 722, ["vc3b"]),
      edge(724, "supersedes", 723, ["vc3b"]), // same tag set as the real lane
    ];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, ["vc3b"]);
    // 724 never becomes a member: the supersedes edge was diverted before
    // `deriveLaneInterpretation` ever grouped it in.
    expect(stats?.members.map((m) => m.id)).toEqual([722, 723]);
    expect(stats?.edgeCountsByRelation).toEqual({ extends: 1, indexes: 1 });
    expect(result.vocabularyConformance.outOfVocabularyEdges.entries).toEqual([
      { citingId: 724, citedId: 723, relation: "supersedes" },
    ]);
  });

  test("a fully-conforming fixture reports clean on both counts", () => {
    const turns = [design(730), design(731)];
    const edges = [edge(731, "extends", 730, ["vc4"]), edge(731, "indexes", 730, ["vc4"])];
    const result = checkLanes(turns, edges);
    expect(result.vocabularyConformance).toEqual({
      typeViolations: { count: 0, entries: [] },
      outOfVocabularyEdges: { count: 0, entries: [] },
    });
  });

  test("both lists are capped, but count always reports the true total", () => {
    const legacyTurns = Array.from({ length: 25 }, (_, i) => design(800 + i, ["bugfix"]));
    const anchor = design(900, ["design"]);
    const edges = [edge(900, "extends", 800, ["vc5"]), edge(900, "indexes", 800, ["vc5"])];
    const result = checkLanes([...legacyTurns, anchor], edges);
    const tv = result.vocabularyConformance.typeViolations;
    expect(tv.count).toBe(25);
    expect(tv.entries.length).toBeLessThan(25);
    expect(tv.entries.length).toBeGreaterThan(0);
    // Ascending by id, and the capped list is a genuine PREFIX of the total.
    expect(tv.entries.map((v) => v.id)).toEqual(
      legacyTurns.slice(0, tv.entries.length).map((t) => t.id),
    );
  });

  test("the rendered text names ids and offending words for both lists, and prints an explicit clean marker when there is nothing to report", () => {
    const turns = [design(740, ["bugfix"]), design(741)];
    const edges = [
      edge(741, "extends", 740, ["vc6"]),
      edge(741, "indexes", 740, ["vc6"]),
      edge(741, "supersedes", 740, []),
    ];
    const result = checkLanes(turns, edges);
    const text = renderLaneCheckerReports(result);
    expect(text).toContain("## Vocabulary conformance");
    expect(text).toContain("types: 1");
    expect(text).toContain("T740 - type: [bugfix] (outside vocabulary: bugfix)");
    expect(text).toContain("edges: 1");
    expect(text).toContain("T741 -> T740 (supersedes)");

    const cleanResult = checkLanes(
      [design(750), design(751)],
      [edge(751, "extends", 750, ["vc7"]), edge(751, "indexes", 750, ["vc7"])],
    );
    const cleanText = renderLaneCheckerReports(cleanResult);
    const vocabTail = cleanText.slice(cleanText.indexOf("## Vocabulary conformance"));
    expect(vocabTail).toBe(["## Vocabulary conformance -- MEMORY_TYPES/EDGE_RELATIONS closed-set check (reported, never enforced)", "types: 0", "(none)", "edges: 0", "(none)"].join("\n"));
  });
});

describe("partial-input coverage", () => {
  test("a lane whose edges reach a turn missing from the input is reported WHOLE (members/terminus/path all computed) with coverage flagged partial", () => {
    const turns = [design(601)]; // 602 deliberately absent
    const edges = [edge(602, "extends", 601, ["w"]), edge(602, "indexes", 601, ["w"])];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, ["w"]);
    expect(stats?.members.map((m) => m.id)).toEqual([601, 602]);
    expect(stats?.coverage).toEqual({ status: "partial", missingTurnIds: [602] });
    // still reported WHOLE: terminus/path resolve despite the missing turn object.
    expect(stats?.declaration.terminus).toBe(602);
    const path = findPath(result, ["w"]);
    expect(path?.status).toBe("ok");
    expect(path?.pathCount).toBe(1);
    // phase only reflects the resolvable member (601); 602 contributes nothing unmapped.
    expect(stats?.phases).toEqual(["decision"]);
  });
});

describe("path counting — fork, merge, and one cross-phase fold, hand-computed", () => {
  // Fork: 2 and 3 both extend 1 (shared origin). Merge: 4 consumes BOTH 2 and
  // 3. Structural graph: 2->1, 3->1, 4->2, 4->3. starts={1}.
  // count(4) = count(2) + count(3) = 1 + 1 = 2 — two distinct start->terminus
  // routes (4-2-1 and 4-3-1).
  const turns = [design(1), design(2), design(3), design(4), design(5, ["implement"])];
  const edges = [
    edge(2, "extends", 1, ["f"]),
    edge(3, "extends", 1, ["f"]),
    edge(4, "consume", 2, ["f"]),
    edge(4, "consume", 3, ["f"]),
    edge(4, "indexes", 2, ["f"]),
    // cross-phase fold: an external (non-member) delivery turn grounds a
    // MID-chain member (3), not the terminus.
    edge(5, "grounds", 3, []),
  ];
  const result = checkLanes(turns, edges);
  const path = findPath(result, ["f"]);

  test("unfolded path count is 2 (fork+merge)", () => {
    expect(path?.status).toBe("ok");
    expect(path?.starts).toEqual([1]);
    expect(path?.terminus).toBe(4);
    expect(path?.pathCount).toBe(2);
  });

  // Round-4 review #3, the mutation-detecting property: the merged graph is
  // structural (2->1, 3->1, 4->2, 4->3) PLUS the fold edge 5->3. Node 3
  // keeps its own incoming edge from 4 (it is mid-chain, not the terminus),
  // so the terminus (4) stays an independent zero-indegree source with its
  // OWN unchanged count of 2 — but 5 is now ALSO a zero-indegree source
  // (nothing cites the external citer), contributing its own route
  // (5->3->1, count 1) on top. Folded = 2 (from 4) + 1 (from 5) = 3. A
  // reducer that (incorrectly) counts paths from the terminus alone — the
  // pre-fix reading — would report 2 here, unchanged from base; this test
  // fails under that old behaviour.
  test("folded path count GROWS to 3 — the external citer's own route to the lane's starts is summed alongside the terminus's own count, not walked from the terminus", () => {
    expect(path?.folded?.citingTurnsFolded).toEqual([5]);
    expect(path?.folded?.pathCount).toBe(3);
  });
});

describe("the fold merges the citer's OWN lane too, not just its bare entry edge (round-5 review #11)", () => {
  // Lane A {left}: 2->1 (declared, terminus 2). Lane B {right}: 4->3
  // (declared, terminus 4). T4 (B's terminus) grounds T2 (A's terminus),
  // cross-phase. The OLD fold reading only ever added the bare entry edge
  // 4->2, giving folded({left}) = 1 (4's only route is 4->2->1, identical in
  // shape to A's own base count). The spec requires "two lanes citing
  // across phases counted as ONE merged graph": folding must also pull in
  // B's OWN structural edge (4->3), so 4 gets a SECOND route (4->3, with 3
  // now a start of the merged graph) alongside 4->2->1 — folded({left})
  // must be 2, not 1.
  const turns = [design(1), design(2), design(3), design(4)];
  const edges = [
    edge(2, "extends", 1, ["left"]),
    edge(2, "indexes", 1, ["left"]),
    edge(4, "extends", 3, ["right"]),
    edge(4, "indexes", 3, ["right"]),
    edge(4, "grounds", 2, []), // cross-phase: B's terminus grounds A's terminus
  ];
  const result = checkLanes(turns, edges);

  test("folded pathCount for {left} is 2 — the citer's own lane {right} joins the merged graph, not just its entry edge", () => {
    const path = findPath(result, ["left"]);
    expect(path?.folded?.citingTurnsFolded).toEqual([4]);
    expect(path?.folded?.pathCount).toBe(2);
  });

  test("a citer with no lane membership of its own still folds as a bare entry edge only (no regression for the plain case)", () => {
    // Same shape, but the citer (5) belongs to no lane at all.
    const plainTurns = [design(1), design(2), design(5, ["implement"])];
    const plainEdges = [
      edge(2, "extends", 1, ["solo"]),
      edge(2, "indexes", 1, ["solo"]),
      edge(5, "grounds", 2, []),
    ];
    const plainResult = checkLanes(plainTurns, plainEdges);
    const path = findPath(plainResult, ["solo"]);
    expect(path?.folded?.pathCount).toBe(1);
  });
});

describe("reports 2/3 build from stance+consume+grounds only — override is excluded", () => {
  test("two members connected ONLY by an override edge do not share a component — the same edge WOULD union them if override were mistakenly included", () => {
    // 10 and 11 share no narrows/extends/consume/grounds edge at all, only a
    // same-tag override — R2/R3's graph must NOT union them.
    const turns = [design(10), design(11), design(12)];
    const edges = [
      edge(11, "extends", 10, ["ov"]), // gives {ov} a terminus candidate to declare
      edge(11, "indexes", 10, ["ov"]),
      edge(12, "override", 11, ["ov"]), // the ONLY edge touching 12 at all
    ];
    const result = checkLanes(turns, edges);
    const component = findComponent(result, ["ov"]);
    // {ov} members are {10,11,12}; 12 is connected to NOTHING via
    // stance/consume/grounds, so it is its own island — component count 2.
    expect(component?.componentCount).toBe(2);
    const islandReps = component?.islands.map((i) => i.representative).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(islandReps).toEqual([10, 12]);
  });
});

describe("R1 edge counts, R4 excludes indexes from the structural graph", () => {
  test("a lane with ONLY an indexes declaration (no narrows/extends/consume) has zero structural edges — path count 0, not 1", () => {
    const turns = [design(701), design(702)];
    const edges = [edge(702, "indexes", 701, ["lone"])];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, ["lone"]);
    expect(stats?.declaration.state).toBe("declared");
    expect(stats?.edgeCountsByRelation).toEqual({ indexes: 1 });
    const path = findPath(result, ["lone"]);
    expect(path?.status).toBe("ok");
    expect(path?.starts).toEqual([]);
    // indexes is excluded from the path graph entirely — no structural chain
    // connects the declared terminus to any start, so the honest count is 0.
    expect(path?.pathCount).toBe(0);
  });
});

describe("R2/R3 union-find is PARTITIONED BY SEGMENT (round-4 review #4b)", () => {
  test("a segment-B node can never bridge two segment-A members, even via a legal cross-segment grounds citation", () => {
    // 30/31 are the ONLY tagged-edge pair in segment A ({seg}); nothing else
    // structurally connects them within their own segment. 32 (segment B)
    // legally grounds BOTH of them cross-phase -- the OLD (buggy) global
    // union-find would let 32 bridge 30 and 31 into one false-healthy
    // component. The fix must refuse that union: 30 and 31 stay separate
    // islands, correctly surfacing that {seg}'s members are severed within
    // their own segment.
    const turns = [
      { id: 30, type: ["design"], segment: "A" },
      { id: 31, type: ["design"], segment: "A" },
      { id: 32, type: ["implement"], segment: "B" },
    ];
    const edges = [
      edge(31, "indexes", 30, ["seg"]),
      edge(32, "grounds", 30),
      edge(32, "grounds", 31),
    ];
    const result = checkLanes(turns, edges);
    const component = findComponent(result, ["seg"]);
    expect(component?.componentCount).toBe(2);
    const islandReps = component?.islands.map((i) => i.representative).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(islandReps).toEqual([30, 31]);
  });

  test("a same-segment stance/consume/grounds edge still unions normally — the segment gate only blocks CROSS-segment unions", () => {
    const turns = [
      { id: 40, type: ["design"], segment: "A" },
      { id: 41, type: ["design"], segment: "A" },
      { id: 42, type: ["design"], segment: "A" },
    ];
    const edges = [edge(41, "extends", 40, ["seg2"]), edge(41, "indexes", 40, ["seg2"]), edge(42, "grounds", 40)];
    const result = checkLanes(turns, edges);
    const component = findComponent(result, ["seg2"]);
    expect(component?.componentCount).toBe(1);
  });
});

describe("sameLaneKey uses collision-safe canonical serialization (round-4 review #6)", () => {
  test("{a,bc} and {ab,c} are DISTINCT lane keys, not merged by a delimiter-free join", () => {
    const turns = [design(1), design(2), design(3)];
    const edges = [
      edge(2, "extends", 1, ["a", "bc"]),
      edge(2, "indexes", 1, ["a", "bc"]),
      edge(3, "extends", 1, ["ab", "c"]),
      edge(3, "indexes", 1, ["ab", "c"]),
    ];
    const result = checkLanes(turns, edges);
    // Both lanes' members reach turn 1 via `extends` (a stance relation), so
    // they share one global component -- report 3 must see BOTH distinct
    // lane keys there, not collapse the second into the first via a
    // `tagSet.join("")` collision ("a"+"bc" === "ab"+"c").
    expect(result.multiLaneComponents).toHaveLength(1);
    const shared = result.multiLaneComponents[0]!;
    const tagSets = shared.lanes.map((key) => key.tagSet.slice().sort().join(","));
    expect(tagSets.sort()).toEqual(["a,bc", "ab,c"]);
  });
});

describe("report 3 gains shared-node sets with a designed-shape annotation (round-4 review #7a)", () => {
  test("a shared fork root cited by stance from TWO distinct lanes is annotated designedShape: true", () => {
    const turns = [design(10), design(11), design(12)];
    const edges = [
      edge(11, "extends", 10, ["left"]),
      edge(11, "indexes", 10, ["left"]),
      edge(12, "extends", 10, ["right"]),
      edge(12, "indexes", 10, ["right"]),
    ];
    const result = checkLanes(turns, edges);
    expect(result.multiLaneComponents).toHaveLength(1);
    const shared = result.multiLaneComponents[0]!;
    expect(shared.sharedNodes).toHaveLength(1);
    const node = shared.sharedNodes[0]!;
    expect(node.id).toBe(10);
    expect(node.designedShape).toBe(true);
    expect(node.citingLanesByStance.map((key) => key.tagSet)).toEqual(
      expect.arrayContaining([["left"], ["right"]]),
    );
  });

  test("a shared node with fewer than two stance citers is surfaced for judgment (designedShape: false)", () => {
    // 10 is shared by {left} and {right} again, but ONLY {left} cites it via
    // a stance edge -- {right}'s own tagged edge is `consume`, which never
    // reads as a "designed fork" citation.
    const turns = [design(10), design(11), design(12)];
    const edges = [
      edge(11, "extends", 10, ["left"]),
      edge(11, "indexes", 10, ["left"]),
      edge(12, "consume", 10, ["right"]),
      edge(12, "indexes", 10, ["right"]),
    ];
    const result = checkLanes(turns, edges);
    const shared = result.multiLaneComponents[0]!;
    const node = shared.sharedNodes.find((n) => n.id === 10);
    expect(node?.designedShape).toBe(false);
    expect(node?.citingLanesByStance.map((key) => key.tagSet)).toEqual([["left"]]);
  });
});

describe("report 3 also detects a CITING-side merge node, not just a cited-side fork root (round-5 review #15)", () => {
  test("a turn citing INTO two lanes via stance-tagged edges is a merge node, annotated designedShape: true", () => {
    // T3 --{left}--> T1 and T3 --{right}--> T2: T3 is the CITING endpoint of
    // both stance edges (never the cited one) — the OLD code only indexed
    // `citedId -> lane`, so T3 (never a cited id here) produced an EMPTY
    // `citingLanesByStance` and read as designedShape: false, even though it
    // is textbook a designed merge node (one turn's decision draws on two
    // distinct lanes at once).
    const turns = [design(1), design(2), design(3)];
    const edges = [
      edge(3, "extends", 1, ["left"]),
      edge(3, "extends", 2, ["right"]),
    ];
    const result = checkLanes(turns, edges);
    expect(result.multiLaneComponents).toHaveLength(1);
    const shared = result.multiLaneComponents[0]!;
    const node = shared.sharedNodes.find((n) => n.id === 3);
    expect(node).toBeDefined();
    expect(node?.designedShape).toBe(true);
    expect(node?.citingLanesByStance.map((key) => key.tagSet)).toEqual(
      expect.arrayContaining([["left"], ["right"]]),
    );
  });
});

describe("report 4 gains fork/join node lists (round-4 review #7b)", () => {
  test("the fork+merge fixture names its fork root and its join/merge node", () => {
    // Reuses the fork(1)+merge(4) shape from "path counting" above:
    // 2->1, 3->1 (1 is cited by two children -> fork), 4->2, 4->3 (4 cites
    // two predecessors -> join/merge).
    const turns = [design(1), design(2), design(3), design(4)];
    const edges = [
      edge(2, "extends", 1, ["fj"]),
      edge(3, "extends", 1, ["fj"]),
      edge(4, "consume", 2, ["fj"]),
      edge(4, "consume", 3, ["fj"]),
      edge(4, "indexes", 2, ["fj"]),
    ];
    const result = checkLanes(turns, edges);
    const path = findPath(result, ["fj"]);
    expect(path?.pathCount).toBe(2);
    expect(path?.forkNodes).toEqual([1]);
    expect(path?.joinNodes).toEqual([4]);
  });

  test("a plain chain (pathCount 1) has no fork/join nodes", () => {
    const turns = [design(801), design(802), design(803)];
    const edges = [
      edge(802, "extends", 801, ["chain"]),
      edge(803, "extends", 802, ["chain"]),
      edge(803, "indexes", 802, ["chain"]),
    ];
    const result = checkLanes(turns, edges);
    const path = findPath(result, ["chain"]);
    expect(path?.pathCount).toBe(1);
    expect(path?.forkNodes).toEqual([]);
    expect(path?.joinNodes).toEqual([]);
  });
});

describe("LaneCheckerResult.warnings passes through cross-segment tagged edges (round-4 review #5)", () => {
  test("a cross-segment tagged edge is named in the top-level `warnings` field", () => {
    const turns = [
      { id: 1, type: ["design"], segment: "A" },
      { id: 2, type: ["design"], segment: "B" },
    ];
    const edges = [edge(2, "extends", 1, ["x"])];
    const result = checkLanes(turns, edges);
    expect(result.warnings).toEqual([
      { citingId: 2, citedId: 1, tagSet: ["x"], citingSegment: "B", citedSegment: "A" },
    ]);
  });

  test("no cross-segment edges means an empty `warnings` array, not an absent field", () => {
    const result = checkLanes([design(1), design(2)], [edge(2, "extends", 1, ["y"])]);
    expect(result.warnings).toEqual([]);
  });
});

// ------------------------------------------------ report 4a: interfaces + bypass (rubric-v10 ticket 08)

describe("report 4a — inter-lane interfaces + per-declared-lane bypass", () => {
  // Lane {alpha}: 101(start) <-extends- 102(mid member) <-extends,indexes- 103(terminus).
  // Lane {beta}: 201(start) <-extends,indexes- 202(terminus).
  const turns = [design(101), design(102), design(103), design(201), design(202)];
  const laneEdges = [
    edge(102, "extends", 101, ["alpha"]),
    edge(103, "extends", 102, ["alpha"]),
    edge(103, "indexes", 102, ["alpha"]),
    edge(202, "extends", 201, ["beta"]),
    edge(202, "indexes", 201, ["beta"]),
  ];
  const alphaKey = { segment: DEFAULT_SEGMENT, tagSet: ["alpha"] };
  const betaKey = { segment: DEFAULT_SEGMENT, tagSet: ["beta"] };

  test("an untagged consume bridge between two lanes counts as ONE inter-lane interface", () => {
    const edges = [...laneEdges, edge(202, "consume", 102, [])]; // beta's terminus -> alpha's mid member
    const result = checkLanes(turns, edges);
    expect(result.interfaces).toEqual([{ laneA: alphaKey, laneB: betaKey, count: 1 }]);
  });

  test("the bridge landing on a declared lane's MID member (not its terminus) is bypass 1", () => {
    const edges = [...laneEdges, edge(202, "consume", 102, [])];
    const result = checkLanes(turns, edges);
    const alphaBypass = result.bypass.find((report) => tagSetSignature(report.key.tagSet) === tagSetSignature(["alpha"]));
    expect(alphaBypass?.count).toBe(1);
    expect(alphaBypass?.edges).toEqual([{ citingId: 202, citedId: 102, relation: "consume", tags: [] }]);
    // beta itself is never bypassed by this edge — 202 is beta's OWN terminus (the citing side), not an outside citation into beta.
    const betaBypass = result.bypass.find((report) => tagSetSignature(report.key.tagSet) === tagSetSignature(["beta"]));
    expect(betaBypass?.count).toBe(0);
  });

  test("re-pointing the SAME bridge at the lane's own terminus drops bypass to 0 — interface count is unaffected", () => {
    const edges = [...laneEdges, edge(202, "consume", 103, [])]; // now lands on alpha's terminus, 103
    const result = checkLanes(turns, edges);
    const alphaBypass = result.bypass.find((report) => tagSetSignature(report.key.tagSet) === tagSetSignature(["alpha"]));
    expect(alphaBypass?.count).toBe(0);
    expect(alphaBypass?.edges).toEqual([]);
    expect(result.interfaces).toEqual([{ laneA: alphaKey, laneB: betaKey, count: 1 }]);
  });

  test("testimony/aggregation edges crossing between two lanes never count as interfaces", () => {
    const edges = [
      ...laneEdges,
      edge(202, "indexes", 102, []), // aggregation
      edge(202, "refutes", 102, []), // testimony
    ];
    const result = checkLanes(turns, edges);
    // Neither the aggregation nor the testimony edge is in
    // LANE_COMPONENT_RELATIONS (stance+consume+grounds), so the pair has no
    // interface edge at all here — no entry is emitted (count > 0 only).
    expect(result.interfaces).toEqual([]);
  });

  test("undeclared/reopened lanes never appear in the bypass report at all", () => {
    // {gamma} is undeclared (no tagged indexes ever) -- has structural
    // members but no terminus to bypass.
    const gammaEdges = [edge(302, "extends", 301, ["gamma"])];
    const edges = [...laneEdges, ...gammaEdges];
    const result = checkLanes([...turns, design(301), design(302)], edges);
    const gammaBypass = result.bypass.find((report) => tagSetSignature(report.key.tagSet) === tagSetSignature(["gamma"]));
    expect(gammaBypass).toBeUndefined();
  });
});

// ------------------------------------------------ report 4c: time-order violations (rubric-v10 ticket 08)

describe("report 4c — time-order violations", () => {
  const turnAt = (id: number, order: readonly [number, number], createdAtEpoch?: number): LaneTurnInput => ({
    id,
    type: ["design"],
    order,
    ...(createdAtEpoch !== undefined ? { createdAtEpoch } : {}),
  });

  test("a same-session forward edge (citing prompt < cited prompt) is listed as a violation", () => {
    const turns = [turnAt(1, [1, 2]), turnAt(2, [1, 9])];
    const edges = [edge(1, "extends", 2, ["x"])]; // citing prompt 2 < cited prompt 9
    const result = checkLanes(turns, edges);
    expect(result.timeOrderViolations).toEqual([{ citingId: 1, citedId: 2, relation: "extends", tags: ["x"] }]);
  });

  test("a same-session edge where citing strictly postdates cited passes", () => {
    const turns = [turnAt(1, [1, 9]), turnAt(2, [1, 2])];
    const edges = [edge(1, "extends", 2, ["x"])]; // citing prompt 9 > cited prompt 2
    const result = checkLanes(turns, edges);
    expect(result.timeOrderViolations).toEqual([]);
  });

  // The tuple-order trap (regression): citing's (session,prompt) tuple [5,1]
  // is lexicographically GREATER than cited's [3,100] (a raw tuple compare
  // would wrongly PASS this), but citing's own wall-clock epoch is EARLIER
  // than cited's — the true, epoch-governed violation.
  test("a cross-session pair whose tuple order inverts wall-clock order fails by epoch, not tuple", () => {
    const turns = [turnAt(10, [5, 1], 2000), turnAt(11, [3, 100], 5000)];
    const edges = [edge(10, "grounds", 11, [])];
    const result = checkLanes(turns, edges);
    expect(result.timeOrderViolations).toEqual([{ citingId: 10, citedId: 11, relation: "grounds", tags: [] }]);
  });

  test("a cross-session pair with EQUAL epoch passes — ties pass", () => {
    const turns = [turnAt(20, [5, 1], 3000), turnAt(21, [3, 100], 3000)];
    const edges = [edge(20, "grounds", 21, [])];
    const result = checkLanes(turns, edges);
    expect(result.timeOrderViolations).toEqual([]);
  });

  test("a cross-session pair with citing epoch strictly greater passes", () => {
    const turns = [turnAt(30, [5, 1], 9000), turnAt(31, [3, 100], 1000)];
    const edges = [edge(30, "grounds", 31, [])];
    const result = checkLanes(turns, edges);
    expect(result.timeOrderViolations).toEqual([]);
  });

  test("self-citation is exempt even with a corrupt order", () => {
    const turns = [turnAt(40, [1, 1])];
    const edges = [edge(40, "grounds", 40, [])];
    const result = checkLanes(turns, edges);
    expect(result.timeOrderViolations).toEqual([]);
  });

  test("all eight relation words are checked — aggregation (indexes) included, not just stance/consume/grounds", () => {
    const turns = [turnAt(50, [1, 1]), turnAt(51, [1, 9])];
    const edges = [edge(50, "indexes", 51, [])]; // citing prompt 1 < cited prompt 9
    const result = checkLanes(turns, edges);
    expect(result.timeOrderViolations).toEqual([{ citingId: 50, citedId: 51, relation: "indexes", tags: [] }]);
  });

  test("a turn missing order/epoch data yields no judgement for edges touching it — never a fabricated verdict", () => {
    const turns = [design(60), turnAt(61, [1, 5])]; // 60 has no `order` at all -> falls back to [0, 60]
    const edges = [edge(61, "grounds", 60, [])]; // 61's order [1,5] vs 60's fallback [0,60]: different "session" (0 vs 1) -> cross-session, needs epoch
    const result = checkLanes(turns, edges);
    // Neither turn carries `createdAtEpoch`, so the cross-session comparison cannot be judged.
    expect(result.timeOrderViolations).toEqual([]);
  });
});

// ------------------------------------------------ milestone-election ticket 04: report 1's state line

describe("report 1's state line (milestone-election ticket 04) — closed-valid / closed-invalid / open, consumed from deriveLaneStates", () => {
  test("a plain closed lane with a living core reads closed-valid, lastDeclarer equals the terminus", () => {
    const turns = [design(30), design(31)];
    const edges = [edge(31, "extends", 30, ["v"]), edge(31, "indexes", 30, ["v"])];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, ["v"]);
    expect(stats?.state.closure).toBe("closed");
    expect(stats?.state.validity).toBe("valid");
    expect(stats?.state.terminus).toBe(31);
    expect(stats?.state.lastDeclarer).toBe(31);
  });

  // Same fixture ticket 02's own "abandonment ritual" test uses — repudiate
  // (kill the wrong conclusion via same-tag override), THEN declare closure
  // indexing the now-dead core.
  test("the abandonment ritual (repudiate, then declare closure indexing the dead core) reads closed-invalid", () => {
    const turns = [design(10), design(11), design(12), design(13)];
    const edges = [
      edge(11, "extends", 10, ["dead"]),
      edge(12, "override", 11, ["dead"]), // repudiate 11 first
      edge(13, "indexes", 11, ["dead"]), // then declare closure indexing the dead core
    ];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, ["dead"]);
    expect(stats?.state.closure).toBe("closed");
    expect(stats?.state.validity).toBe("invalid");
    expect(stats?.state.terminus).toBe(13);
    expect(stats?.state.lastDeclarer).toBe(13);
    // The rendered text says exactly "closed-invalid" — no other spelling.
    const text = renderLaneCheckerReports(result);
    expect(text).toContain("declaration: closed-invalid");
  });

  test("a lane reopened by a later override reads open, naming the pre-override winner as lastDeclarer — no invented 'last stable milestone'", () => {
    const turns = [design(101), design(102), design(103)];
    const edges = [
      edge(102, "extends", 101, ["x"]),
      edge(102, "indexes", 101, ["x"]),
      edge(103, "override", 102, ["x"]), // reopens: the lane has no living terminus any more
    ];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, ["x"]);
    expect(stats?.state.closure).toBe("open");
    expect(stats?.state.validity).toBeNull();
    expect(stats?.state.terminus).toBeNull(); // no living "last stable milestone"
    expect(stats?.state.lastDeclarer).toBe(102); // the override's own target, honestly named
    const text = renderLaneCheckerReports(result);
    expect(text).toContain("declaration: open (last declarer T102)");
  });

  test("an undeclared lane (structural continuation only, no `indexes` ever) reads open with lastDeclarer null — bare 'open', no fabricated declarer", () => {
    const turns = [design(401), design(402), design(403)];
    const edges = [edge(402, "extends", 401, ["silent"]), edge(403, "extends", 402, ["silent"])];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, ["silent"]);
    expect(stats?.state.closure).toBe("open");
    expect(stats?.state.lastDeclarer).toBeNull();
    const text = renderLaneCheckerReports(result);
    expect(text).toContain("declaration: open");
    expect(text).not.toContain("declaration: open (last declarer");
  });
});

// ------------------------------------------------ milestone-election ticket 04: used[] consume-class citations

describe("used[] — consume-class external citations (the T1351 trap fix)", () => {
  const turns = [design(1), design(2), design(3), design(4), design(5), design(6)];
  // Lane {u}: 2 extends 1, declared by 2's own tagged indexes. 3's own
  // consume edge is IN-LANE (both endpoints members of {u} — 3 is not a
  // member of {u} until it gets its own {u}-tagged edge, so give it one).
  const edges = [
    edge(2, "extends", 1, ["u"]),
    edge(2, "indexes", 1, ["u"]),
    edge(3, "consume", 2, ["u"]), // IN-LANE: 3 becomes a {u} member via this same tagged edge
    edge(4, "consume", 1, []), // EXTERNAL, untagged consume -> counts
    edge(5, "consume", 2, ["other-lane"]), // EXTERNAL, tagged with a DIFFERENT lane's set -> still counts (any tag state)
    edge(6, "verifies", 1, []), // EXTERNAL testimony, a DIFFERENT citer -> must NOT appear in used[]
  ];
  const result = checkLanes(turns, edges);
  const stats = findLaneStats(result, ["u"]);

  test("external consume citations (untagged and differently-tagged) both land in usedFromNonMembers", () => {
    const pairs = stats?.citedness.usedFromNonMembers.map((f) => `${f.citingId}->${f.citedId}`).sort();
    expect(pairs).toEqual(["4->1", "5->2"]);
  });

  test("a member's own IN-LANE consume edge (3->2, both {u} members) never enters usedFromNonMembers", () => {
    expect(stats?.citedness.usedFromNonMembers.some((f) => f.citingId === 3)).toBe(false);
    // Confirm 3 really is a member (the in-lane exclusion is doing real work, not vacuous).
    expect(stats?.members.some((m) => m.id === 3)).toBe(true);
  });

  test("testimony from outside (verifies/refutes) never enters usedFromNonMembers, only testimonyFromNonMembers", () => {
    expect(stats?.citedness.usedFromNonMembers.some((f) => f.citingId === 6)).toBe(false);
    expect(stats?.citedness.testimonyFromNonMembers).toEqual([{ citingId: 6, citedId: 1, relation: "verifies" }]);
  });

  test("the rendered text carries used[] beside grounds[]/testimony[]", () => {
    const text = renderLaneCheckerReports(result);
    expect(text).toContain("used[T4->T1, T5->T2]");
  });
});

// ------------------------------------------------ milestone-election ticket 04: reports 2/3/4 byte-stability pin

describe("reports 2/3/4 are byte-stable across the ticket 04 report-1-only change", () => {
  // Captured from the ACTUAL `renderLaneCheckerReports` output for the golden
  // fixture before ticket 04's report-1 edits landed (`## Report 2` onward,
  // verbatim) — this ticket touches only report 1's rendering
  // (`renderStatsReport`); reports 2/3/4 go through `renderComponentReport`/
  // `renderPathReport`/`renderInterfacePair`/`renderBypassReport`/
  // `renderTimeOrderViolation`/`renderSharedNodes`, none of which this ticket
  // edits. A future change that (even accidentally) perturbs any of those
  // functions' output breaks this pin.
  const REPORT_2_ONWARD_BASELINE = [
    "## Report 2 -- component integrity",
    "Lane default:{cadence} - components: 1 (healthy)",
    "  island@978: 978,979,981",
    "Lane default:{contract-repair} - components: 1 (healthy)",
    "  island@982: 982,983,984",
    "Lane default:{contract-verify} - components: 1 (healthy)",
    "  island@945: 945,946",
    "Lane default:{ownership} - components: 1 (healthy)",
    "  island@900: 900,910,912,913",
    "Lane default:{relation-vocabulary} - components: 1 (healthy)",
    "  island@933: 933,935,937,938,939",
    "Lane default:{rewind-marking} - components: 1 (healthy)",
    "  island@914: 914,915",
    "Lane default:{segment-audit} - components: 1 (healthy)",
    "  island@989: 989,990",
    "Lane default:{settlement-scope} - components: 1 (healthy)",
    "  island@900: 900,906",
    "Lane default:{spec-design} - components: 1 (healthy)",
    "  island@900: 900,901",
    "Lane default:{turn-edge-mechanism} - components: 1 (healthy)",
    "  island@926: 926,927,929",
    "Lane default:{view-spec} - components: 1 (healthy)",
    "  island@919: 919,920,921,922",
    "Lane default:{write-gate} - components: 1 (healthy)",
    "  island@950: 950,951,952,953,954,955,957,958",
    "",
    "## Report 3 -- shared components (multi-lane entanglement)",
    "component@918: default:{contract-verify}, default:{ownership}, default:{relation-vocabulary}, default:{settlement-scope}, default:{spec-design}, default:{turn-edge-mechanism}, default:{view-spec}",
    "  shared T900 (designed fork/merge): default:{ownership}, default:{settlement-scope}, default:{spec-design}",
    "component@958: default:{cadence}, default:{contract-repair}, default:{segment-audit}, default:{write-gate}",
    "",
    "## Report 4a -- inter-lane interfaces + per-lane bypass (fewer/zero is the aspiration; nothing enforced)",
    "  default:{cadence} <-> default:{segment-audit}: 1",
    "  default:{contract-verify} <-> default:{ownership}: 1",
    "  default:{contract-verify} <-> default:{relation-vocabulary}: 1",
    "  Lane default:{cadence} - bypass: 2",
    "    T985 -> T978 (grounds)",
    "    T989 -> T978 (grounds)",
    "  Lane default:{contract-repair} - bypass: 1",
    "    T985 -> T982 (consume)",
    "  Lane default:{contract-verify} - bypass: 0",
    "  Lane default:{ownership} - bypass: 5",
    "    T901 -> T900 (extends {spec-design})",
    "    T902 -> T900 (consume)",
    "    T906 -> T900 (narrows {settlement-scope})",
    "    T936 -> T910 (grounds)",
    "    T946 -> T912 (grounds)",
    "  Lane default:{relation-vocabulary} - bypass: 1",
    "    T942 -> T935 (grounds)",
    "  Lane default:{rewind-marking} - bypass: 0",
    "  Lane default:{segment-audit} - bypass: 1",
    "    T992 -> T989 (consume)",
    "  Lane default:{settlement-scope} - bypass: 3",
    "    T901 -> T900 (extends {spec-design})",
    "    T902 -> T900 (consume)",
    "    T910 -> T900 (extends {ownership})",
    "  Lane default:{spec-design} - bypass: 3",
    "    T902 -> T900 (consume)",
    "    T906 -> T900 (narrows {settlement-scope})",
    "    T910 -> T900 (extends {ownership})",
    "  Lane default:{turn-edge-mechanism} - bypass: 0",
    "  Lane default:{view-spec} - bypass: 0",
    "",
    "## Report 4b -- start-to-terminus path counts (fact, no target)",
    "Lane default:{cadence} - paths: 1 (terminus T981; starts: 978)",
    "  folded pathCount=3 (citing turns folded: 985,989,992)",
    "Lane default:{contract-repair} - paths: 1 (terminus T984; starts: 982)",
    "  folded pathCount=1 (citing turns folded: -)",
    "Lane default:{contract-verify} - paths: 1 (terminus T946; starts: 945)",
    "  folded pathCount=1 (citing turns folded: -)",
    "Lane default:{ownership} - paths: 1 (terminus T913; starts: 900)",
    "  folded pathCount=4 (citing turns folded: 936,946)",
    "Lane default:{relation-vocabulary} - paths: 1 (terminus T939; starts: 933)",
    "  folded pathCount=3 (citing turns folded: 940,942,945)",
    "Lane default:{rewind-marking} - paths: 1 (terminus T915; starts: 914)",
    "  folded pathCount=1 (citing turns folded: -)",
    "Lane default:{segment-audit} - paths: 1 (terminus T990; starts: 989)",
    "  folded pathCount=1 (citing turns folded: -)",
    "Lane default:{settlement-scope} - paths: 1 (terminus T906; starts: 900)",
    "  folded pathCount=1 (citing turns folded: -)",
    "Lane default:{spec-design} - paths: 1 (terminus T901; starts: 900)",
    "  folded pathCount=1 (citing turns folded: -)",
    "Lane default:{turn-edge-mechanism} - paths: 1 (terminus T929; starts: 926)",
    "  folded pathCount=1 (citing turns folded: 930)",
    "Lane default:{view-spec} - paths: 1 (terminus T922; starts: 919)",
    "  folded pathCount=1 (citing turns folded: 923)",
    "Lane default:{write-gate} - paths: skipped (undeclared); starts: 950",
    "",
    "## Report 4c -- time-order violations (the DAG guarantee)",
    "(none)",
    "",
    "## Cross-segment warnings",
    "(none)",
  ].join("\n");

  test("the golden fixture's report 2/3/4 text (## Report 2 through Cross-segment warnings) is byte-identical to the pre-ticket-04 baseline", () => {
    const result = checkLanes(fixtureTurns, fixtureEdges);
    const text = renderLaneCheckerReports(result);
    const tail = text.slice(
      text.indexOf("## Report 2"),
      text.indexOf("## Vocabulary conformance"),
    );
    // Trailing newlines trimmed (the blank-line separator before the new
    // "## Vocabulary conformance" section): the baseline has no trailing
    // newline of its own.
    expect(tail.replace(/\n+$/, "")).toBe(REPORT_2_ONWARD_BASELINE);
  });

  // semantic-conformance ticket 02 — appended after "## Cross-segment
  // warnings", captured by running the real implementation against the SAME
  // golden fixture (this file's own methodology throughout), not
  // hand-guessed (`/tmp/dump-vocab-tail.ts`-style probe).
  //
  // The worker's stop-and-report found T907/T944 (PreCompact marker rows,
  // `type: ["compact"]`) flagged under a literal closed-set reading. The
  // acceptance RULING exempts compact markers: they are infrastructure, not
  // annotations — the settlement facade refuses every write addressed at one
  // ("is a compact marker, not a turn"), so flagging them is permanent,
  // non-actionable noise in every window that holds a /compact. With the
  // exemption the golden fixture reads fully conforming, matching the
  // ticket's original expectation.
  test("the golden fixture is fully conforming once compact markers are exempt; no out-of-vocabulary edges are present", () => {
    const result = checkLanes(fixtureTurns, fixtureEdges);
    const text = renderLaneCheckerReports(result);
    const tail = text.slice(text.indexOf("## Cross-segment warnings"));
    expect(tail).toBe(
      [
        "## Cross-segment warnings",
        "(none)",
        "",
        "## Vocabulary conformance -- MEMORY_TYPES/EDGE_RELATIONS closed-set check (reported, never enforced)",
        "types: 0",
        "(none)",
        "edges: 0",
        "(none)",
      ].join("\n"),
    );
    expect(result.vocabularyConformance).toEqual({
      typeViolations: { count: 0, entries: [] },
      outOfVocabularyEdges: { count: 0, entries: [] },
    });
  });
  test("a compact marker row is exempt from type conformance even though 'compact' is outside MEMORY_TYPES", () => {
    const result = checkLanes(
      [
        { id: 1, type: ["compact"] },
        { id: 2, type: ["discovery"] },
      ],
      [],
    );
    expect(result.vocabularyConformance.typeViolations).toEqual({
      count: 1,
      entries: [{ id: 2, types: ["discovery"], outsideVocabulary: ["discovery"] }],
    });
  });
});
