import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openReadOnlyLaneCheckDatabase } from "../../src/cli/lane-check-cli";
import {
  buildLaneControlsReport,
  collectTerminusSample,
  DEFAULT_LANE_CONTROLS_OPENER,
  drawGoldSample,
  parseLaneControlsArguments,
  readGradedSample,
  renderLaneControlsReport,
  runLaneControlsCli,
  scoreGoldSample,
  type LaneControl,
  type LaneControlsCliOptions,
  type LaneGoldSampleRow,
} from "../../src/cli/lane-controls-cli";
import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

/**
 * THE ATTRIBUTION CONTROLS (lane-model-v12 ticket 13).
 *
 * The fixture below is one deliberately IMPERFECT database — every control has
 * something to find and every control's number is hand-countable from the
 * comment on the edge list. A clean fixture would prove only that the tool can
 * print zeros, which is exactly the answer this ticket exists to distrust.
 *
 * Two fixtures, not one: the second is a PRE-MIGRATION database (the shape the
 * production file is in today — merged `tags` column, no side columns, no
 * registry), because "cannot measure, because …" versus a fabricated `0` is the
 * property this whole ticket turns on.
 */

const NOW = 1_800_000_000;
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lane-controls-cli-"));
  dbPath = join(dir, "fixture.db");
});

