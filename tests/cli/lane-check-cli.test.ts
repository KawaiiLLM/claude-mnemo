import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openReadOnlyLaneCheckDatabase,
  parseLaneCheckArguments,
  runLaneCheckCli,
} from "../../src/cli/lane-check-cli";
import { createDatabase } from "../../src/db/database";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";

/**
 * The lane checker CLI (rubric-v10 ticket 06). `runLaneCheckCli` is the
 * script's own testable half (`scripts/lane-check.ts` is a two-line
 * wrapper) — every test here drives it directly, capturing stdout/stderr
 * instead of spawning a subprocess.
 *
 * The smoke tests below seed a REAL sqlite file (not `:memory:` -- the
 * CLI's own production opener takes a path, and two separate `:memory:`
 * connections do not share state) and open it through the CLI's actual
 * default opener, `openReadOnlyLaneCheckDatabase` -- proving the hard
 * constraint ("the CLI must hardcode readonly mode") against the REAL
 * default, not a stand-in.
 */

const NOW = 1_800_000_000;
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lane-check-cli-"));
  dbPath = join(dir, "fixture.db");
});

afterEach(() => {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedFixtureDatabase(): { sessionId: number } {
  const db = createDatabase(dbPath);
  initializeSchema(db);

  const sessionId = upsertSession(db, {
    contentSessionId: "lane-check-cli-fixture",
    project: "/tmp/lane-check-cli-fixture",
    title: "fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW,
    updatedAtEpoch: NOW,
    completedAtEpoch: null,
  }).id;

  function insertTurn(promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, assistant_response, tool_call_count, created_at_epoch, type)
         VALUES (?, ?, 'active', 'p', 'r', 1, ?, ?) RETURNING id`,
      )
      .get(sessionId, promptNumber, NOW + promptNumber, JSON.stringify(["design"]))!.id;
  }

  const t1 = insertTurn(1);
  const t2 = insertTurn(2);
  const t3 = insertTurn(3);

  writeMemoryEdges(
    db,
    [
      { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "extends", provenance: "asserted", ...deriveSideTags(["ownership"]) },
      { citing: { kind: "turn", id: t3 }, cited: { kind: "turn", id: t1 }, relation: "indexes", provenance: "asserted", ...deriveSideTags(["ownership"]) },
      { citing: { kind: "turn", id: t3 }, cited: { kind: "turn", id: t2 }, relation: "indexes", provenance: "asserted", ...deriveSideTags(["ownership"]) },
    ],
    NOW,
  );
  db.close();

  return { sessionId };
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
  test("requires exactly one scope", () => {
    expect(() => parseLaneCheckArguments([])).toThrow(/exactly one scope/);
    expect(() =>
      parseLaneCheckArguments(["--segment", "1", "--lane", "default:x"]),
    ).toThrow(/exactly one scope/);
  });

  test("--range requires --session and a well-formed bound", () => {
    expect(() => parseLaneCheckArguments(["--range", "1-3"])).toThrow(/requires --session/);
    expect(() => parseLaneCheckArguments(["--session", "1", "--range", "bogus"])).toThrow(
      /must be "<start>-<end>"/,
    );
  });

  test("--lane requires <segment>:<tags>", () => {
    expect(() => parseLaneCheckArguments(["--lane", "no-colon-here"])).toThrow(
      /"<segment>:<tag1>,<tag2>/,
    );
    expect(() => parseLaneCheckArguments(["--lane", "default:"])).toThrow(/no tags/);
  });

  test("a well-formed --session/--range resolves to a range scope", () => {
    const options = parseLaneCheckArguments(["--session", "7", "--range", "10-20"]);
    expect(options.scope).toEqual({ kind: "range", sessionId: 7, promptStart: 10, promptEnd: 20 });
  });

  test("--help short-circuits scope validation", () => {
    const options = parseLaneCheckArguments(["--help"]);
    expect(options.help).toBe(true);
    expect(options.scope).toBeNull();
  });
});

describe("read-only production opener", () => {
  test("openReadOnlyLaneCheckDatabase opens a handle that refuses a write", () => {
    seedFixtureDatabase();
    const db = openReadOnlyLaneCheckDatabase(dbPath);
    try {
      expect(() => db.run("INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (1, 999, 'active', 0)")).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("runLaneCheckCli end to end", () => {
  test("a segment scope prints all four reports plus a glyphed digraph, exit 0", () => {
    const { sessionId } = seedFixtureDatabase();
    const { io, stdout } = captureIo();

    const code = runLaneCheckCli(
      ["--session", String(sessionId), "--range", "1-3", "--db", dbPath],
      io,
    );

    expect(code).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("Report 1");
    expect(out).toContain("Report 2");
    expect(out).toContain("Report 3");
    expect(out).toContain("Report 4");
    expect(out).toContain("## Digraph");
    // Glyphs: at least a member and a terminus present in this fixture
    // (T3 declares itself terminus over T1/T2 via tagged `indexes`).
    expect(out).toContain("●");
    expect(out).toContain("◎");
    // milestone-election ticket 04: report 1's state line and used[] reach
    // the CLI surface too — T3 declares over T1/T2 with no later
    // continuation, so the lane reads closed. (lane-model-v12 ticket 04
    // removed the validity suffix this line used to carry.)
    expect(out).toContain("declaration: closed (terminus S1/T3)");
    expect(out).toContain("used[-]");
  });

  test("--no-digraph suppresses the digraph section but keeps the four reports", () => {
    const { sessionId } = seedFixtureDatabase();
    const { io, stdout } = captureIo();

    const code = runLaneCheckCli(
      ["--session", String(sessionId), "--range", "1-3", "--db", dbPath, "--no-digraph"],
      io,
    );

    expect(code).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("Report 1");
    expect(out).not.toContain("## Digraph");
    expect(out).not.toContain("●");
  });

  test("a named-lane scope renders the same lane a segment/range scope would", () => {
    seedFixtureDatabase();
    const { io, stdout } = captureIo();

    const code = runLaneCheckCli(["--lane", "default:ownership", "--db", dbPath], io);

    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("default:{ownership}");
  });

  test("an unrecognized flag reports usage on stderr and exits 1, never opening a database", () => {
    const { io, stderr } = captureIo();
    let opened = false;
    const code = runLaneCheckCli(["--bogus"], io, (path) => {
      opened = true;
      return new Database(":memory:");
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("unrecognized argument");
    expect(opened).toBe(false);
  });

  // floor-and-render-fidelity ticket 03 (user ruling S15069/T1482): the CLI
  // now builds an address map from the SAME projection it loaded
  // (`buildLaneAnchorAddresses`) and passes it to BOTH renderers — the four
  // reports and the digraph's own member labels alike. Internal node
  // IDENTITY (the digraph's crossing/anchor bookkeeping) may still key off
  // `turns.id`, but nothing PRINTED does any more.
  test("every rendered turn reference — reports and digraph member labels alike — is an S<n>/T<m> address, never a bare T<dbid>", () => {
    const { sessionId } = seedFixtureDatabase();
    const { io, stdout } = captureIo();

    const code = runLaneCheckCli(
      ["--session", String(sessionId), "--range", "1-3", "--db", dbPath],
      io,
    );

    expect(code).toBe(0);
    const out = stdout.join("\n");
    // The reports side: the declared terminus (report 1) and the path
    // start/terminus (report 4b) both address T3/T1.
    expect(out).toContain(`terminus S${sessionId}/T3`);
    expect(out).toContain(`starts: S${sessionId}/T1`);
    // The digraph's own member lines carry the address too, not `T1`/`T2`/`T3`.
    expect(out).toContain(`S${sessionId}/T1`);
    expect(out).toContain(`S${sessionId}/T2`);
    expect(out).toContain(`S${sessionId}/T3`);
    // Every one of this fixture's three turns is in-projection (the range
    // scope loaded exactly them) — the bare fallback never fires for them.
    for (const promptNumber of [1, 2, 3]) {
      expect(out).not.toMatch(new RegExp(`(^|[^0-9A-Za-z/])T${promptNumber}\\b`));
    }
  });

  test("the CLI's own default database open is READ-ONLY -- a write attempted through the real end-to-end path throws", () => {
    seedFixtureDatabase();
    // Same seam `runLaneCheckCli` uses by default (`openReadOnlyLaneCheckDatabase`
    // is its own default parameter) -- proven directly against the path this
    // test just seeded, rather than trusting the default silently.
    const db = openReadOnlyLaneCheckDatabase(dbPath);
    try {
      expect(() => db.exec("DELETE FROM turns")).toThrow();
    } finally {
      db.close();
    }
  });
});
