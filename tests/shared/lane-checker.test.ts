import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  checkLanes as runCheckLanes,
  DEFAULT_SEGMENT,
  type LaneCheckerError,
  type LaneCheckerTurnInput,
  type LaneEdgeInput,
  type LaneTurnInput,
} from "../../src/shared/lane-checker";
import { renderLaneCheckerReports } from "../../src/shared/lane-checker-render";
import { laneEdge, withEdgeClaimedLaneTags } from "../support/lane-edge-fixtures";

/**
 * `checkLanes`, with every fixture turn first given the lane tags ITS OWN
 * SIDE of the fixture's edges names (`withEdgeClaimedLaneTags`).
 *
 * Membership is a NODE fact since lane-model-v12 ticket 10 — a turn belongs
 * to the lanes its own tags name, never to the lanes its edges name — so a
 * fixture that states its lanes on the edges alone would enumerate nothing at
 * all here. Every test in this file is about a REPORT (connectivity, coupling,
 * bypass candidates, citedness, error classes), not about where membership
 * comes from, and this projects the E4-clean membership each fixture always
 * implied. A test whose subject IS membership states `laneTags` on its turns
 * explicitly and passes them straight through; the ticket's own
 * counter-example lives in `tests/shared/lane-interpretation.test.ts`.
 */