afterEach(() => {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  sessionId: number;
  segmentA: number;
  segmentB: number;
  turns: Record<string, number>;
}

/**
 * Segment A declares `ownership`; segment B declares the SAME literal word,
 * which is a different lane (identity is `(segment, tag)`).
 *
 *   T1 [ea, ownership]      T2 [ea, ownership, drafting]   T3 [ea, ownership]
 *   T4 [ea]  T5 [ea]  T6 [ea]  T7 [ea]   T8 [eb, ownership]
 *   T9 [eb, ownership, handoff]
 *
 * Edges (the whole of what every expected number below is counted from):
 *   E1 T2 --extends--> T1   (ownership, ownership)   clean
 *   E2 T3 --indexes--> T1   (ownership, ownership)   clean; closes lane A at T3
 *   E3 T3 --indexes--> T2   (ownership, ownership)   clean
 *   E4 T4 --grounds--> T1   ('', '')                 C1: both sides unsettled
 *   E5 T4 --consume--> T2   (ownership, '')          C1: HALF-settled (D2 forbids)
 *   E6 T2 --narrows--> T1   (drafting, ownership)    C2: tail tag never DECLARED
 *   E7 T6 --grounds--> T1   (ownership, ownership)   C2: tail tag not ON T6
 *   E8 T7 --grounds--> T4   ('', '')                 C1: both unsettled; C3: both ends laneless
 *   E9 T9 --extends--> T8   (ownership, ownership)   clean, in segment B
 *   E10 T10 --grounds--> T1 (ownership, ownership)   T10's stored tags are
 *       UNPARSEABLE -> no subset verdict for the tail (ignorance never
 *       manufactures an error), but T10 IS a laneless node
 *   E11 T11 --extends--> T1 (ownership, ownership)   T11 is SKIPPED -> law 8
 *       keeps the whole row out of every control, and keeps T11 from becoming
 *       lane A's latest member (which would reopen the lane)
 *   E12 T9 --consume--> T1   (handoff, ownership)     CROSS-SEGMENT and
 *       CROSS-LANE, and clean: `handoff` is declared in B (where the CITING
 *       turn lives) and `ownership` in A (where the CITED one does). It is the
 *       row that can tell a per-side check from a swapped one -- `handoff` is
 *       declared in B ONLY.
 */
function seedFixture(): Fixture {
  const db = createDatabase(dbPath);
  initializeSchema(db);

  const sessionId = upsertSession(db, {
    contentSessionId: "lane-controls-fixture",
    project: "/tmp/lane-controls-fixture",
    title: "fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW,
    updatedAtEpoch: NOW,
    completedAtEpoch: null,
  }).id;

  const insertTurn = (promptNumber: number, tags: readonly string[]): number =>
    db
      .query<{ id: number }, [number, number, number, string, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, assistant_response,
                            tool_call_count, created_at_epoch, type, tags)
         VALUES (?, ?, 'active', 'p', 'r', 1, ?, ?, ?) RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        NOW + promptNumber,
        JSON.stringify(["design"]),
        JSON.stringify(tags),
      )!.id;

  const turns: Record<string, number> = {
    T1: insertTurn(1, ["ea", "ownership"]),
    T2: insertTurn(2, ["ea", "ownership", "drafting"]),
    T3: insertTurn(3, ["ea", "ownership"]),
    T4: insertTurn(4, ["ea"]),
    T5: insertTurn(5, ["ea"]),
    T6: insertTurn(6, ["ea"]),
    T7: insertTurn(7, ["ea"]),
    T8: insertTurn(8, ["eb", "ownership"]),
    T9: insertTurn(9, ["eb", "ownership", "handoff"]),
  };

  // T10's `tags` is valid JSON but NOT an array — storable (the column has no
  // `json_valid` CHECK) and unreadable, which `parseTurnTags` maps to "not
  // loaded", i.e. no subset verdict for this turn's side of any edge.
  turns.T10 = db
    .query<{ id: number }, [number, number, string]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, assistant_response,
                          tool_call_count, created_at_epoch, type, tags)
       VALUES (?, ?, 'active', 'p', 'r', 1, ?, '["design"]', '{"not":"an array"}') RETURNING id`,
    )
    .get(sessionId, 10, NOW + 10)!.id;
  // T11 is SKIPPED (law 8, `db/turn-liveness.ts`): dormant, so it is neither a
  // node nor an edge endpoint anywhere, and it carries `ownership` precisely so
  // that admitting it would visibly reopen lane A.
  turns.T11 = db
    .query<{ id: number }, [number, number, string]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, assistant_response,
                          tool_call_count, created_at_epoch, type, tags)
       VALUES (?, ?, 'skipped', 'p', 'r', 1, ?, '["design"]', ?) RETURNING id`,
    )
    .get(sessionId, 11, NOW + 11, JSON.stringify(["ea", "ownership"]))!.id;

  const segmentA = createSegment(db, { title: "segment A", nowEpoch: NOW }).id;
  const segmentB = createSegment(db, { title: "segment B", nowEpoch: NOW }).id;
  addSegmentMembers(
    db,
    segmentA,
    [
      turns.T1!,
      turns.T2!,
      turns.T3!,
      turns.T4!,
      turns.T5!,
      turns.T6!,
      turns.T7!,
      turns.T10!,
      turns.T11!,
    ],
    NOW,
  );
  addSegmentMembers(db, segmentB, [turns.T8!, turns.T9!], NOW);
  insertLane(db, segmentA, "ownership", NOW);
  insertLane(db, segmentB, "ownership", NOW);
  insertLane(db, segmentB, "handoff", NOW);

  const edge = (
    citing: number,
    cited: number,
    relation: string,
    tailTag: string,
    headTag: string,
  ) => ({
    citing: { kind: "turn" as const, id: citing },
    cited: { kind: "turn" as const, id: cited },
    relation,
    provenance: "asserted" as const,
    tailTag,
    headTag,
  });

  writeMemoryEdges(
    db,
    [
      edge(turns.T2!, turns.T1!, "extends", "ownership", "ownership"),
      edge(turns.T3!, turns.T1!, "indexes", "ownership", "ownership"),
      edge(turns.T3!, turns.T2!, "indexes", "ownership", "ownership"),
      edge(turns.T4!, turns.T1!, "grounds", "", ""),
      edge(turns.T4!, turns.T2!, "consume", "ownership", ""),
      edge(turns.T2!, turns.T1!, "narrows", "drafting", "ownership"),
      edge(turns.T6!, turns.T1!, "grounds", "ownership", "ownership"),
      edge(turns.T7!, turns.T4!, "grounds", "", ""),
      edge(turns.T9!, turns.T8!, "extends", "ownership", "ownership"),
      edge(turns.T10!, turns.T1!, "grounds", "ownership", "ownership"),
      edge(turns.T11!, turns.T1!, "extends", "ownership", "ownership"),
      edge(turns.T9!, turns.T1!, "consume", "handoff", "ownership"),
    ],
    NOW,
  );
  db.close();

  return { sessionId, segmentA, segmentB, turns };
}

