import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { openReadOnlyDatabase } from "../../src/metrics/p1/database";
import { main } from "../../src/metrics/p1/cli";
import { createFixtureDatabase } from "./p1-fixture";

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    },
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}

describe("p1-metrics CLI", () => {
  test("one command prints all three metrics", async () => {
    const fixture = createFixtureDatabase();
    const { io, stdout } = makeIo();

    const code = await main(["--db", fixture.path], io);
    const output = stdout();

    expect(code).toBe(0);
    expect(output).toContain("(a) NOTE COMPLIANCE");
    expect(output).toContain("(b) BLIND EVAL");
    expect(output).toContain("(c) MIS-ATTRIBUTION");
    expect(output).toContain("by session length");
    expect(output).toContain("by turn weight");
    expect(output).toContain("by writer model");
    // The headline rate, rendered.
    expect(output).toContain("60.0%");
  });

  test("the connection refuses writes", () => {
    const fixture = createFixtureDatabase();
    const db = openReadOnlyDatabase(fixture.path);

    expect(() =>
      db.exec("INSERT INTO note_debt (turn_id, session_id, prompt_number, opened_at_epoch, updated_at_epoch) VALUES (999, 1, 1, 1, 1)"),
    ).toThrow();
    expect(() => db.exec("DELETE FROM turns")).toThrow();

    db.close();
  });

  test("reports P1 as not enabled on a database without the tables", async () => {
    const fixture = createFixtureDatabase();
    const writable = new Database(fixture.path);
    writable.exec("DROP TABLE note_id_exposures");
    writable.exec("DROP TABLE note_debt");
    writable.exec("DROP TABLE shadow_notes");
    writable.close();

    const { io, stdout } = makeIo();
    const code = await main(["--db", fixture.path], io);
    const output = stdout();

    expect(code).toBe(0);
    expect(output).toContain("P1 not enabled in this database");
    expect(output).toContain("note_debt");
    // The legacy-only metric still runs.
    expect(output).toContain("(c) MIS-ATTRIBUTION");
    expect(output).toContain("channels skipped");
  });

  test("requires an explicit database path", async () => {
    const { io, stderr } = makeIo();

    expect(await main(["compliance"], io)).toBe(1);
    expect(stderr()).toContain("--db is required");
  });

  test("rejects an unknown command and an unknown flag", async () => {
    const { io, stderr } = makeIo();

    expect(await main(["nonsense"], io)).toBe(1);
    expect(await main(["--nope"], io)).toBe(1);
    expect(stderr()).toContain("Unknown command: nonsense");
    expect(stderr()).toContain("Unknown option: --nope");
  });

  test("accepts S-prefixed, numeric and uuid session selectors", async () => {
    const fixture = createFixtureDatabase();

    for (const selector of [
      String(fixture.sessionB),
      `S${fixture.sessionB}`,
      "sess-b",
    ]) {
      const { io, stdout } = makeIo();
      const code = await main(
        ["compliance", "--db", fixture.path, "--session", selector, "--json"],
        io,
      );

      expect(code).toBe(0);
      expect(JSON.parse(stdout()).compliance.overall.counts.total).toBe(1);
    }

    const { io, stderr } = makeIo();
    expect(
      await main(["compliance", "--db", fixture.path, "--session", "nope"], io),
    ).toBe(1);
    expect(stderr()).toContain("No session matches");
  });

  test("blind-eval writes the pairs and the key to separate files", async () => {
    const fixture = createFixtureDatabase();
    const directory = mkdtempSync(join(tmpdir(), "p1-cli-"));
    const { io, stdout } = makeIo();

    const code = await main(
      ["blind-eval", "--db", fixture.path, "--out", "run1", "--seed", "7"],
      io,
      { cwd: directory },
    );

    expect(code).toBe(0);
    const prefix = join(directory, "run1");
    const pairs = readFileSync(`${prefix}.pairs.jsonl`, "utf8").trim().split("\n");
    const key = readFileSync(`${prefix}.key.jsonl`, "utf8").trim().split("\n");

    // Line one declares the blinding; the pairs follow.
    expect(pairs).toHaveLength(3);
    expect(JSON.parse(pairs[0]!)).toMatchObject({ kind: "blind-pairs-header" });
    expect(key).toHaveLength(2);
    expect(pairs.join("\n")).not.toContain("shadow");
    expect(pairs.join("\n")).not.toContain("writerModel");
    expect(JSON.parse(key[0]!)).toMatchObject({ pairId: "p0001" });
    expect(stdout()).toContain("keep away from the judge");
    expect(stdout()).toContain("residual length signal");
  });

  test("--out may not escape the working directory", async () => {
    const fixture = createFixtureDatabase();
    const directory = mkdtempSync(join(tmpdir(), "p1-cli-"));
    const { io, stderr } = makeIo();

    // The key file de-anonymises the whole trial; an absolute or climbing
    // prefix would drop it wherever the string happened to point.
    const code = await main(
      ["blind-eval", "--db", fixture.path, "--out", join(tmpdir(), "escaped")],
      io,
      { cwd: directory },
    );

    expect(code).toBe(1);
    expect(stderr()).toContain("must stay inside the working directory");
  });

  test("--out may not escape through a symlinked directory that is lexically inside cwd", async () => {
    const fixture = createFixtureDatabase();
    const directory = mkdtempSync(join(tmpdir(), "p1-cli-"));
    const outside = mkdtempSync(join(tmpdir(), "p1-cli-outside-"));
    // Lexically "escape-link/run" resolves under `directory` and passes a
    // string-only containment check; on disk it lands in `outside` instead.
    symlinkSync(outside, join(directory, "escape-link"));
    const { io, stderr } = makeIo();

    const code = await main(
      ["blind-eval", "--db", fixture.path, "--out", "escape-link/run"],
      io,
      { cwd: directory },
    );

    expect(code).toBe(1);
    expect(stderr()).toContain("must stay inside the working directory");
  });

  test("blind-eval scores a verdicts file without touching the database", async () => {
    const fixture = createFixtureDatabase();
    const directory = mkdtempSync(join(tmpdir(), "p1-cli-"));
    const prefix = join(directory, "run2");

    await main(["blind-eval", "--db", fixture.path, "--out", "run2"], makeIo().io, {
      cwd: directory,
    });

    const key = readFileSync(`${prefix}.key.jsonl`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { pairId: string; a: string });
    const verdictsPath = join(directory, "verdicts.jsonl");
    await Bun.write(
      verdictsPath,
      key
        .map((row) =>
          JSON.stringify({
            pairId: row.pairId,
            winner: row.a === "shadow" ? "A" : "B",
          }),
        )
        .join("\n"),
    );

    const { io, stdout } = makeIo();
    const code = await main(
      ["blind-eval", "--verdicts", verdictsPath, "--out", prefix],
      io,
    );

    expect(code).toBe(0);
    expect(stdout()).toContain("shadow note wins");
    expect(stdout()).toContain("100.0%");
  });

  test("a partial verdict set reports the gap and fails instead of a rate", async () => {
    const fixture = createFixtureDatabase();
    const directory = mkdtempSync(join(tmpdir(), "p1-cli-"));
    const prefix = join(directory, "run3");

    await main(["blind-eval", "--db", fixture.path, "--out", "run3"], makeIo().io, {
      cwd: directory,
    });

    // Two pairs were exported, one verdict answers them: the pairs a judge
    // fails on are not a random sample, so a rate over what arrived would be a
    // biased number wearing a clean face.
    const verdictsPath = join(directory, "verdicts.jsonl");
    await Bun.write(verdictsPath, JSON.stringify({ pairId: "p0001", winner: "A" }));

    const { io, stdout, stderr } = makeIo();
    const code = await main(
      ["blind-eval", "--out", prefix, "--verdicts", verdictsPath],
      io,
    );

    expect(code).toBe(1);
    expect(stdout()).toContain("INCOMPLETE");
    expect(stdout()).toContain("key pairs with no verdict: 1 — p0002");
    expect(stdout()).not.toContain("%");
    expect(stderr()).toContain("no win rate was computed");
  });

  test("with verdicts in hand, `all` reports the judged rate for metric (b)", async () => {
    const fixture = createFixtureDatabase();
    const directory = mkdtempSync(join(tmpdir(), "p1-cli-"));
    const prefix = join(directory, "run4");

    await main(["blind-eval", "--db", fixture.path, "--out", "run4"], makeIo().io, {
      cwd: directory,
    });

    const verdictsPath = join(directory, "verdicts.jsonl");
    await Bun.write(
      verdictsPath,
      [
        JSON.stringify({ pairId: "p0001", winner: "A" }),
        JSON.stringify({ pairId: "p0002", winner: "B" }),
      ].join("\n"),
    );

    const { io, stdout } = makeIo();
    const code = await main(
      ["all", "--db", fixture.path, "--out", prefix, "--verdicts", verdictsPath],
      io,
    );

    expect(code).toBe(0);
    expect(stdout()).toContain("(a) NOTE COMPLIANCE");
    expect(stdout()).toContain("verdicts scored against the key");
    expect(stdout()).toContain("(c) MIS-ATTRIBUTION");
  });

  test("misattribution prints instances with their turn addresses", async () => {
    const fixture = createFixtureDatabase();
    const { io, stdout } = makeIo();

    const code = await main(["misattribution", "--db", fixture.path], io);
    const output = stdout();

    expect(code).toBe(0);
    expect(output).toContain(`S${fixture.sessionB}/T10`);
    expect(output).toContain("(rolled-back)");
    expect(output).toContain("shadow-note");
  });

  test("--json emits the machine-readable report", async () => {
    const fixture = createFixtureDatabase();
    const { io, stdout } = makeIo();

    const code = await main(["--db", fixture.path, "--json"], io);
    const payload = JSON.parse(stdout());

    expect(code).toBe(0);
    expect(payload.compliance.overall.counts.noted).toBe(3);
    expect(payload.blindEval.stats.candidates).toBe(2);
    expect(payload.misattribution.channels).toHaveLength(3);
  });

  test("fails loudly when the database file is missing", async () => {
    const { io, stderr } = makeIo();

    expect(await main(["--db", "/tmp/definitely-not-here.db"], io)).toBe(1);
    expect(stderr()).toContain("Database not found");
  });
});
