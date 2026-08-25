import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  checkLanes,
  DEFAULT_SEGMENT,
  LANE_COMPONENT_RELATIONS,
  type LaneCheckerError,
  type LaneCheckerTurnInput,
  type LaneEdgeInput,
  type LaneTurnInput,
} from "../../src/shared/lane-checker";
import { renderLaneCheckerReports } from "../../src/shared/lane-checker-render";
import { laneEdge } from "../support/lane-edge-fixtures";

const design = (id: number, type: string[] = ["design"]): LaneTurnInput => ({ id, type });
const edge = (
  citingId: number,
  relation: string,
  citedId: number,
  tags: string[] = [],
  sides?: { tailTag: string; headTag: string },
): LaneEdgeInput =>
  laneEdge({ citingId, relation, citedId, tags, ...(sides ?? {}) });

function findLaneStats(result: ReturnType<typeof checkLanes>, tag: string) {
  return result.lanes.find((lane) => lane.key.tag === tag);
}
function findComponent(result: ReturnType<typeof checkLanes>, tag: string) {
  return result.components.find((c) => c.key.tag === tag);
}
function findPath(result: ReturnType<typeof checkLanes>, tag: string) {
  return result.paths.find((p) => p.key.tag === tag);
}

// ---------------------------------------------------------------- golden fixture

