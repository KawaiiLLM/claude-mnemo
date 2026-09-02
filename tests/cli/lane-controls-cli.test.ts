import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { openReadOnlyLaneCheckDatabase } from "../../src/cli/lane-check-cli";
import {
  buildLaneControlsReport,
  DEFAULT_LANE_CONTROLS_OPENER,
  parseLaneControlsArguments,
  renderLaneControlsReport,
  runLaneControlsCli,
  type LaneControl,
  type LaneControlsCliOptions,
} from "../../src/cli/lane-controls-cli";
import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

/**
 * THE ATTRIBUTION CONTROL (lane-model-v12 ticket 13; C1/C3/C4 retired by
 * main-agent-edges D10, ticket 8 — only C2 remains).
 *
 * The fixture below is one deliberately IMPERFECT database — C2 has something
 * to find, and every OTHER row is either clean or unsettled (out of C2's
 * domain), which is exactly the boundary this control has to draw right. A
 * clean fixture would prove only that the tool can print zeros, which is
 * exactly the answer this ticket exists to distrust.
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
 *   E2 T3 --indexes--> T1   (ownership, ownership)   clean
 *   E3 T3 --indexes--> T2   (ownership, ownership)   clean
 *   E4 T4 --grounds--> T1   ('', '')                 both sides unsettled — out of C2's domain
 *   E5 T4 --consume--> T2   (ownership, '')          one side unsettled — out of C2's domain
 *   E6 T2 --narrows--> T1   (drafting, ownership)    C2: tail tag never DECLARED.
 *       Shares its PAIR with E1, so main-agent-edges D1 makes it unwritable
 *       through `writeMemoryEdges`; it is inserted at the storage layer as the
 *       legacy multi-row stock it is -- see the note beside the insert.
 *   E7 T6 --grounds--> T1   (ownership, ownership)   C2: tail tag not ON T6
 *   E8 T7 --grounds--> T4   ('', '')                 both sides unsettled — out of C2's domain
 *   E9 T9 --extends--> T8   (ownership, ownership)   clean, in segment B
 *   E10 T10 --grounds--> T1 (ownership, ownership)   T10's stored tags are
 *       UNPARSEABLE -> no subset verdict for the tail (ignorance never
 *       manufactures an error)
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
      edge(turns.T6!, turns.T1!, "grounds", "ownership", "ownership"),
      edge(turns.T7!, turns.T4!, "grounds", "", ""),
      edge(turns.T9!, turns.T8!, "extends", "ownership", "ownership"),
      edge(turns.T10!, turns.T1!, "grounds", "ownership", "ownership"),
      edge(turns.T11!, turns.T1!, "extends", "ownership", "ownership"),
      edge(turns.T9!, turns.T1!, "consume", "handoff", "ownership"),
    ],
    NOW,
  );

  // E6, AND WHY IT IS THE ONE ROW THIS FIXTURE INSERTS BY HAND.
  //
  // `T2 --narrows--> T1` shares its PAIR with E1 (`T2 --extends--> T1`), and
  // main-agent-edges D1 retired that shape as a WRITE: a pair holds one row, so
  // `writeMemoryEdges` no longer inserts a second one — it compares the classes
  // (`narrows` is `correct`, `extends` is `use`), finds the incoming claim
  // strictly stronger, and PROMOTES E1's row in place, keeping E1's own two
  // side tags. The `drafting` tail that is E6's entire reason for existing
  // never reaches storage, and the C2 count this fixture is built to make
  // hand-countable drops by one.
  //
  // The row is still legal STOCK, though, and that is the point worth keeping:
  // a pre-cutover database holds many such pairs, the readers are untouched,
  // and D4's caps count a legacy multi-row pair once precisely because it
  // exists. This fixture is a deliberately imperfect database, so it keeps
  // carrying one — inserted at the storage layer, the only level that can still
  // produce the shape, with the side-tag index rows `writeMemoryEdges` would
  // have written beside it.
  const e6RowId = db
    .query<{ id: number }, [number, number, number]>(
      `INSERT INTO memory_edges (
         citing_kind, citing_id, cited_kind, cited_id,
         relation, provenance, tail_tag, head_tag,
         relation_class, relation_coverage, created_at_epoch
       ) VALUES ('turn', ?, 'turn', ?, 'narrows', 'asserted', 'drafting', 'ownership', '', '', ?)
       RETURNING id`,
    )
    .get(turns.T2!, turns.T1!, NOW)!.id;
  for (const [side, tag] of [
    ["tail", "drafting"],
    ["head", "ownership"],
  ] as const) {
    db.query<unknown, [number, string, string]>(
      `INSERT OR IGNORE INTO memory_edge_side_tags (edge_row_id, side, tag) VALUES (?, ?, ?)`,
    ).run(e6RowId, side, tag);
  }

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
    downstreamLimit: 10,
    findingLimit: 20,
    help: false,
    ...overrides,
  };
}

function report(overrides: Partial<LaneControlsCliOptions> = {}) {
  const db = openReadOnlyLaneCheckDatabase(dbPath);
  try {
    return buildLaneControlsReport(db, dbPath, options(overrides));
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

  test("--findings must be a non-negative integer", () => {
    expect(() => parseLaneControlsArguments(["--findings", "-1"])).toThrow(/non-negative integer/);
  });

  test("--segment is repeatable and --help short-circuits", () => {
    expect(parseLaneControlsArguments(["--segment", "3", "--segment", "9"]).segmentIds).toEqual([3, 9]);
    expect(parseLaneControlsArguments(["--help"]).help).toBe(true);
  });
});

describe("the control quantity", () => {
  test("C2 counts per-side declaration and subset violations on SETTLED edges only", () => {
    seedFixture();
    const c2 = control(report(), "C2");

    // E6's tail names `drafting`, which segment A never declared; E7's tail
    // names `ownership`, which T6 does not carry. The unsettled/half-settled
    // rows (E4, E5, E8) carry no assignment and are out of this control's
    // domain entirely.
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
});

describe("every finding carries its source address and BOTH side LaneKeys", () => {
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
    const built = report();

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

describe("a PRE-MIGRATION database reports why, never a zero", () => {
  test("the control says CANNOT MEASURE and names the migration", () => {
    seedPreMigrationFixture();
    const built = report();
    const text = renderLaneControlsReport(built);

    for (const entry of built.controls) {
      expect(entry.measured).toBeNull();
      expect(entry.unmeasurableReason).not.toBeNull();
    }
    expect(built.edgeCount).toBeNull();
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
    seedFixture();
    const built = report();

    // E10's tail names `ownership` — declared in segment A, so no declaration
    // violation — and T10's tags cannot be read, so the subset half issues no
    // verdict at all. Two violations, not three.
    const c2 = control(built, "C2");
    expect(c2.measured).toBe(2);
    expect(c2.findings.every((finding) => !finding.address.includes("/T10 "))).toBe(true);
  });

  test("a SKIPPED turn (law 8) is neither a node, an edge endpoint, nor a lane member", () => {
    const fixture = seedFixture();
    const built = report();
    const text = renderLaneControlsReport(built);

    // 12 edges written, E11's citing turn is dormant -> 11 in the domain.
    expect(built.edgeCount).toBe(11);
    expect(text).not.toContain(`S${fixture.sessionId}/T11`);
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

  test("every statement on the control path is a SELECT, and the tool writes no file at all", () => {
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
    // No file write of any kind survives the retirement of --export: the tool
    // reads the database and prints to stdout, nothing else.
    expect(strip("src/cli/lane-controls-cli.ts")).not.toContain("writeFileSync");
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

  test("a full run leaves the database file byte-identical", () => {
    seedFixture();
    const digest = () => createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    const before = digest();
    const { io, stdout } = captureIo();

    const code = runLaneControlsCli(["--db", dbPath], io);

    expect(code).toBe(0);
    expect(digest()).toBe(before);
    expect(stdout.join("\n")).toContain("## C2 --");
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

/**
 * C1 (blank sides), C3 (lane-less endpoints) and C4 (sampled side audit) are
 * RETIRED (main-agent-edges D10, ticket 8), not reinterpreted: E6 accounting
 * now lives in `lane_check`, a lane-less edge is legal, and a declaration is
 * validated at write. Nothing replaces them, so nothing should re-teach them
 * under another name.
 *
 * WHY SOURCE TEXT AND NOT BEHAVIOUR: a deletion is observable only as an
 * absence, and an absence is exactly what a reimplementation restores without
 * touching any assertion above. This sentinel is what a behavioural test
 * cannot be.
 *
 * MUTATION-VERIFICATION NOTE. Each symbol below was checked by reintroducing
 * it into `src/cli/lane-controls-cli.ts` and confirming this test reddens.
 */