/** The shape the PRODUCTION database is in today: merged `tags`, no side columns, no registry. */
function seedPreMigrationFixture(): void {
  const db = new Database(dbPath, { create: true });
  db.run(
    `CREATE TABLE memory_edges (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       citing_kind TEXT NOT NULL, citing_id INTEGER NOT NULL,
       cited_kind TEXT NOT NULL, cited_id INTEGER NOT NULL,
       relation TEXT, provenance TEXT NOT NULL,
       tags TEXT NOT NULL DEFAULT '[]', created_at_epoch INTEGER NOT NULL)`,
  );
  db.run(
    `CREATE TABLE memory_edge_tags (
       edge_row_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (edge_row_id, tag))`,
  );
  db.close();
}

function options(overrides: Partial<LaneControlsCliOptions> = {}): LaneControlsCliOptions {
  return {
    segmentIds: [],
    perStratum: 2,
    downstreamLimit: 10,
    findingLimit: 20,
    help: false,
    ...overrides,
  };
}

function report(overrides: Partial<LaneControlsCliOptions> = {}, graded: LaneGoldSampleRow[] | null = null) {
  const db = openReadOnlyLaneCheckDatabase(dbPath);
  try {
    return buildLaneControlsReport(db, dbPath, options(overrides), graded);
  } finally {
    db.close();
  }
}

function control(built: ReturnType<typeof report>, id: string): LaneControl {
  return built.controls.find((entry) => entry.id === id)!;
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) },
    stdout,
    stderr,
  };
}

describe("argument parsing", () => {
  test("an unrecognized flag throws rather than being ignored", () => {
    expect(() => parseLaneControlsArguments(["--bogus"])).toThrow(/unrecognized argument/);
  });

  test("--sample and --findings must be non-negative integers", () => {
    expect(() => parseLaneControlsArguments(["--sample", "2.5"])).toThrow(/non-negative integer/);
    expect(() => parseLaneControlsArguments(["--findings", "-1"])).toThrow(/non-negative integer/);
  });

  test("--segment is repeatable and --help short-circuits", () => {
    expect(parseLaneControlsArguments(["--segment", "3", "--segment", "9"]).segmentIds).toEqual([3, 9]);
    expect(parseLaneControlsArguments(["--help"]).help).toBe(true);
  });
});

describe("the four control quantities each produce a number", () => {
  test("C1 counts BOTH-unsettled and HALF-settled edges, and keeps them apart", () => {
    seedFixture();
    const c1 = control(report(), "C1");

    expect(c1.unmeasurableReason).toBeNull();
    expect(c1.measured).toBe(3); // E4, E5, E8
    expect(c1.target).toBe("0");
    expect(c1.context.join(" | ")).toContain("2 with BOTH sides unsettled");
    expect(c1.context.join(" | ")).toContain("1 HALF-settled");
  });

  test("C2 counts per-side declaration and subset violations on SETTLED edges only", () => {
    seedFixture();
    const c2 = control(report(), "C2");

    // E6's tail names `drafting`, which segment A never declared; E7's tail
    // names `ownership`, which T6 does not carry. The three unsettled/half
    // rows are control 1's, not this one's.
    expect(c2.measured).toBe(2);
    expect(c2.context.join(" | ")).toContain("1 undeclared-lane, 1 subset (E4)");
    expect(c2.context.join(" | ")).toContain("over 8 settled edge(s)");
    expect(c2.findings.map((finding) => finding.note).join(" | ")).toContain(
      "is not DECLARED in that endpoint's own segment",
    );
    expect(c2.findings.map((finding) => finding.note).join(" | ")).toContain(
      "is not on that endpoint turn itself",
    );
  });

  test("C3 counts nodes with edges and no declared lane, naming the literal both-ends reading as a subset", () => {
    seedFixture();
    const c3 = control(report(), "C3");

    expect(c3.measured).toBe(4); // T4, T6, T7, T10
    expect(c3.context.join(" | ")).toContain("out of 9 turn(s) with at least one live edge");
    // T7's only edge (E8) has T4 — also laneless — at the far end.
    expect(c3.context.join(" | ")).toContain("1 of them are the ticket's literal reading");
  });

  test("C4 reports an accuracy from a graded sample and applies NO threshold", () => {
    seedFixture();
    const drawn = report().sample!;
    const graded = drawn.rows.map((row, index) => ({
      ...row,
      verdict:
        index === 0
          ? { tail: "wrong" as const, head: "correct" as const }
          : { tail: "correct" as const, head: "correct" as const },
    }));

    const c4 = control(report({}, graded), "C4");

    expect(c4.unmeasurableReason).toBeNull();
    expect(c4.measured).toBe(Math.round(((graded.length - 1) / graded.length) * 1000) / 10);
    expect(c4.target).toContain("NO THRESHOLD");
    expect(c4.context.join(" | ")).toContain("NO THRESHOLD is applied to this number");
    expect(c4.findings).toHaveLength(1);
    expect(c4.findings[0]!.note).toContain("graded WRONG on the tail");
  });
});

