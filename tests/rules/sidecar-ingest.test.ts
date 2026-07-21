import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { createRuleStore } from "../../src/db/rules";
import { initializeSchema } from "../../src/db/schema";
import { resolveHitSidecarPath } from "../../src/rules/pretooluse-dispatcher";
import {
  ingestHitSidecars,
  resolveHitTurn,
  resolveHitIngestCheckpointPath,
  rotateHitSidecars,
  type SidecarHit,
} from "../../src/rules/sidecar-ingest";
import {
  resolveHitSidecarLockPath,
  summarizeToolInput,
} from "../../src/rules/sidecar-protocol";

const firstHit: SidecarHit = {
  hit_id: "11111111-1111-4111-8111-111111111111",
  content_session_id: "content-session-05",
  event_type: "PreToolUse",
  ts_ms: 1_721_555_200_999,
  rule_id: 1,
  tool_name: "Bash",
  tool_input_summary: '{"command":"bun test"}',
  tool_use_id: "tool-use-05",
};

function writeHits(path: string, hits: SidecarHit[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${hits.map((hit) => JSON.stringify(hit)).join("\n")}\n`);
}

function countEvents(db: Database): number {
  return db
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM rule_events")
    .get()!.count;
}

function seedRule(db: Database, name = "rule-one"): number {
  return createRuleStore(db).create({
    name,
    claim: "命中后执行正确动作。",
    rationale: "测试规则。",
    scope: "global",
    triggerKind: "tool",
    triggerSpec: { kind: "tool", tool: "Bash" },
    status: "provisional",
    createdAtEpoch: 1,
  }).id;
}

describe("sidecar hit ingestion", () => {
  let db: Database;
  let dataRoot: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    dataRoot = mkdtempSync(join(tmpdir(), "mnemo-hit-ingest-"));
    seedRule(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  test("atomic rotation leaves concurrent post-rotate appends in a new active file", () => {
    const activePath = resolveHitSidecarPath(dataRoot, firstHit.ts_ms);
    writeHits(activePath, [firstHit]);
    const secondHit: SidecarHit = {
      ...firstHit,
      hit_id: "22222222-2222-4222-8222-222222222222",
    };

    const rotated = rotateHitSidecars(dataRoot, {
      rotationId: () => "rotation-one",
    });
    writeHits(activePath, [secondHit]);

    expect(rotated).toHaveLength(1);
    expect(readFileSync(rotated[0]!, "utf8")).toContain(firstHit.hit_id);
    expect(readFileSync(activePath, "utf8")).toContain(secondHit.hit_id);

    const first = ingestHitSidecars(db, dataRoot, { rotateActive: false });
    expect(first).toMatchObject({ inserted: 1, duplicate: 0 });
    expect(existsSync(activePath)).toBeTrue();

    const second = ingestHitSidecars(db, dataRoot);
    expect(second).toMatchObject({ inserted: 1, duplicate: 0 });
    expect(countEvents(db)).toBe(2);
  });

  test("waits for a writer that opened the active inode before rotation", async () => {
    const activePath = resolveHitSidecarPath(dataRoot, firstHit.ts_ms);
    const childCode = `
      import { closeSync, constants, mkdirSync, openSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      import { withHitSidecarLock } from "./src/rules/sidecar-protocol.ts";
      const [dataRoot, activePath, row] = process.argv.slice(1);
      withHitSidecarLock(dataRoot, () => {
        mkdirSync(dirname(activePath), { recursive: true });
        const descriptor = openSync(
          activePath,
          constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
          0o600,
        );
        process.stdout.write("opened\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        writeFileSync(descriptor, row + "\\n");
        closeSync(descriptor);
      });
    `;
    const child = Bun.spawn(
      [process.execPath, "-e", childCode, dataRoot, activePath, JSON.stringify(firstHit)],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const reader = child.stdout.getReader();
    const opened = await reader.read();
    expect(new TextDecoder().decode(opened.value)).toContain("opened");

    const result = ingestHitSidecars(db, dataRoot);
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(result).toMatchObject({ inserted: 1, duplicate: 0 });
    expect(countEvents(db)).toBe(1);
  });

  test("replaying identical rotated content is idempotent by hit_id", () => {
    const activePath = resolveHitSidecarPath(dataRoot, firstHit.ts_ms);
    writeHits(activePath, [firstHit]);
    const [rotatedPath] = rotateHitSidecars(dataRoot, {
      rotationId: () => "idempotent",
    });

    expect(
      ingestHitSidecars(db, dataRoot, {
        rotateActive: false,
        afterCheckpoint: () => {
          expect(existsSync(resolveHitIngestCheckpointPath(dataRoot))).toBeTrue();
          expect(existsSync(rotatedPath!)).toBeTrue();
        },
      }),
    ).toMatchObject({ inserted: 1, duplicate: 0 });
    writeHits(rotatedPath!, [firstHit]);
    expect(ingestHitSidecars(db, dataRoot, { rotateActive: false })).toMatchObject({
      inserted: 0,
      duplicate: 1,
    });
    expect(countEvents(db)).toBe(1);
  });

  test("a crash after DB commit replays safely before checkpoint and deletion", () => {
    const activePath = resolveHitSidecarPath(dataRoot, firstHit.ts_ms);
    writeHits(activePath, [firstHit]);
    const [rotatedPath] = rotateHitSidecars(dataRoot, {
      rotationId: () => "post-commit-crash",
    });

    expect(() =>
      ingestHitSidecars(db, dataRoot, {
        rotateActive: false,
        afterCommit: () => {
          throw new Error("crash after commit");
        },
      }),
    ).toThrow("crash after commit");
    expect(countEvents(db)).toBe(1);
    expect(existsSync(rotatedPath!)).toBeTrue();
    expect(existsSync(resolveHitIngestCheckpointPath(dataRoot))).toBeFalse();

    expect(ingestHitSidecars(db, dataRoot, { rotateActive: false })).toMatchObject({
      inserted: 0,
      duplicate: 1,
    });
    expect(countEvents(db)).toBe(1);
    expect(existsSync(rotatedPath!)).toBeFalse();
  });

  test("recovers a complete lock whose owner process has crashed", () => {
    const activePath = resolveHitSidecarPath(dataRoot, firstHit.ts_ms);
    writeHits(activePath, [firstHit]);
    writeFileSync(
      resolveHitSidecarLockPath(dataRoot),
      JSON.stringify({ pid: 2_147_483_647, token: "dead-owner" }),
    );

    expect(ingestHitSidecars(db, dataRoot)).toMatchObject({ inserted: 1 });
    expect(countEvents(db)).toBe(1);
    expect(existsSync(resolveHitSidecarLockPath(dataRoot))).toBeFalse();
  });

  test("a crash during the transaction retains readable rotated files for replay", () => {
    const secondRuleId = seedRule(db, "rule-two");
    const secondHit: SidecarHit = {
      ...firstHit,
      hit_id: "33333333-3333-4333-8333-333333333333",
      rule_id: secondRuleId,
    };
    const activePath = resolveHitSidecarPath(dataRoot, firstHit.ts_ms);
    writeHits(activePath, [firstHit, secondHit]);
    const [rotatedPath] = rotateHitSidecars(dataRoot, {
      rotationId: () => "crash-replay",
    });

    expect(() =>
      ingestHitSidecars(db, dataRoot, {
        rotateActive: false,
        beforeInsert: (_hit, index) => {
          if (index === 1) throw new Error("simulated crash");
        },
      }),
    ).toThrow("simulated crash");
    expect(countEvents(db)).toBe(0);
    expect(existsSync(rotatedPath!)).toBeTrue();
    expect(readFileSync(rotatedPath!, "utf8")).toContain(secondHit.hit_id);

    expect(ingestHitSidecars(db, dataRoot, { rotateActive: false })).toMatchObject({
      inserted: 2,
      duplicate: 0,
    });
    expect(countEvents(db)).toBe(2);
    expect(existsSync(rotatedPath!)).toBeFalse();
  });

  test("resolves prompt and tool hits by identity within same-second turns", () => {
    const sessionId = db
      .query<{ id: number }, []>(
        `INSERT INTO sessions (content_session_id, project, created_at_epoch)
         VALUES ('content-session-05', '/project', 1721555200) RETURNING id`,
      )
      .get()!.id;
    const firstTurnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, 1, 'active', 'diagnose cache identity', 1721555200) RETURNING id`,
      )
      .get(sessionId)!.id;
    const secondTurnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, 2, 'active', 'run the focused tests', 1721555200) RETURNING id`,
      )
      .get(sessionId)!.id;
    db.query(
      `INSERT INTO observations (turn_id, tool_name, tool_input, created_at_epoch)
       VALUES (?, 'Bash', '{"command":"echo wrong"}', 1721555200),
              (?, 'Bash', '{"command":"bun test"}', 1721555200)`,
    ).run(firstTurnId, secondTurnId);

    expect(resolveHitTurn(db, firstHit)).toBe(`S${sessionId}/T2`);
    expect(
      resolveHitTurn(db, {
        hit_id: "44444444-4444-4444-8444-444444444444",
        content_session_id: "content-session-05",
        event_type: "UserPromptSubmit",
        ts_ms: firstHit.ts_ms,
        rule_id: 1,
        prompt_summary: "diagnose cache identity",
      }),
    ).toBe(`S${sessionId}/T1`);
  });

  test("uses epoch-second conversion only to break an identity tie", () => {
    const sessionId = db
      .query<{ id: number }, []>(
        `INSERT INTO sessions (content_session_id, project, created_at_epoch)
         VALUES ('timestamp-tie', '/project', 100) RETURNING id`,
      )
      .get()!.id;
    const firstTurnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, 1, 'active', 'first', 100) RETURNING id`,
      )
      .get(sessionId)!.id;
    const secondTurnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, 2, 'active', 'second', 200) RETURNING id`,
      )
      .get(sessionId)!.id;
    db.query(
      `INSERT INTO observations (turn_id, tool_name, tool_input, created_at_epoch)
       VALUES (?, 'Bash', '{"command":"same"}', 100),
              (?, 'Bash', '{"command":"same"}', 200)`,
    ).run(firstTurnId, secondTurnId);

    expect(
      resolveHitTurn(db, {
        ...firstHit,
        content_session_id: "timestamp-tie",
        ts_ms: 101_000,
        tool_input_summary: '{"command":"same"}',
      }),
    ).toBe(`S${sessionId}/T1`);
  });

  test("shares private-tag normalization between hit production and resolution", () => {
    const sessionId = db
      .query<{ id: number }, []>(
        `INSERT INTO sessions (content_session_id, project, created_at_epoch)
         VALUES ('private-tag-session', '/project', 100) RETURNING id`,
      )
      .get()!.id;
    const turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, 1, 'active', 'private input', 100) RETURNING id`,
      )
      .get(sessionId)!.id;
    db.query(
      `INSERT INTO observations (turn_id, tool_name, tool_input, created_at_epoch)
       VALUES (?, 'Bash', '{"command":"bun  test"}', 100)`,
    ).run(turnId);
    const summary = summarizeToolInput({
      command: "bun <private>secret</private> test",
    });

    expect(summary).toBe('{"command":"bun  test"}');
    expect(
      resolveHitTurn(db, {
        ...firstHit,
        content_session_id: "private-tag-session",
        ts_ms: 100_000,
        tool_input_summary: summary,
      }),
    ).toBe(`S${sessionId}/T1`);
  });

  test("matches the null summary when an observation has no tool_input", () => {
    const sessionId = db
      .query<{ id: number }, []>(
        `INSERT INTO sessions (content_session_id, project, created_at_epoch)
         VALUES ('null-input-session', '/project', 100) RETURNING id`,
      )
      .get()!.id;
    const turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, 1, 'active', 'null input', 100) RETURNING id`,
      )
      .get(sessionId)!.id;
    db.query(
      `INSERT INTO observations (turn_id, tool_name, tool_input, created_at_epoch)
       VALUES (?, 'Bash', NULL, 100)`,
    ).run(turnId);

    expect(
      resolveHitTurn(db, {
        ...firstHit,
        content_session_id: "null-input-session",
        ts_ms: 100_000,
        tool_input_summary: "null",
      }),
    ).toBe(`S${sessionId}/T1`);
  });

  test("retains unresolved hits in the queryable ledger", () => {
    const activePath = resolveHitSidecarPath(dataRoot, firstHit.ts_ms);
    writeHits(activePath, [firstHit]);

    const result = ingestHitSidecars(db, dataRoot);
    const event = createRuleStore(db).listEvents(1)[0]!;

    expect(result).toMatchObject({ inserted: 1, unresolved: 1 });
    expect(event).toMatchObject({
      eventUid: firstHit.hit_id,
      eventKind: "hit",
      turnRef: null,
      adjustment: {
        resolution: "unresolved",
        hit: firstHit,
      },
      createdAtEpoch: 1_721_555_200,
    });
  });
});
