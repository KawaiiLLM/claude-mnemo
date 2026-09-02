import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { buildTimelineView, renderTimeline } from "../../src/mcp/timeline";
import { wordEdgeClass } from "../support/edge-row-fixtures";

/**
 * rubric-v10 ticket 04 (flow-era read-side retirement). Tickets 01/02 already
 * retired the WRITE path's flow derivation (`grounds-warning.ts` deleted);
 * this ticket retires the READ side — `db/flows.ts`'s `deriveFlowsForSessions`
 * had zero production callers left by the time this ticket started (only
 * historical comments in `mcp/note.ts` and
 * `worker/note-settlement-turn-facade.ts` still named it, documenting ticket
 * 02's own retirement), and no read-side renderer (`mcp/timeline.ts`,
 * `mcp/recall.ts`) ever built a flow/settlement badge — `timeline.ts`'s own
 * header already treats `↳` as "a pure ADDRESS INDEX... the arrow is an
 * index, not a claim about the relation". Both `src/db/flows.ts` and
 * `src/shared/flows.ts` are deleted outright (requirement 2's "decide by
 * looking at remaining importers" — the only surviving reader,
 * `shared/lane-checker.ts`'s `STANCE_RELATIONS` import, moved to
 * `shared/turn-phase.ts`, the relation vocabulary's one stated home).
 *
 * The LOAD-BEARING property this file pins, in two independent forms:
 *
 *   1. STATIC — no functional (non-comment, non-string) reference to any
 *      flow-derivation identifier survives anywhere in `src/`, and no file
 *      imports a module path ending in `/flows` (the deleted modules'
 *      shape). A reintroduced flow-derived badge necessarily either calls
 *      one of these functions/types or re-creates an equivalent module — one
 *      of the two checks below always sees it.
 *   2. BEHAVIORAL — rendering a session that carries the exact shape flow
 *      derivation was built to interpret (a narrows chain plus an override,
 *      `shared/flow-window-fixture.ts`'s retired scenario in miniature)
 *      produces plain `↳` address rows and nothing that names a flow,
 *      branch, or settlement state. This is the acceptance criterion's own
 *      mutation check: a renderer change that computes and prints such a
 *      badge fails this test without needing the retired module back.
 */

const SRC_ROOT = join(import.meta.dir, "..", "..", "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const BACKTICK = String.fromCharCode(96);
const TEMPLATE_LITERAL_RE = new RegExp(`${BACKTICK}(?:[^${BACKTICK}\\\\]|\\\\.)*${BACKTICK}`, "g");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function stripCommentsAndStrings(source: string): string {
  return stripComments(source)
    .replace(TEMPLATE_LITERAL_RE, "TPL")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

describe("flow-era read-side retirement (rubric-v10 ticket 04)", () => {
  const files = listTsFiles(SRC_ROOT);

  test("src/db/flows.ts and src/shared/flows.ts no longer exist", () => {
    expect(existsSync(join(SRC_ROOT, "db", "flows.ts"))).toBe(false);
    expect(existsSync(join(SRC_ROOT, "shared", "flows.ts"))).toBe(false);
  });

  test("no functional (non-comment, non-string) reference to a flow-derivation identifier survives in src/", () => {
    const pattern =
      /\bderiveFlows\b|\bderiveFlowsForSessions\b|\bFlowDerivation\b|\bFlowTurnInput\b|\bFlowEdgeInput\b|\bisFlowSettlement\b|\bisOwnFlowMember\b|\bsettlementsOfTurn\b|\bTERMINATING_RELATION\b|\bINHERITING_RELATIONS\b/;
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      if (pattern.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no import path shaped like the deleted flow-derivation modules survives (comments excluded)", () => {
    const importPattern = /\bfrom\s+["'][^"']*\/flows["']/;
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (importPattern.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("timeline renders the retired flow scenario as plain edges only", () => {
  let db: Database;
  let sessionId: number;
  let root: number;
  let mid: number;
  let terminus: number;
  let victim: number;
  let overrider: number;

  const insertTurn = (promptNumber: number, title: string): number =>
    db
      .query<{ id: number }, [number, number, string, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, type, title, content, created_at_epoch)
         VALUES (?, ?, 'extracted', ?, ?, 'body', 100)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, JSON.stringify(["design"]), title)!.id;

  const edge = (
    citingId: number,
    citedId: number,
    relation: "narrows" | "extends" | "override",
  ): void => {
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citingId },
          cited: { kind: "turn", id: citedId },
          ...wordEdgeClass(relation),
          provenance: "asserted",
        },
      ],
      500,
    );
  };

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "edge-render-fixture",
      project: "/tmp/edge-render-fixture",
      title: "edge render fixture",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;

    // A narrows/extends chain (the branch flow derivation used to name and
    // settle) plus a second branch an override kills — exactly the shape
    // `shared/flow-window-fixture.ts` (deleted with this ticket) measured.
    root = insertTurn(1, "root decision");
    mid = insertTurn(2, "narrowing decision");
    terminus = insertTurn(3, "settling decision");
    victim = insertTurn(4, "overridden decision");
    overrider = insertTurn(5, "the override itself");

    edge(mid, root, "extends");
    edge(terminus, mid, "narrows");
    edge(overrider, victim, "override");
  });

  afterEach(() => {
    db.close();
  });

  test("↳ rows carry addresses only — no flow/settlement/branch/lane badge text anywhere in the render", () => {
    const rendered = renderTimeline(
      buildTimelineView(db, { id: `S${sessionId}`, view: "turns" }),
    );

    // The edges exist and are addressable — this is not a "nothing renders"
    // pass, it is a "renders plainly" pass.
    expect(rendered).toContain(`T${mid}`);
    expect(rendered).toContain(`T${terminus}`);
    expect(rendered).toContain(`T${overrider}`);

    // No flow-derived vocabulary: a reintroduced badge necessarily prints
    // one of these words to be legible to a reader at all.
    const forbidden = [
      /\bflow\b/i,
      /\bsettlement\b/i,
      /\bsettled\b/i,
      /\bbranch\b/i,
      /\blane\b/i,
      /定案/,
      /分支/,
      /终点/,
      /起点/,
    ];
    for (const pattern of forbidden) {
      expect(rendered).not.toMatch(pattern);
    }
  });
});