describe("every finding carries its source address and BOTH side LaneKeys", () => {
  test("the C1 finding for a fully unsettled edge spells the address and both sides", () => {
    const fixture = seedFixture();
    const c1 = control(report(), "C1");

    const finding = c1.findings.find((entry) => entry.address.includes("--grounds-->"))!;
    expect(finding.address).toMatch(/^S\d+\/T4 --grounds--> S\d+\/T1$/);
    expect(finding.tailLane).toBe(`E${fixture.segmentA}:<unsettled>`);
    expect(finding.headLane).toBe(`E${fixture.segmentA}:<unsettled>`);
  });

  test("a settled finding names the real lane on each side, in the checker's own spelling", () => {
    const fixture = seedFixture();
    const c2 = control(report(), "C2");

    const undeclared = c2.findings.find((entry) => entry.note.includes("not DECLARED"))!;
    expect(undeclared.address).toMatch(/^S\d+\/T2 --narrows--> S\d+\/T1$/);
    expect(undeclared.tailLane).toBe(`E${fixture.segmentA}:{drafting}`);
    expect(undeclared.headLane).toBe(`E${fixture.segmentA}:{ownership}`);
  });

  test("no control anywhere emits a finding missing an address or a side", () => {
    seedFixture();
    const drawn = report().sample!;
    const graded = drawn.rows.map((row) => ({
      ...row,
      verdict: { tail: "wrong" as const, head: "wrong" as const },
    }));
    const built = report({}, graded);

    const findings = built.controls.flatMap((entry) => entry.findings);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.address).toMatch(/S\d+\/T\d+/);
      expect(finding.tailLane).not.toBe("");
      expect(finding.headLane).not.toBe("");
      expect(finding.note).not.toBe("");
    }
  });

  test("the RENDER prints both side LaneKeys next to the address, not only the data carries them", () => {
    const fixture = seedFixture();
    const text = renderLaneControlsReport(report());

    expect(text).toMatch(
      new RegExp(
        `tail E${fixture.segmentA}:\\{drafting\\}  head E${fixture.segmentA}:\\{ownership\\}`,
      ),
    );
  });
});

describe("the causal matrix is in the tool's own output", () => {
  test("all three branches and the no-threshold clause are printed", () => {
    seedFixture();
    const text = renderLaneControlsReport(report());

    expect(text).toContain("the judging order these controls exist to enforce");
    // Each BRANCH, not merely each phrase: the matrix's own opening paragraph
    // already names both causes, so asserting the words alone would survive
    // the deletion of any one branch.
    expect(text).toContain("-> the attribution is UNFINISHED, and no checker report is yet evidence");
    expect(text).toContain("-> fix the labels -- the turn's own tags, the edge's two side tags");
    expect(text).toContain("-> the DEFINITION is wrong. This is the ONLY branch that is evidence");
    expect(text).toContain("C4 sets no threshold");
  });
});