describe("main-agent-edges ticket 8 — C1, C3 and C4 stay retired", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const readSource = (relativePath: string): string =>
    readFileSync(join(REPO_ROOT, relativePath), "utf8");

  test("no C1/C3/C4 symbol, control id or gold-sample machinery survives in the CLI or its loader", () => {
    for (const relative of ["src/cli/lane-controls-cli.ts", "src/db/lane-checker-load.ts"]) {
      const source = readSource(relative);
      for (const retired of [
        "controlUnsettledSides",
        "controlLanelessNodes",
        "controlGoldSample",
        "computeLanelessNodes",
        "LaneLanelessNode",
        "drawGoldSample",
        "scoreGoldSample",
        "readGradedSample",
        "goldEdgeIdentity",
        "LaneGoldSample",
        "LaneGoldScore",
        "LaneGoldSampleRow",
        "LaneGoldSampleEdgeId",
        "LaneGoldVerdict",
        "LaneGoldStratumScore",
        '"C1"',
        '"C3"',
        '"C4"',
      ]) {
        expect(source, `${relative} must not contain "${retired}"`).not.toContain(retired);
      }
    }
  });

  test("the CLI accepts no --sample, --export or --graded flag", () => {
    for (const flag of ["--sample", "--export", "--graded"]) {
      expect(() => parseLaneControlsArguments([flag, "x"])).toThrow(/unrecognized argument/);
    }
  });

  test("a report never carries a sample, exportPath or gradedPath field", () => {
    seedFixture();
    const built = report();
    expect("sample" in built).toBe(false);
    expect("exportPath" in built).toBe(false);
    expect("gradedPath" in built).toBe(false);
  });
});
