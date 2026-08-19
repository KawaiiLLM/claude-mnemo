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

  test("release metadata is consistently bumped to 0.12.1", () => {
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

    expect(packageJson.version).toBe("0.12.1");
    expect(pluginManifest.version).toBe("0.12.1");
    expect(marketplace.metadata?.version).toBe("0.12.1");
    expect(marketplace.plugins?.[0]?.version).toBe("0.12.1");
    expect(diarySdkQuery).toContain('version: "0.12.1"');
    expect(settlementSdkQuery).toContain('version: "0.12.1"');
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
      'audience: "worker"', // recall worker DB-id surface
      "dbid:T", // DB-id token the worker recall emits
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
    ]) {
      expect(worker).not.toContain(removed);
    }

    const mcpServer = readFileSync("plugin/scripts/mcp-server.cjs", "utf8");
    for (const marker of [
      "OUTCOME_TAGS",
      '"release"', // release tag → 🏁 milestone
      "REVERSED_ROLE_TAGS", // literal rolled-back role tag → ↩️ milestone
      "parseInlineCitations", // shared literal inline-citation grammar
      "turn_citations", // structured citation edge table
      "bracketBareTurnReferences", // bare-id → [T<n>] write-side backstop
      "buildCorrectionGraph", // corrector-promotion / victim-demotion selection
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
      "noteHidden", // `+N more` conservation for a day with no rendered rows
      // esbuild writes the bundle ASCII-escaped, so the CJK render literals are
      // matched in their escaped form: `前件` (↳ fold counter past the
      // 4-antecedent cap) and `被T` (🚫 back-link on a superseded ↳ row).
      "\\u524D\\u4EF6",
      "\\u88ABT",
      "compareMilestoneRank", // one ordering for selection rank and budget degradation
      "citerPromptNumbers", // full citer list — antecedent re-homing after a removal
    ]) {
      expect(mcpServer).toContain(marker);
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