describe("the terminus sample and its third cause", () => {
  test("an uncited closed terminus exports the downstream turns' addresses", () => {
    const fixture = seedFixture();
    const built = report();

    expect(built.terminus.unmeasurableReason).toBeNull();
    expect(built.terminus.closedLanesScanned).toBe(1);
    expect(built.terminus.entryCount).toBe(1);
    const entry = built.terminus.entries[0]!;
    expect(entry.lane).toBe(`E${fixture.segmentA}:{ownership}`);
    expect(entry.terminus).toBe(`S${fixture.sessionId}/T3`);
    // Every live segment-A turn written after T3 — the rows a human must READ
    // to rule out "the citing edge was never written".
    expect(entry.downstream).toEqual([
      `S${fixture.sessionId}/T4`,
      `S${fixture.sessionId}/T5`,
      `S${fixture.sessionId}/T6`,
      `S${fixture.sessionId}/T7`,
      `S${fixture.sessionId}/T10`,
    ]);
  });

  test("a lane reached from ANOTHER segment's scan is reported once, with its OWN segment's downstream turns", () => {
    const fixture = seedFixture();
    const db = openReadOnlyLaneCheckDatabase(dbPath);
    try {
      // Segment B FIRST, deliberately: E12 (T9 --consume--> T1) makes lane A an
      // involved lane of B's own scope, so B's scan is where lane A is first
      // seen. A per-scan report would name it twice, and a downstream list read
      // off the SCANNED segment would hand a reader segment B's turns to go
      // read about a lane that lives in A.
      const collected = collectTerminusSample(db, [fixture.segmentB, fixture.segmentA], 10);
      expect(collected.closedLanesScanned).toBe(1);
      expect(collected.entries).toHaveLength(1);
      expect(collected.entries[0]!.lane).toBe(`E${fixture.segmentA}:{ownership}`);
      expect(collected.entries[0]!.downstream).toEqual([
        `S${fixture.sessionId}/T4`,
        `S${fixture.sessionId}/T5`,
        `S${fixture.sessionId}/T6`,
        `S${fixture.sessionId}/T7`,
        `S${fixture.sessionId}/T10`,
      ]);
    } finally {
      db.close();
    }
  });

  test("the render states the third cause and refuses the report as grounds for rejecting connectivity", () => {
    seedFixture();
    const text = renderLaneControlsReport(report());

    expect(text).toContain("THREE causes");
    expect(text).toContain("THE CITING EDGE WAS NEVER WRITTEN");
    expect(text).toContain("MUST NOT BE USED TO REJECT THE CONNECTIVITY RULE");
  });
});

describe("the gold sample is stratified by relation word AND by segment", () => {
  test("the same relation word in two segments is two strata", () => {
    const fixture = seedFixture();
    const sample = report().sample!;

    const strata = [...new Set(sample.rows.map((row) => row.stratum))].sort();
    expect(strata).toContain(`extends @ E${fixture.segmentA}:{ownership}`);
    expect(strata).toContain(`extends @ E${fixture.segmentB}:{ownership}`);
    expect(sample.stratifiedBy).toContain("relation word");
    expect(sample.stratifiedBy).toContain("segment");
  });

  test("the draw is a pure function of the database and honours --sample", () => {
    seedFixture();
    expect(report().sample!.rows).toEqual(report().sample!.rows);

    // At --sample 1 the SELECTION itself is what has to be stable: two strata
    // here hold two candidates each, so an order that depended on anything but
    // the edge identities would pick differently across these draws.
    const first = report({ perStratum: 1 }).sample!.rows;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(report({ perStratum: 1 }).sample!.rows).toEqual(first);
    }

    const one = report({ perStratum: 1 }).sample!;
    const byStratum = new Map<string, number>();
    for (const row of one.rows) {
      byStratum.set(row.stratum, (byStratum.get(row.stratum) ?? 0) + 1);
    }
    expect([...byStratum.values()].every((count) => count === 1)).toBe(true);
    expect(one.rows.length).toBe(one.strata);
  });

  test("an unsettled edge is never drawn — it has no assignment to grade", () => {
    seedFixture();
    const sample = report().sample!;
    expect(sample.rows.every((row) => row.edge.tailTag !== "" && row.edge.headTag !== "")).toBe(true);
  });

  test("--segment restricts the draw to that segment's strata", () => {
    const fixture = seedFixture();
    const sample = report({ segmentIds: [fixture.segmentB] }).sample!;
    expect(sample.rows.every((row) => row.stratum.includes(`E${fixture.segmentB}:`))).toBe(true);
  });
});