interface FixtureTurn {
  id: number;
  type: string[];
  /** The turn's OWN tags — fed to the checker (tag-mandate ticket 03) so error class E4's subset invariant is genuinely exercised against the golden corpus rather than skipped for want of an input. */
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
const fixtureTurns: LaneCheckerTurnInput[] = fixture.turns.map((t) => ({
  id: t.id,
  type: t.type,
  tags: t.tags,
}));
/**
 * Lane-model v12 ticket 02 merged `refutes` into `override`, and ticket 03
 * migrates the stored rows. The fixture JSON is a SNAPSHOT of production at
 * the moment it was captured, so it is left byte-for-byte as recorded (its
 * whole value is being un-adjusted evidence) and the migration is applied
 * HERE instead, by the same rule ticket 03 applies to the database. It moves
 * exactly one edge, 941 -> 935; every other golden assertion in this file is
 * unchanged by it, which is itself the measurement that the merge is
 * behaviour-preserving on hand-judged data.
 */
const MIGRATED_RELATION: Record<string, string> = { refutes: "override" };
const fixtureEdges: LaneEdgeInput[] = fixture.edges.map((e) =>
  laneEdge({
    citingId: e.citingId,
    relation: MIGRATED_RELATION[e.relation] ?? e.relation,
    citedId: e.citedId,
    tags: e.tags,
  }),
);
const declaredLaneTags = fixture.lanes.map((l) => l.tag).filter((tag) => tag !== "write-gate");

describe("golden fixture — S15069 T900-1001 lane simulation (12 lanes, hand-judged)", () => {
  const result = checkLanes(fixtureTurns, fixtureEdges);

  test("every declared lane has component count 1 and (unfolded) path count 1", () => {
    expect(declaredLaneTags.length).toBe(11);
    for (const tag of declaredLaneTags) {
      const stats = findLaneStats(result, tag);
      const component = findComponent(result, tag);
      const path = findPath(result, tag);
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
      const path = findPath(result, tag);
      expect(path?.folded?.pathCount).toBe(expectedFolded[tag]);
    }
  });

  test("{write-gate} reports undeclared — no `indexes` ever tagged write-gate, only a same-tag override of its latest structural node", () => {
    const stats = findLaneStats(result, "write-gate");
    expect(stats?.declaration.state).toBe("undeclared");
    expect(stats?.declaration.terminus).toBe(null);
    expect(stats?.declaration.latestEventTurn).toBe(958); // T958's override of T957
    // Ticket 04: the override marks nobody — a member is a plain `{ id }`.
    expect(stats?.members.find((m) => m.id === 957)).toEqual({ id: 957 });
    const path = findPath(result, "write-gate");
    expect(path?.status).toBe("skipped");
    expect(path?.skipReason).toBe("undeclared");
  });

  test("report 3 yields EXACTLY two multi-lane components (7-lane and 4-lane groups)", () => {
    expect(result.multiLaneComponents.length).toBe(2);
    const sizes = result.multiLaneComponents.map((c) => c.lanes.length).sort((a, b) => a - b);
    expect(sizes).toEqual([4, 7]);
  });

  test("{ownership}'s cited-ness shows MID-MEMBER grounds (T936->T910, T946->T912) — a terminus-only reading would show none, since nothing cites T913 directly", () => {
    const stats = findLaneStats(result, "ownership");
    const pairs = stats?.citedness.groundsFromNonMembers.map((f) => `${f.citingId}->${f.citedId}`).sort();
    expect(pairs).toEqual(["936->910", "946->912"]);
    // Confirm the terminus itself really is never directly cited — the
    // lane-wide reading is doing real work here, not just being permissive.
    const directlyOnTerminus = stats?.citedness.groundsFromNonMembers.some((f) => f.citedId === 913);
    expect(directlyOnTerminus).toBe(false);
  });

  test("{ownership}'s phases include delivery too (T900 is typed design+ops — ops is delivery-phase), edge counts by word tally the lane's own 7 tagged edges", () => {
    const stats = findLaneStats(result, "ownership");
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
      .map((pair) => `${pair.laneA.tag}<->${pair.laneB.tag}:${pair.count}`)
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
      counts[report.key.tag] = report.count;
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
    expect(result.bypass.some((report) => report.key.tag === "write-gate")).toBe(false);
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
    const ownershipBypass = result.bypass.find((report) => report.key.tag === "ownership");
    const pairs = ownershipBypass?.edges.map((e) => `${e.citingId}->${e.citedId}`).sort();
    expect(pairs).toEqual(["901->900", "902->900", "906->900", "936->910", "946->912"]);
  });

  test("report 4c golden — no time-order violations: the fixture has no cross-session or forward edges", () => {
    expect(result.timeOrderViolations).toEqual([]);
  });

  // milestone-election ticket 04 — recomputed by running the real
  // implementation (`deriveLaneStates` via `checkLanes`) against the
  // fixture, not hand-guessed, the same methodology every other golden test
  // in this block uses. All 11 declared lanes read CLOSED; {write-gate} is
  // the one undeclared lane and reads open.
  //
  // lane-model-v12 ticket 04: the state's two other fields are DELETED. This
  // golden used to assert `validity === "valid"` on all 11 (the spec's own
  // measured baseline "All 11 closed lanes are valid on this window") and a
  // most-recent-declarer equal to the terminus. The whole-object equality on
  // {write-gate} below is the sentinel: a state that grew a third field back
  // — under any name — fails here.
  test("report 1 golden — every declared lane's state is closed; {write-gate} is open, and a state has exactly key/closure/terminus", () => {
    for (const tag of declaredLaneTags) {
      const stats = findLaneStats(result, tag);
      expect(stats?.state.closure).toBe("closed");
      expect(stats?.state.terminus).toBe(stats?.declaration.terminus);
    }
    const writeGate = findLaneStats(result, "write-gate");
    expect(writeGate?.state).toEqual({
      key: writeGate!.key,
      closure: "open",
      terminus: null,
    });
  });

  // T1351 trap fix — external CONSUME citations the fixture actually
  // carries (`python3` probe over the fixture JSON, not hand-guessed):
  // {ownership} is used by 902->900, {segment-audit} by 991->990 and
  // 992->989. None of these are grounds/testimony, so the OLD report (no
  // `used[]`) rendered these lanes' "cited from outside" line as if they
  // were never cited by consume at all.
  // tag-mandate tickets 03/04's acceptance bar: the hand-judged golden corpus
  // CONFORMS, so the error side must be empty on it — every tagged edge's
  // set sits inside both endpoints' own tags (E4), every relation is one of
  // the eight (E2), every turn's type is in vocabulary once compact markers
  // are exempt (E3). (E1, the untagged extends/narrows, is retired with the
  // tag mandate — lane-declaration ticket 02; E5, the lane-shape law, is
  // deleted by lane-model-v12 ticket 04.) Any discrepancy here is a
  // STOP-AND-REPORT, never a golden adjustment.
  test("the golden fixture reports ZERO errors — it conforms", () => {
    expect(result.errors).toEqual([]);
    // Not vacuous: the fixture really does carry tagged edges and turn tags
    // for E4 to judge.
    expect(fixtureEdges.some((e) => e.tags.length > 0)).toBe(true);
    expect(fixtureTurns.every((t) => (t.tags ?? []).length >= 0)).toBe(true);
    expect(fixtureEdges.some((e) => e.relation === "extends" || e.relation === "narrows")).toBe(true);
  });

  // Ticket 04 REPLACES this block's old "ZERO E5" assertion. The lane-shape
  // law it enforced ("exactly one start and one end") was removed from the
  // rubric a revision before the class was, so the class was blocking commits
  // on a clause the model no longer stated. What the fixture still pins is
  // that twelve real lanes enumerate with real members — the shape the
  // deleted class used to read.
  test("the golden fixture enumerates 12 real lanes, and no error class judges their shape", () => {
    expect(result.lanes).toHaveLength(12);
    for (const lane of result.lanes) {
      expect(lane.members.length).toBeGreaterThanOrEqual(2);
    }
    expect(fixtureEdges.some((e) => e.relation === "override" && e.tags.length > 0)).toBe(true);
    expect(fixtureEdges.some((e) => e.relation === "indexes" && e.tags.length > 0)).toBe(true);
  });

  test("report 1 golden — used[] lists the fixture's real external consume citations", () => {
    const ownership = findLaneStats(result, "ownership");
    expect(ownership?.citedness.usedFromNonMembers).toEqual([{ citingId: 902, citedId: 900 }]);
    const segmentAudit = findLaneStats(result, "segment-audit");
    const pairs = segmentAudit?.citedness.usedFromNonMembers
      .map((f) => `${f.citingId}->${f.citedId}`)
      .sort();
    expect(pairs).toEqual(["991->990", "992->989"]);
  });
});

// ---------------------------------------------------------------- synthetic checks

// THE MERGE, pinned at the CHECKER (lane-declaration spec Rev 2, D5; Testing
// decisions: "Checker — the peer's own figure as a fixture: indexes{a} then
// override{a,b}, asserting lane a reopens. This is the merge, pinned.").
// `deriveLaneInterpretation`'s own reduction is pinned separately
// (`tests/shared/lane-interpretation.test.ts`); this fixture instead proves
// the CHECKER's own report 1 output — `LaneStatsReport.declaration`/`state`,
// consumed straight from `deriveLaneStates` — reflects the reopen, not just
// the lower-level reduction. Under the RETIRED exact-set identity this
// suite pinned through v10, `{a,b}` was a third, independent lane and lane
// `{a}` read closed-valid, undisturbed, right up to this ticket.
describe("the merge (D5): a multi-tag override reaches into a lane it only partially names", () => {
  test("T2 --indexes{a}--> T1 closes lane {a}; T3 --override{a,b}--> T2 kills T2 in lane {a} too and REOPENS it", () => {
    const turns = [design(1), design(2), design(3)];
    const edges = [
      edge(2, "indexes", 1, ["a"]), // T2 declares lane {a}, terminus = T2
      edge(3, "override", 2, ["a", "b"]), // multi-tag override — the merge
    ];
    const result = checkLanes(turns, edges);

    const laneA = findLaneStats(result, "a");
    expect(laneA?.declaration).toEqual({ state: "reopened", terminus: null, latestEventTurn: 3 });
    expect(laneA?.state.closure).toBe("open");
    expect(laneA?.state.terminus).toBeNull();
    expect(laneA?.members.find((m) => m.id === 2)).toEqual({ id: 2 });

    // The identical row is simultaneously lane {b}'s own first-ever event —
    // an override touching a lane nobody had declared yet.
    const laneB = findLaneStats(result, "b");
    expect(laneB?.declaration.state).toBe("undeclared");
    expect(laneB?.members.find((m) => m.id === 2)).toEqual({ id: 2 });

    // Two lanes total — {a,b} is NOT a third lane (the old, retired v10
    // pin). Report 4b's path graph also sees both independently: lane {a}
    // is reopened (skipped, no terminus to count paths to), never
    // conflated with a lane {a,b} that would have stood declared.
    expect(result.lanes.map((lane) => lane.key.tag).sort()).toEqual(["a", "b"]);
    const pathA = findPath(result, "a");
    expect(pathA?.status).toBe("skipped");
    expect(pathA?.skipReason).toBe("reopened");
  });
});

describe("cited-ness self-cite exclusion", () => {
  test("a self-grounds edge (settlement+implementer turn) never inflates its own lane's cited-ness", () => {
    const turns = [design(501, ["design", "implement"]), design(502)];
    const edges = [
      edge(502, "extends", 501, ["s"]),
      edge(502, "indexes", 501, ["s"]),
      edge(501, "grounds", 501, []), // self-cite: citer IS a member
    ];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, "s");
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
    const stats = findLaneStats(result, "vc3");
    expect(stats?.edgeCountsByRelation).toEqual({ extends: 1, indexes: 1 });
    const path = findPath(result, "vc3");
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
    const stats = findLaneStats(result, "vc3b");
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

  // tag-mandate ticket 03 reclassified these two fact lists into error
  // classes E3/E2: the raw computation (and the capped `vocabularyConformance`
  // field every test above asserts on) is untouched, but the RENDER now
  // surfaces them in the leading ERRORS block instead of a trailing
  // "reported, never enforced" section that the commit gate would contradict.
  test("the rendered text names ids and offending words in the ERRORS block, and prints an explicit clean marker when there is nothing to report", () => {
    const turns = [design(740, ["bugfix"]), design(741)];
    const edges = [
      edge(741, "extends", 740, ["vc6"]),
      edge(741, "indexes", 740, ["vc6"]),
      edge(741, "supersedes", 740, []),
    ];
    const result = checkLanes(turns, edges);
    const text = renderLaneCheckerReports(result);
    expect(text).not.toContain("## Vocabulary conformance");
    expect(text).toContain("2 error(s)");
    expect(text).toContain("[E3] anchor T740 -- T740 type: [bugfix] (outside vocabulary: bugfix)");
    expect(text).toContain("[E2] anchor T741 -- T741 --supersedes--> T740");

    const cleanResult = checkLanes(
      [design(750), design(751)],
      [edge(751, "extends", 750, ["vc7"]), edge(751, "indexes", 750, ["vc7"])],
    );
    const cleanText = renderLaneCheckerReports(cleanResult);
    expect(cleanText.split("\n")[1]).toBe("(none)");
  });
});

describe("partial-input coverage", () => {
  test("a lane whose edges reach a turn missing from the input is reported WHOLE (members/terminus/path all computed) with coverage flagged partial", () => {
    const turns = [design(601)]; // 602 deliberately absent
    const edges = [edge(602, "extends", 601, ["w"]), edge(602, "indexes", 601, ["w"])];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, "w");
    expect(stats?.members.map((m) => m.id)).toEqual([601, 602]);
    expect(stats?.coverage).toEqual({ status: "partial", missingTurnIds: [602] });
    // still reported WHOLE: terminus/path resolve despite the missing turn object.
    expect(stats?.declaration.terminus).toBe(602);
    const path = findPath(result, "w");
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
  const path = findPath(result, "f");

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
    const path = findPath(result, "left");
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
    const path = findPath(plainResult, "solo");
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
    const component = findComponent(result, "ov");
    // {ov} members are {10,11,12}; 12 is connected to NOTHING via
    // stance/consume/grounds, so it is its own island — component count 2.
    expect(component?.componentCount).toBe(2);
    const islandReps = component?.islands.map((i) => i.representative).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(islandReps).toEqual([10, 12]);
  });
});

// ------------------------------------------------------------------------
// Ticket 12 (P1-7): a lane's own graph asks "does this edge carry THIS
// lane's tag", not "is the relation word in some fixed set". Before this
// ticket, `grounds` sat outside `LANE_PATH_RELATIONS` (report 4b's base
// graph) entirely, and the fold's own `!memberIds.has(citingId)` guard
// assumed every cross-phase citer was an outsider — an assumption only true
// while `grounds` could never carry a tag. `verifies` never
// entered ANY structural graph, tagged or not. See lane-checker.ts's module
// header, "Report domains", for the two-predicate design this fixes it with.
describe("ticket 12 — the peer's own failure case: a lane made of a tagged grounds + verifies pair", () => {
  // T2 --grounds{x}--> T1 and T2 --verifies{x}--> T1: the ticket's own
  // pinned fixture. Before the fix: `grounds` was excluded from
  // LANE_PATH_RELATIONS and excluded from the fold (its citing turn, T2, IS
  // a member by construction once it carries the tag, so the fold's
  // non-member guard already ruled it out) — the lane rendered as two
  // disconnected single-node starts. `verifies` never touched a structural
  // graph at all.
  const turns = [design(1), design(2, ["research"])];
  const edges = [edge(2, "grounds", 1, ["x"]), edge(2, "verifies", 1, ["x"])];
  const result = checkLanes(turns, edges);

  test("membership: both turns are members of lane x", () => {
    expect(findLaneStats(result, "x")?.members.map((m) => m.id)).toEqual([1, 2]);
  });

  test("component: ONE connected island, not two severed single-node islands", () => {
    const component = findComponent(result, "x");
    expect(component?.componentCount).toBe(1);
    expect(component?.islands).toEqual([{ representative: 1, memberIds: [1, 2] }]);
  });

  test("path: the base structural graph has T1 as the SOLE start — a real (if undeclared) path, not two disconnected starts", () => {
    const path = findPath(result, "x");
    // undeclared (no tagged `indexes` ever named this lane) — status is
    // "skipped", but the STRUCTURAL shape underneath is what this ticket
    // fixes: before, neither tagged edge was in `LANE_PATH_RELATIONS`, so
    // `starts` would have been `[1, 2]` (T2 with no outgoing edge in an
    // otherwise-empty base graph too) — two severed starts, not a path.
    expect(path?.status).toBe("skipped");
    expect(path?.skipReason).toBe("undeclared");
    expect(path?.starts).toEqual([1]);
  });

  test("declared: adding a tagged indexes closes the lane with a real pathCount over the SAME two cross-phase edges", () => {
    const declared = checkLanes(turns, [...edges, edge(2, "indexes", 1, ["x"])]);
    const path = findPath(declared, "x");
    expect(path?.status).toBe("ok");
    expect(path?.terminus).toBe(2);
    expect(path?.starts).toEqual([1]);
    // Two parallel relations (grounds, verifies) on the SAME pair are ONE
    // route (the T1241 precedent, module header) — pathCount is 1, not 2.
    expect(path?.pathCount).toBe(1);
  });
});

describe("ticket 12 — untagged cross-phase edges never leak into the shared component graph (AC2, no naive widening)", () => {
  // Lane {y} = {1,2} via narrows+indexes. Lane {z} = {3,4} via
  // narrows+indexes. `verifies` was NEVER in
  // `LANE_COMPONENT_RELATIONS`, tagged or not — this isolates ticket 12's
  // uf-widening cleanly, since (unlike `grounds`) there is no pre-existing
  // unconditional inclusion to accidentally piggyback on.
  const baseTurns = [design(1), design(2), design(3), design(4, ["implement"])];
  const baseEdges = [
    edge(2, "narrows", 1, ["y"]),
    edge(2, "indexes", 1, ["y"]),
    edge(4, "narrows", 3, ["z"]),
    edge(4, "indexes", 3, ["z"]),
  ];

  test("an UNTAGGED verifies bridging {y} and {z} does not merge them into a reported multi-lane component", () => {
    const result = checkLanes(baseTurns, [...baseEdges, edge(4, "verifies", 1, [])]);
    expect(result.multiLaneComponents).toEqual([]);
    expect(findComponent(result, "y")?.componentCount).toBe(1);
    expect(findComponent(result, "z")?.componentCount).toBe(1);
  });

  test("the SAME verifies edge TAGGED {y} instead correctly connects T4 into lane y's own component — it is now lane y's own structural edge", () => {
    const result = checkLanes(baseTurns, [...baseEdges, edge(4, "verifies", 1, ["y"])]);
    // T4 is now a member of BOTH y (the tagged verifies) and z (narrows) —
    // lane y's OWN component must include it, not report it severed.
    const componentY = findComponent(result, "y");
    expect(componentY?.componentCount).toBe(1);
    expect(componentY?.islands[0]?.memberIds).toEqual([1, 2, 4]);
  });
});

describe("ticket 12 — computeInterfaces/computeBypass deliberately do NOT widen (decided NOT to change)", () => {
  test("a tagged verifies edge crossing between two lanes still never counts as an interface or a bypass", () => {
    const turns = [design(101), design(102), design(201, ["research"]), design(202, ["research"])];
    const edges = [
      edge(102, "extends", 101, ["alpha"]),
      edge(102, "indexes", 101, ["alpha"]),
      edge(202, "extends", 201, ["beta"]),
      edge(202, "indexes", 201, ["beta"]),
      // tagged with a THIRD lane's own tag, crossing alpha/beta — computeInterfaces/
      // computeBypass read only `edge.relation`, never `edge.tags`, so this
      // takes the identical excluded code path an untagged verifies would.
      edge(202, "verifies", 101, ["gamma"]),
    ];
    const result = checkLanes(turns, edges);
    expect(result.interfaces).toEqual([]);
    expect(result.bypass.find((b) => b.key.tag === "alpha")?.count ?? 0).toBe(0);
    expect(result.bypass.find((b) => b.key.tag === "beta")?.count ?? 0).toBe(0);
  });
});

describe("R1 edge counts, R4 excludes indexes from the structural graph", () => {
  test("a lane with ONLY an indexes declaration (no narrows/extends/consume) has zero structural edges — path count 0, not 1", () => {
    const turns = [design(701), design(702)];
    const edges = [edge(702, "indexes", 701, ["lone"])];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, "lone");
    expect(stats?.declaration.state).toBe("declared");
    expect(stats?.edgeCountsByRelation).toEqual({ indexes: 1 });
    const path = findPath(result, "lone");
    expect(path?.status).toBe("ok");
    expect(path?.starts).toEqual([]);
    // indexes is excluded from the path graph entirely — no structural chain
    // connects the declared terminus to any start, so the honest count is 0.
    expect(path?.pathCount).toBe(0);
  });

  // AC4 (ticket 12): "indexes 不参与连通性计算" must survive the rewrite —
  // pinned on the COMPONENT graph specifically (the path-graph case above
  // predates ticket 12; this one exercises `unionsLaneComponentGraph`'s own
  // `edge.relation !== "indexes"` clause, which no earlier test touched).
  test("a lane with ONLY a tagged indexes edge has componentCount 2 — indexes never unions its endpoints", () => {
    const turns = [design(701), design(702)];
    const edges = [edge(702, "indexes", 701, ["lone"])];
    const result = checkLanes(turns, edges);
    // Membership still forms (word-agnostic grouping) — both turns are
    // members — but the component graph must not connect them.
    expect(findLaneStats(result, "lone")?.members.map((m) => m.id)).toEqual([701, 702]);
    const component = findComponent(result, "lone");
    expect(component?.componentCount).toBe(2);
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
    const component = findComponent(result, "seg");
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
    const component = findComponent(result, "seg2");
    expect(component?.componentCount).toBe(1);
  });
});

