import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { DATA_DIR } from "../../src/shared/paths";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { insertLane } from "../../src/db/lanes";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { countTokens } from "../../src/shared/token-count";
import { estimateTokens } from "../../src/utils/token-estimate";
import {
  createNoteSettlementSdkQuery,
  createUnifiedNoteSettlementSdkQuery,
} from "../../src/worker/note-settlement-sdk-query";
import { RESPONSE_ORIGIN_TOOL_USE_META_KEY } from "../../src/worker/note-settlement-response-origin";
import type { SettlementScopeProvenance } from "../../src/worker/note-settlement-context";
import {
  isSettlementSystemFailure,
  missingProductionProvenanceFailure,
  overProtocolResultFailure,
  renderSettlementSystemFailure,
  selfContradictingEvaluatorFailure,
  SETTLEMENT_RESULT_TOKEN_CEILING,
  unconstructibleProjectionFailure,
  type SettlementSystemFailure,
  type SettlementSystemFailureCase,
  type SettlementSystemFailureSite,
} from "../../src/worker/note-settlement-system-failure";
import {
  SETTLEMENT_ERA_CUTOFF_EPOCH,
  settlementScopeProvenanceFor,
} from "../support/settlement-config";

/**
 * SETTLEMENT-GATE-TAXONOMY TICKET 05 — THE THIRD CHANNEL.
 *
 * Four cases, four fixtures, and one honest statement about which of them a
 * database state can reach.
 *
 * Ticket 03 shipped case 1's behaviour as a plain string; its own fixture
 * (`tests/worker/note-settlement-sdk-query.test.ts`, "a call with NO
 * scopeProvenance yields the system-failure channel from both surfaces") still
 * pins the fail-closed BEHAVIOUR and is not duplicated here. What this file adds
 * for case 1 is the two things ticket 03 deferred: the typed case reaching the
 * OPERATOR, and the real worker-log file.
 *
 * REACHABILITY, stated up front because it decides what each fixture can be:
 *
 *   - cases 1, 2 and 4 are reachable from the real tool path and are driven
 *     through the registered `lane_check`/`commit` handlers here;
 *   - case 3 is NOT reachable from any input. `evaluateWindowLanes` applies the
 *     judgment filter and then the writable-set projection, so the value it
 *     returns satisfies the postcondition case 3 checks BY CONSTRUCTION — no
 *     fixture can hand it a database that violates it. Its fixture is therefore
 *     on the predicate itself, and this limitation is written down rather than
 *     hidden behind a test that would pass either way.
 */

const NOW = 1_800_000_000;

function seedTagContainers(db: Database): void {
  for (const tag of ["lease", "lane"]) {
    const held = db
      .query<{ id: number }, [string]>(
        "SELECT id FROM segments WHERE json_extract(tags, '$[0]') = ?",
      )
      .get(tag);
    if (!held) {
      createSegment(db, { title: `${tag} container`, tags: [tag], nowEpoch: 100 });
    }
  }
}

interface Fixture {
  sessionDbId: number;
  job: NoteSettlementJob;
  /** w1/w2 — prompts 7/8, the job's window and its whole writable set. */
  windowTurnIds: number[];
}

/**
 * A deliberately DIRTY window: `w2 --verifies--> w1` with both sides unsettled
 * is a DRAFT edge, which is E6 — a blocking error under the frozen
 * classification rule. Every assertion below that says "no report / no verdict"
 * therefore has something real to suppress: without the guard `lane_check`
 * prints `[E6]` under `## ERRORS` and `commit` refuses over the same anchor.
 */