describe("scoring never lets an unmeasurable stand in as a number", () => {
  test("without --graded, C4 says it cannot measure and prints no accuracy", () => {
    seedFixture();
    const c4 = control(report(), "C4");

    expect(c4.measured).toBeNull();
    expect(c4.unmeasurableReason).toContain("no graded sample was supplied");
    expect(renderLaneControlsReport(report())).toContain("CANNOT MEASURE, because no graded sample");
  });

  test("ungraded, unsure and STALE rows are each excluded and each named", () => {
    seedFixture();
    const drawn = report().sample!;
    const live = new Set(
      drawn.rows.map((row) => JSON.stringify([
        row.edge.citingId,
        row.edge.citedId,
        row.edge.relation,
        row.edge.tailTag,
        row.edge.headTag,
      ])),
    );
    const rows: LaneGoldSampleRow[] = [
      { ...drawn.rows[0]!, verdict: { tail: "correct", head: "correct" } },
      { ...drawn.rows[1]!, verdict: { tail: "correct", head: "" } },
      { ...drawn.rows[2]!, verdict: { tail: "unsure", head: "correct" } },
      {
        ...drawn.rows[3]!,
        edge: { ...drawn.rows[3]!.edge, tailTag: "a-tag-nobody-stores" },
        verdict: { tail: "correct", head: "correct" },
      },
    ];

    const score = scoreGoldSample(rows, live);
    expect(score.graded).toBe(1);
    expect(score.bothSidesCorrect).toBe(1);
    expect(score.ungraded).toBe(1);
    expect(score.unsure).toBe(1);
    expect(score.stale).toBe(1);
    expect(score.accuracy).toBe(100);
  });

  test("a graded file with nothing gradable reports a reason, never 0%", () => {
    seedFixture();
    const drawn = report().sample!;
    const rows = drawn.rows.map((row) => ({ ...row, verdict: { tail: "" as const, head: "" as const } }));

    const c4 = control(report({}, rows), "C4");
    expect(c4.measured).toBeNull();
    expect(c4.unmeasurableReason).toContain("no gradable row");
  });

  test("scoreGoldSample with no live identity set skips the staleness probe entirely", () => {
    const row: LaneGoldSampleRow = {
      edge: { citingId: 1, citedId: 2, relation: "extends", tailTag: "a", headTag: "a" },
      stratum: "extends @ E1:{a}",
      address: "S1/T2 --extends--> S1/T1",
      tailLane: "E1:{a}",
      headLane: "E1:{a}",
      citingTurnTags: ["a"],
      citedTurnTags: ["a"],
      verdict: { tail: "correct", head: "wrong" },
    };
    const score = scoreGoldSample([row], null);
    expect(score.stale).toBe(0);
    expect(score.graded).toBe(1);
    expect(score.bothSidesCorrect).toBe(0);
    expect(score.accuracy).toBe(0);
  });
});

describe("a PRE-MIGRATION database reports why, never a zero", () => {
  test("every control and the terminus sample say CANNOT MEASURE and name the migration", () => {
    seedPreMigrationFixture();
    const built = report();
    const text = renderLaneControlsReport(built);

    for (const entry of built.controls) {
      expect(entry.measured).toBeNull();
      expect(entry.unmeasurableReason).not.toBeNull();
    }
    expect(built.edgeCount).toBeNull();
    expect(built.terminus.unmeasurableReason).not.toBeNull();
    expect(text).toContain("the v12 edge migration (spec M-A) has not run on this database");
    expect(text).toContain("This is NOT zero. Nothing was counted.");
    // The failure mode this whole ticket exists to prevent.
    expect(text).not.toContain("measured: 0");
  });

  test("the capability probe, not an exception, is what stops the load", () => {
    seedPreMigrationFixture();
    const built = report();
    expect(built.capability).toEqual({
      edgeSideTagColumns: false,
      edgeSideTagIndex: false,
      laneRegistry: false,
    });
  });
});

