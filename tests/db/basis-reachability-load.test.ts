import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import {
  closureAsPhaseConnectivityInput,
  loadBasisReachabilityClosure,
  selectLandingTurnIds,
} from "../../src/db/basis-reachability-load";
import { evaluatePhaseConnectivity } from "../../src/shared/phase-connectivity";

const NOW = 1_800_000_000;

function seedSession(db: Database, contentSessionId: string): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-basis-reachability",
    title: "basis-reachability fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function insertTurn(
  db: Database,
  sessionId: number,
  promptNumber: number,
  type: readonly string[],
  status: "active" | "skipped" = "active",
): number {
  return db
    .query<{ id: number }, [number, number, string, string, string, number, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, was_rolled_back
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)
       RETURNING id`,
    )
    .get(
      sessionId,
      promptNumber,
      status,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 900 + promptNumber,
      JSON.stringify(type),
    )!.id;
}

/** A tagged, both-sides-settled ("commit-valid") edge — the walk's own domain. */
function tagged(
  db: Database,
  citingId: number,
  citedId: number,
  relation: "override" | "narrows" | "extends" | "indexes" | "consume" | "grounds" | "verifies",
  tag: string,
): void {
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: citingId },
        cited: { kind: "turn", id: citedId },
        relation,
        provenance: "asserted",
        tailTag: tag,
        headTag: tag,
      },
    ],
    NOW,
  );
}

function db(): Database {
  const database = createDatabase(":memory:");
  initializeSchema(database);
  return database;
}

describe("selectLandingTurnIds — the obligation anchor is exactly the ids handed in", () => {
  test("returns only the LIVE landing-typed ids among the given set, never widening beyond it", () => {
    const conn = db();
    const sessionId = seedSession(conn, "select-landing");
    const landing = insertTurn(conn, sessionId, 1, ["fix"]);
    const basis = insertTurn(conn, sessionId, 2, ["design"]);
    const dead = insertTurn(conn, sessionId, 3, ["implement"], "skipped");
    const ids = selectLandingTurnIds(conn, [landing, basis, dead]);
    expect(ids).toEqual([landing]);
    conn.close();
  });

  test("LOOKBACK ORPHANS DON'T BLOCK: an old landing turn dragged in only by lookback, absent from the given id set, is invisible here", () => {
    const conn = db();
    const sessionId = seedSession(conn, "lookback-orphan");
    const oldOrphanLanding = insertTurn(conn, sessionId, 1, ["fix"]); // never in the given set below
    const windowLanding = insertTurn(conn, sessionId, 2, ["implement"]);
    const ids = selectLandingTurnIds(conn, [windowLanding]);
    expect(ids).toEqual([windowLanding]);
    expect(ids).not.toContain(oldOrphanLanding);
    conn.close();
  });

  test("THE SAME TURN AS A BACKFILL TARGET DOES apply: a landing turn IS the obligation the moment it is in the given (target-window) set", () => {
    const conn = db();
    const sessionId = seedSession(conn, "backfill-target");
    const backfillTarget = insertTurn(conn, sessionId, 1, ["refactor"]);
    const ids = selectLandingTurnIds(conn, [backfillTarget]);
    expect(ids).toEqual([backfillTarget]);
    conn.close();
  });
});

describe("loadBasisReachabilityClosure — commit-valid, cross-lane/task, out-of-window basis endpoints", () => {
  test("DRAFT edges (either side unsettled) do not carry the walk", () => {
    const conn = db();
    const sessionId = seedSession(conn, "draft-exclusion");
    const landing = insertTurn(conn, sessionId, 1, ["fix"]);
    const basis = insertTurn(conn, sessionId, 2, ["design"]);
    // A draft: only the tail side placed.
    writeMemoryEdges(
      conn,
      [
        {
          citing: { kind: "turn", id: landing },
          cited: { kind: "turn", id: basis },
          relation: "extends",
          provenance: "asserted",
          tailTag: "some-lane",
          headTag: "",
        },
      ],
      NOW,
    );
    const closure = loadBasisReachabilityClosure(conn, [landing]);
    const { types, graph } = closureAsPhaseConnectivityInput(closure);
    const [finding] = evaluatePhaseConnectivity([landing], types, graph);
    expect(finding!.outcome).toBe("unreached");
    conn.close();
  });

  test("cross-lane, cross-task, out-of-window basis endpoints ALL carry — the walk is not scoped to lane, task or window", () => {
    const conn = db();
    // Two DIFFERENT sessions stand in for two different tasks/scopes; the
    // basis endpoint lives in a session that is never named in the caller's
    // landing-id set (the "out-of-window" half).
    const taskA = seedSession(conn, "cross-scope-a");
    const taskB = seedSession(conn, "cross-scope-b");
    const landing = insertTurn(conn, taskA, 1, ["implement"]);
    const basis = insertTurn(conn, taskB, 1, ["research"]);
    tagged(conn, landing, basis, "grounds", "lane-a"); // tail names lane-a, head lane-b implicitly by segment — same literal tag, different owning scope is fine here since ownership is segment-derived elsewhere; this loader reads relation/liveness only
    const closure = loadBasisReachabilityClosure(conn, [landing]);
    const { types, graph } = closureAsPhaseConnectivityInput(closure);
    const [finding] = evaluatePhaseConnectivity([landing], types, graph);
    expect(finding!.outcome).toBe("reached");
    expect(finding!.basisTurnId).toBe(basis);
    conn.close();
  });

  test("every one of the seven relation words is loaded as a carrying out-edge", () => {
    const conn = db();
    const sessionId = seedSession(conn, "seven-words-loader");
    const words = ["override", "narrows", "extends", "indexes", "consume", "grounds", "verifies"] as const;
    for (const word of words) {
      const landing = insertTurn(conn, sessionId, words.indexOf(word) * 2 + 1, ["fix"]);
      const basis = insertTurn(conn, sessionId, words.indexOf(word) * 2 + 2, ["measure"]);
      tagged(conn, landing, basis, word, "shared-lane");
      const closure = loadBasisReachabilityClosure(conn, [landing]);
      const { types, graph } = closureAsPhaseConnectivityInput(closure);
      const [finding] = evaluatePhaseConnectivity([landing], types, graph);
      expect(finding!.outcome).toBe("reached");
    }
    conn.close();
  });

  test("a dead (rolled-back) node along the walk is a dead end, not a crash", () => {
    const conn = db();
    const sessionId = seedSession(conn, "dead-endpoint");
    const landing = insertTurn(conn, sessionId, 1, ["fix"]);
    const deadCited = insertTurn(conn, sessionId, 2, ["design"], "skipped");
    tagged(conn, landing, deadCited, "grounds", "some-lane");
    const closure = loadBasisReachabilityClosure(conn, [landing]);
    const { types, graph } = closureAsPhaseConnectivityInput(closure);
    const [finding] = evaluatePhaseConnectivity([landing], types, graph);
    expect(finding!.outcome).toBe("unreached");
    conn.close();
  });

  /**
   * Ticket 06, acceptance criterion 2, the LOADER half: a basis lying beyond
   * the shared 500-hop cap (mirrored here and in
   * `shared/phase-connectivity.ts`, ticket 06 decision 2/3) must reach the
   * pure module as `"unresolved-at-cap"` through the REAL loader, not just
   * the pure module's own in-memory graph — this is the end-to-end proof
   * that the loader's fixpoint closure does not truncate a specific landing
   * turn's own reach before its own cap does (see `basis-reachability-
   * load.ts`'s own `MAX_WALK_DEPTH` comment for why that holds). Builds a
   * straight 502-turn directed chain (0 = landing, 501 = the design basis,
   * one hop past the 500-hop cap) via raw `extends` edges.
   */
  test("a basis one hop beyond the shared depth cap resolves as unresolved-at-cap through the real loader, not a violation", () => {
    const conn = db();
    const sessionId = seedSession(conn, "beyond-cap-chain");
    const CHAIN_LENGTH = 501; // one hop past the shared 500-hop cap
    const nodeIds: number[] = [];
    for (let i = 0; i <= CHAIN_LENGTH; i++) {
      nodeIds.push(insertTurn(conn, sessionId, i + 1, i === CHAIN_LENGTH ? ["design"] : ["fix"]));
    }
    for (let i = 0; i < CHAIN_LENGTH; i++) {
      tagged(conn, nodeIds[i]!, nodeIds[i + 1]!, "extends", "chain-lane");
    }
    const landing = nodeIds[0]!;
    const closure = loadBasisReachabilityClosure(conn, [landing]);
    const { types, graph } = closureAsPhaseConnectivityInput(closure);
    const [finding] = evaluatePhaseConnectivity([landing], types, graph);
    expect(finding!.outcome).toBe("unresolved-at-cap");
    expect(finding!.hops).toBeNull();
    expect(finding!.basisTurnId).toBeNull();
    conn.close();
  });
});