function seedFixture(db: Database): Fixture {
  const sessionDbId = upsertSession(db, {
    contentSessionId: "settlement-system-failure-session",
    project: "/tmp/project-settlement-system-failure",
    title: "system failure fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;

  function insertTurn(promptNumber: number, tags: readonly string[]): number {
    return db
      .query<{ id: number }, [number, number, string, string, number, string]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           tool_call_count, created_at_epoch, type, tags
         ) VALUES (?, ?, 'active', ?, ?, 3, ?, '["design"]', ?)
         RETURNING id`,
      )
      .get(
        sessionDbId,
        promptNumber,
        `prompt ${promptNumber}`,
        `response ${promptNumber}`,
        NOW - 900 + promptNumber,
        JSON.stringify(tags),
      )!.id;
  }

  const segmentId = createSegment(db, {
    title: "system failure fixture",
    tags: ["system-failure-task"],
    nowEpoch: NOW,
  }).id;
  // TWO lanes (main-agent-edges spec D6): E6 is "a blank side whose endpoint
  // has ≥2 lanes" now, so a fixture whose members sit in ONE lane raises no
  // draft finding at all and the surfaces under test would have nothing to
  // refuse over.
  const laneTags = ["system-failure-task", "window-lane", "second-lane"];
  const w1 = insertTurn(7, laneTags);
  const w2 = insertTurn(8, laneTags);
  addSegmentMembers(db, segmentId, [w1, w2], NOW);
  insertLane(db, segmentId, "window-lane", NOW);
  insertLane(db, segmentId, "second-lane", NOW);

  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: w2 },
        cited: { kind: "turn", id: w1 },
        relation: "verifies",
        provenance: "asserted",
        // Both sides unsettled — a DRAFT edge, which is E6 and blocks.
        tailTag: "",
        headTag: "",
      },
    ],
    NOW,
  );

  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 7, windowEnd: 8, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return { sessionDbId, job, windowTurnIds: [w1, w2] };
}

function captureToolImpl() {
  const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();
  const toolImpl = mock(
    (
      name: string,
      _description: string,
      _shape: unknown,
      handler: (args: Record<string, unknown>) => unknown,
    ) => {
      handlers.set(name, handler);
      return { name };
    },
  );
  return { toolImpl, handlers };
}

interface RunOptions {
  /** Omitted means "the honest provenance for this writable set". `null` means none at all (case 1). */
  scopeProvenance?: SettlementScopeProvenance | null;
  resultTokenCeiling?: number;
  /** Omitted installs no sink, so the DEFAULT one (the worker log) runs. */
  sink?: (failure: SettlementSystemFailure, site: SettlementSystemFailureSite) => void;
}

/** Drives one settlement run against the fixture, with the body scripted against the REAL registered handlers. */
async function runSettlement(
  db: Database,
  fixture: Fixture,
  options: RunOptions,
  body: (handlers: Map<string, (args: Record<string, unknown>) => unknown>) => Promise<void>,
): Promise<void> {
  const { toolImpl, handlers } = captureToolImpl();
  const queryImpl = mock(() =>
    (async function* () {
      await body(handlers);
      yield { type: "result", subtype: "success", is_error: false, result: "done" };
    })(),
  );
  const systemFailure = {
    ...(options.sink ? { sink: options.sink } : {}),
    ...(options.resultTokenCeiling !== undefined
      ? { resultTokenCeiling: options.resultTokenCeiling }
      : {}),
  };
  const runQuery = createNoteSettlementSdkQuery({
    db,
    dataRoot: "/tmp/claude-mnemo-settlement-system-failure",
    queryImpl: queryImpl as never,
    createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
    toolImpl: toolImpl as never,
    now: () => NOW,
    ...(Object.keys(systemFailure).length > 0 ? { systemFailure } : {}),
  });
  const provenance =
    options.scopeProvenance === undefined
      ? settlementScopeProvenanceFor(db, fixture.sessionDbId, fixture.windowTurnIds, 7, 8)
      : options.scopeProvenance;
  await runQuery({
    prompt: "settle",
    systemPrompt: "system",
    model: "claude-sonnet-5",
    jobId: fixture.job.id,
    claimGeneration: fixture.job.claimGeneration,
    stage: fixture.job.stage,
    sessionId: fixture.sessionDbId,
    writableTurnIds: new Set(fixture.windowTurnIds),
    ...(provenance === null ? {} : { scopeProvenance: provenance }),
    contextBuiltAtEpoch: NOW,
    windowStart: 7,
    windowEnd: 8,
  });
}

const text = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content[0]!.text;

/**
 * THE THREE THINGS A FAIL-CLOSED RESULT MUST NOT BE, asserted the same way for
 * every case: not an ERROR list, not a WARNING, and not a truncated report. The
 * fixture that produces each of these is deliberately dirty, so every one of
 * these absences is the channel's own doing.
 */
function expectFailClosed(rendered: string): void {
  expect(rendered).toContain("SYSTEM / PROJECTION FAILURE");
  // Not an error list — the fixture's own E6 would otherwise be here.
  expect(rendered).not.toContain("## ERRORS");
  expect(rendered).not.toContain("[E6]");
  expect(rendered).not.toContain("Commit refused");
  // Not a warning — the channel may never be demoted to one.
  expect(rendered).not.toContain("WARNINGS");
  expect(rendered).not.toContain("does not block commit");
  // Not a repairable list: no verb, no retry, no count of findings.
  expect(rendered).not.toContain("call `commit` again");
  expect(rendered).not.toContain("error(s)");
  // Not a truncated report: no ellipsis marker, no "showing first N", no
  // pointer at a file the run would then pay to read back.
  expect(rendered).not.toContain("truncat");
  expect(rendered).not.toContain("showing first");
  expect(rendered).not.toContain("saved to");
}

// ===========================================================================
// The channel itself
// ===========================================================================

describe("ticket 05 — the third channel is a type, not a sentence", () => {
  test("every case renders as a system failure, and none of them renders as an error or a warning", () => {
    const cases: SettlementSystemFailureCase[] = [
      "missing-production-provenance",
      "unconstructible-projection",
      "self-contradicting-evaluator",
      "over-protocol-result",
    ];
    const rendered = new Set<string>();
    for (const failureCase of cases) {
      const failure: SettlementSystemFailure = {
        channel: "system-failure",
        case: failureCase,
        operatorDetail: "detail that must never reach the agent",
      };
      expect(isSettlementSystemFailure(failure)).toBe(true);
      const output = renderSettlementSystemFailure(failure);
      expectFailClosed(output);
      // The OPERATOR's line stays the operator's: a diagnostic inside a
      // fail-closed result reads as a repair hint.
      expect(output).not.toContain("detail that must never reach the agent");
      rendered.add(output);
    }
    // Four distinct causes, four distinct sentences — a channel that said the
    // same thing four times would be a sentence again.
    expect(rendered.size).toBe(4);

    // The discriminant is the type's, not the prose's.
    expect(isSettlementSystemFailure({ ok: false, refusal: "Commit refused — 1 error(s)" })).toBe(
      false,
    );
    expect(isSettlementSystemFailure(null)).toBe(false);
  });
});

// ===========================================================================
// CASE 1 — missing production provenance
// ===========================================================================

describe("ticket 05 — case 1: missing production provenance", () => {
  test("the predicate answers one question and only that question", () => {
    expect(missingProductionProvenanceFailure(undefined)?.case).toBe(
      "missing-production-provenance",
    );
    expect(
      missingProductionProvenanceFailure({
        window: new Set([1]),
        baseLookback: new Set(),
        closureOnly: new Set(),
      }),
    ).toBeNull();
  });

  /**
   * THE OPERATOR PATH, on the REAL default sink and the REAL log file.
   *
   * This is the acceptance criterion ticket 03 could not meet: "it reaches the
   * worker log, not only the agent's transcript". No sink is injected here, so
   * `logSettlementSystemFailure` runs and appends to
   * `$HOME/.claude-mnemo/claude-mnemo.log` — the sandboxed home the test preload
   * installs, which is the same path the settlement child writes in production.
   */
  test("both surfaces fail closed AND the failure lands in the worker log", async () => {
    let db: Database | undefined;
    // `shared/logger.ts` caches "the log directory exists" in a module-level
    // flag, and the test sandbox re-points `homedir()` per preload — so once
    // this file runs after enough of the suite the logger's own `mkdirSync` is
    // skipped against a directory that is not there, its append falls back to
    // stderr, and this assertion fails for a reason that has nothing to do
    // with whether the failure reached the log. Creating the directory here
    // makes the cached flag true and correct at the same time.
    mkdirSync(DATA_DIR, { recursive: true });
    const logPath = join(DATA_DIR, "claude-mnemo.log");
    const before = (() => {
      try {
        return readFileSync(logPath, "utf8").length;
      } catch {
        return 0;
      }
    })();
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedFixture(db);

      let preview = "";
      let verdict = "";
      await runSettlement(db, fixture, { scopeProvenance: null }, async (handlers) => {
        preview = text(await handlers.get("lane_check")!({}));
        verdict = text(await handlers.get("commit")!({ report: "no friction this window" }));
      });

      expectFailClosed(preview);
      expectFailClosed(verdict);
      expect(preview).toContain("carried no scope provenance");
      expect(verdict).toContain("carried no scope provenance");
      // Nothing committed, and the job is still claimable.
      expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");

      const appended = readFileSync(logPath, "utf8").slice(before);
      const lines = appended
        .split("\n")
        .filter((line) => line.includes("settlement system / projection failure"))
        .map((line) => JSON.parse(line) as {
          level: string;
          component: string;
          context: { case: string; surface: string; jobId: number; claimGeneration: number };
        });
      // One per surface, both at error level, both naming the typed case and
      // the dispatch — the operator can find the job without the transcript.
      expect(lines.map((line) => line.context.surface).sort()).toEqual(["commit", "lane_check"]);
      for (const line of lines) {
        expect(line.level).toBe("error");
        expect(line.component).toBe("MNEMOSYNE");
        expect(line.context.case).toBe("missing-production-provenance");
        expect(line.context.jobId).toBe(fixture.job.id);
        expect(line.context.claimGeneration).toBe(fixture.job.claimGeneration);
      }
    } finally {
      db?.close();
    }
  });
});

// ===========================================================================
// CASE 2 — unconstructible projection
// ===========================================================================

describe("ticket 05 — case 2: an unconstructible projection", () => {
  test("the predicate is the scope descriptor's own stated postcondition", () => {
    const writable = new Set([1, 2, 3]);
    // Coherent: exactly one bucket each, union is the writable set.
    expect(
      unconstructibleProjectionFailure(writable, {
        window: new Set([1, 2]),
        baseLookback: new Set([3]),
        closureOnly: new Set(),
      }),
    ).toBeNull();
    // A writable id filed under no provenance at all.
    expect(
      unconstructibleProjectionFailure(writable, {
        window: new Set([1, 2]),
        baseLookback: new Set(),
        closureOnly: new Set(),
      })?.case,
    ).toBe("unconstructible-projection");
    // A judged id this run may not write.
    expect(
      unconstructibleProjectionFailure(writable, {
        window: new Set([1, 2, 3, 99]),
        baseLookback: new Set(),
        closureOnly: new Set(),
      })?.case,
    ).toBe("unconstructible-projection");
    // The same id in two buckets — the sets are declared mutually exclusive.
    expect(
      unconstructibleProjectionFailure(writable, {
        window: new Set([1, 2, 3]),
        baseLookback: new Set([3]),
        closureOnly: new Set(),
      })?.case,
    ).toBe("unconstructible-projection");
  });

  test("both surfaces fail closed on a descriptor that names a turn this run may not write", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedFixture(db);
      const raised: SettlementSystemFailure[] = [];
      const surfaces: string[] = [];

      // The descriptor claims this run is judged on a turn id its authority
      // does not contain. Nothing else about the run changes: the writable set
      // is still {w1, w2} and the E6 is still inside it.
      const incoherent: SettlementScopeProvenance = {
        window: new Set([...fixture.windowTurnIds, 9_999]),
        baseLookback: new Set(),
        closureOnly: new Set(),
      };

      let preview = "";
      let verdict = "";
      await runSettlement(
        db,
        fixture,
        {
          scopeProvenance: incoherent,
          sink: (failure, site) => {
            raised.push(failure);
            surfaces.push(site.surface);
          },
        },
        async (handlers) => {
          preview = text(await handlers.get("lane_check")!({}));
          verdict = text(await handlers.get("commit")!({ report: "no friction this window" }));
        },
      );

      expectFailClosed(preview);
      expectFailClosed(verdict);
      expect(preview).toContain("do not describe the same turns");
      expect(raised.map((failure) => failure.case)).toEqual([
        "unconstructible-projection",
        "unconstructible-projection",
      ]);
      expect(surfaces).toEqual(["lane_check", "commit"]);
      // The operator line names the arithmetic; the agent's does not.
      expect(raised[0]!.operatorDetail).toContain("1 outside the writable set");
      expect(preview).not.toContain("outside the writable set");
      expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");
    } finally {
      db?.close();
    }
  });

  /**
   * THE CONTROL for the test above: the SAME fixture with an honest descriptor
   * produces a real report and a real verdict. Without it "no report" could be
   * satisfied by a fixture that had nothing to say.
   */
  test("CONTROL — the same fixture with a coherent descriptor still reports and still refuses", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedFixture(db);
      const raised: SettlementSystemFailure[] = [];

      let preview = "";
      let verdict = "";
      await runSettlement(
        db,
        fixture,
        { sink: (failure) => raised.push(failure) },
        async (handlers) => {
          preview = text(await handlers.get("lane_check")!({}));
          verdict = text(await handlers.get("commit")!({ report: "no friction this window" }));
        },
      );

      expect(raised).toEqual([]);
      expect(preview).toContain("## ERRORS");
      expect(preview).toContain("[E6]");
      expect(verdict).toContain("Commit refused");
      expect(preview).not.toContain("SYSTEM / PROJECTION FAILURE");
      expect(verdict).not.toContain("SYSTEM / PROJECTION FAILURE");
    } finally {
      db?.close();
    }
  });
});

// ===========================================================================
// CASE 3 — a self-contradicting shared evaluator
// ===========================================================================

describe("ticket 05 — case 3: a self-contradicting shared evaluator", () => {
  /**
   * NO DATABASE STATE REACHES THIS, and that is stated rather than worked
   * around. `evaluateWindowLanes` filters its errors by the judgment predicate
   * and then projects them against the writable set, so the value it hands both
   * surfaces satisfies this postcondition by construction. The check exists
   * because the postcondition is what the two surfaces RELY on — the preview
   * prints the list and the verdict refuses over it — and because this batch
   * exists precisely because one question once got two answers.
   *
   * The fixture is therefore on the predicate, driven with the shapes a broken
   * evaluator would produce. Its red-capability is direct: making the predicate
   * return `null` turns all three positive arms red.
   */
  test("an evaluation that violates the filters it advertises is a system failure", () => {
    const writable = new Set([10, 11]);
    const judgedAll = () => true;

    // Consistent — every anchor writable and judged.
    expect(
      selfContradictingEvaluatorFailure({
        errorAnchorIds: [10, 11],
        writableTurnIds: writable,
        judged: judgedAll,
      }),
    ).toBeNull();
    // Consistent and empty.
    expect(
      selfContradictingEvaluatorFailure({
        errorAnchorIds: [],
        writableTurnIds: writable,
        judged: judgedAll,
      }),
    ).toBeNull();

    // An error the projection claims to have dropped.
    const unwritable = selfContradictingEvaluatorFailure({
      errorAnchorIds: [10, 42],
      writableTurnIds: writable,
      judged: judgedAll,
    });
    expect(unwritable?.case).toBe("self-contradicting-evaluator");
    expect(unwritable!.operatorDetail).toContain("1 anchored outside the writable set");

    // An error the judgment filter claims to have dropped.
    const unjudged = selfContradictingEvaluatorFailure({
      errorAnchorIds: [10, 11],
      writableTurnIds: writable,
      judged: (id) => id === 10,
    });
    expect(unjudged?.case).toBe("self-contradicting-evaluator");
    expect(unjudged!.operatorDetail).toContain("1 outside the judgment set");

    // Both at once, counted separately — the operator line has to say which
    // filter the evaluator broke, since they are repaired in different places.
    const both = selfContradictingEvaluatorFailure({
      errorAnchorIds: [42],
      writableTurnIds: writable,
      judged: () => false,
    });
    expect(both!.operatorDetail).toContain("1 anchored outside the writable set");
    expect(both!.operatorDetail).toContain("1 outside the judgment set");

    expectFailClosed(renderSettlementSystemFailure(unwritable!));
  });
});

// ===========================================================================
// CASE 4 — a result that cannot be expressed inside the protocol
// ===========================================================================

/**
 * Production-shaped `lane_check` text: the two line shapes that dominate a real
 * report (an anchored error, and a component's island member list), mixed in the
 * proportion the real reports carry. Sized in CHARACTERS so a fixture can name
 * a real observed spill size.
 */
function laneCheckShapedText(targetChars: number): string {
  const lines: string[] = [];
  let index = 0;
  let length = 0;
  while (length < targetChars) {
    index += 1;
    const line =
      index % 3 === 0
        ? `  island@S12/T${1000 + index}: ${Array.from(
            { length: 8 },
            (_, k) => `S12/T${1000 + index + k}`,
          ).join(",")}`
        : `  [E6] anchor S12/T${2000 + index} -> S12/T${1500 + index}: a side names no lane`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}

describe("ticket 05 — case 4: a result that cannot be expressed inside the protocol", () => {
  /**
   * THE CALIBRATION, pinned as a test because the choice of counter IS the
   * predicate. The smallest real settlement spill was a `lane_check` result of
   * 59,077 characters across 851 lines (2026-08-24) — the harness itself
   * measured it over its own 25,000-token cap. On text of that shape and size:
   *
   *   - `estimateTokens` (4 chars/token, the estimator every other settlement
   *     budget uses) reads ~15,000 and would pass it by 40%;
   *   - `countTokens` (o200k_base, the runtime tokenizer this repo ships) reads
   *     ~26,500 and refuses it.
   *
   * Settlement output is address lists, not prose: ~2.2 characters per token.
   * Anything that prices it at four would make this whole case unreachable.
   */
  test("the real tokenizer refuses the smallest observed production spill; the char-class estimator would have passed it", () => {
    const smallestObservedSpill = laneCheckShapedText(59_077);
    expect(smallestObservedSpill.length).toBeGreaterThanOrEqual(59_077);
    expect(smallestObservedSpill.length).toBeLessThan(59_300);

    expect(estimateTokens(smallestObservedSpill)).toBeLessThan(SETTLEMENT_RESULT_TOKEN_CEILING);
    expect(countTokens(smallestObservedSpill)).toBeGreaterThan(SETTLEMENT_RESULT_TOKEN_CEILING);

    const failure = overProtocolResultFailure(smallestObservedSpill);
    expect(failure?.case).toBe("over-protocol-result");
    expect(failure!.operatorDetail).toContain("characters across");
    expectFailClosed(renderSettlementSystemFailure(failure!));

    // AND IT DOES NOT FIRE ON AN ORDINARY RESULT — the guard is a ceiling, not
    // a tax. A full page of the same shape at a quarter the size passes.
    expect(overProtocolResultFailure(laneCheckShapedText(14_000))).toBeNull();
    expect(overProtocolResultFailure("")).toBeNull();
  });

  test("the length pre-gate is exact — a text shorter than the ceiling never reaches the encoder", () => {
    // o200k emits at most one token per character, so skipping the encoder below
    // `ceiling` characters is a proof and not a heuristic. Asserted on the
    // WORST case a settlement result could carry — single-character tokens, one
    // token per character — rather than on prose, which would pass trivially.
    // The assertion exists to stop a later reader "optimising" the pre-gate
    // into a chars/4 guess, which would skip real overflows.
    let densest = "";
    for (let i = 0; i < 5_000; i += 1) {
      densest += String.fromCharCode(33 + ((i * 7) % 90));
    }
    expect(countTokens(densest)).toBeLessThanOrEqual(densest.length);
    // …and a text at exactly the ceiling length short-circuits, whatever it is.
    expect(overProtocolResultFailure(densest, densest.length)).toBeNull();
  });

  test("lane_check returns a SYSTEM FAILURE, never a truncated report and never a warning", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedFixture(db);
      const raised: SettlementSystemFailure[] = [];
      const surfaces: string[] = [];

      let full = "";
      let overProtocol = "";
      await runSettlement(
        db,
        fixture,
        { sink: (failure, site) => {
            raised.push(failure);
            surfaces.push(site.surface);
          } },
        async (handlers) => {
          // The SAME call, twice, differing only in the ceiling the protocol
          // imposes — so the difference below is the guard's and not the
          // fixture's. (The default ceiling is exercised by the calibration
          // test above; a fixture that rendered 25,000 real tokens of lane
          // report would be a 60KB fixture proving the same thing.)
          full = text(await handlers.get("lane_check")!({}));
        },
      );
      await runSettlement(
        db,
        fixture,
        {
          resultTokenCeiling: 20,
          sink: (failure, site) => {
            raised.push(failure);
            surfaces.push(site.surface);
          },
        },
        async (handlers) => {
          overProtocol = text(await handlers.get("lane_check")!({}));
        },
      );

      // The control: at the real ceiling this window has a real report, with
      // the fixture's own E6 in it.
      expect(full).toContain("## ERRORS");
      expect(full).toContain("[E6]");
      expect(countTokens(full)).toBeGreaterThan(20);

      // Over the protocol: a system failure INSTEAD. Not the same report cut
      // short — `expectFailClosed` asserts the E6, the section headers and the
      // truncation vocabulary are all absent — and not a warning.
      expectFailClosed(overProtocol);
      expect(overProtocol).toContain("does not fit inside the tool protocol");
      expect(raised.map((failure) => failure.case)).toEqual(["over-protocol-result"]);
      expect(surfaces).toEqual(["lane_check"]);
      // What was MEASURED is the whole composed result, byte for byte — the
      // operator line names the same character count the unguarded call
      // returned, so nothing was measured on a fragment.
      expect(raised[0]!.operatorDetail).toContain(
        `(${full.length} characters across ${full.split("\n").length} lines)`,
      );
      // The failure itself fits. A channel that could not deliver its own
      // refusal would be no channel at all.
      expect(countTokens(overProtocol)).toBeLessThan(SETTLEMENT_RESULT_TOKEN_CEILING);
    } finally {
      db?.close();
    }
  });

  /**
   * THE PLACEMENT, and why it is at the END of the handler.
   *
   * `lane_check` page 1 appends blocks the pager never sized: the phase-
   * connectivity report and the lane-disposition warnings are joined onto
   * `paged.text` AFTER `renderLaneCheckerReportsPaged` has spent its budget. A
   * guard placed on `paged.text` would therefore pass a result that then leaves
   * over the protocol's ceiling — which is the shape of the real production
   * overflows, since the paged body alone is budgeted and the tail is not.
   *
   * The fixture calibrates itself: it takes the real composed result, cuts it at
   * the tail's own header, and sets the ceiling to exactly what the HEAD costs.
   * The head fits by construction; only a guard that measured the head-plus-tail
   * can fire.
   */
  test("the guard measures the composed result, tail included — a budgeted body plus an unbudgeted tail still fails closed", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedFixture(db);
      // A LANDING-phase turn is what makes the phase-connectivity block render
      // at all; it is appended to page 1 outside the pager's budget.
      db.query("UPDATE turns SET type = ? WHERE id = ?").run(
        JSON.stringify(["implement"]),
        fixture.windowTurnIds[1]!,
      );

      let full = "";
      await runSettlement(db, fixture, {}, async (handlers) => {
        full = text(await handlers.get("lane_check")!({}));
      });

      const tailStart = full.indexOf("\n\nPHASE CONNECTIVITY");
      expect(tailStart).toBeGreaterThan(0);
      const head = full.slice(0, tailStart);
      const headTokens = countTokens(head);
      // The premise: the pager's own output would have fitted this ceiling and
      // the appended tail is what breaks it.
      expect(countTokens(full)).toBeGreaterThan(headTokens);

      const raised: SettlementSystemFailure[] = [];
      let guarded = "";
      await runSettlement(
        db,
        fixture,
        { resultTokenCeiling: headTokens, sink: (failure) => raised.push(failure) },
        async (handlers) => {
          guarded = text(await handlers.get("lane_check")!({}));
        },
      );

      expectFailClosed(guarded);
      expect(raised.map((failure) => failure.case)).toEqual(["over-protocol-result"]);
    } finally {
      db?.close();
    }
  });

  test("a refused commit whose refusal cannot be expressed becomes a system failure, and nothing is committed", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedFixture(db);
      const raised: SettlementSystemFailure[] = [];
      const surfaces: string[] = [];

      let verdict = "";
      await runSettlement(
        db,
        fixture,
        {
          resultTokenCeiling: 20,
          sink: (failure, site) => {
            raised.push(failure);
            surfaces.push(site.surface);
          },
        },
        async (handlers) => {
          verdict = text(await handlers.get("commit")!({ report: "no friction this window" }));
        },
      );

      // The fixture's E6 would otherwise produce "Commit refused — 1 error(s)
      // … [E6] …", which is what `expectFailClosed` proves is absent.
      expectFailClosed(verdict);
      expect(raised.map((failure) => failure.case)).toEqual(["over-protocol-result"]);
      expect(surfaces).toEqual(["commit"]);
      // FAIL CLOSED means the window is not settled: the transaction rolled
      // back before the completion CAS, so the job is still claimable.
      expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");
    } finally {
      db?.close();
    }
  });
});

// ===========================================================================
// THE SECOND REGISTRATION SITE
// ===========================================================================

/**
 * `note-settlement-sdk-query.ts` registers `lane_check` and `commit` TWICE —
 * once in the legacy single-stage builder that every test above drives, and once
 * in the unified builder the scheduler actually dispatches. The two handlers are
 * near-copies by this file's own long-standing shape, so a channel wired into
 * one and missed in the other would be invisible: every assertion above would
 * still pass while production, which runs the unified site, kept spilling.
 *
 * This drives the unified site's own registered handler, with a real assistant
 * message ahead of the call so `resolveResponseOrigin` resolves the same way the
 * host loop makes it.
 */
async function runUnifiedLaneCheck(
  db: Database,
  fixture: Fixture,
  options: RunOptions,
): Promise<string> {
  const handlers = new Map<string, (args: Record<string, unknown>, extra: unknown) => unknown>();
  const toolImpl = mock(
    (
      name: string,
      _description: string,
      _shape: unknown,
      handler: (args: Record<string, unknown>, extra: unknown) => unknown,
    ) => {
      handlers.set(name, handler);
      return { name };
    },
  );
  let out = "";
  const queryImpl = mock(() =>
    (async function* () {
      yield {
        type: "assistant",
        message: {
          id: "msg_lane_check",
          content: [
            { type: "tool_use", id: "tu_lane_check", name: "lane_check", input: {} },
          ],
        },
      };
      out = text(
        await handlers.get("lane_check")!(
          {},
          { _meta: { [RESPONSE_ORIGIN_TOOL_USE_META_KEY]: "tu_lane_check" } },
        ),
      );
      yield { type: "result", subtype: "success", is_error: false, result: "done" };
    })(),
  );
  const systemFailure = {
    ...(options.sink ? { sink: options.sink } : {}),
    ...(options.resultTokenCeiling !== undefined
      ? { resultTokenCeiling: options.resultTokenCeiling }
      : {}),
  };
  const runQuery = createUnifiedNoteSettlementSdkQuery({
    db,
    dataRoot: "/tmp/claude-mnemo-settlement-system-failure-unified",
    queryImpl: queryImpl as never,
    createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
    toolImpl: toolImpl as never,
    now: () => NOW,
    ...(Object.keys(systemFailure).length > 0 ? { systemFailure } : {}),
  });
  await runQuery({
    prompt: "settle",
    systemPrompt: "system",
    model: "claude-sonnet-5",
    jobId: fixture.job.id,
    claimGeneration: fixture.job.claimGeneration,
    stage: fixture.job.stage,
    sessionId: fixture.sessionDbId,
    writableTurnIds: new Set(fixture.windowTurnIds),
    scopeProvenance:
      options.scopeProvenance === undefined || options.scopeProvenance === null
        ? settlementScopeProvenanceFor(db, fixture.sessionDbId, fixture.windowTurnIds, 7, 8)
        : options.scopeProvenance,
    contextBuiltAtEpoch: NOW,
    windowStart: 7,
    windowEnd: 8,
  });
  return out;
}

describe("ticket 05 — the channel is wired at BOTH registration sites", () => {
  test("the unified run's lane_check fails closed on an unconstructible projection and on an over-protocol result", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedFixture(db);
      const raised: SettlementSystemFailure[] = [];
      const sink = (failure: SettlementSystemFailure) => raised.push(failure);

      // CONTROL: the unified site renders a real report for this dirty window.
      const full = await runUnifiedLaneCheck(db, fixture, { sink });
      expect(full).toContain("## ERRORS");
      expect(full).toContain("[E6]");
      expect(raised).toEqual([]);

      // CASE 2 on the unified site.
      const incoherent = await runUnifiedLaneCheck(db, fixture, {
        sink,
        scopeProvenance: {
          window: new Set([...fixture.windowTurnIds, 9_999]),
          baseLookback: new Set<number>(),
          closureOnly: new Set<number>(),
        },
      });
      expectFailClosed(incoherent);

      // CASE 4 on the unified site.
      const overProtocol = await runUnifiedLaneCheck(db, fixture, {
        sink,
        resultTokenCeiling: 20,
      });
      expectFailClosed(overProtocol);

      expect(raised.map((failure) => failure.case)).toEqual([
        "unconstructible-projection",
        "over-protocol-result",
      ]);
    } finally {
      db?.close();
    }
  });
});