describe("the control domain honours the loader's own two laws", () => {
  test("an endpoint whose stored tags are UNPARSEABLE yields no subset verdict for its side", () => {
    const fixture = seedFixture();
    const built = report();

    // E10's tail names `ownership` — declared in segment A, so no declaration
    // violation — and T10's tags cannot be read, so the subset half issues no
    // verdict at all. Two violations, not three.
    const c2 = control(built, "C2");
    expect(c2.measured).toBe(2);
    expect(c2.findings.every((finding) => !finding.address.includes("/T10 "))).toBe(true);
    // T10 is still a LANELESS node: unreadable tags name no lane.
    expect(
      control(built, "C3").findings.some((finding) =>
        finding.address.startsWith(`S${fixture.sessionId}/T10 (via`),
      ),
    ).toBe(true);
  });

  test("a SKIPPED turn (law 8) is neither a node, an edge endpoint, nor a lane member", () => {
    const fixture = seedFixture();
    const built = report();
    const text = renderLaneControlsReport(built);

    // 12 edges written, E11's citing turn is dormant -> 11 in the domain.
    expect(built.edgeCount).toBe(11);
    expect(text).not.toContain(`S${fixture.sessionId}/T11`);
    // T11 carries `ownership` and postdates T3. Were it admitted it would be
    // lane A's latest member and the lane would read OPEN, so this also pins
    // the terminus sample's own input.
    expect(built.terminus.entries[0]!.terminus).toBe(`S${fixture.sessionId}/T3`);
  });
});