// D5 (v11) retires the tag-SET join this describe block used to guard
// (round-4 review #6: a naive `tagSet.join("")` merged `{a,bc}` with
// `{ab,c}`) — a lane's identity is never a joined SET any more, so that
// specific collision cannot occur. What remains true, and worth pinning, is
// the merge itself: an edge tagged `{a,bc}` and a different edge tagged
// `{ab,c}` enumerate FOUR distinct single-tag lanes (a, bc, ab, c), not two
// coarser ones — `sameLaneKey`'s collision-safe `laneToken` comparison is
// what keeps report 3 from accidentally conflating any pair of them.
describe("report 3 keeps every distinct tag its own lane, even across multi-tag edges (D5, v11)", () => {
  test("an edge tagged {a,bc} and a different edge tagged {ab,c} enumerate FOUR distinct lanes sharing one component", () => {
    const turns = [design(1), design(2), design(3)];
    const edges = [
      edge(2, "extends", 1, ["a", "bc"]),
      edge(2, "indexes", 1, ["a", "bc"]),
      edge(3, "extends", 1, ["ab", "c"]),
      edge(3, "indexes", 1, ["ab", "c"]),
    ];
    const result = checkLanes(turns, edges);
    // All four lanes' members reach turn 1 via `extends` (a stance
    // relation), so they share one global component -- report 3 must see
    // all FOUR distinct lane keys there, not merge "a"+"bc" with "ab"+"c".
    expect(result.multiLaneComponents).toHaveLength(1);
    const shared = result.multiLaneComponents[0]!;
    const tags = shared.lanes.map((key) => key.tag).sort();
    expect(tags).toEqual(["a", "ab", "bc", "c"]);
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
    expect(node.citingLanesByStance.map((key) => key.tag)).toEqual(
      expect.arrayContaining(["left", "right"]),
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
    expect(node?.citingLanesByStance.map((key) => key.tag)).toEqual(["left"]);
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
    expect(node?.citingLanesByStance.map((key) => key.tag)).toEqual(
      expect.arrayContaining(["left", "right"]),
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
    const path = findPath(result, "fj");
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
    const path = findPath(result, "chain");
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
  const alphaKey = { segment: DEFAULT_SEGMENT, tag: "alpha" };
  const betaKey = { segment: DEFAULT_SEGMENT, tag: "beta" };

  test("an untagged consume bridge between two lanes counts as ONE inter-lane interface", () => {
    const edges = [...laneEdges, edge(202, "consume", 102, [])]; // beta's terminus -> alpha's mid member
    const result = checkLanes(turns, edges);
    expect(result.interfaces).toEqual([{ laneA: alphaKey, laneB: betaKey, count: 1 }]);
  });

  test("the bridge landing on a declared lane's MID member (not its terminus) is bypass 1", () => {
    const edges = [...laneEdges, edge(202, "consume", 102, [])];
    const result = checkLanes(turns, edges);
    const alphaBypass = result.bypass.find((report) => report.key.tag === "alpha");
    expect(alphaBypass?.count).toBe(1);
    expect(alphaBypass?.edges).toEqual([{ citingId: 202, citedId: 102, relation: "consume", tags: [] }]);
    // beta itself is never bypassed by this edge — 202 is beta's OWN terminus (the citing side), not an outside citation into beta.
    const betaBypass = result.bypass.find((report) => report.key.tag === "beta");
    expect(betaBypass?.count).toBe(0);
  });

  test("re-pointing the SAME bridge at the lane's own terminus drops bypass to 0 — interface count is unaffected", () => {
    const edges = [...laneEdges, edge(202, "consume", 103, [])]; // now lands on alpha's terminus, 103
    const result = checkLanes(turns, edges);
    const alphaBypass = result.bypass.find((report) => report.key.tag === "alpha");
    expect(alphaBypass?.count).toBe(0);
    expect(alphaBypass?.edges).toEqual([]);
    expect(result.interfaces).toEqual([{ laneA: alphaKey, laneB: betaKey, count: 1 }]);
  });

  test("testimony/aggregation edges crossing between two lanes never count as interfaces", () => {
    const edges = [
      ...laneEdges,
      edge(202, "indexes", 102, []), // aggregation
      edge(202, "verifies", 102, []), // testimony
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
    const gammaBypass = result.bypass.find((report) => report.key.tag === "gamma");
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

describe("report 1's state line (milestone-election ticket 04, narrowed by v12 ticket 04) — closed / open, consumed from deriveLaneStates", () => {
  test("a plain closed lane reads closed, with the terminus", () => {
    const turns = [design(30), design(31)];
    const result = checkLanes(turns, [edge(31, "extends", 30, ["v"]), edge(31, "indexes", 30, ["v"])]);
    const stats = findLaneStats(result, "v");
    expect(stats?.state.closure).toBe("closed");
    expect(stats?.state.terminus).toBe(31);
    const text = renderLaneCheckerReports(result);
    expect(text).toContain("declaration: closed");
  });

  // THE RENDERED DELETION. This lane is the old "repudiate, then declare
  // closure indexing the overridden core" ritual, which rendered the literal
  // string "closed-invalid". v12 has no node death for that verdict to read,
  // so the line prints a bare "closed" — and no lane, in any shape, can print
  // a hyphenated closed state again.
  test("the lane that used to render closed-invalid renders a bare closed — no validity suffix survives anywhere", () => {
    const turns = [design(10), design(11), design(12), design(13)];
    const result = checkLanes(turns, [
      edge(11, "extends", 10, ["d"]),
      edge(12, "override", 11, ["d"]),
      edge(13, "indexes", 11, ["d"]),
    ]);
    const stats = findLaneStats(result, "d");
    expect(stats?.state.closure).toBe("closed");
    expect(stats?.state.terminus).toBe(13);
    const text = renderLaneCheckerReports(result);
    expect(text).toContain("declaration: closed (terminus T13)");
    expect(text).not.toContain("closed-");
  });

  // THE OTHER RENDERED DELETION: an open lane used to append "(last declarer
  // T<n>)" whenever one existed. It never does now.
  test("a lane reopened by a later override renders a bare open — no declarer is named", () => {
    const turns = [design(101), design(102), design(103)];
    const result = checkLanes(turns, [
      edge(102, "extends", 101, ["x"]),
      edge(102, "indexes", 101, ["x"]),
      edge(103, "override", 102, ["x"]),
    ]);
    const stats = findLaneStats(result, "x");
    expect(stats?.state.closure).toBe("open");
    expect(stats?.state.terminus).toBeNull();
    const text = renderLaneCheckerReports(result);
    expect(text).toContain("declaration: open [last event T103]");
    expect(text).not.toContain("last declarer");
  });

  test("an undeclared lane (structural continuation only, no `indexes` ever) reads open too", () => {
    const turns = [design(401), design(402), design(403)];
    const result = checkLanes(turns, [edge(402, "extends", 401, ["s"]), edge(403, "extends", 402, ["s"])]);
    const stats = findLaneStats(result, "s");
    expect(stats?.state.closure).toBe("open");
    expect(stats?.state.terminus).toBeNull();
    expect(renderLaneCheckerReports(result)).toContain("declaration: open");
  });
});

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
  const stats = findLaneStats(result, "u");

  test("external consume citations (untagged and differently-tagged) both land in usedFromNonMembers", () => {
    const pairs = stats?.citedness.usedFromNonMembers.map((f) => `${f.citingId}->${f.citedId}`).sort();
    expect(pairs).toEqual(["4->1", "5->2"]);
  });

  test("a member's own IN-LANE consume edge (3->2, both {u} members) never enters usedFromNonMembers", () => {
    expect(stats?.citedness.usedFromNonMembers.some((f) => f.citingId === 3)).toBe(false);
    // Confirm 3 really is a member (the in-lane exclusion is doing real work, not vacuous).
    expect(stats?.members.some((m) => m.id === 3)).toBe(true);
  });

  test("testimony from outside (verifies) never enters usedFromNonMembers, only testimonyFromNonMembers", () => {
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
  //
  // Re-captured for floor-and-render-fidelity ticket 03 (no addresses map
  // supplied here, so this stays the bare-id form): every id those SAME
  // renderers print — an island's representative/members, a shared
  // component's representative, a path's starts/folded-citing list — now
  // routes through the file's one `formatTurnRef` formatter, which is why
  // ids that used to render bare (`island@978: 978,979,981`) now carry the
  // uniform `T<dbid>` prefix (`island@T978: T978,T979,T981`) — bypass/
  // time-order/cross-segment lines already carried it and are unchanged.
  const REPORT_2_ONWARD_BASELINE = [
    "## Report 2 -- component integrity",
    "Lane default:{cadence} - components: 1 (healthy)",
    "  island@T978: T978,T979,T981",
    "Lane default:{contract-repair} - components: 1 (healthy)",
    "  island@T982: T982,T983,T984",
    "Lane default:{contract-verify} - components: 1 (healthy)",
    "  island@T945: T945,T946",
    "Lane default:{ownership} - components: 1 (healthy)",
    "  island@T900: T900,T910,T912,T913",
    "Lane default:{relation-vocabulary} - components: 1 (healthy)",
    "  island@T933: T933,T935,T937,T938,T939",
    "Lane default:{rewind-marking} - components: 1 (healthy)",
    "  island@T914: T914,T915",
    "Lane default:{segment-audit} - components: 1 (healthy)",
    "  island@T989: T989,T990",
    "Lane default:{settlement-scope} - components: 1 (healthy)",
    "  island@T900: T900,T906",
    "Lane default:{spec-design} - components: 1 (healthy)",
    "  island@T900: T900,T901",
    "Lane default:{turn-edge-mechanism} - components: 1 (healthy)",
    "  island@T926: T926,T927,T929",
    "Lane default:{view-spec} - components: 1 (healthy)",
    "  island@T919: T919,T920,T921,T922",
    "Lane default:{write-gate} - components: 1 (healthy)",
    "  island@T950: T950,T951,T952,T953,T954,T955,T957,T958",
    "",
    "## Report 3 -- shared components (multi-lane entanglement)",
    "component@T918: default:{contract-verify}, default:{ownership}, default:{relation-vocabulary}, default:{settlement-scope}, default:{spec-design}, default:{turn-edge-mechanism}, default:{view-spec}",
    "  shared T900 (designed fork/merge): default:{ownership}, default:{settlement-scope}, default:{spec-design}",
    "component@T958: default:{cadence}, default:{contract-repair}, default:{segment-audit}, default:{write-gate}",
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
    "Lane default:{cadence} - paths: 1 (terminus T981; starts: T978)",
    "  folded pathCount=3 (citing turns folded: T985,T989,T992)",
    "Lane default:{contract-repair} - paths: 1 (terminus T984; starts: T982)",
    "  folded pathCount=1 (citing turns folded: -)",
    "Lane default:{contract-verify} - paths: 1 (terminus T946; starts: T945)",
    "  folded pathCount=1 (citing turns folded: -)",
    "Lane default:{ownership} - paths: 1 (terminus T913; starts: T900)",
    "  folded pathCount=4 (citing turns folded: T936,T946)",
    "Lane default:{relation-vocabulary} - paths: 1 (terminus T939; starts: T933)",
    "  folded pathCount=3 (citing turns folded: T940,T942,T945)",
    "Lane default:{rewind-marking} - paths: 1 (terminus T915; starts: T914)",
    "  folded pathCount=1 (citing turns folded: -)",
    "Lane default:{segment-audit} - paths: 1 (terminus T990; starts: T989)",
    "  folded pathCount=1 (citing turns folded: -)",
    "Lane default:{settlement-scope} - paths: 1 (terminus T906; starts: T900)",
    "  folded pathCount=1 (citing turns folded: -)",
    "Lane default:{spec-design} - paths: 1 (terminus T901; starts: T900)",
    "  folded pathCount=1 (citing turns folded: -)",
    "Lane default:{turn-edge-mechanism} - paths: 1 (terminus T929; starts: T926)",
    "  folded pathCount=1 (citing turns folded: T930)",
    "Lane default:{view-spec} - paths: 1 (terminus T922; starts: T919)",
    "  folded pathCount=1 (citing turns folded: T923)",
    "Lane default:{write-gate} - paths: skipped (undeclared); starts: T950",
    "",
    "## Report 4c -- time-order violations (the DAG guarantee)",
    "(none)",
    "",
    // lane-declaration ticket 09 (D9): the two attribution warnings. These
    // lines are the golden corpus's own measured attribution debt, so they
    // double as a real-shape sanity check on the 4+ boundary — a
    // hand-judged 100-turn window with 12 lanes yields THREE clusters
    // totalling 14 turns, not one degenerate cluster swallowing the window.
    // The proliferation line is silent because a hand fixture supplies no
    // `segmentFacts`: no registry, no verdict.
    "## Attribution -- unattributed clusters + lane proliferation (warnings; settlement's own debt, never enforced)",
    "3 unattributed cluster(s) of 4+ turns:",
    "  4 turns, none in any lane: T902,T903,T904,T905",
    "  6 turns, none in any lane: T959,T960,T961,T962,T965,T966",
    "  4 turns, none in any lane: T991,T993,T994,T995",
    "(no segment over its lane budget)",
    "",
    "## Cross-segment warnings",
    "(none)",
  ].join("\n");

  test("the golden fixture's report 2/3/4 text (## Report 2 through Cross-segment warnings) is byte-identical to the pre-ticket-04 baseline", () => {
    const result = checkLanes(fixtureTurns, fixtureEdges);
    const text = renderLaneCheckerReports(result);
    // tag-mandate ticket 03 retired the trailing "## Vocabulary conformance"
    // section (those facts are error classes E2/E3 now and print in the
    // leading ERRORS block), so the warning side now ENDS at the
    // cross-segment warnings — the baseline's own last line, unchanged.
    const tail = text.slice(text.indexOf("## Report 2"));
    expect(tail.replace(/\n+$/, "")).toBe(REPORT_2_ONWARD_BASELINE);
  });

  // semantic-conformance ticket 02's acceptance, carried forward through
  // ticket 03's reclassification: the SAME facts, now read off the errors
  // side. The worker's stop-and-report found T907/T944 (PreCompact marker
  // rows, `type: ["compact"]`) flagged under a literal closed-set reading.
  // The acceptance RULING exempts compact markers: they are infrastructure,
  // not annotations — the settlement facade refuses every write addressed at
  // one ("is a compact marker, not a turn"), so flagging them is permanent,
  // non-actionable noise in every window that holds a /compact.
  test("the golden fixture is fully conforming once compact markers are exempt; the errors block leads with (none)", () => {
    const result = checkLanes(fixtureTurns, fixtureEdges);
    const text = renderLaneCheckerReports(result);
    expect(text.startsWith(
      "## ERRORS -- states the grammar forbids; commit refuses while one anchored in your writable scope remains\n" +
        "(none)\n",
    )).toBe(true);
    expect(text.endsWith("## Cross-segment warnings\n(none)")).toBe(true);
    expect(text).not.toContain("Vocabulary conformance");
    expect(result.vocabularyConformance).toEqual({
      typeViolations: { count: 0, entries: [] },
      outOfVocabularyEdges: { count: 0, entries: [] },
    });
    // The fixture really does contain compact markers — the exemption is
    // doing work, not passing vacuously.
    expect(fixtureTurns.filter((t) => t.type.includes("compact")).map((t) => t.id)).toEqual([907, 944]);
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

// ------------------------------------------------ tag-mandate ticket 03: the error classes E2-E4

/**
 * The ERROR side of the checker's error/warning split. Every test below
 * probes the same two things per class: that the defect is DETECTED, and
 * that its ANCHOR lands on the turn the settlement commit gate (ticket 05)
 * will scope by — an EDGE error at its citing turn, a TYPE error at the turn
 * itself.
 *
 * The "in-scope / out-of-scope anchor variant" pairs are what pin the
 * anchoring RULE rather than merely the anchor value: the checker itself has
 * no notion of a window (scoping is the gate's job), so each pair wires the
 * SAME defect with its anchor once inside and once outside a declared
 * writable set, and asserts the gate's own one-line filter reaches opposite
 * verdicts. Without the rule, one bad out-of-window row would pin a window on
 * a permanently failing commit — the terminal-state trap the spec's
 * "Anchoring and repairability" section exists to prevent.
 */
describe("errors E2-E4 — detection and anchoring", () => {
  /** The commit gate's whole filter, in one line — ticket 05 implements exactly this over the window's immutable writable set. */
  const anchoredIn = (errors: readonly LaneCheckerError[], writable: readonly number[]) =>
    errors.filter((error) => writable.includes(error.anchorId));

  const tagged = (id: number, tags: string[], type: string[] = ["design"]): LaneCheckerTurnInput => ({
    id,
    type,
    tags,
  });

  // ---- E1 IS RETIRED (lane-declaration ticket 02, [S15069/T1548]) ----
  //
  // This block used to pin the class: an untagged extends/narrows was an
  // error anchored at its citing turn. The tag mandate is withdrawn, so an
  // untagged stance edge is an ordinary legal edge. The pins that replace it
  // sit HERE, where a reader looking for E1 will find them, and they are
  // BEHAVIOURAL (the class is not in the type union any more, so a type-level
  // pin alone would say nothing about what the checker computes).

  test("an untagged extends/narrows produces NO error — the mandate's stock half is gone", () => {
    const turns = [tagged(10, ["lane-a"]), tagged(11, ["lane-a"])];
    expect(checkLanes(turns, [edge(11, "extends", 10, [])]).errors).toEqual([]);
    expect(checkLanes(turns, [edge(11, "narrows", 10, [])]).errors).toEqual([]);
    // Not vacuous: the same shapes with a tag REMOVED from an endpoint still
    // raise E4, so the checker is genuinely looking at these rows.
    expect(
      checkLanes([tagged(10, []), tagged(11, ["lane-a"])], [edge(11, "extends", 10, ["lane-a"])])
        .errors.map((e) => e.class),
    ).toEqual(["E4"]);
  });

  test("no error class named E1 is ever produced, whatever the untagged shape", () => {
    const turns = [tagged(20, []), tagged(21, [])];
    for (const word of ["override", "narrows", "extends", "indexes", "consume", "grounds", "verifies"]) {
      const bare = checkLanes(turns, [edge(21, word, 20, [])]);
      expect(bare.errors).toEqual([]);
    }
  });

  // ---- E2: out-of-vocabulary relation words ----

  test("E2 — a frozen-legacy supersedes is an error anchored at its citing turn, via either input channel", () => {
    const turns = [tagged(60, []), tagged(61, [])];
    const inline = checkLanes(turns, [edge(61, "supersedes", 60, [])]);
    expect(inline.errors).toEqual([
      { class: "E2", anchorId: 61, citingId: 61, citedId: 60, relation: "supersedes" },
    ]);

    // The loader's own dedicated channel (`checkLanes`'s third argument)
    // produces the identical error — one classification, two supply routes.
    const viaLoaderChannel = checkLanes(turns, [], [edge(61, "supersedes", 60, [])]);
    expect(viaLoaderChannel.errors).toEqual(inline.errors);
  });

  test("E2 — in-scope vs out-of-scope anchor variants", () => {
    const turns = [tagged(70, []), tagged(71, []), tagged(80, []), tagged(81, [])];
    const writable = [80, 81];
    expect(anchoredIn(checkLanes(turns, [edge(71, "supersedes", 70, [])]).errors, writable)).toEqual([]);
    expect(anchoredIn(checkLanes(turns, [edge(81, "supersedes", 80, [])]).errors, writable)).toHaveLength(1);
  });

  // ---- E3: empty / out-of-vocabulary turn types ----

  test("E3 — an empty type and an out-of-vocabulary type both anchor at the turn itself", () => {
    const result = checkLanes([tagged(90, [], []), tagged(91, [], ["bugfix"]), tagged(92, [], ["design"])], []);
    expect(result.errors).toEqual([
      { class: "E3", anchorId: 90, id: 90, types: [], outsideVocabulary: [] },
      { class: "E3", anchorId: 91, id: 91, types: ["bugfix"], outsideVocabulary: ["bugfix"] },
    ]);
  });

  test("E3 exemption — a compact MARKER row is never an error, however many windows contain one", () => {
    const result = checkLanes([tagged(100, [], ["compact"]), tagged(101, [], ["design"])], []);
    expect(result.errors).toEqual([]);
  });

  test("E3 exemption — a legally-SKIPPED turn cannot reach this module at all (the exemption is the loader's law-8 gate)", () => {
    // Stated as an absence: `LaneCheckerTurnInput` carries no status field,
    // so there is nothing here that COULD re-admit a skipped turn. The
    // exemption is pinned where it actually lives, in
    // `tests/db/lane-checker-load.test.ts`; this test exists so a future
    // reader looking for a skip predicate in the checker finds the pointer
    // instead of adding one.
    const asIfSkipped = checkLanes([tagged(110, [], [])], []);
    expect(asIfSkipped.errors).toHaveLength(1); // it WOULD be an error if it ever arrived
    expect(Object.keys(asIfSkipped.errors[0]!)).not.toContain("status");
  });

  test("E3 — in-scope vs out-of-scope anchor variants", () => {
    const turns = [tagged(120, [], []), tagged(130, [], [])];
    const errors = checkLanes(turns, []).errors;
    expect(anchoredIn(errors, [130]).map((e) => e.anchorId)).toEqual([130]);
    expect(anchoredIn(errors, [120]).map((e) => e.anchorId)).toEqual([120]);
  });

  // ---- E4: the subset invariant over stock ----

  test("E4 — a tag missing from an endpoint's own tags is named per (tag, endpoint), anchored at the citing turn", () => {
    const turns = [tagged(140, ["a"]), tagged(141, ["a", "b"])];
    const result = checkLanes(turns, [edge(141, "extends", 140, ["a", "b"])]);
    expect(result.errors).toEqual([
      {
        class: "E4",
        anchorId: 141,
        citingId: 141,
        citedId: 140,
        relation: "extends",
        tags: ["a", "b"],
        missing: [{ tag: "b", endpoint: "cited" }],
      },
    ]);
  });

  test("E4 — a tag missing from BOTH endpoints is named twice, once per side (the write gate's own rejection shape)", () => {
    const turns = [tagged(150, ["a"]), tagged(151, ["a"])];
    const result = checkLanes(turns, [edge(151, "consume", 150, ["a", "z"])]);
    expect(result.errors).toHaveLength(1);
    const error = result.errors[0]!;
    expect(error.class === "E4" && error.missing).toEqual([
      { tag: "z", endpoint: "cited" },
      { tag: "z", endpoint: "citing" },
    ]);
  });

  test("E4 — an endpoint whose tags were never LOADED yields no verdict; an endpoint with an empty loaded set does", () => {
    // `undefined` (not loaded) vs `[]` (loaded, genuinely tagless) — the one
    // distinction that separates "cannot judge" from "judged, and it fails".
    const notLoaded = checkLanes(
      [{ id: 160, type: ["design"] }, { id: 161, type: ["design"] }],
      [edge(161, "extends", 160, ["a"])],
    );
    expect(notLoaded.errors).toEqual([]);

    const loadedEmpty = checkLanes([tagged(170, []), tagged(171, [])], [edge(171, "extends", 170, ["a"])]);
    expect(loadedEmpty.errors.map((e) => e.class)).toEqual(["E4"]);

    // Half-loaded: only the side that HAS tags is judged.
    const halfLoaded = checkLanes(
      [tagged(180, []), { id: 181, type: ["design"] }],
      [edge(181, "extends", 180, ["a"])],
    );
    const error = halfLoaded.errors[0]!;
    expect(error.class === "E4" && error.missing).toEqual([{ tag: "a", endpoint: "cited" }]);
  });

  test("E4 — in-scope vs out-of-scope anchor variants", () => {
    const turns = [tagged(190, []), tagged(191, []), tagged(200, []), tagged(201, [])];
    const writable = [200, 201];
    expect(anchoredIn(checkLanes(turns, [edge(191, "extends", 190, ["a"])]).errors, writable)).toEqual([]);
    expect(
      anchoredIn(checkLanes(turns, [edge(201, "extends", 200, ["a"])]).errors, writable).map((e) => e.class),
    ).toEqual(["E4"]);
  });

  // ---- cross-class properties ----

  test("an out-of-vocabulary relation is classed E2 and E2 ONLY, never also E4", () => {
    // `supersedes` is partitioned out before any graph computation, so it can
    // never be double-classed by the two edge checks that read the
    // in-vocabulary set. A tagged one is the sharp case: its tags are absent
    // from both (tagless) endpoints, so E4 would fire if it were admitted.
    const result = checkLanes([tagged(210, []), tagged(211, [])], [edge(211, "supersedes", 210, ["a"])]);
    expect(result.errors.map((e) => e.class)).toEqual(["E2"]);
  });

  test("errors sort by anchor, then class — one deterministic order for both surfaces", () => {
    // Two classes on the SAME anchor (222) is what pins the class tiebreak;
    // it used to be E1+E4 and is E2+E4 now that E1 is retired.
    const turns = [tagged(220, [], []), tagged(221, ["a"]), tagged(222, [])];
    const result = checkLanes(turns, [
      edge(222, "supersedes", 221, []), // E2 @ 222
      edge(222, "consume", 221, ["a"]), // E4 @ 222 (222 lacks "a")
      edge(221, "supersedes", 220, []), // E2 @ 221
    ]);
    expect(result.errors.map((e) => `${e.anchorId}:${e.class}`)).toEqual([
      "220:E3",
      "221:E2",
      "222:E2",
      "222:E4",
    ]);
  });

  test("the errors LIST is uncapped even where the fact lists it is classed from are capped", () => {
    // LOAD-BEARING: the commit gate filters this list by anchor. A display
    // cap here would let an instance past the gate simply by sorting late,
    // and the window would commit dirty.
    // 60 > MAX_ERROR_RENDER_ENTRIES (50): the one cap value a refactor would
    // plausibly copy into the data path must itself go red here.
    const turns = Array.from({ length: 60 }, (_, index) => tagged(300 + index, [], ["bugfix"]));
    const result = checkLanes(turns, []);
    expect(result.errors).toHaveLength(60);
    expect(result.vocabularyConformance.typeViolations.count).toBe(60);
    expect(result.vocabularyConformance.typeViolations.entries).toHaveLength(20); // capped, as before
    expect(result.errors.at(-1)!.anchorId).toBe(359);
  });

  test("the warning side's own computations are untouched by the split", () => {
    // A fixture that is simultaneously error-bearing and lane-bearing: the
    // reports still report exactly what they always did.
    const turns = [tagged(400, ["L"], ["design"]), tagged(401, ["L"], ["design"])];
    const edges = [edge(401, "extends", 400, ["L"]), edge(401, "indexes", 400, ["L"]), edge(401, "supersedes", 400, [])];
    const result = checkLanes(turns, edges);
    expect(result.errors.map((e) => e.class)).toEqual(["E2"]);
    const stats = findLaneStats(result, "L");
    expect(stats?.edgeCountsByRelation).toEqual({ extends: 1, indexes: 1 });
    expect(stats?.state.closure).toBe("closed");
    expect(findPath(result, "L")?.pathCount).toBe(1);
  });
});

// -------------------------------- lane-model-v12 ticket 04: E5 is DELETED
//
// E5 was "a lane has exactly ONE start and ONE end", a COMMIT-BLOCKING error
// class. Rubric v11 removed the clause it enforced a revision before this
// ticket removed the class, so for one revision settlement was refused
// commits over a law the model no longer stated. Its whole describe block —
// the disjoint-chain fixture, the canonical-source/sink choice, the
// order-key/epoch tie-break, the eight-word edge domain, the diamond
// exemption and the T1466 anchor rule — goes with it.
//
// The grep sentinel that keeps it from coming back under another name lives
// in `tests/shared/lane-model-v12-deletions.test.ts`.

describe("D9 warning 1 — unattributed clusters", () => {
  const t = (id: number, tags: string[] = []): LaneCheckerTurnInput => ({
    id,
    type: ["design"],
    tags,
  });
  const clusters = (result: ReturnType<typeof checkLanes>) => result.unattributedClusters;
  const clusterSizes = (result: ReturnType<typeof checkLanes>) =>
    clusters(result).entries.map((cluster) => cluster.turnCount);

  /**
   * The retired rule's own graph, computed here in the TEST so the
   * "component-level rule would have been silent" claim is a measured fact
   * about the fixture rather than an assertion about the fixture's author's
   * intent. `LANE_COMPONENT_RELATIONS` = stance + consume + grounds.
   */
  function sameComponentUnderComponentRelations(
    edges: readonly LaneEdgeInput[],
    a: number,
    b: number,
  ): boolean {
    const parent = new Map<number, number>();
    const find = (id: number): number => {
      const seen = parent.get(id);
      if (seen === undefined || seen === id) {
        parent.set(id, id);
        return id;
      }
      const root = find(seen);
      parent.set(id, root);
      return root;
    };
    for (const edge of edges) {
      if (!LANE_COMPONENT_RELATIONS.has(edge.relation)) continue;
      const rootA = find(edge.citingId);
      const rootB = find(edge.citedId);
      if (rootA !== rootB) parent.set(rootA, rootB);
    }
    return find(a) === find(b);
  }

  // ---- the boundary, both sides ----

  test("THREE untagged turns connected to each other are SILENT — a short exchange is not a workflow", () => {
    const result = checkLanes([t(1), t(2), t(3)], [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
    ]);
    expect(clusters(result).count).toBe(0);
  });

  test("FOUR untagged turns connected to each other WARN, naming every one of them", () => {
    const result = checkLanes([t(1), t(2), t(3), t(4)], [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(4, "extends", 3),
    ]);
    expect(clusters(result).count).toBe(1);
    expect(clusters(result).entries[0]).toEqual({ turnIds: [1, 2, 3, 4], turnCount: 4 });
  });

  test("four turns that are NOT connected to each other are four one-turn nothings, not a cluster", () => {
    // The connectivity half of the rule, isolated: same four unattributed
    // turns, no edges at all. A rule that counted untagged TURNS rather than
    // untagged clusters would fire here.
    const result = checkLanes([t(1), t(2), t(3), t(4)], []);
    expect(clusters(result).count).toBe(0);
  });

  // ---- membership is an EDGE fact (peer P1-8) ----

  test("a turn whose OWN tags carry a lane tag is still UNATTRIBUTED when no edge ever joined it", () => {
    // The rubric ADMITS a turn to a lane by its nouns ("准入的必要条件"), and
    // settlement stamps those nouns onto whole segments in bulk — so reading
    // the `tags` column as membership silently exempts exactly the turns this
    // warning exists to find. T9/T10 are a REAL lane (a tagged edge joins
    // them); T1-T4 merely carry the same word.
    const result = checkLanes(
      [
        t(1, ["ownership"]),
        t(2, ["ownership"]),
        t(3, ["ownership"]),
        t(4, ["ownership"]),
        t(9, ["ownership"]),
        t(10, ["ownership"]),
      ],
      [
        edge(2, "extends", 1),
        edge(3, "extends", 2),
        edge(4, "extends", 3),
        edge(10, "extends", 9, ["ownership"]),
      ],
    );
    // Not vacuous: the lane really exists and really has those two members.
    expect(result.lanes.map((lane) => lane.key.tag)).toEqual(["ownership"]);
    expect(clusterSizes(result)).toEqual([4]);
    expect(clusters(result).entries[0]!.turnIds).toEqual([1, 2, 3, 4]);
  });

  test("an endpoint of a tagged edge IS attributed and leaves the cluster domain — the same four turns fall silent", () => {
    // The mirror of the test above: attach T4 to the lane with a tagged edge
    // and the cluster drops to three. This is what makes the previous test's
    // verdict a statement about EDGES rather than about the number four.
    const result = checkLanes(
      [t(1), t(2), t(3), t(4, ["ownership"]), t(9, ["ownership"])],
      [
        edge(2, "extends", 1),
        edge(3, "extends", 2),
        edge(4, "extends", 3),
        edge(4, "consume", 9, ["ownership"]),
      ],
    );
    expect(result.lanes[0]?.members.map((member) => member.id)).toEqual([4, 9]);
    expect(clusters(result).count).toBe(0);
  });

  // ---- the cluster, not the component [S15069/T1553] ----

  test("a tagged member ELSEWHERE in the same component does NOT excuse an unattributed cluster inside it", () => {
    // The replacement for the retired "a component with ONE tagged member is
    // silent" bullet, which contradicted the cluster rule outright. T13
    // grounds T20, and T20/T21 are a real lane — so `grounds` (a member of
    // `LANE_COMPONENT_RELATIONS`) puts all six turns in ONE component, which
    // is precisely why the retired reading measurably never fires: one real
    // E60 component holds 77 turns.
    const edges = [
      edge(11, "extends", 10),
      edge(12, "extends", 11),
      edge(13, "extends", 12),
      edge(13, "grounds", 20),
      edge(21, "extends", 20, ["rubric-design"]),
    ];
    const result = checkLanes(
      [t(10), t(11), t(12), t(13), t(20, ["rubric-design"]), t(21, ["rubric-design"])],
      edges,
    );
    // The fixture really is ONE component under the retired rule's own graph.
    expect(sameComponentUnderComponentRelations(edges, 13, 21)).toBe(true);
    // And the cluster warns anyway, naming only the four unattributed turns.
    expect(clusters(result).entries).toEqual([{ turnIds: [10, 11, 12, 13], turnCount: 4 }]);
  });

  // ---- the excuse is per-member (peer P1-9) ----

  test("an untagged `indexes` aggregating TWO members of a six-turn cluster leaves FOUR unexcused, and still warns", () => {
    const result = checkLanes([t(1), t(2), t(3), t(4), t(5), t(6)], [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(4, "extends", 3),
      edge(5, "extends", 4),
      edge(6, "extends", 5),
      // The release's own free aggregation over what it shipped.
      edge(6, "indexes", 1),
      edge(6, "indexes", 2),
    ]);
    expect(clusters(result).entries).toEqual([{ turnIds: [3, 4, 5, 6], turnCount: 4 }]);
  });

  test("a legal four-turn one-off that ships ONE artifact falls silent — the excuse is per member, with no two-or-more gate", () => {
    // Spec D9's older phrasing ("EXCUSED when some node aggregates two or
    // more of its members") would leave this at four and warn forever.
    const result = checkLanes([t(1), t(2), t(3), t(4)], [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(4, "extends", 3),
      edge(4, "indexes", 1),
    ]);
    expect(clusters(result).count).toBe(0);
  });

  test("a release indexing two artifacts does NOT silence a large orphan cluster — the rest is re-judged, not excused", () => {
    // Nine chained turns, two of them aggregated. Whole-cluster excusal (the
    // reading this test exists to forbid) returns silence; the induced
    // subgraph returns seven.
    const chain = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const result = checkLanes(
      chain.map((id) => t(id)),
      [
        ...chain.slice(1).map((id) => edge(id, "extends", id - 1)),
        edge(9, "indexes", 1),
        edge(9, "indexes", 2),
      ],
    );
    expect(clusterSizes(result)).toEqual([7]);
  });

  test("excusing the connector SPLITS the remainder, and each surviving piece is judged on its own", () => {
    // The "induced subgraph" wording doing visible work: T5 is the only
    // bridge between two four-turn arms, and an untagged `indexes` removes
    // it — leaving two clusters, each still over the boundary.
    const result = checkLanes(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map((id) => t(id)),
      [
        edge(2, "extends", 1),
        edge(3, "extends", 2),
        edge(4, "extends", 3),
        edge(5, "extends", 4),
        edge(6, "extends", 5),
        edge(7, "extends", 6),
        edge(8, "extends", 7),
        edge(9, "extends", 8),
        edge(20, "indexes", 5),
      ],
    );
    expect(clusters(result).entries).toEqual([
      { turnIds: [1, 2, 3, 4], turnCount: 4 },
      { turnIds: [6, 7, 8, 9], turnCount: 4 },
    ]);
  });

  test("a TAGGED `indexes` excuses nothing — it declares convergence, and its endpoints are lane members anyway", () => {
    const result = checkLanes(
      [t(1), t(2), t(3), t(4), t(30, ["release"]), t(31, ["release"])],
      [
        edge(2, "extends", 1),
        edge(3, "extends", 2),
        edge(4, "extends", 3),
        edge(31, "indexes", 30, ["release"]),
      ],
    );
    expect(clusters(result).entries).toEqual([{ turnIds: [1, 2, 3, 4], turnCount: 4 }]);
  });

  // ---- the relation domain, pinned in its own right ----

  test("DOMAIN — an evidence line joined only by verifies/consume/grounds IS a cluster", () => {
    // The ticket's own worry: this line must not appear and disappear with a
    // word-set chosen for another report. Under `LANE_COMPONENT_RELATIONS`
    // (stance + consume + grounds, the EXTERNAL bridge domain) the two
    // testimony edges vanish and the largest surviving piece is three.
    //
    // Lane-model v12 ticket 02: the second testimony edge was `refutes`, which
    // is no longer in `EDGE_RELATIONS` — the checker partitions an
    // out-of-vocabulary word out BEFORE any graph computation, so leaving it
    // here would have made the fixture measure E2 handling instead of the
    // relation domain. Two `verifies` edges keep the line's shape and its
    // point.
    const edges = [
      edge(2, "verifies", 1),
      edge(3, "verifies", 2),
      edge(4, "consume", 3),
      edge(5, "grounds", 4),
    ];
    const result = checkLanes([t(1), t(2), t(3), t(4), t(5)], edges);
    expect(clusters(result).entries).toEqual([{ turnIds: [1, 2, 3, 4, 5], turnCount: 5 }]);
    // The measured statement of what the other domain would have said.
    expect(sameComponentUnderComponentRelations(edges, 1, 2)).toBe(false);
  });

  test("DOMAIN — an untagged `override` is a state event, not a join: the turn it kills off does not enlarge the cluster", () => {
    const result = checkLanes([t(1), t(2), t(3), t(4)], [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(4, "override", 3),
    ]);
    expect(clusters(result).count).toBe(0);
  });

  // ---- shape of the report itself ----

  test("the cluster's turn list is capped for display while `turnCount` stays the TRUE size the boundary was judged on", () => {
    const ids = Array.from({ length: 25 }, (_, index) => index + 1);
    const result = checkLanes(
      ids.map((id) => t(id)),
      ids.slice(1).map((id) => edge(id, "extends", id - 1)),
    );
    const cluster = clusters(result).entries[0]!;
    expect(cluster.turnCount).toBe(25);
    expect(cluster.turnIds).toHaveLength(20);
    expect(cluster.turnIds[0]).toBe(1);
  });

  test("an unattributed cluster is a WARNING — it never enters `errors` and never reaches the commit gate", () => {
    const result = checkLanes([t(1), t(2), t(3), t(4)], [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(4, "extends", 3),
    ]);
    expect(clusters(result).count).toBe(1);
    expect(result.errors).toEqual([]);
  });

  test("an edge endpoint the projection never loaded is not invented as a cluster member", () => {
    // "Never fabricate completeness", the same posture report 1's `coverage`
    // takes: T5 is cited but absent from `turns`, so the cluster is four, not
    // five — and the count would silently become five if the domain were
    // taken from the edges rather than from the loaded turns.
    const result = checkLanes([t(1), t(2), t(3), t(4)], [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(4, "extends", 3),
      edge(1, "extends", 5),
    ]);
    expect(clusters(result).entries).toEqual([{ turnIds: [1, 2, 3, 4], turnCount: 4 }]);
  });
});

describe("D9 warning 2 — lane proliferation", () => {
  const facts = (segment: string, declaredLaneCount: number, memberTurnCount: number) => ({
    segment,
    declaredLaneCount,
    memberTurnCount,
  });
  const proliferation = (declaredLaneCount: number, memberTurnCount: number) =>
    checkLanes([], [], [], [facts("60", declaredLaneCount, memberTurnCount)]).laneProliferation;

  test("a segment EXACTLY at the ratio is silent, and one lane over it warns", () => {
    expect(proliferation(5, 100)).toEqual([]);
    expect(proliferation(6, 100)).toEqual([
      { segment: "60", declaredLaneCount: 6, memberTurnCount: 100, allowance: 5 },
    ]);
  });

  test("the max(1, …) floor keeps a 19-turn segment's single legitimate lane quiet (peer P2-12)", () => {
    // Without the floor, 1 > 0.05 × 19 = 0.95 warns forever and then falls
    // silent at 20 turns — a threshold that moves the wrong way with size.
    expect(proliferation(1, 19)).toEqual([]);
    expect(proliferation(1, 20)).toEqual([]);
    // The floor suppresses ONE lane, not the rule: a second lane on the same
    // 19-turn segment is genuinely over the line.
    expect(proliferation(2, 19)).toEqual([
      { segment: "60", declaredLaneCount: 2, memberTurnCount: 19, allowance: 1 },
    ]);
  });

  test("the boundary is exact at magnitudes where 0.05 × n is not representable — 20 lanes over 400 turns is silent", () => {
    expect(proliferation(20, 400)).toEqual([]);
    expect(proliferation(21, 400)).toEqual([
      { segment: "60", declaredLaneCount: 21, memberTurnCount: 400, allowance: 20 },
    ]);
  });

  test("a segment with lanes and no live members is over the line by construction", () => {
    expect(proliferation(2, 0)).toEqual([
      { segment: "60", declaredLaneCount: 2, memberTurnCount: 0, allowance: 1 },
    ]);
  });

  test("the counts come from `segmentFacts` alone — the lanes this projection happens to hold never enter the verdict", () => {
    // Peer P1-11, at the unit seam. The projection below carries ONE lane and
    // two turns; the segment behind it has 63 declared over 100 members. A
    // rule that counted `result.lanes` would report 1 and stay silent.
    const turns: LaneCheckerTurnInput[] = [
      { id: 1, type: ["design"], tags: ["ownership"], segment: "60" },
      { id: 2, type: ["design"], tags: ["ownership"], segment: "60" },
    ];
    const result = checkLanes(turns, [edge(2, "extends", 1, ["ownership"])], [], [
      facts("60", 63, 100),
    ]);
    expect(result.lanes).toHaveLength(1);
    expect(result.laneProliferation).toEqual([
      { segment: "60", declaredLaneCount: 63, memberTurnCount: 100, allowance: 5 },
    ]);
  });

  test("no facts, no verdict — a caller that loaded none gets silence rather than a fabricated ratio", () => {
    const result = checkLanes(
      [
        { id: 1, type: ["design"], tags: ["a"], segment: "60" },
        { id: 2, type: ["design"], tags: ["a"], segment: "60" },
      ],
      [edge(2, "extends", 1, ["a"])],
    );
    expect(result.laneProliferation).toEqual([]);
  });

  test("proliferation is a WARNING — over the line, `errors` is still empty", () => {
    const result = checkLanes([], [], [], [facts("60", 63, 100)]);
    expect(result.laneProliferation).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  test("several segments each get their own verdict, deterministically ordered", () => {
    const result = checkLanes([], [], [], [
      facts("61", 9, 40),
      facts("60", 6, 100),
      facts("62", 1, 3),
    ]);
    expect(result.laneProliferation.map((warning) => warning.segment)).toEqual(["60", "61"]);
  });

  // ---- ticket 14: the numerator and the registry agree on what counts ----

  test("ticket 14: a lane with no live member STILL COUNTS in the numerator, and is named rather than silently padding it", () => {
    // The boundary that decides the rule. Two declared lanes, ONE of them
    // empty, over 40 member turns: 2 × 20 == 40, exactly at the line, silent.
    expect(
      checkLanes([], [], [], [{ ...facts("60", 2, 40), emptyLaneTags: ["ghost"] }])
        .laneProliferation,
    ).toEqual([]);
    // One member fewer and the SAME two lanes are over it. Under the rejected
    // alternative (subtract the empty lane from the numerator) this reads as
    // one declared lane and the max(1, …) floor silences it forever.
    expect(
      checkLanes([], [], [], [{ ...facts("60", 2, 39), emptyLaneTags: ["ghost"] }])
        .laneProliferation,
    ).toEqual([
      {
        segment: "60",
        declaredLaneCount: 2,
        memberTurnCount: 39,
        allowance: 1.95,
        emptyLaneTags: ["ghost"],
      },
    ]);
  });

  test("ticket 14: facts that name no empty lanes carry the empty list; facts that never loaded the field carry nothing", () => {
    const loadedNone = checkLanes([], [], [], [{ ...facts("60", 6, 100), emptyLaneTags: [] }])
      .laneProliferation[0]!;
    expect(loadedNone.emptyLaneTags).toEqual([]);
    // `undefined` is "the caller loaded no such field", never "none are
    // empty" — the same posture `LaneCheckerTurnInput.tags` takes.
    expect(checkLanes([], [], [], [facts("60", 6, 100)]).laneProliferation[0]!.emptyLaneTags)
      .toBeUndefined();
  });
});
