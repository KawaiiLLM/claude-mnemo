import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  createDefaultHookHandlers,
  runHookCommand,
} from "../../src/hooks/hook-command";
import { ATTACHED_SEGMENT_BLOCK_SLOTS } from "../../src/hooks/session-composition";
import type { HookHandler } from "../../src/hooks/types";

/**
 * lane-model-v12 ticket 16 (spec D3f) — the SessionStart injection surface is
 * FIVE slots, and the three that retired may not come back under another name.
 *
 * Surviving:  roster · persona · rubric · segment<n>-fields · segment<n>-milestones
 * Retired:    notes (ticket 12) · proposals (ticket 15) · digest (ticket 16)
 *
 * The slot count is not cosmetic. Claude Code persists a single SessionStart
 * hook output past roughly 10K characters to a file and injects a 2KB preview
 * in its place ([S1730/T931], measured 25KB → 2KB), so ONE SLOT, ONE BLOCK is
 * a hard rule: a re-added block that shares a surviving slot detonates only
 * when the SUM crosses the line, later than either half's own growth would
 * warn. Every check below therefore pins the surface at three independent
 * layers, because a returning block has to pass all three:
 *
 *   1. WIRING — `plugin/hooks/hooks.json` fires exactly the five kinds. A new
 *      slot needs a command here; a renamed one changes this list.
 *   2. ROUTING — a section argument outside the five renders NOTHING. Not the
 *      roster: an installed plugin's hooks.json only updates on `/plugin
 *      update`, so a bundle from this build is certain to be invoked as
 *      `context digest` by a stale hooks.json, and a fallback to the bare
 *      `context` handler would render the roster TWICE in one SessionStart.
 *   3. STATIC — no module under `src/hooks/` reaches the retired content at
 *      all: not the renderers, not the modules that hold them, not the block
 *      headers they printed. This is the "another name" guard — a slot called
 *      `ledger` still has to import `renderRuleDigest` or re-print
 *      `## Rule Digest` to be the digest.
 *
 * EXEMPT, deliberately: `src/db/note-settlement-proposals.ts` and the
 * `note_settlement_proposals` TABLE. What ticket 15 retired is the injection
 * BLOCK and the `propose` verb, not the storage; the table still holds rows,
 * dropping it is a migration, and `db/schema.ts` still imports the module's
 * `canonicalizeSettlementProposalAddresses` for one. The sentinel below
 * targets the module's INJECTION-side reader (`listRecentSettlementProposals`,
 * which has had no caller since ticket 15) rather than the module.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const HOOKS_JSON_PATH = join(REPO_ROOT, "plugin", "hooks", "hooks.json");
const HOOKS_SRC_ROOT = join(REPO_ROOT, "src", "hooks");

const SURVIVING_SLOT_KINDS = [
  "roster",
  "persona",
  "rubric",
  "segment<n>-fields",
  "segment<n>-milestones",
] as const;

const RETIRED_SECTIONS = ["notes", "proposals", "digest"] as const;

function readHookCommands(event: string): string[] {
  const config = JSON.parse(readFileSync(HOOKS_JSON_PATH, "utf8")) as {
    hooks: Record<
      string,
      Array<{ hooks: Array<{ command: string }> }> | undefined
    >;
  };
  return (config.hooks[event] ?? []).flatMap((group) =>
    group.hooks.map((hook) => hook.command),
  );
}

/** `…hook-command.cjs context segment2-fields` → `segment<n>-fields`. */
function slotKindFromCommand(command: string): string {
  const argument = command.split("hook-command.cjs")[1]?.trim() ?? "";
  const section = argument.replace(/^context\s*/, "");
  if (section === "") return "roster";
  return section.replace(/^segment\d+-/, "segment<n>-");
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Comments are where a retirement is DOCUMENTED — `session-composition.ts`
 * names `<mnemo-note-taking>` to explain why it is gone — so the static
 * sentinel reads code only. String literals stay in: a block header like
 * `## Rule Digest` IS a string literal, and printing one is the whole
 * behavior being forbidden.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("SessionStart injection surface — five slots (lane-model-v12 ticket 16)", () => {
  test("hooks.json fires exactly the five surviving slot kinds", () => {
    const kinds = readHookCommands("SessionStart").map(slotKindFromCommand);

    expect([...new Set(kinds)].sort()).toEqual([...SURVIVING_SLOT_KINDS].sort());
    // One bare `context`, one persona, one rubric, and the fixed segment pool.
    expect(kinds).toHaveLength(3 + ATTACHED_SEGMENT_BLOCK_SLOTS * 2);
    expect(kinds.filter((kind) => kind === "roster")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "persona")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "rubric")).toHaveLength(1);
  });

  test("no retired section is wired anywhere in the plugin manifest", () => {
    const raw = readFileSync(HOOKS_JSON_PATH, "utf8");
    for (const section of RETIRED_SECTIONS) {
      expect(raw).not.toContain(`context ${section}`);
    }
  });

  test("the default handler map serves the five slots and nothing else", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    try {
      const keys = Object.keys(createDefaultHookHandlers({ db }))
        .filter((key) => key.startsWith("SessionStart"))
        .sort();
      const expected = ["SessionStart", "SessionStart:persona", "SessionStart:rubric"];
      for (let slot = 1; slot <= ATTACHED_SEGMENT_BLOCK_SLOTS; slot += 1) {
        expected.push(`SessionStart:segment${slot}-fields`);
        expected.push(`SessionStart:segment${slot}-milestones`);
      }
      expect(keys).toEqual(expected.sort());
      for (const section of RETIRED_SECTIONS) {
        expect(keys).not.toContain(`SessionStart:${section}`);
      }
    } finally {
      db.close();
    }
  });
});