describe("read-only, end to end", () => {
  test("the CLI's DEFAULT opener is the hard-readonly one, by binding not by comment", () => {
    seedFixture();
    expect(DEFAULT_LANE_CONTROLS_OPENER).toBe(openReadOnlyLaneCheckDatabase);
    const db = DEFAULT_LANE_CONTROLS_OPENER(dbPath);
    try {
      expect(() => db.run("DELETE FROM turns")).toThrow();
    } finally {
      db.close();
    }
  });

  test("every statement on the control path is a SELECT, and the ONE file write is --export's", () => {
    // The byte-identical run below proves today's code writes nothing. This
    // proves the NEXT edit cannot quietly add a write and still pass: the
    // reason `--export` exists at all is that a sample has to leave the tool,
    // and the boundary between "writes a named file" and "writes the database"
    // is the whole read-only claim.
    const strip = (relative: string): string =>
      readFileSync(join(process.cwd(), relative), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
    for (const relative of ["src/cli/lane-controls-cli.ts", "src/db/lane-checker-load.ts"]) {
      const code = strip(relative);
      expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE)\s+(INTO|TABLE|FROM|INDEX)\b/i);
      expect(code).not.toMatch(/\bCREATE\s+(TABLE|INDEX|TRIGGER|VIEW)\b/i);
      expect(code).not.toMatch(/\bdb\.(run|exec|transaction)\s*\(/);
    }
    expect(strip("src/cli/lane-controls-cli.ts").match(/writeFileSync\(/g)).toHaveLength(1);
    expect(strip("src/db/lane-checker-load.ts")).not.toContain("writeFileSync");
  });

  test("the default opener refuses a write", () => {
    seedFixture();
    const db = openReadOnlyLaneCheckDatabase(dbPath);
    try {
      expect(() => db.exec("DELETE FROM turns")).toThrow();
    } finally {
      db.close();
    }
  });

  test("a full run WITH --export leaves the database file byte-identical", () => {
    seedFixture();
    const digest = () => createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    const before = digest();
    const exportPath = join(dir, "sample.json");
    const { io } = captureIo();

    const code = runLaneControlsCli(["--db", dbPath, "--export", exportPath], io);

    expect(code).toBe(0);
    expect(digest()).toBe(before);
    expect(existsSync(exportPath)).toBe(true);
  });

  test("an argument error exits 1 without opening a database at all", () => {
    const { io, stderr } = captureIo();
    let opened = false;
    const code = runLaneControlsCli(["--bogus"], io, () => {
      opened = true;
      return new Database(":memory:");
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("unrecognized argument");
    expect(opened).toBe(false);
  });
});

describe("the export bundle and the graded round trip", () => {
  test("--export writes the gold sample and the downstream addresses, and --graded reads it back", () => {
    const fixture = seedFixture();
    const exportPath = join(dir, "sample.json");
    const { io } = captureIo();
    expect(runLaneControlsCli(["--db", dbPath, "--export", exportPath], io)).toBe(0);

    const bundle = JSON.parse(readFileSync(exportPath, "utf8")) as {
      goldSample: { rows: LaneGoldSampleRow[] };
      terminusSample: Array<{ terminus: string; downstream: string[] }>;
    };
    expect(bundle.goldSample.rows.length).toBeGreaterThan(0);
    expect(bundle.terminusSample[0]!.terminus).toBe(`S${fixture.sessionId}/T3`);
    expect(bundle.terminusSample[0]!.downstream).toContain(`S${fixture.sessionId}/T5`);

    // Grade every row and feed the bundle straight back.
    const graded = {
      ...bundle,
      goldSample: {
        ...bundle.goldSample,
        rows: bundle.goldSample.rows.map((row) => ({
          ...row,
          verdict: { tail: "correct", head: "correct" },
        })),
      },
    };
    const gradedPath = join(dir, "sample.graded.json");
    writeFileSync(gradedPath, JSON.stringify(graded, null, 2));

    const rerun = captureIo();
    expect(
      runLaneControlsCli(["--db", dbPath, "--graded", gradedPath], rerun.io),
    ).toBe(0);
    expect(rerun.stdout.join("\n")).toContain("measured: 100 % of graded rows with BOTH sides correct");
  });

  test("readGradedSample accepts the bundle and a bare sample, and refuses anything else", () => {
    const rows = [{ stratum: "x" }];
    expect(readGradedSample(JSON.stringify({ goldSample: { rows } }))).toHaveLength(1);
    expect(readGradedSample(JSON.stringify({ rows }))).toHaveLength(1);
    expect(() => readGradedSample(JSON.stringify({ nope: 1 }))).toThrow(/rows/);
  });

  test("a --graded path that cannot be read exits 1 rather than scoring nothing as zero", () => {
    seedFixture();
    const { io, stderr } = captureIo();
    const code = runLaneControlsCli(["--db", dbPath, "--graded", join(dir, "absent.json")], io);
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("could not read --graded");
  });
});

describe("drawGoldSample is pure", () => {
  test("it never draws from an unsettled edge and orders strata deterministically", () => {
    const edges = [
      {
        citingId: 2,
        citedId: 1,
        relation: "extends",
        provenance: "asserted",
        tailTag: "a",
        headTag: "a",
        citingSegment: "7",
        citedSegment: "7",
        citingOrder: [1, 2] as const,
        citedOrder: [1, 1] as const,
        citingEpoch: 2,
        citedEpoch: 1,
        citingTags: ["a"],
        citedTags: ["a"],
      },
      {
        citingId: 3,
        citedId: 1,
        relation: "extends",
        provenance: "asserted",
        tailTag: "",
        headTag: "",
        citingSegment: "7",
        citedSegment: "7",
        citingOrder: [1, 3] as const,
        citedOrder: [1, 1] as const,
        citingEpoch: 3,
        citedEpoch: 1,
      },
    ];
    const sample = drawGoldSample(edges, 5, (id) => "S1/T" + id);
    expect(sample.rows).toHaveLength(1);
    expect(sample.rows[0]!.stratum).toBe("extends @ E7:{a}");
    expect(sample.rows[0]!.address).toBe("S1/T2 --extends--> S1/T1");
  });
});
