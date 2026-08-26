import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

describe("release artifacts", () => {
  test("plugin manifest declares an author", () => {
    const manifest = JSON.parse(
      readFileSync("plugin/.claude-plugin/plugin.json", "utf8"),
    ) as {
      author?: {
        name?: string;
      };
    };

    expect(typeof manifest.author).toBe("object");
    expect(typeof manifest.author?.name).toBe("string");
    expect(manifest.author?.name?.trim().length).toBeGreaterThan(0);
  });

  test("release metadata is consistently bumped to 0.21.0", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      version?: string;
    };
    const pluginManifest = JSON.parse(
      readFileSync("plugin/.claude-plugin/plugin.json", "utf8"),
    ) as {
      version?: string;
    };
    const marketplace = JSON.parse(
      readFileSync(".claude-plugin/marketplace.json", "utf8"),
    ) as {
      metadata?: { version?: string };
      plugins?: Array<{ version?: string }>;
    };

    const diarySdkQuery = readFileSync(
      "src/worker/diary-sdk-query.ts",
      "utf8",
    );
    const settlementSdkQuery = readFileSync(
      "src/worker/note-settlement-sdk-query.ts",
      "utf8",
    );

    expect(packageJson.version).toBe("0.21.0");
    expect(pluginManifest.version).toBe("0.21.0");
    expect(marketplace.metadata?.version).toBe("0.21.0");
    expect(marketplace.plugins?.[0]?.version).toBe("0.21.0");
    expect(diarySdkQuery).toContain('version: "0.21.0"');
    expect(settlementSdkQuery).toContain('version: "0.21.0"');
  });

  test("plugin scripts declare local ESM module type for bun-runner", () => {
    const scriptsPackage = JSON.parse(
      readFileSync("plugin/scripts/package.json", "utf8"),
    ) as {
      type?: string;
    };

    expect(scriptsPackage).toEqual({ type: "module" });
  });

  test("tracks built plugin entrypoints in git", () => {
    const result = spawnSync(
      "git",
      [
        "ls-files",
        "--error-unmatch",
        "plugin/scripts/hook-command.cjs",
        "plugin/scripts/mcp-server.cjs",
        "plugin/scripts/worker.cjs",
        "plugin/scripts/replay-parse.cjs",
        "plugin/scripts/turn-detail.sh",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
  });

  test("rebuilds BUILD_ID bundles to the current package version", () => {
    const { version } = JSON.parse(readFileSync("package.json", "utf8")) as {
      version?: string;
    };
    expect(typeof version).toBe("string");

    // Only the long-lived entrypoints embed BUILD_ID (`<version>-<base36>`); the
    // base36 suffix is non-deterministic, so pin just the version prefix. This
    // catches a release that bumped the manifests but forgot `bun run build`.
    const stamp = new RegExp(`BUILD_ID = [^;]*"${version!.replace(/\./g, "\\.")}-`);
    for (const bundle of ["hook-command.cjs", "worker.cjs"]) {
      const source = readFileSync(`plugin/scripts/${bundle}`, "utf8");
      expect(source).toMatch(stamp);
    }
  });

  test("bundles claude agent sdk into hook entrypoint", () => {
    const hookCommand = readFileSync("plugin/scripts/hook-command.cjs", "utf8");

    expect(hookCommand).not.toContain(
      'var import_claude_agent_sdk = require("@anthropic-ai/claude-agent-sdk")',
    );
  });

  test("built bundles embed current worker + timeline logic (stale-bundle guard)", () => {
    const output = mkdtempSync(join(tmpdir(), "mnemo-release-build-"));
    try {
      const outputRelative = relative(process.cwd(), output);
      const build = spawnSync("node", ["scripts/build.js"], {
        encoding: "utf8",
        env: { ...process.env, MNEMO_BUILD_OUTPUT_DIR: outputRelative },
      });
      expect(build.status).toBe(0);
      // The build stamp is non-deterministic (base36 timestamp suffix), so it is
      // removed before comparing. It appears in TWO shapes, not one: the
      // top-level `var BUILD_ID = …;` and, since a lazily-initialised module
      // started importing it, an indented bare `BUILD_ID = …;` inside esbuild's
      // `__esm` wrapper. Stripping only the first form made this guard fail on a
      // pair of bundles that were otherwise byte-identical — a false positive
      // that reads exactly like a skipped rebuild. Hence global, both shapes.
      const stripBuildId = (source: string) =>
        source.replace(/^[ \t]*(?:var )?BUILD_ID = .*;\n/gm, "");
      for (const bundle of ["hook-command.cjs", "mcp-server.cjs", "worker.cjs", "replay-parse.cjs"]) {
        expect(stripBuildId(readFileSync(join(output, bundle), "utf8"))).toBe(
          stripBuildId(readFileSync(join("plugin", "scripts", bundle), "utf8")),
        );
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }

    // The BUILD_ID guard above catches a version bump WITHOUT a rebuild; it does
    // NOT catch a SOURCE change without a rebuild — the version prefix is
    // unchanged, so BUILD_ID still matches and the bundle silently runs old
    // logic. These content sentinels are stable identifiers from shipped
    // features; if `bun run build` was skipped after editing src/, a missing one
    // fails here instead of shipping a stale bundle.
    const hookCommand = readFileSync("plugin/scripts/hook-command.cjs", "utf8");
    expect(hookCommand).toContain("renderPersonaDocumentInjection");
    // read-write-contract (tickets 03/13): the owed-suffix helper retired
    // with the backlog cadence, and the universal 20-turn remember reminder
    // renders on the UserPromptSubmit channel — a stale bundle would still
    // carry the suffix helper and lack the reminder.
    expect(hookCommand).not.toContain("formatOwedSuffix");
    expect(hookCommand).toContain("renderRememberReminder");
    expect(hookCommand).toContain("listOwedNoteTurns");
    expect(hookCommand).not.toContain("reconcileNoteDebt");
    expect(hookCommand).not.toContain("NOTE_RELIEF_DRY_TURNS");
    // `reminded_at_epoch` itself stays (spec D8: the column is a trial-history
    // leftover, not retired) — only the classification walk that wrote it is
    // gone, which the two assertions above already pin.
    // The retired tool-adjacent subcommands are asserted absent too: a stale
    // bundle would still register `pre-tool-dispatch` and `result-dispatch`,
    // whose additionalContext is what breaks the message-side cache breakpoint.
    expect(hookCommand).not.toContain("pre-tool-dispatch");
    expect(hookCommand).not.toContain("result-dispatch");
    // The SessionStart milestones section is the unified renderer's budget
    // fitter now, not the old four-stage cap ladder; a stale bundle would still
    // carry the ladder and re-render the whole view once per candidate count.
    expect(hookCommand).toContain("fitMilestoneBodyToBudget");
    expect(hookCommand).not.toContain("REDUCED_PROMPT_CAP");

    const worker = readFileSync("plugin/scripts/worker.cjs", "utf8");
    for (const marker of [
      // floor-and-render-fidelity ticket 03 retired the "dbid:T" DB-id
      // correlation token the worker recall used to emit — lane_check and
      // recall both speak S<n>/T<m> now, so a stale bundle would still carry
      // the token; a fresh one never does. `audience: "worker"` itself stays
      // a marker — that gate still exists, for the private-tag-stripped
      // envelope cap, just not for the dbid token any more.
      'audience: "worker"', // recall worker envelope-cap surface
      "OUTCOME_TAGS", // milestone marker logic
      "workerRecallInputShape", // uncapped worker recall schema
      "allowedDocumentSubtrees", // read_doc request scope
      "Dream agent attempted more than one commit", // single-commit dream contract
      "memory/archive.md", // dream curation workspace
      "last_successful_date", // durable dream completion marker
      "recordDreamFailure", // retryable dream queue path
      "note_settlement_jobs", // D9 settlement: the durable settle work unit
      "frozen_member_ids", // cohort frozen at enqueue — retries settle one set
      "claim_generation", // lease ownership fence — a stale worker commits nothing
      "settleCompletedTurn", // ticket 15: completion settles the row, no agent
      "completionFloorStatus", // the ONE definition of an un-noted turn's status
      // 0.19.0 — memory console (worker HTTP seam): the request gate and the
      // final-envelope byte bound; a stale worker bundle would 404 /console.
      "evaluateRequestGate",
      "applyGraphAutoInterval",
      "electionCoverage", // R2 #11: election tiers computed on the full snapshot
      // 0.19.0 — semantic conformance: the checker's vocabulary fact block and
      // the settlement re-annotation duty (non-conforming is never standing
      // content).
      "vocabularyConformance",
      "RE-ANNOTATED FROM SCRATCH",
      "getRolledBackCiterIds", // R1 #7: the corrector fact the live edge feed cannot carry
    ]) {
      expect(worker).toContain(marker);
    }

    // The demolished extraction agent (ticket 15, spec D10/D13). A stale worker
    // bundle would still open an SDK session per content session, resume it, run
    // the stall watchdog and push obs summaries — none of which any source file
    // can express any more, so their absence is the only way to see the rebuild.
    for (const removed of [
      "needsReprime", // compact re-prime of the resident agent
      "onCompactBoundary", // SDK-auto compact boundary wiring
      "last_agent_session_id", // the resume pointer
      // `extraction_stall_attempts` USED to be listed here as the stall
      // watchdog's durable counter. It was removed when the `cites_recorded`
      // retirement found that the four `extraction_stall_*` columns are still
      // physically present on the production `turns` table, and that the
      // ticket-02 rebuild — whose explicit INSERT column list predates them —
      // would silently drop them the next time it fired. Preserving a column
      // means naming it, so the literal now has a legitimate home in
      // db/schema.ts's migration and its absence can no longer stand for "the
      // watchdog is gone". The eight markers left still prove the rebuild;
      // dropping the columns for real belongs to the extraction-redesign
      // ticket that owns them, not to a bundle guard.
      "exceedsG3EvidenceGate", // obs/turn grade calibration fed to the agent
      "parseSettlementBatch", // 0.8.4 two-phase grading
      "This message is a SETTLEMENT", // the settle message class
      "buildCorrectiveResend", // the derailment ladder
      // note-prompt-clock (ticket 03): the classification walk that used to
      // run inside Stop/PostToolUse/the worker's turn-stop retirement is
      // retired outright — owed turns are a derived query, not a maintained
      // ledger — so a stale worker bundle would still carry its call sites.
      "reconcileNoteDebt",
      // floor-and-render-fidelity ticket 03: the dbid:T<n> correlation token
      // retired — lane_check and recall both speak S<n>/T<m> now, so a stale
      // bundle would still carry the token a fresh one never emits.
      "dbid:T",
    ]) {
      expect(worker).not.toContain(removed);
    }

    const mcpServer = readFileSync("plugin/scripts/mcp-server.cjs", "utf8");
    for (const marker of [
      "OUTCOME_TAGS",
      '"release"', // release tag → 🏁 milestone
      "REVERSED_ROLE_TAGS", // literal rolled-back role tag → ↩️ milestone
      "turn_citations", // structured citation edge table
      "bracketBareTurnReferences", // bare-id → [T<n>] write-side backstop
      "json_each", // tag: facet — json_each exact-match clause
      "workerRecallInputShape", // worker recall schema shared by SDK agents
      "renderMilestoneBody", // unified row renderer — arc body
      "fitUnitTrim", // per-unit 150-token hard cap, spec §D termination order
      "fitMilestoneBodyToBudget", // global budget: desc → title-only → drop unit
      // incremental body model: memoized unit fits + running token weight, so a
      // long session's budget search is linear rather than quadratic
      "createMilestoneBodyModel",
      // Day frames degrade with the units: a day that loses its last row folds
      // into a collapsed run, and consecutive collapsed days cost one line.
      "collapseState",
      // The `前件` fold counter that used to sit beside it RETIRED with
      // view-render-repair ticket 05's one row form — the fold renders a bare
      // `+N` now, too generic to pin. What that marker was really guarding is
      // the antecedent aggregation, so this pins the aggregator itself; it is
      // also where edge-mechanism-revision ticket 10 put the by-pair dedupe,
      // so a stale bundle here would double-print `↳ T1, T1`.
      "resolveTurnRowLinks",
      "compareMilestoneRank", // one ordering for selection rank and budget degradation
      // 0.19.0 — the milestone election (spec .scratch/milestone-election/):
      // five identity tiers over lane structure replace the old
      // correction-graph/always-keep/effGrade chain outright.
      "electMilestones", // the pure election core
      "buildElectedCitations", // ↳ = elected-only citation index from lane edges
      "deriveLaneStates", // closed-valid/closed-invalid/open, shared with the checker
      "getRolledBackCiterIds", // R1 #7 corrector channel
      "compareOrderKeyAcrossSessions", // R1 #6 cross-session rank tie-break
    ]) {
      expect(mcpServer).toContain(marker);
    }

    // The election redesign DELETED the old milestone machinery from source
    // (milestone-election ticket 03, f7ae051): corrector-promotion graph,
    // antecedent re-homing, the `+N more` conservation row, and the escaped
    // `被T` back-link literal on superseded ↳ rows. A stale mcp-server bundle
    // would still carry them — absence is the rebuild's signature, the same
    // pattern the worker's demolished-extraction block uses above.
    // (`parseInlineCitations` is NOT in this list: db/citations.ts still
    // exports it for the write-side grammar, it merely fell out of this
    // bundle when the prose-re-parse ↳ path retired — its presence would not
    // indicate staleness, only a new legitimate consumer.)
    for (const removed of [
      "buildCorrectionGraph",
      "citerPromptNumbers",
      "noteHidden",
      "\\u88ABT",
    ]) {
      expect(mcpServer).not.toContain(removed);
    }

    // The `tag:` rejection was removed when the turn-scoped facet landed; a
    // stale bundle would still carry it and silently break `tag:` in the plugin.
    expect(mcpServer).not.toContain("tag: filtering was removed");
    // The inline-only ≤2-ref ↳ mechanism was replaced by structured
    // pull-through; a stale bundle would still carry the resolver and render
    // the pre-redesign sub-lines.
    expect(mcpServer).not.toContain("resolveMilestoneReferences");

    // The extraction agent's batch prompt (its correction rubric, its
    // rolled-back tag contract and the two-class tag rules it carried) went with
    // the agent — nothing in the worker addresses a model about a turn any more.
    expect(worker).not.toContain("Correcting an earlier turn");
    expect(worker).not.toContain("topic tags NEVER affect milestones");
  });
});