describe("a retired section renders nothing — never the roster (ticket 16)", () => {
  // A stale installed hooks.json keeps calling the retired sections until the
  // user runs `/plugin update`. Each must write NOTHING and, above all, must
  // not reach the bare-`context` roster handler.
  for (const section of [...RETIRED_SECTIONS, "ledger", "recent", "milestones"]) {
    test(`\`context ${section}\` writes nothing and calls no handler`, async () => {
      const rosterHandler = mock(async () => ({
        continue: true,
        hookSpecificOutput: "## Segment roster",
      }));
      const writes: string[] = [];
      const exitCode = await runHookCommand({
        env: {},
        argv: ["bun", "hook-command.ts", "context", section],
        stdout: { write: (chunk: string) => { writes.push(chunk); return true; } },
        stderr: { write: () => true },
        readJsonFromStdin: () => ({}),
        normalizeHookInputImpl: () => ({
          eventName: "SessionStart",
          source: "startup",
          sessionId: "retired-section",
          cwd: "/projects/retired-section",
          stopHookActive: false,
          raw: {},
        }),
        handlers: {
          SessionStart: rosterHandler as unknown as HookHandler,
          [`SessionStart:${section}`]: rosterHandler as unknown as HookHandler,
        },
      });

      expect(exitCode).toBe(0);
      expect(writes).toEqual([]);
      expect(rosterHandler).not.toHaveBeenCalled();
    });
  }

  test("the bare `context` command still reaches the roster handler", async () => {
    // The negative above is only worth something if the positive still holds:
    // routing everything to silence would pass every check but this one.
    const rosterHandler = mock(async () => ({
      continue: true,
      hookSpecificOutput: "## Segment roster",
    }));
    const writes: string[] = [];
    await runHookCommand({
      env: {},
      argv: ["bun", "hook-command.ts", "context"],
      stdout: { write: (chunk: string) => { writes.push(chunk); return true; } },
      stderr: { write: () => true },
      readJsonFromStdin: () => ({}),
      normalizeHookInputImpl: () => ({
        eventName: "SessionStart",
        source: "startup",
        sessionId: "bare-context",
        cwd: "/projects/bare-context",
        stopHookActive: false,
        raw: {},
      }),
      handlers: { SessionStart: rosterHandler as unknown as HookHandler },
    });

    expect(rosterHandler).toHaveBeenCalledTimes(1);
    expect(writes.join("")).toContain("## Segment roster");
  });
});

describe("grep sentinels — the retired content cannot return under another name", () => {
  const hookSources = listTsFiles(HOOKS_SRC_ROOT).map((path) => ({
    path,
    code: stripComments(readFileSync(path, "utf8")),
  }));

  test("the retired renderers' own modules are gone from the tree", () => {
    // The `notes` slot's whole handler (ticket 12). `proposals` had no module
    // of its own — its renderer lived in `session-composition.ts`, so the
    // identifier check below is what covers it.
    expect(
      existsSync(join(HOOKS_SRC_ROOT, "handlers", "context-note-taking.ts")),
    ).toBe(false);
  });

  test("no hook module names a retired renderer, header, or module path", () => {
    const forbidden = [
      // Identifiers of the three retired renderers.
      "renderRuleDigest",
      "renderProposalsBlock",
      "renderProposalLine",
      "NOTE_TAKING_INSTRUCTIONS",
      "createNoteTakingContextHandler",
      // The injection-side reader of the exempted proposals table: the table
      // stays, but nothing may list it back into a block.
      "listRecentSettlementProposals",
      // The block headers themselves — a slot named anything at all still has
      // to print one of these to BE the retired block.
      "## Rule Digest",
      "## Proposals",
      "<mnemo-note-taking>",
      // Module paths, so a re-import is caught even under a local alias.
      "rules/digest",
      "note-settlement-proposals",
      "context-note-taking",
    ];

    for (const { path, code } of hookSources) {
      for (const needle of forbidden) {
        expect(`${path}: ${code.includes(needle) ? needle : "clean"}`).toBe(
          `${path}: clean`,
        );
      }
    }
  });

  test("no `sessions` section kind survives the rename to `roster`", () => {
    // Ticket 16's rename. The section used to be called `sessions` back when
    // it rendered a recent-session list; ticket 14 replaced its contents with
    // the segment roster and left the name, which sent readers looking for a
    // session list that does not exist. (`db/sessions` and the session helpers
    // are a different word — only the quoted SECTION literal is forbidden.)
    for (const { path, code } of hookSources) {
      expect(`${path}: ${code.includes('"sessions"') ? "sessions" : "clean"}`).toBe(
        `${path}: clean`,
      );
      expect(`${path}: ${code.includes("'sessions'") ? "sessions" : "clean"}`).toBe(
        `${path}: clean`,
      );
    }
  });
});