function checkLanes(
  turns: readonly LaneCheckerTurnInput[],
  edges: readonly LaneEdgeInput[],
  knownOutOfVocabularyEdges?: readonly LaneEdgeInput[],
  segmentFacts?: Parameters<typeof runCheckLanes>[3],
): ReturnType<typeof runCheckLanes> {
  return runCheckLanes(
    withEdgeClaimedLaneTags(turns, edges),
    edges,
    knownOutOfVocabularyEdges,
    segmentFacts,
  );
}

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
function findCoupling(result: ReturnType<typeof checkLanes>, tag: string) {
  return result.coupling.find((c) => c.key.tag === tag);
}
/** The three group counts for one lane, in `LANE_COUPLING_GROUPS` order — the shape every coupling assertion below reads. */
function couplingCounts(result: ReturnType<typeof checkLanes>, tag: string): number[] | undefined {
  return findCoupling(result, tag)?.groups.map((group) => group.count);
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
 * HERE instead, by the same rule ticket 03 applies to the database.
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

  // v12 ticket 11 RETARGETED this: the domain is the lane's OWN claiming
  // edges, not the old global stance+consume+grounds union-find. Every
  // hand-judged lane still reads whole, which is the measurement that the
  // retarget does not manufacture severance on real data.
  test("every declared lane's own edges hold its members in ONE component", () => {
    expect(declaredLaneTags.length).toBe(11);
    for (const tag of declaredLaneTags) {
      const stats = findLaneStats(result, tag);
      expect(stats?.declaration.state).toBe("declared");
      expect(findComponent(result, tag)?.componentCount).toBe(1);
    }
  });

  test("{write-gate} reports undeclared — no `indexes` ever tagged write-gate, only a same-tag override of its latest structural node", () => {
    const stats = findLaneStats(result, "write-gate");
    expect(stats?.declaration.state).toBe("undeclared");
    expect(stats?.declaration.terminus).toBe(null);
    // v11 also asserted this lane's freshest EDGE activity here (T958's
    // override of T957) through `declaration.latestEventTurn`. That field
    // existed to tell "an override touched this undeclared lane" apart from
    // "nothing ever touched it", a distinction only the deleted
    // override-writes-state rule could draw. Undeclared is undeclared.
    // Ticket 04: the override marks nobody — a member is a plain `{ id }`.
    expect(stats?.members.find((m) => m.id === 957)).toEqual({ id: 957 });
    // Open, so report 2 asks no terminus question of it.
    expect(findComponent(result, "write-gate")?.terminusCitedness).toBeNull();
  });

  // THE NEW CONNECTIVITY LINE (ticket 11). Measured by running the real
  // implementation against the fixture, not hand-guessed — the same
  // methodology every other golden in this block uses. 7 of the 11 closed
  // lanes have their terminus cited from outside; 4 do not, and those four are
  // the finding the line exists to surface (the spec's own caution applies:
  // "uncited" can also mean the citing edge was never written).
  test("report 2's closed-terminus line — 7 of 11 closed lanes are cited from outside, 4 are not", () => {
    const cited: Record<string, number[]> = {};
    for (const component of result.components) {
      const citedness = component.terminusCitedness;
      if (citedness) {
        cited[component.key.tag] = citedness.citedBy;
      }
    }
    expect(cited).toEqual({
      cadence: [992],
      "contract-repair": [998],
      "contract-verify": [947, 998],
      ownership: [],
      "relation-vocabulary": [940, 945],
      "rewind-marking": [],
      "segment-audit": [991],
      "settlement-scope": [],
      "spec-design": [],
      "turn-edge-mechanism": [930],
      "view-spec": [923],
    });
    expect(Object.keys(cited).sort()).toEqual([...declaredLaneTags].sort());
  });

  // The coupling count is ZERO everywhere on this corpus, and that is a
  // MEASUREMENT rather than an empty report: a cross-lane edge is the shape
  // v11's single merged tag set structurally could not store (spec problem 2),
  // so a fixture captured before v12 cannot contain one. The exact-count pin
  // the ticket asks for lives on the three-lane synthetic fixture below.
  test("report 3 golden — no cross-lane coupling exists on a pre-v12 corpus, and every lane still gets all three groups", () => {
    expect(result.coupling).toHaveLength(12);
    for (const report of result.coupling) {
      expect(report.groups.map((group) => group.count)).toEqual([0, 0, 0]);
      expect(report.groups.map((group) => group.relations)).toEqual([
        ["verifies", "override", "narrows", "extends"],
        ["grounds"],
        ["consume", "indexes"],
      ]);
    }
    // Not vacuous: the fixture really does carry settled edges — they are all
    // INTERNAL (both sides one lane), which is exactly what "no coupling" means.
    expect(fixtureEdges.some((e) => e.tailTag !== "" && e.tailTag === e.headTag)).toBe(true);
    expect(fixtureEdges.some((e) => e.tailTag !== "" && e.headTag !== "" && e.tailTag !== e.headTag)).toBe(false);
  });

  // Report 4b, measured the same way. Four direct edges in this window have a
  // longer route between the same two turns; each entry names BOTH and marks
  // neither for deletion.
  test("report 4b golden — four structural bypass candidates, each carrying its own alternative route", () => {
    expect(
      result.bypassCandidates.map(
        (candidate) =>
          `${candidate.citingId}->${candidate.citedId}(${candidate.relations.join(",")}) via ${candidate.alternativePath.join(",")}`,
      ),
    ).toEqual([
      "942->930(consume) via 942,935,933,932,930",
      "965->959(grounds) via 965,962,961,960,959",
      "974->958(grounds) via 974,972,970,966,965,959,958",
      "1001->998(consume) via 1001,999,998",
    ]);
    // Every candidate is computed inside ONE segment's graph — this fixture
    // has no segments at all, so all four sit in the default scope.
    for (const candidate of result.bypassCandidates) {
      expect(candidate.segment).toBe(DEFAULT_SEGMENT);
      expect(candidate.alternativePath.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("{ownership}'s cited-ness shows MID-MEMBER grounds (T936->T910, T946->T912) — a terminus-only reading would show none, since nothing cites T913 directly", () => {
    const stats = findLaneStats(result, "ownership");
    const pairs = stats?.citedness.groundsFromNonMembers.map((f) => `${f.citingId}->${f.citedId}`).sort();
    expect(pairs).toEqual(["936->910", "946->912"]);
    // Confirm the terminus itself really is never directly cited — the
    // lane-wide reading is doing real work here, not just being permissive,
    // and report 2's own terminus line reports exactly the opposite verdict
    // on this lane (`ownership: []` above), which is the whole reason the two
    // questions are asked separately.
    const directlyOnTerminus = stats?.citedness.groundsFromNonMembers.some((f) => f.citedId === 913);
    expect(directlyOnTerminus).toBe(false);
  });

  test("{ownership}'s phases include delivery too (T900 is typed design+ops — ops is delivery-phase), edge counts by word tally the lane's own 7 tagged edges", () => {
    const stats = findLaneStats(result, "ownership");
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

  test("report 4c golden — no time-order violations: the fixture has no cross-session or forward edges", () => {
    expect(result.timeOrderViolations).toEqual([]);
  });

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

  // The acceptance bar: the hand-judged golden corpus CONFORMS on every class
  // that judges a SETTLED row — every tagged edge's side tags sit inside both
  // endpoints' own tags (E4) and every turn's type is in vocabulary once
  // compact markers are exempt (E3). (E1 is retired with the tag mandate; E5
  // was deleted by v12 ticket 04; E2 was deleted as a CLASS by v12 ticket 11
  // and its fact is a warning now.) Any discrepancy on E3/E4 here is a
  // STOP-AND-REPORT, never a golden adjustment.
  //
  // TICKET 20 ADDS THE ONE CLASS THIS CORPUS DOES TRIP: E6, the DRAFT edge.
  // 77 of its 125 edges carry no lane on either side — this is a snapshot of
  // production taken while the tag mandate was still being withdrawn, so an
  // unattributed edge was the ordinary state — and every one of them is now a
  // row settlement owes a decision. That number is a MEASUREMENT of the corpus,
  // not a threshold: it is exactly the count of fixture edges with an empty
  // side, asserted from the fixture itself right below so the two can never
  // drift apart into a hand-maintained constant.
  test("the golden fixture's only errors are E6 DRAFT edges — every settled row conforms", () => {
    const draftEdges = fixtureEdges.filter((e) => e.tailTag === "" || e.headTag === "");
    expect(draftEdges).toHaveLength(77);
    expect([...new Set(result.errors.map((e) => e.class))]).toEqual(["E6"]);
    expect(result.errors).toHaveLength(draftEdges.length);
    // Every draft on this corpus is FULLY unsettled: the half-settled shape
    // ticket 08 refused at the write gate could not be written when the
    // snapshot was taken, so E6's two-sides arm is what the corpus exercises.
    for (const error of result.errors) {
      expect(error.class === "E6" && error.unsettledSides).toEqual(["tail", "head"]);
    }
    // Not vacuous: the fixture really does carry attributed edges and turn
    // tags for E4 to judge, and E4 stays silent on all of them.
    expect(fixtureEdges.some((e) => e.tailTag !== "" || e.headTag !== "")).toBe(true);
    expect(fixtureTurns.every((t) => (t.tags ?? []).length >= 0)).toBe(true);
    expect(fixtureEdges.some((e) => e.relation === "extends" || e.relation === "narrows")).toBe(true);
  });

  test("the golden fixture enumerates 12 real lanes, and no error class judges their shape", () => {
    expect(result.lanes).toHaveLength(12);
    for (const lane of result.lanes) {
      expect(lane.members.length).toBeGreaterThanOrEqual(2);
    }
    expect(
      fixtureEdges.some(
        (e) => e.relation === "override" && (e.tailTag !== "" || e.headTag !== ""),
      ),
    ).toBe(true);
    expect(
      fixtureEdges.some(
        (e) => e.relation === "indexes" && (e.tailTag !== "" || e.headTag !== ""),
      ),
    ).toBe(true);
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

// THE MERGE, pinned at the CHECKER. `deriveLaneInterpretation`'s own reduction
// is pinned separately (`tests/shared/lane-interpretation.test.ts`); this
// fixture instead proves the CHECKER's own report 1 output carries the same
// answer. v12 D1 has no multi-tag row (spec M-A splits each into one row per
// tag), so the same intent is TWO rows on one pair+relation.
describe("a many-lane override is two rows (spec M-A), and neither writes declaration state", () => {
  // INVERTED (peer cross-review A1). v11 asserted `{ state: "reopened",
  // terminus: null }` for lane {a} — an override citing the terminus cleared
  // it. Only `index` touches open/closed in v12, so the declaration stands and
  // the lane reads open on T3's membership instead (`withEdgeClaimedLaneTags`
  // gives T3 both tags its own side names).
  test("T2 --indexes{a}--> T1 declares lane {a}; the override{a} row leaves that terminus standing while T3's membership reads it open", () => {
    const turns = [design(1), design(2), design(3)];
    const edges = [
      edge(2, "indexes", 1, ["a"]), // T2 declares lane {a}, terminus = T2
      edge(3, "override", 2, ["a"]),
      edge(3, "override", 2, ["b"]),
    ];
    const result = checkLanes(turns, edges);

    const laneA = findLaneStats(result, "a");
    expect(laneA?.declaration).toEqual({ state: "declared", terminus: 2 });
    expect(laneA?.state.closure).toBe("open");
    expect(laneA?.state.terminus).toBe(2);
    expect(laneA?.members.find((m) => m.id === 2)).toEqual({ id: 2 });

    // The identical row is simultaneously lane {b}'s own first-ever event —
    // an override touching a lane nobody had declared yet.
    const laneB = findLaneStats(result, "b");
    expect(laneB?.declaration.state).toBe("undeclared");
    expect(laneB?.members.find((m) => m.id === 2)).toEqual({ id: 2 });

    expect(result.lanes.map((lane) => lane.key.tag).sort()).toEqual(["a", "b"]);
    // Neither lane is CLOSED, so neither gets a terminus line in report 2.
    expect(findComponent(result, "a")?.terminusCitedness).toBeNull();
  });

  // The CROSS-LANE row is the shape v11 could not store, and the contrast that
  // makes the two rows above meaningful: ONE row whose ends name different
  // lanes acts in NEITHER, where two single-lane rows act in both.
  test("the same intent written as ONE cross-lane override row reaches neither lane — {a} keeps its terminus", () => {
    const turns = [design(1), design(2), design(3)];
    const result = checkLanes(turns, [
      edge(2, "indexes", 1, ["a"]),
      edge(3, "override", 2, [], { tailTag: "b", headTag: "a" }),
    ]);
    const laneA = findLaneStats(result, "a");
    expect(laneA?.declaration).toEqual({ state: "declared", terminus: 2 });
    expect(laneA?.state.closure).toBe("closed");
    const laneB = findLaneStats(result, "b");
    expect(laneB?.members.map((m) => m.id)).toEqual([3]);
    expect(laneB?.declaration).toEqual({ state: "undeclared", terminus: null });
    expect(laneB?.edgeCountsByRelation).toEqual({});
    // …but report 3 SEES it: acting in no lane and coupling two lanes are
    // different questions, and the crossing is exactly what the coupling
    // count exists to report.
    expect(couplingCounts(result, "a")).toEqual([1, 0, 0]);
    expect(couplingCounts(result, "b")).toEqual([1, 0, 0]);
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

// -------------------------------- report 3: cross-lane coupling (v12 ticket 11)

/**
 * THE TICKET'S OWN ACCEPTANCE: "三组计数在一个三 lane 夹具上精确".
 *
 * Three lanes, five cross-lane edges chosen so every group is exercised and no
 * lane's three counts are permutations of another's — a grouping bug that
 * merged two buckets, or one that counted a crossing for only one of the two
 * lanes it names, moves at least one number here.
 *
 *   {a} = T1,T2   {b} = T3,T4   {c} = T5,T6
 *   T3 --verifies{b->a}--> T2     group 1, for a and b
 *   T4 --override{b->a}--> T2     group 1, for a and b
 *   T5 --grounds{c->a}--> T2      group 2, for a and c
 *   T5 --consume{c->b}--> T4      group 3, for b and c
 *   T6 --indexes{c->b}--> T4      group 3, for b and c
 */
describe("report 3 — the three coupling groups, exact on a three-lane fixture", () => {
  const turns = [design(1), design(2), design(3), design(4), design(5), design(6)];
  const edges = [
    edge(2, "extends", 1, ["a"]),
    edge(4, "extends", 3, ["b"]),
    edge(6, "extends", 5, ["c"]),
    edge(3, "verifies", 2, [], { tailTag: "b", headTag: "a" }),
    edge(4, "override", 2, [], { tailTag: "b", headTag: "a" }),
    edge(5, "grounds", 2, [], { tailTag: "c", headTag: "a" }),
    edge(5, "consume", 4, [], { tailTag: "c", headTag: "b" }),
    edge(6, "indexes", 4, [], { tailTag: "c", headTag: "b" }),
  ];
  const result = checkLanes(turns, edges);

  test("each lane's three groups are counted exactly, and a crossing counts for BOTH lanes it names", () => {
    expect(result.lanes.map((lane) => lane.key.tag)).toEqual(["a", "b", "c"]);
    expect(couplingCounts(result, "a")).toEqual([2, 1, 0]);
    expect(couplingCounts(result, "b")).toEqual([2, 0, 2]);
    expect(couplingCounts(result, "c")).toEqual([0, 1, 2]);
  });

  test("the groups are the ticket's own word lists, named on every entry — no coined bucket names, no fourth group", () => {
    expect(findCoupling(result, "a")?.groups.map((group) => group.relations)).toEqual([
      ["verifies", "override", "narrows", "extends"],
      ["grounds"],
      ["consume", "indexes"],
    ]);
  });

  test("an INTERNAL edge is never a crossing, however many of them a lane has", () => {
    // The three `extends` edges above are each internal to one lane; drop the
    // five crossings and every count is zero.
    const internalOnly = checkLanes(turns, edges.slice(0, 3));
    for (const tag of ["a", "b", "c"]) {
      expect(couplingCounts(internalOnly, tag)).toEqual([0, 0, 0]);
    }
  });

  test("an UNSETTLED edge between two lanes' members is not coupling — it is settlement's debt", () => {
    // The same T5 -> T2 link with neither side settled. It couples nothing
    // (report 3 stays zero) and shows up as attribution debt instead.
    const unsettled = checkLanes(turns, [...edges.slice(0, 3), edge(5, "grounds", 2, [])]);
    expect(couplingCounts(unsettled, "a")).toEqual([0, 0, 0]);
    expect(couplingCounts(unsettled, "c")).toEqual([0, 0, 0]);
  });

  test("the same literal tag in TWO segments is two lanes, so an edge between them is a crossing", () => {
    // Identity is `(segment, tag)`. Both sides read "shared", but they name
    // different lanes — a merged tag set could never have told them apart.
    const crossSegment = checkLanes(
      [
        { id: 10, type: ["design"], segment: "A" },
        { id: 11, type: ["design"], segment: "A" },
        { id: 20, type: ["design"], segment: "B" },
        { id: 21, type: ["design"], segment: "B" },
      ],
      [
        edge(11, "extends", 10, ["shared"]),
        edge(21, "extends", 20, ["shared"]),
        edge(21, "consume", 11, [], { tailTag: "shared", headTag: "shared" }),
      ],
    );
    expect(crossSegment.coupling.map((report) => report.key.segment)).toEqual(["A", "B"]);
    for (const report of crossSegment.coupling) {
      expect(report.groups.map((group) => group.count)).toEqual([0, 0, 1]);
    }
  });

  test("report 3 reports EVERY lane, provisional ones included — unlike report 2, which does not judge them", () => {
    const provisional = checkLanes(
      [{ id: 1, type: ["design"], laneTags: ["solo"] }],
      [],
    );
    expect(couplingCounts(provisional, "solo")).toEqual([0, 0, 0]);
    expect(findComponent(provisional, "solo")).toBeUndefined();
  });
});

// -------------------------------- report 2: connectivity (v12 ticket 11)

describe("report 2 — connectivity over the lane's OWN claiming edges", () => {
  test("a PROVISIONAL lane (0 or 1 member) is not reported at all — the principle does not apply to it", () => {
    const result = checkLanes(
      [
        { id: 1, type: ["design"], laneTags: ["fresh"] },
        { id: 2, type: ["design"], laneTags: ["pair"] },
        { id: 3, type: ["design"], laneTags: ["pair"] },
      ],
      [edge(3, "extends", 2, ["pair"])],
    );
    // Both lanes exist in report 1; only the two-member one is judged.
    expect(result.lanes.map((lane) => lane.key.tag).sort()).toEqual(["fresh", "pair"]);
    expect(result.components.map((component) => component.key.tag)).toEqual(["pair"]);
  });

  test("a lane whose members share no claiming edge is SEVERED, one island per member", () => {
    const result = checkLanes(
      [
        { id: 1, type: ["design"], laneTags: ["split"] },
        { id: 2, type: ["design"], laneTags: ["split"] },
      ],
      [],
    );
    const component = findComponent(result, "split");
    expect(component?.componentCount).toBe(2);
    expect(component?.islands).toEqual([
      { representative: 1, memberIds: [1] },
      { representative: 2, memberIds: [2] },
    ]);
  });

  // THE RETARGET, stated as the behaviour it replaced. Under v11 report 2 read
  // a GLOBAL, tag-agnostic stance+consume+grounds graph, so an UNTAGGED edge
  // between two members counted as connectivity. It cannot now: the domain is
  // "two sides both name this lane", and an unsettled edge names nothing.
  test("an UNSETTLED edge between two members no longer connects them", () => {
    const turns = [
      { id: 1, type: ["design"], laneTags: ["u"] },
      { id: 2, type: ["design"], laneTags: ["u"] },
    ];
    expect(findComponent(checkLanes(turns, [edge(2, "extends", 1, [])]), "u")?.componentCount).toBe(2);
    // The SAME edge, settled to the lane on both sides, connects them.
    expect(findComponent(checkLanes(turns, [edge(2, "extends", 1, ["u"])]), "u")?.componentCount).toBe(1);
  });

  // The other half of the retarget: `indexes` and `override` are IN the domain
  // now. v11 excluded both from its component graph by relation word; v12's
  // domain reads the two side tags and nothing else, and excluding the index
  // would sever a closed lane's terminus from the members it just aggregated.
  test("a lane joined ONLY by a tagged `indexes` is whole — the convergence edge is one of the lane's own", () => {
    const result = checkLanes([design(701), design(702)], [edge(702, "indexes", 701, ["lone"])]);
    expect(findLaneStats(result, "lone")?.members.map((m) => m.id)).toEqual([701, 702]);
    const component = findComponent(result, "lone");
    expect(component?.componentCount).toBe(1);
    expect(component?.islands).toEqual([{ representative: 701, memberIds: [701, 702] }]);
  });

  test("a lane joined ONLY by a tagged `override` is whole too — same domain, same answer", () => {
    const turns = [design(10), design(11), design(12)];
    const result = checkLanes(turns, [
      edge(11, "extends", 10, ["ov"]),
      edge(11, "indexes", 10, ["ov"]),
      edge(12, "override", 11, ["ov"]),
    ]);
    expect(findComponent(result, "ov")?.componentCount).toBe(1);
  });

  // The segment gate is STRUCTURAL now rather than a union-find guard: an edge
  // whose endpoints sit in different segments claims no lane at all
  // (`laneMembershipClaims`), so it cannot enter any lane's own graph.
  test("a node in another segment can never bridge two members, even via a legal cross-segment grounds citation", () => {
    const turns = [
      { id: 30, type: ["design"], segment: "A", laneTags: ["seg"] },
      { id: 31, type: ["design"], segment: "A", laneTags: ["seg"] },
      { id: 32, type: ["implement"], segment: "B" },
    ];
    const result = checkLanes(turns, [edge(32, "grounds", 30), edge(32, "grounds", 31)]);
    const component = findComponent(result, "seg");
    expect(component?.componentCount).toBe(2);
    expect(component?.islands.map((i) => i.representative)).toEqual([30, 31]);
  });

  test("the closed-terminus line names only citers from OUTSIDE the lane, and prints the negative case in words", () => {
    const turns = [design(1), design(2), design(3, ["implement"])];
    const cited = checkLanes(turns, [
      edge(2, "extends", 1, ["t"]),
      edge(2, "indexes", 1, ["t"]),
      edge(3, "grounds", 2, []),
    ]);
    expect(findComponent(cited, "t")?.terminusCitedness).toEqual({ terminus: 2, citedBy: [3] });
    expect(renderLaneCheckerReports(cited)).toContain("terminus T2 cited from outside: T3");

    // An IN-LANE citation of the terminus is not "from outside". T3's own
    // `order` keeps it EARLIER than the terminus, so the lane stays closed
    // (`latestMember` is still T2) while T3 is a full member citing it.
    const inLaneOnly = checkLanes(
      [
        { id: 1, type: ["design"], order: [0, 1] },
        { id: 2, type: ["design"], order: [0, 3] },
        { id: 3, type: ["implement"], order: [0, 2] },
      ],
      [
        edge(2, "extends", 1, ["t"]),
        edge(2, "indexes", 1, ["t"]),
        edge(3, "grounds", 2, ["t"]),
      ],
    );
    expect(findComponent(inLaneOnly, "t")?.terminusCitedness).toEqual({ terminus: 2, citedBy: [] });
    expect(renderLaneCheckerReports(inLaneOnly)).toContain(
      "is NOT cited from outside the lane",
    );
  });

  test("an OPEN lane is asked no terminus question — the field is null, not an empty citer list", () => {
    const result = checkLanes(
      [design(401), design(402), design(403)],
      [edge(402, "extends", 401, ["s"]), edge(403, "extends", 402, ["s"])],
    );
    expect(findLaneStats(result, "s")?.state.closure).toBe("open");
    expect(findComponent(result, "s")?.terminusCitedness).toBeNull();
  });
});

// -------------------------------- report 4b: structural bypass candidates

describe("report 4b — structural bypass candidates over the SEGMENT's whole graph", () => {
  test("a direct edge with a two-hop alternative is a candidate naming both routes", () => {
    const turns = [design(1), design(2), design(3)];
    const result = checkLanes(turns, [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(3, "grounds", 1), // the direct edge the chain also reaches
    ]);
    expect(result.bypassCandidates).toEqual([
      {
        segment: DEFAULT_SEGMENT,
        citingId: 3,
        citedId: 1,
        relations: ["grounds"],
        alternativePath: [3, 2, 1],
      },
    ]);
  });

  test("the report names NO disposition — neither route is marked, in the data or in the render", () => {
    const turns = [design(1), design(2), design(3)];
    const result = checkLanes(turns, [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(3, "grounds", 1),
    ]);
    const candidate = result.bypassCandidates[0]!;
    expect(Object.keys(candidate).sort()).toEqual([
      "alternativePath",
      "citedId",
      "citingId",
      "relations",
      "segment",
    ]);
    const text = renderLaneCheckerReports(result);
    expect(text).toContain("T3 -> T1 (grounds) -- also joined by T3 -> T2 -> T1");
    for (const verdict of ["redundant", "delete", "remove", "drop this"]) {
      expect(text.toLowerCase()).not.toContain(verdict);
    }
  });

  test("a plain chain with no shortcut yields nothing", () => {
    const result = checkLanes(
      [design(1), design(2), design(3)],
      [edge(2, "extends", 1), edge(3, "extends", 2)],
    );
    expect(result.bypassCandidates).toEqual([]);
  });

  test("the graph is the SEGMENT's, not a lane's — a detour through a turn in no lane still counts", () => {
    const turns = [
      { id: 1, type: ["design"], segment: "A", laneTags: ["x"] },
      { id: 2, type: ["design"], segment: "A" }, // in no lane at all
      { id: 3, type: ["design"], segment: "A", laneTags: ["x"] },
    ];
    const result = checkLanes(turns, [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(3, "extends", 1, ["x"]),
    ]);
    expect(result.bypassCandidates.map((c) => `${c.citingId}->${c.citedId}`)).toEqual(["3->1"]);
    expect(result.bypassCandidates[0]!.segment).toBe("A");
  });

  test("a route that leaves the segment is no route — each segment's graph is judged alone", () => {
    // T3 -> T2 -> T1 and the direct T3 -> T1, with T1 alone in segment B. BOTH
    // hops into T1 cross the boundary, so segment A's own graph holds only
    // T3 -> T2 and there is no direct edge left to be bypassed. A reader that
    // keyed the graph on the CITING side alone (dropping the equality test)
    // would pull all three edges into A and report a candidate.
    const turns = [
      { id: 1, type: ["design"], segment: "B" },
      { id: 2, type: ["design"], segment: "A" },
      { id: 3, type: ["design"], segment: "A" },
    ];
    const result = checkLanes(turns, [
      edge(3, "extends", 2),
      edge(2, "extends", 1),
      edge(3, "extends", 1),
    ]);
    expect(result.bypassCandidates).toEqual([]);
  });

  test("`indexes` and `override` are outside the graph — a convergence marker is never proposed as a bypass", () => {
    const turns = [design(1), design(2), design(3)];
    // The only "alternative" runs through an indexes edge, which is not a
    // structural hop; and the direct edge itself is an indexes, which is never
    // a candidate either.
    const viaIndexes = checkLanes(turns, [
      edge(2, "indexes", 1),
      edge(3, "indexes", 2),
      edge(3, "extends", 1),
    ]);
    expect(viaIndexes.bypassCandidates).toEqual([]);
    const directIndexes = checkLanes(turns, [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(3, "indexes", 1),
    ]);
    expect(directIndexes.bypassCandidates).toEqual([]);
  });

  test("parallel relation words on ONE pair are ONE candidate carrying every word", () => {
    const turns = [design(1), design(2), design(3)];
    const result = checkLanes(turns, [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(3, "grounds", 1),
      edge(3, "consume", 1),
    ]);
    expect(result.bypassCandidates).toHaveLength(1);
    expect(result.bypassCandidates[0]!.relations).toEqual(["consume", "grounds"]);
  });

  test("the alternative is the SHORTEST route, and equal-length routes break on the smaller next hop", () => {
    // Two detours exist: 5->4->1 (two hops) and 5->3->2->1 (three). The short
    // one wins, whatever order the edges arrive in.
    const turns = [design(1), design(2), design(3), design(4), design(5)];
    const edges = [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(4, "extends", 1),
      edge(5, "extends", 3),
      edge(5, "extends", 4),
      edge(5, "grounds", 1),
    ];
    expect(checkLanes(turns, edges).bypassCandidates[0]!.alternativePath).toEqual([5, 4, 1]);
    expect(checkLanes(turns, [...edges].reverse()).bypassCandidates[0]!.alternativePath).toEqual([5, 4, 1]);

    // THE TIE. Both 5->3->1 and 5->4->1 are two hops, so length decides
    // nothing and only the ascending walk order does — the answer must be a
    // pure function of the graph, not of edge input order or of which
    // neighbour a set happened to yield first.
    const tiedTurns = [design(1), design(3), design(4), design(5)];
    const tiedEdges = [
      edge(3, "extends", 1),
      edge(4, "extends", 1),
      edge(5, "extends", 3),
      edge(5, "extends", 4),
      edge(5, "grounds", 1),
    ];
    expect(checkLanes(tiedTurns, tiedEdges).bypassCandidates[0]!.alternativePath).toEqual([5, 3, 1]);
    expect(checkLanes(tiedTurns, [...tiedEdges].reverse()).bypassCandidates[0]!.alternativePath).toEqual([
      5, 3, 1,
    ]);
  });

  test("an endpoint the projection never loaded is not invented as a node", () => {
    const result = checkLanes(
      [design(1), design(3)], // 2 deliberately absent
      [edge(2, "extends", 1), edge(3, "extends", 2), edge(3, "grounds", 1)],
    );
    expect(result.bypassCandidates).toEqual([]);
  });

  test("a cyclic graph terminates and reports the honest route rather than hanging", () => {
    // A corrupt forward edge closes a cycle 1 -> 3 -> 2 -> 1.
    const result = checkLanes(
      [design(1), design(2), design(3)],
      [edge(2, "extends", 1), edge(3, "extends", 2), edge(1, "extends", 3), edge(3, "grounds", 1)],
    );
    expect(result.bypassCandidates.map((c) => `${c.citingId}->${c.citedId}`)).toEqual(["3->1"]);
  });
});

// -------------------------------- semantic-conformance ticket 02 + v12 ticket 11

describe("vocabulary conformance — reported, never enforced", () => {
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
    // entirely, and report 2's connectivity is unaffected.
    const stats = findLaneStats(result, "vc3");
    expect(stats?.edgeCountsByRelation).toEqual({ extends: 1, indexes: 1 });
    expect(findComponent(result, "vc3")?.componentCount).toBe(1);
  });

  // A supersedes edge that (hypothetically) carried the SAME tag as a real
  // lane would, if admitted, be silently absorbed into that lane's own
  // `taggedEdges` by `deriveLaneInterpretation`'s tag-only grouping — proving
  // the partition in `checkLanes` runs BEFORE that grouping.
  test("a TAGGED supersedes edge still never joins the lane it would otherwise tag into", () => {
    const turns = [design(722), design(723), design(724)];
    const edges = [
      edge(723, "extends", 722, ["vc3b"]),
      edge(723, "indexes", 722, ["vc3b"]),
      edge(724, "supersedes", 723, ["vc3b"]),
    ];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, "vc3b");
    expect(stats?.edgeCountsByRelation).toEqual({ extends: 1, indexes: 1 });
    expect(stats?.declaration.terminus).toBe(723);
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
    expect(tv.entries.map((v) => v.id)).toEqual(
      legacyTurns.slice(0, tv.entries.length).map((t) => t.id),
    );
  });

  /**
   * V12 TICKET 11'S E2 RULING, pinned behaviourally.
   *
   * The TYPE half of this fact block is error class E3 and prints in the
   * leading ERRORS block. The EDGE half is NOT an error class any more: no
   * write face can produce a word outside the seven, so the only database that
   * can hold such a row is one no writer has migrated — and the commit gate,
   * `errors`' one machine consumer, never runs against one. The fact still
   * prints, on the warning side, because `partitionEdgesByVocabulary` excludes
   * these rows from every graph and a reader who was not told would see a
   * silently under-reported scope.
   */
  test("an out-of-vocabulary relation is a WARNING, not an error — the ERRORS block never names it", () => {
    const turns = [design(740, ["bugfix"]), design(741)];
    const edges = [
      edge(741, "extends", 740, ["vc6"]),
      edge(741, "indexes", 740, ["vc6"]),
      edge(741, "supersedes", 740, []),
    ];
    const result = checkLanes(turns, edges);
    expect(result.errors.map((e) => e.class)).toEqual(["E3"]);
    const text = renderLaneCheckerReports(result);
    expect(text).toContain("1 error(s)");
    expect(text).toContain("[E3] anchor T740 -- T740 type: [bugfix] (outside vocabulary: bugfix)");
    expect(text).not.toContain("[E2]");
    // …and the row is still SAID, on the warning side, with its own reason.
    expect(text).toContain(
      "1 edge(s) whose relation is outside the seven-word vocabulary -- pre-migration stock, admitted to no graph",
    );
    expect(text).toContain("  T741 --supersedes--> T740");

    const cleanResult = checkLanes(
      [design(750), design(751)],
      [edge(751, "extends", 750, ["vc7"]), edge(751, "indexes", 750, ["vc7"])],
    );
    const cleanText = renderLaneCheckerReports(cleanResult);
    expect(cleanText.split("\n")[1]).toBe("(none)");
    expect(cleanText).toContain("(no out-of-vocabulary relations)");
  });
});

describe("partial-input coverage", () => {
  test("a lane whose edges reach a turn missing from the input keeps its terminus, with coverage flagged partial", () => {
    const turns = [design(601)]; // 602 deliberately absent
    const edges = [edge(602, "extends", 601, ["w"]), edge(602, "indexes", 601, ["w"])];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, "w");
    // 602 is NOT a member: membership is the turn's own tags, and this
    // projection never loaded the turn that would have carried them.
    expect(stats?.members.map((m) => m.id)).toEqual([601]);
    expect(stats?.coverage).toEqual({ status: "partial", missingTurnIds: [602] });
    expect(stats?.declaration.terminus).toBe(602);
    // One member left -> PROVISIONAL, so connectivity is not judged.
    expect(findComponent(result, "w")).toBeUndefined();
    expect(stats?.phases).toEqual(["decision"]);
  });
});

// ------------------------------------------------------------------------
// Ticket 12 (P1-7): a lane's own graph asks "do both sides name THIS lane",
// not "is the relation word in some fixed set". v12 ticket 11 made that the
// WHOLE of report 2's domain — there is no second word-set left to drift.
describe("ticket 12 — the peer's own failure case: a lane made of a tagged grounds + verifies pair", () => {
  const turns = [design(1), design(2, ["research"])];
  const edges = [edge(2, "grounds", 1, ["x"]), edge(2, "verifies", 1, ["x"])];
  const result = checkLanes(turns, edges);

  test("membership: both turns are members of lane x", () => {
    expect(findLaneStats(result, "x")?.members.map((m) => m.id)).toEqual([1, 2]);
  });

  test("connectivity: ONE connected island, not two severed single-node islands", () => {
    const component = findComponent(result, "x");
    expect(component?.componentCount).toBe(1);
    expect(component?.islands).toEqual([{ representative: 1, memberIds: [1, 2] }]);
  });
});

describe("ticket 12 — an unsettled cross-phase edge joins no lane's own graph", () => {
  const baseTurns = [design(1), design(2), design(3), design(4, ["implement"])];
  const baseEdges = [
    edge(2, "narrows", 1, ["y"]),
    edge(2, "indexes", 1, ["y"]),
    edge(4, "narrows", 3, ["z"]),
    edge(4, "indexes", 3, ["z"]),
  ];

  test("an UNSETTLED verifies between {y} and {z} adds nothing to either lane's island", () => {
    const result = checkLanes(baseTurns, [...baseEdges, edge(4, "verifies", 1, [])]);
    expect(findComponent(result, "y")?.islands[0]?.memberIds).toEqual([1, 2]);
    expect(findComponent(result, "z")?.islands[0]?.memberIds).toEqual([3, 4]);
    // …and it couples nothing either: an unsettled edge names no lane.
    expect(couplingCounts(result, "y")).toEqual([0, 0, 0]);
  });

  test("the SAME verifies edge TAGGED {y} connects T4 into lane y's own island", () => {
    const result = checkLanes(baseTurns, [...baseEdges, edge(4, "verifies", 1, ["y"])]);
    const componentY = findComponent(result, "y");
    expect(componentY?.componentCount).toBe(1);
    expect(componentY?.islands[0]?.memberIds).toEqual([1, 2, 4]);
  });
});

describe("every distinct tag keeps its own lane, with no delimiter collision between tags", () => {
  // D5 retired the tag-SET join this block used to guard (round-4 review #6: a
  // naive `tagSet.join("")` merged `{a,bc}` with `{ab,c}`). What remains worth
  // pinning is that `laneToken`'s JSON encoding keeps four single-tag lanes
  // apart everywhere a lane is keyed — report 1, report 2 and report 3 alike.
  test("edges tagged {a}/{bc} on one pair and {ab}/{c} on another enumerate FOUR distinct lanes", () => {
    const turns = [design(1), design(2), design(3)];
    const edges = [
      edge(2, "extends", 1, ["a"]),
      edge(2, "extends", 1, ["bc"]),
      edge(2, "indexes", 1, ["a"]),
      edge(2, "indexes", 1, ["bc"]),
      edge(3, "extends", 1, ["ab"]),
      edge(3, "extends", 1, ["c"]),
      edge(3, "indexes", 1, ["ab"]),
      edge(3, "indexes", 1, ["c"]),
    ];
    const result = checkLanes(turns, edges);
    expect(result.lanes.map((lane) => lane.key.tag).sort()).toEqual(["a", "ab", "bc", "c"]);
    expect(result.coupling.map((report) => report.key.tag).sort()).toEqual(["a", "ab", "bc", "c"]);
    expect(result.components.map((component) => component.key.tag).sort()).toEqual([
      "a",
      "ab",
      "bc",
      "c",
    ]);
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

// ------------------------------------------------ report 4c: time-order violations

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
    const edges = [edge(1, "extends", 2, ["x"])];
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
    const result = checkLanes(turns, [edge(20, "grounds", 21, [])]);
    expect(result.timeOrderViolations).toEqual([]);
  });

  test("a cross-session pair with citing epoch strictly greater passes", () => {
    const turns = [turnAt(30, [5, 1], 9000), turnAt(31, [3, 100], 1000)];
    const result = checkLanes(turns, [edge(30, "grounds", 31, [])]);
    expect(result.timeOrderViolations).toEqual([]);
  });

  test("self-citation is exempt even with a corrupt order", () => {
    const result = checkLanes([turnAt(40, [1, 1])], [edge(40, "grounds", 40, [])]);
    expect(result.timeOrderViolations).toEqual([]);
  });

  test("all seven relation words are checked — aggregation (indexes) included, not just stance/consume/grounds", () => {
    const turns = [turnAt(50, [1, 1]), turnAt(51, [1, 9])];
    const result = checkLanes(turns, [edge(50, "indexes", 51, [])]);
    expect(result.timeOrderViolations).toEqual([{ citingId: 50, citedId: 51, relation: "indexes", tags: [] }]);
  });

  test("a turn missing order/epoch data yields no judgement for edges touching it — never a fabricated verdict", () => {
    const turns = [design(60), turnAt(61, [1, 5])];
    const result = checkLanes(turns, [edge(61, "grounds", 60, [])]);
    expect(result.timeOrderViolations).toEqual([]);
  });
});

// ------------------------------------------------ report 1's state line

describe("report 1's state line — closed / open, consumed from deriveLaneStates", () => {
  test("a plain closed lane reads closed, with the terminus", () => {
    const turns = [design(30), design(31)];
    const result = checkLanes(turns, [edge(31, "extends", 30, ["v"]), edge(31, "indexes", 30, ["v"])]);
    const stats = findLaneStats(result, "v");
    expect(stats?.state.closure).toBe("closed");
    expect(stats?.state.terminus).toBe(31);
    expect(renderLaneCheckerReports(result)).toContain("declaration: closed");
  });

  // THE RENDERED DELETION (v12 ticket 04). This lane is the old "repudiate,
  // then declare closure indexing the overridden core" ritual, which rendered
  // the literal string "closed-invalid".
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

  // INVERTED TWICE (peer cross-review A1). v11 asserted a null terminus (the
  // override had cleared it) and a trailing `[last event T103]` clause. The
  // terminus stands now, so the line NAMES it while still reading open — T103
  // is a newer member than T102 — and the freshest-edge clause is deleted with
  // the field behind it.
  test("a lane an in-lane override corrected renders open WITH its terminus — and no freshest-edge clause trails the line", () => {
    const turns = [design(101), design(102), design(103)];
    const result = checkLanes(turns, [
      edge(102, "extends", 101, ["x"]),
      edge(102, "indexes", 101, ["x"]),
      edge(103, "override", 102, ["x"]),
    ]);
    const stats = findLaneStats(result, "x");
    expect(stats?.state.closure).toBe("open");
    expect(stats?.state.terminus).toBe(102);
    const text = renderLaneCheckerReports(result);
    expect(text).toContain("declaration: open (terminus T102)");
    expect(text).not.toContain("last event");
    expect(text).not.toContain("last declarer");
  });

  // TICKET 19, AT THE CHECKER. The state line consumes `deriveLaneStates`
  // directly, so the tail-only convergence rule arrives here with no second
  // derivation: an `indexes` that leaves lane `p` for lane `q` closes `p`,
  // and `q` — merely pointed at — stays open. Restoring "both sides must
  // agree" makes BOTH lanes render `declaration: open` and reddens this.
  test("a lane whose terminus indexes ACROSS into a sibling lane renders closed; the lane it points at stays open (ticket 19)", () => {
    const turns = [design(50), design(51)];
    // Per SIDE (`withEdgeClaimedLaneTags`): turn 51 carries `p`, turn 50 `q`.
    const result = checkLanes(turns, [edge(51, "indexes", 50, [], { tailTag: "p", headTag: "q" })]);
    expect(findLaneStats(result, "p")?.state.closure).toBe("closed");
    expect(findLaneStats(result, "p")?.state.terminus).toBe(51);
    expect(findLaneStats(result, "q")?.state.closure).toBe("open");
    expect(findLaneStats(result, "q")?.state.terminus).toBeNull();
    const text = renderLaneCheckerReports(result);
    expect(text).toContain("declaration: closed (terminus T51)");
    // The crossing is still INTERNAL to neither lane, so it joins no lane's
    // own graph — closure moved, connectivity did not.
    expect(findLaneStats(result, "p")?.edgeCountsByRelation).toEqual({});
    expect(findLaneStats(result, "q")?.edgeCountsByRelation).toEqual({});
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
  const edges = [
    edge(2, "extends", 1, ["u"]),
    edge(2, "indexes", 1, ["u"]),
    edge(3, "consume", 2, ["u"]), // IN-LANE: 3 becomes a {u} member via this same tagged edge
    edge(4, "consume", 1, []), // EXTERNAL, unsettled consume -> counts
    edge(5, "consume", 2, ["other-lane"]), // EXTERNAL, tagged with a DIFFERENT lane -> still counts
    edge(6, "verifies", 1, []), // EXTERNAL testimony -> must NOT appear in used[]
  ];
  const result = checkLanes(turns, edges);
  const stats = findLaneStats(result, "u");

  test("external consume citations (unsettled and differently-tagged) both land in usedFromNonMembers", () => {
    const pairs = stats?.citedness.usedFromNonMembers.map((f) => `${f.citingId}->${f.citedId}`).sort();
    expect(pairs).toEqual(["4->1", "5->2"]);
  });

  test("a member's own IN-LANE consume edge (3->2, both {u} members) never enters usedFromNonMembers", () => {
    expect(stats?.citedness.usedFromNonMembers.some((f) => f.citingId === 3)).toBe(false);
    expect(stats?.members.some((m) => m.id === 3)).toBe(true);
  });

  test("testimony from outside (verifies) never enters usedFromNonMembers, only testimonyFromNonMembers", () => {
    expect(stats?.citedness.usedFromNonMembers.some((f) => f.citingId === 6)).toBe(false);
    expect(stats?.citedness.testimonyFromNonMembers).toEqual([{ citingId: 6, citedId: 1, relation: "verifies" }]);
  });

  test("the rendered text carries used[] beside grounds[]/testimony[]", () => {
    expect(renderLaneCheckerReports(result)).toContain("used[T4->T1, T5->T2]");
  });
});

// ------------------------------------------------ the whole warning-side render, pinned

describe("the golden fixture's warning-side render is byte-stable", () => {
  /**
   * Captured from the ACTUAL `renderLaneCheckerReports` output for the golden
   * fixture, by running the implementation (`## Report 2` onward, verbatim) —
   * the same methodology the file it replaced used. It is the ONE assertion
   * that covers every surviving report's rendering at once: a change to any of
   * `renderComponentReport`/`renderCouplingReport`/`renderBypassCandidate`/
   * `renderTimeOrderViolation`/`renderUnattributedCluster` breaks it.
   *
   * Two shapes in here are v12 ticket 11's own retargets and are worth reading
   * as measurements rather than as text:
   *
   *   - report 2's terminus line: 7 of 11 closed lanes are cited from outside.
   *   - the attribution cluster: ONE 54-turn component. The cluster is defined
   *     by unsettled EDGES now ("两侧 tag 为空串的边 … 结算自己的待办队列"), and
   *     this corpus predates v12, so most of its edges are unsettled and they
   *     form one large component. That is the honest picture of settlement's
   *     backlog on pre-migration stock, not a defect of the rule: the model's
   *     own completion criterion is zero unsettled edges, at which point the
   *     warning falls silent entirely.
   */
  const WARNING_SIDE_BASELINE = [
    "## Report 2 -- connectivity over each lane's OWN edges (provisional lanes, 0-1 members, are not judged)",
    "Lane default:{cadence} - components: 1 (healthy)",
    "  island@T978: T978,T979,T981",
    "  terminus T981 cited from outside: T992",
    "Lane default:{contract-repair} - components: 1 (healthy)",
    "  island@T982: T982,T983,T984",
    "  terminus T984 cited from outside: T998",
    "Lane default:{contract-verify} - components: 1 (healthy)",
    "  island@T945: T945,T946",
    "  terminus T946 cited from outside: T947,T998",
    "Lane default:{ownership} - components: 1 (healthy)",
    "  island@T900: T900,T910,T912,T913",
    "  terminus T913 is NOT cited from outside the lane",
    "Lane default:{relation-vocabulary} - components: 1 (healthy)",
    "  island@T933: T933,T935,T937,T938,T939",
    "  terminus T939 cited from outside: T940,T945",
    "Lane default:{rewind-marking} - components: 1 (healthy)",
    "  island@T914: T914,T915",
    "  terminus T915 is NOT cited from outside the lane",
    "Lane default:{segment-audit} - components: 1 (healthy)",
    "  island@T989: T989,T990",
    "  terminus T990 cited from outside: T991",
    "Lane default:{settlement-scope} - components: 1 (healthy)",
    "  island@T900: T900,T906",
    "  terminus T906 is NOT cited from outside the lane",
    "Lane default:{spec-design} - components: 1 (healthy)",
    "  island@T900: T900,T901",
    "  terminus T901 is NOT cited from outside the lane",
    "Lane default:{turn-edge-mechanism} - components: 1 (healthy)",
    "  island@T926: T926,T927,T929",
    "  terminus T929 cited from outside: T930",
    "Lane default:{view-spec} - components: 1 (healthy)",
    "  island@T919: T919,T920,T921,T922",
    "  terminus T922 cited from outside: T923",
    "Lane default:{write-gate} - components: 1 (healthy)",
    "  island@T950: T950,T951,T952,T953,T954,T955,T957,T958",
    "",
    "## Report 3 -- cross-lane coupling (counts only; no threshold and no verdict)",
    "Lane default:{cadence} - cross-lane edges: verifies/override/narrows/extends=0  grounds=0  consume/indexes=0",
    "Lane default:{contract-repair} - cross-lane edges: verifies/override/narrows/extends=0  grounds=0  consume/indexes=0",
    "Lane default:{contract-verify} - cross-lane edges: verifies/override/narrows/extends=0  grounds=0  consume/indexes=0",
    "Lane default:{ownership} - cross-lane edges: verifies/override/narrows/extends=0  grounds=0  consume/indexes=0",
    "Lane default:{relation-vocabulary} - cross-lane edges: verifies/override/narrows/extends=0  grounds=0  consume/indexes=0",
    "Lane default:{rewind-marking} - cross-lane edges: verifies/override/narrows/extends=0  grounds=0  consume/indexes=0",
    "Lane default:{segment-audit} - cross-lane edges: verifies/override/narrows/extends=0  grounds=0  consume/indexes=0",
    "Lane default:{settlement-scope} - cross-lane edges: verifies/override/narrows/extends=0  grounds=0  consume/indexes=0",
    "Lane default:{spec-design} - cross-lane edges: verifies/override/narrows/extends=0  grounds=0  consume/indexes=0",
    "Lane default:{turn-edge-mechanism} - cross-lane edges: verifies/override/narrows/extends=0  grounds=0  consume/indexes=0",
    "Lane default:{view-spec} - cross-lane edges: verifies/override/narrows/extends=0  grounds=0  consume/indexes=0",
    "Lane default:{write-gate} - cross-lane edges: verifies/override/narrows/extends=0  grounds=0  consume/indexes=0",
    "",
    "## Report 4b -- structural bypass candidates (a direct edge and a longer route between the same two turns; which to keep depends on what each contributes, so nothing here is marked for deletion)",
    "4 candidate(s):",
    "  T942 -> T930 (consume) -- also joined by T942 -> T935 -> T933 -> T932 -> T930",
    "  T965 -> T959 (grounds) -- also joined by T965 -> T962 -> T961 -> T960 -> T959",
    "  T974 -> T958 (grounds) -- also joined by T974 -> T972 -> T970 -> T966 -> T965 -> T959 -> T958",
    "  T1001 -> T998 (consume) -- also joined by T1001 -> T999 -> T998",
    "",
    "## Report 4c -- time-order violations (the DAG guarantee)",
    "(none)",
    "",
    "## Attribution -- unattributed clusters + lane proliferation (warnings; settlement's own debt, never enforced -- a cluster's edges are ALSO listed one by one as E6 above, which is the half that blocks commit)",
    "3 unattributed cluster(s) of 4+ turns:",
    "  54 turns joined by edges with no lane on either side: T900,T902,T903,T904,T905,T910,T911,T912,T929,T930,T931,T932,T933,T935,T936,T939,T940,T941,T942,T945 (showing first 20)",
    "  4 turns joined by edges with no lane on either side: T922,T923,T924,T926",
    "  5 turns joined by edges with no lane on either side: T990,T991,T993,T994,T995",
    "(no task over its lane budget)",
    "",
    "## Stock warnings -- rows that take part in no report",
    "(no cross-task tagged edges)",
    "(no out-of-vocabulary relations)",
  ].join("\n");

  test("the golden fixture's `## Report 2` onward is byte-identical to the captured baseline", () => {
    const result = checkLanes(fixtureTurns, fixtureEdges);
    const text = renderLaneCheckerReports(result);
    const tail = text.slice(text.indexOf("## Report 2"));
    expect(tail.replace(/\n+$/, "")).toBe(WARNING_SIDE_BASELINE);
  });

  test("the golden fixture's TYPE conformance is clean once compact markers are exempt; the errors block leads with its E6 count", () => {
    const result = checkLanes(fixtureTurns, fixtureEdges);
    const text = renderLaneCheckerReports(result);
    // Ticket 20: the block no longer leads with "(none)" on this corpus — its
    // 77 draft edges are E6 instances. The TYPE half (E3) is still silent,
    // which is what `vocabularyConformance` below pins directly.
    expect(text.startsWith(
      "## ERRORS -- states the grammar forbids; commit refuses while one anchored in your writable scope remains\n" +
        "77 error(s)\n",
    )).toBe(true);
    expect(text).toContain(
      "  [E6] anchor T902 -- T902 --consume--> T900: DRAFT edge -- neither side names a lane",
    );
    expect(text).not.toContain("[E3]");
    expect(text).not.toContain("[E4]");
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

// --------------------------------------------- the error classes E3/E4/E6

/**
 * The ERROR side of the checker's error/warning split. Every test below probes
 * the same two things per class: that the defect is DETECTED, and that its
 * ANCHOR lands on the turn the settlement commit gate will scope by — an EDGE
 * error at its citing turn, a TYPE error at the turn itself.
 *
 * The "in-scope / out-of-scope anchor variant" pairs are what pin the anchoring
 * RULE rather than merely the anchor value: the checker itself has no notion of
 * a window, so each pair wires the SAME defect with its anchor once inside and
 * once outside a declared writable set.
 */
describe("errors E3/E4/E6 — detection and anchoring", () => {
  /** The commit gate's whole filter, in one line. */
  const anchoredIn = (errors: readonly LaneCheckerError[], writable: readonly number[]) =>
    errors.filter((error) => writable.includes(error.anchorId));

  const tagged = (id: number, tags: string[], type: string[] = ["design"]): LaneCheckerTurnInput => ({
    id,
    type,
    tags,
  });

  // ---- E1 IS RETIRED, E2 IS DELETED AS A CLASS ----

  // Ticket 20 changed what an untagged stance edge produces: E6, the draft
  // class, which fires on the SHAPE (an empty side) for every word alike. E1
  // fired on the WORD (`extends`/`narrows` specifically, under the withdrawn
  // mandate) and its absence is what these two still pin — the class list must
  // never single out a word again.
  test("an untagged extends/narrows produces no WORD-specific error — the mandate's stock half is gone", () => {
    const turns = [tagged(10, ["lane-a"]), tagged(11, ["lane-a"])];
    expect(checkLanes(turns, [edge(11, "extends", 10, [])]).errors.map((e) => e.class)).toEqual(["E6"]);
    expect(checkLanes(turns, [edge(11, "narrows", 10, [])]).errors.map((e) => e.class)).toEqual(["E6"]);
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
      // Every word yields the SAME class — the shape one, never a word one.
      expect(checkLanes(turns, [edge(21, word, 20, [])]).errors.map((e) => e.class)).toEqual(["E6"]);
    }
  });

  test("an out-of-vocabulary relation produces NO error, via either input channel — E2 is gone as a class", () => {
    const turns = [tagged(60, []), tagged(61, [])];
    const inline = checkLanes(turns, [edge(61, "supersedes", 60, [])]);
    expect(inline.errors).toEqual([]);
    expect(inline.vocabularyConformance.outOfVocabularyEdges.count).toBe(1);

    // The loader's own dedicated channel (`checkLanes`'s third argument)
    // reports the identical fact — one classification, two supply routes.
    const viaLoaderChannel = checkLanes(turns, [], [edge(61, "supersedes", 60, [])]);
    expect(viaLoaderChannel.errors).toEqual([]);
    expect(viaLoaderChannel.vocabularyConformance.outOfVocabularyEdges).toEqual(
      inline.vocabularyConformance.outOfVocabularyEdges,
    );
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
    expect(checkLanes([tagged(100, [], ["compact"]), tagged(101, [], ["design"])], []).errors).toEqual([]);
  });

  test("E3 exemption — a legally-SKIPPED turn cannot reach this module at all (the exemption is the loader's law-8 gate)", () => {
    // Stated as an absence: `LaneCheckerTurnInput` carries no status field, so
    // there is nothing here that COULD re-admit a skipped turn. The exemption
    // is pinned where it lives, in `tests/db/lane-checker-load.test.ts`.
    const asIfSkipped = checkLanes([tagged(110, [], [])], []);
    expect(asIfSkipped.errors).toHaveLength(1);
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
    const result = checkLanes(turns, [
      edge(141, "extends", 140, ["a"]),
      edge(141, "extends", 140, ["b"]),
    ]);
    expect(result.errors).toEqual([
      {
        class: "E4",
        anchorId: 141,
        citingId: 141,
        citedId: 140,
        relation: "extends",
        tags: ["b"],
        missing: [{ tag: "b", endpoint: "cited" }],
      },
    ]);
  });

  test("E4 — a tag missing from BOTH endpoints is named twice, once per side (the write gate's own rejection shape)", () => {
    const turns = [tagged(150, ["a"]), tagged(151, ["a"])];
    const result = checkLanes(turns, [
      edge(151, "consume", 150, ["a"]),
      edge(151, "consume", 150, ["z"]),
    ]);
    expect(result.errors).toHaveLength(1);
    const error = result.errors[0]!;
    expect(error.class === "E4" && error.missing).toEqual([
      { tag: "z", endpoint: "cited" },
      { tag: "z", endpoint: "citing" },
    ]);
  });

  // ---- E4 is per-SIDE (lane-model-v12 D2 rule 3, ticket 06) ----
  //
  // THE MUTATION TARGET. `subsetObligations` binds `tailTag` to the CITING turn
  // and `headTag` to the CITED one. Point either at the other endpoint and
  // every test in this block goes red. A same-lane edge (`tail === head`)
  // cannot detect the swap at all, which is why these three fixtures are all
  // ASYMMETRIC.
  describe("E4 is per-SIDE: tailTag is owed by the citing turn, headTag by the cited turn", () => {
    test("a cross-lane edge whose two sides each sit on their OWN endpoint is clean", () => {
      const turns = [tagged(180, ["b"]), tagged(181, ["a"])];
      const result = checkLanes(turns, [
        edge(181, "extends", 180, [], { tailTag: "a", headTag: "b" }),
      ]);
      expect(result.errors).toEqual([]);
    });

    test("a tailTag absent from the CITING turn is blamed on the citing side ALONE — the cited turn is never asked about it", () => {
      const turns = [tagged(190, ["b"]), tagged(191, [])];
      const result = checkLanes(turns, [
        edge(191, "extends", 190, [], { tailTag: "a", headTag: "b" }),
      ]);
      expect(result.errors).toHaveLength(1);
      const error = result.errors[0]!;
      expect(error.class === "E4" && error.tags).toEqual(["a", "b"]);
      expect(error.class === "E4" && error.missing).toEqual([{ tag: "a", endpoint: "citing" }]);
    });

    test("a headTag absent from the CITED turn is blamed on the cited side ALONE", () => {
      const turns = [tagged(200, []), tagged(201, ["a"])];
      const result = checkLanes(turns, [
        edge(201, "extends", 200, [], { tailTag: "a", headTag: "b" }),
      ]);
      expect(result.errors).toHaveLength(1);
      const error = result.errors[0]!;
      expect(error.class === "E4" && error.missing).toEqual([{ tag: "b", endpoint: "cited" }]);
    });
  });

  test("E4 — an endpoint whose tags were never LOADED yields no verdict; an endpoint with an empty loaded set does", () => {
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

  // ---- E6 — a DRAFT edge (ticket 20) ----
  //
  // THE MUTATION for the whole class: make `computeDraftEdgeErrors` return `[]`
  // and every test in this block goes red (as does the commit-refusal test in
  // `tests/worker/note-settlement-sdk-query.test.ts`).

  test("E6 — a fully unsettled edge is an error naming BOTH sides, anchored at the citing turn", () => {
    const result = checkLanes([tagged(500, []), tagged(501, [])], [edge(501, "consume", 500, [])]);
    expect(result.errors).toEqual([
      {
        class: "E6",
        anchorId: 501,
        citingId: 501,
        citedId: 500,
        relation: "consume",
        tags: [],
        unsettledSides: ["tail", "head"],
      },
    ]);
  });

  test("E6 — a HALF-settled edge names the MISSING side, either way round", () => {
    // The side is the whole finding: "settle this row" and "settle the other
    // half of this row" are different jobs, and a class that only said "draft"
    // would leave the reader to diff the two side values themselves.
    const turns = [tagged(510, ["a"]), tagged(511, ["a"])];
    const headOpen = checkLanes(turns, [
      edge(511, "extends", 510, [], { tailTag: "a", headTag: "" }),
    ]).errors[0]!;
    expect(headOpen.class === "E6" && headOpen.unsettledSides).toEqual(["head"]);
    expect(headOpen.class === "E6" && headOpen.tags).toEqual(["a"]);

    const tailOpen = checkLanes(turns, [
      edge(511, "extends", 510, [], { tailTag: "", headTag: "a" }),
    ]).errors[0]!;
    expect(tailOpen.class === "E6" && tailOpen.unsettledSides).toEqual(["tail"]);
    expect(tailOpen.class === "E6" && tailOpen.tags).toEqual(["a"]);
  });

  test("E6 — a fully SETTLED edge is not a draft, whatever else is wrong with it", () => {
    // Same-lane and CROSS-lane both count as settled: E6 asks only whether each
    // side names something, never whether the two agree.
    const turns = [tagged(520, ["a"]), tagged(521, ["a", "b"])];
    expect(checkLanes(turns, [edge(521, "extends", 520, ["a"])]).errors).toEqual([]);
    expect(
      checkLanes(turns, [edge(521, "extends", 520, [], { tailTag: "b", headTag: "a" })]).errors,
    ).toEqual([]);
  });

  test("E6 — every relation word alike; the class fires on the SHAPE, never on the word", () => {
    const turns = [tagged(530, []), tagged(531, [])];
    for (const word of ["override", "narrows", "extends", "indexes", "consume", "grounds", "verifies"]) {
      expect(
        checkLanes(turns, [edge(531, word, 530, [])]).errors.map((e) => e.class),
        word,
      ).toEqual(["E6"]);
    }
  });

  test("E6 — in-scope vs out-of-scope anchor variants", () => {
    // The gate's whole scoping rule, on the new class: a draft anchored outside
    // the writable set is another window's work.
    const turns = [tagged(540, []), tagged(541, []), tagged(550, []), tagged(551, [])];
    const writable = [550, 551];
    expect(anchoredIn(checkLanes(turns, [edge(541, "extends", 540, [])]).errors, writable)).toEqual([]);
    expect(
      anchoredIn(checkLanes(turns, [edge(551, "extends", 550, [])]).errors, writable).map((e) => e.class),
    ).toEqual(["E6"]);
  });

  test("E6 — an out-of-vocabulary relation is never classed as a draft either", () => {
    const result = checkLanes([tagged(560, []), tagged(561, [])], [edge(561, "supersedes", 560, [])]);
    expect(result.errors).toEqual([]);
    expect(result.vocabularyConformance.outOfVocabularyEdges.count).toBe(1);
  });

  // REQUIREMENT 2, pinned rather than rewritten: "计算时视为无边". A draft edge
  // reaches `laneMembershipClaims`, which yields no claim the moment either side
  // is `''` — so it joins no lane's own edge set, unions no connectivity, counts
  // as no crossing and adds no member. Every one of those is asserted here on a
  // HALF-settled edge, the shape that only became writable with this ticket.
  test("a DRAFT edge takes part in no lane computation — it is E6 and nothing else", () => {
    const turns: LaneCheckerTurnInput[] = [
      { id: 570, type: ["design"], tags: ["a"], laneTags: ["a"] },
      { id: 571, type: ["design"], tags: ["a"], laneTags: ["a"] },
      { id: 572, type: ["design"], tags: ["a"], laneTags: ["a"] },
    ];
    const result = runCheckLanes(turns, [
      // The lane's ONE real internal edge, plus a half-settled row between the
      // same two turns and a fully unsettled one reaching the third.
      edge(571, "extends", 570, ["a"]),
      edge(571, "consume", 570, [], { tailTag: "a", headTag: "" }),
      edge(572, "grounds", 571, []),
    ]);
    const stats = findLaneStats(result, "a");
    // Attribution: only the settled row is the lane's own edge.
    expect(stats?.edgeCountsByRelation).toEqual({ extends: 1 });
    // Membership is unchanged by the drafts (it is a NODE fact anyway), and the
    // draft to T572 does NOT sever the lane, because it never joined it.
    expect(stats?.members.map((m) => m.id)).toEqual([570, 571, 572]);
    expect(findComponent(result, "a")?.componentCount).toBe(2);
    expect(findComponent(result, "a")?.islands.map((i) => i.memberIds)).toEqual([[570, 571], [572]]);
    // Coupling: a draft names at most one lane, so it is no crossing.
    expect(couplingCounts(result, "a")).toEqual([0, 0, 0]);
    // And the errors are exactly the two drafts.
    expect(result.errors.map((e) => `${e.class}:${e.anchorId}:${e.citedId ?? ""}`)).toEqual([
      "E6:571:570",
      "E6:572:571",
    ]);
  });

  // ---- cross-class properties ----

  test("an out-of-vocabulary relation is never re-classed as E4 either — it reaches no edge check at all", () => {
    // `supersedes` is partitioned out before any graph computation. A TAGGED
    // one is the sharp case: its tags are absent from both (tagless)
    // endpoints, so E4 would fire if it were admitted.
    const result = checkLanes([tagged(210, []), tagged(211, [])], [edge(211, "supersedes", 210, ["a"])]);
    expect(result.errors).toEqual([]);
    expect(result.vocabularyConformance.outOfVocabularyEdges.count).toBe(1);
  });

  test("errors sort by anchor, then class — one deterministic order for both surfaces", () => {
    // Two classes on the SAME anchor (222) is what pins the class tiebreak.
    const turns = [tagged(220, [], []), tagged(221, ["a"]), tagged(222, [], [])];
    const result = checkLanes(turns, [
      edge(222, "consume", 221, ["a"]), // E4 @ 222 (222 lacks "a")
    ]);
    expect(result.errors.map((e) => `${e.anchorId}:${e.class}`)).toEqual([
      "220:E3",
      "222:E3",
      "222:E4",
    ]);
  });

  test("the errors LIST is uncapped even where the fact lists it is classed from are capped", () => {
    // LOAD-BEARING: the commit gate filters this list by anchor. A display cap
    // here would let an instance past the gate simply by sorting late.
    // 60 > MAX_ERROR_RENDER_ENTRIES (50): the one cap value a refactor would
    // plausibly copy into the data path must itself go red here.
    const turns = Array.from({ length: 60 }, (_, index) => tagged(300 + index, [], ["bugfix"]));
    const result = checkLanes(turns, []);
    expect(result.errors).toHaveLength(60);
    expect(result.vocabularyConformance.typeViolations.count).toBe(60);
    expect(result.vocabularyConformance.typeViolations.entries).toHaveLength(20);
    expect(result.errors.at(-1)!.anchorId).toBe(359);
  });

  test("the warning side's own computations are untouched by the split", () => {
    const turns = [tagged(400, ["L"], ["design"]), tagged(401, ["L"], ["design"])];
    const edges = [edge(401, "extends", 400, ["L"]), edge(401, "indexes", 400, ["L"]), edge(401, "supersedes", 400, [])];
    const result = checkLanes(turns, edges);
    expect(result.errors).toEqual([]);
    const stats = findLaneStats(result, "L");
    expect(stats?.edgeCountsByRelation).toEqual({ extends: 1, indexes: 1 });
    expect(stats?.state.closure).toBe("closed");
    expect(findComponent(result, "L")?.componentCount).toBe(1);
  });
});

// ------------------------------------------------ D9 warning 1, retargeted

/**
 * v12 ticket 11 REDEFINED this warning by its EDGES: 4+ turns joined by edges
 * with BOTH sides unsettled. Spec D2 makes "both sides tagged or neither" the
 * law, so a both-sides-empty edge is exactly a row settlement has not decided —
 * "那就是结算自己的待办队列". Three parts of the v11 rule go with the
 * redefinition, and each has a test below that would have passed under it:
 *
 *   - the NODE filter ("turns carrying no lane tag"): a lane member's own
 *     unsettled edge is debt exactly like an orphan's;
 *   - the relation word-set: every word counts, because settlement owes a
 *     decision on every unsettled row;
 *   - the untagged-`indexes` "free aggregation" excuse: v12 has no free
 *     aggregation, only unsettled edges.
 */
describe("D9 warning 1 — unsettled-edge clusters", () => {
  const t = (id: number, tags: string[] = []): LaneCheckerTurnInput => ({
    id,
    type: ["design"],
    tags,
  });
  const clusters = (result: ReturnType<typeof checkLanes>) => result.unattributedClusters;
  const clusterSizes = (result: ReturnType<typeof checkLanes>) =>
    clusters(result).entries.map((cluster) => cluster.turnCount);

  // ---- the boundary, both sides ----

  test("THREE turns joined by unsettled edges are SILENT — a short exchange is not a workflow", () => {
    const result = checkLanes([t(1), t(2), t(3)], [edge(2, "extends", 1), edge(3, "extends", 2)]);
    expect(clusters(result).count).toBe(0);
  });

  test("FOUR turns joined by unsettled edges WARN, naming every one of them", () => {
    const result = checkLanes([t(1), t(2), t(3), t(4)], [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(4, "extends", 3),
    ]);
    expect(clusters(result).count).toBe(1);
    expect(clusters(result).entries[0]).toEqual({ turnIds: [1, 2, 3, 4], turnCount: 4 });
  });

  test("four turns with NO edges between them are four one-turn nothings, not a cluster", () => {
    // The connectivity half of the rule, isolated. A rule that counted
    // unattributed TURNS rather than unsettled edges would fire here.
    expect(clusters(checkLanes([t(1), t(2), t(3), t(4)], [])).count).toBe(0);
  });

  // ---- the subject is the EDGE, not the turn ----

  test("a settled edge takes its pair out of the debt graph, and only that pair", () => {
    const result = checkLanes(
      [t(1), t(2), t(3), t(4, ["lane"]), t(5, ["lane"])],
      [
        edge(2, "extends", 1),
        edge(3, "extends", 2),
        edge(4, "extends", 3),
        edge(5, "extends", 4, ["lane"]), // settled: not debt
      ],
    );
    // The real lane exists (not vacuous), and the four unsettled-edge
    // endpoints still cluster — T4 among them, because its OWN edge to T3 is
    // unsettled whether or not T4 belongs to a lane.
    expect(result.lanes.map((lane) => lane.key.tag)).toEqual(["lane"]);
    expect(clusters(result).entries).toEqual([{ turnIds: [1, 2, 3, 4], turnCount: 4 }]);
  });

  test("a LANE MEMBER's own unsettled edge is debt too — membership excuses nothing", () => {
    // THE REDEFINITION, isolated. Under the v11 node rule every one of these
    // turns carries a lane tag and the cluster was silent; under the edge rule
    // the four unsettled edges are four rows settlement still owes.
    const member = (id: number): LaneCheckerTurnInput => ({
      id,
      type: ["design"],
      tags: ["L"],
      laneTags: ["L"],
    });
    const result = checkLanes(
      [member(1), member(2), member(3), member(4), member(5)],
      [
        edge(5, "extends", 4, ["L"]), // the one settled edge
        edge(2, "extends", 1),
        edge(3, "extends", 2),
        edge(4, "extends", 3),
      ],
    );
    expect(result.lanes[0]?.members.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
    expect(clusters(result).entries).toEqual([{ turnIds: [1, 2, 3, 4], turnCount: 4 }]);
  });

  test("a HALF-settled edge leaves the CLUSTER graph — it is E6's row, not the warning's", () => {
    // `laneEdgeTags` is non-empty when EITHER side is settled, so a
    // half-settled row leaves the debt graph. The rule reads "both sides
    // empty", and this pins which side of that boundary a half-settled row
    // falls on: OUT, because it names a lane. Ticket 20 makes that boundary
    // matter in ordinary stock rather than only after a migration defect — the
    // write gate ACCEPTS a half-settled edge now — and it is why the two
    // findings are not redundant: E6 is the ONLY place this shape is reported.
    const result = checkLanes([t(1), t(2), t(3), t(4)], [
      edge(2, "extends", 1, [], { tailTag: "x", headTag: "" }),
      edge(3, "extends", 2),
      edge(4, "extends", 3),
    ]);
    expect(clusters(result).count).toBe(0);
    const draft = result.errors.filter((e) => e.class === "E6");
    expect(draft).toHaveLength(3);
    expect(draft[0]).toEqual({
      class: "E6",
      anchorId: 2,
      citingId: 2,
      citedId: 1,
      relation: "extends",
      tags: ["x"],
      unsettledSides: ["head"],
    });
  });

  // ---- every relation word counts ----

  test("DOMAIN — an evidence line joined only by verifies/consume/grounds IS a cluster", () => {
    const result = checkLanes([t(1), t(2), t(3), t(4), t(5)], [
      edge(2, "verifies", 1),
      edge(3, "verifies", 2),
      edge(4, "consume", 3),
      edge(5, "grounds", 4),
    ]);
    expect(clusters(result).entries).toEqual([{ turnIds: [1, 2, 3, 4, 5], turnCount: 5 }]);
  });

  test("DOMAIN — an unsettled `override` counts too: settlement owes it a decision like any other row", () => {
    // Under the v11 word-set (`indexes`/`override` excluded) this was three
    // turns and silent.
    const result = checkLanes([t(1), t(2), t(3), t(4)], [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(4, "override", 3),
    ]);
    expect(clusters(result).entries).toEqual([{ turnIds: [1, 2, 3, 4], turnCount: 4 }]);
  });

  test("DOMAIN — an unsettled `indexes` no longer EXCUSES what it aggregates; it joins the cluster", () => {
    // v11 read an untagged `indexes` as "free aggregation" and dropped its
    // cited endpoints. v12 has no free aggregation: an unsettled edge is
    // unsettled, whatever word it carries.
    const result = checkLanes([t(1), t(2), t(3), t(4)], [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(4, "indexes", 1),
      edge(4, "indexes", 2),
    ]);
    expect(clusterSizes(result)).toEqual([4]);
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

  test("two disconnected debt components are two clusters, each judged on its own", () => {
    const result = checkLanes(
      [1, 2, 3, 4, 6, 7, 8, 9].map((id) => t(id)),
      [
        edge(2, "extends", 1),
        edge(3, "extends", 2),
        edge(4, "extends", 3),
        edge(7, "extends", 6),
        edge(8, "extends", 7),
        edge(9, "extends", 8),
      ],
    );
    expect(clusters(result).entries).toEqual([
      { turnIds: [1, 2, 3, 4], turnCount: 4 },
      { turnIds: [6, 7, 8, 9], turnCount: 4 },
    ]);
  });

  // THE TICKET-20 OVERLAP RULING, pinned. The CLUSTER stays a warning — its
  // subject is the SCALE of unattributed work, it needs 4+ turns, and nothing
  // refuses on it. The same three rows are ALSO error class E6, one per edge,
  // which is what the commit gate reads. Both, deliberately: filtering either
  // list by the other would make a window's blocking set depend on how many
  // neighbours its debt happens to have (E6 filtered by the cluster) or empty
  // the warning outright (the cluster filtered by E6).
  test("an unsettled-edge cluster stays a WARNING while its rows are E6 errors — the scale fact and the per-row backlog both stand", () => {
    const result = checkLanes([t(1), t(2), t(3), t(4)], [
      edge(2, "extends", 1),
      edge(3, "extends", 2),
      edge(4, "extends", 3),
    ]);
    // The warning: ONE cluster, unfiltered by the fact that every row in it is
    // separately an error.
    expect(clusters(result).count).toBe(1);
    expect(clusters(result).entries).toEqual([{ turnIds: [1, 2, 3, 4], turnCount: 4 }]);
    // The backlog: one E6 per EDGE, anchored at each citing turn, unfiltered by
    // the fact that the rows happen to form a cluster.
    expect(result.errors.map((e) => `${e.class}:${e.anchorId}`)).toEqual([
      "E6:2",
      "E6:3",
      "E6:4",
    ]);
  });

  // Below the cluster boundary the two come apart, which is what shows they are
  // genuinely two findings rather than one printed twice: two turns joined by
  // one draft edge are silent as a cluster (3 or fewer is "a short exchange is
  // not a workflow") and still one blocking error.
  test("a single draft edge is E6 with no cluster at all — the per-row class has no 4+ boundary", () => {
    const result = checkLanes([t(1), t(2)], [edge(2, "extends", 1)]);
    expect(clusters(result).count).toBe(0);
    expect(result.errors.map((e) => e.class)).toEqual(["E6"]);
  });

  // The other direction (a HALF-settled row is E6 but no cluster) is pinned by
  // "a HALF-settled edge leaves the CLUSTER graph" above, in the block that
  // owns the cluster boundary.

  test("an edge endpoint the projection never loaded is not invented as a cluster member", () => {
    // "Never fabricate completeness", the same posture report 1's `coverage`
    // takes: T5 is cited but absent from `turns`.
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
    expect(proliferation(1, 19)).toEqual([]);
    expect(proliferation(1, 20)).toEqual([]);
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
    expect(
      checkLanes([], [], [], [{ ...facts("60", 2, 40), emptyLaneTags: ["ghost"] }])
        .laneProliferation,
    ).toEqual([]);
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
    expect(checkLanes([], [], [], [facts("60", 6, 100)]).laneProliferation[0]!.emptyLaneTags)
      .toBeUndefined();
  });
});

// ------------------------- v12 ticket 06: the source swap itself

/**
 * A SENTINEL, not a behaviour test. Ticket 06's whole content is that the
 * checker family reads the two SIDE columns instead of the merged `tags` set,
 * with every report number unchanged — and "unchanged" is exactly what no
 * behaviour test can distinguish from "never switched at all" on today's
 * stock, where the two surfaces agree. The only way to pin the swap is to
 * assert the old surface is gone from the source.
 */
describe("the checker family never reads an edge's merged `tags` set (v12 ticket 06)", () => {
  const read = (relative: string): string =>
    readFileSync(join(process.cwd(), relative), "utf8");

  test("`lane-checker.ts` and `lane-interpretation.ts` contain no `edge.tags` read", () => {
    for (const file of ["src/shared/lane-checker.ts", "src/shared/lane-interpretation.ts"]) {
      const source = read(file);
      // Strip block comments: both files discuss the retired surface at
      // length, and the prose is not a read.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(code).not.toContain("edge.tags");
      expect(code).not.toContain("canonicalTagSet(edge");
    }
  });

  test("the DB adapter's three lane passes select on the side columns and the side index", () => {
    const loader = read("src/db/lane-checker-load.ts");
    const code = loader.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // DISCOVER
    expect(code).toContain("me.tail_tag <> '' OR me.head_tag <> ''");
    expect(code).not.toContain("me.tags != '[]'");
    // WIDEN and the empty-lane pass — `memory_edge_tags` had THREE readers
    // here and now has none.
    expect(code).not.toMatch(/memory_edge_tags\b/);
    // The two QUERY readers, counted where they actually read (`FROM …`).
    // Ticket 13 added a third MENTION of the table name — the attribution
    // controls' capability probe, which asks `sqlite_master` whether the table
    // EXISTS on an unmigrated database. That is not a lane pass and must not
    // make this sentinel red, so the count is anchored to the reading position
    // rather than to the bare name; the probe is pinned separately below.
    expect(code.match(/FROM memory_edge_side_tags/g)?.length).toBe(2);
    expect(code).toContain("name IN ('memory_edge_side_tags', 'lanes')");
  });
});
