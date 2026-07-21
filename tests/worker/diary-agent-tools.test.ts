import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  AGENT_READ_DOC_MAX_BYTES,
  createDreamAgentToolHandlers,
} from "../../src/worker/diary-agent-tools";

describe("shared SDK agent tools", () => {
  let db: Database;
  let dataRoot: string;
  let outsideRoot: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-agent-tools-"));
    outsideRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-agent-tools-outside-"));
    mkdirSync(join(dataRoot, "diary"));
    mkdirSync(join(dataRoot, "memory"));
    writeFileSync(join(dataRoot, "diary", "2026-07-10.md"), "shared promotion fact in diary");
    writeFileSync(join(dataRoot, "memory", "archive.md"), "shared promotion fact in archive");
    writeFileSync(join(dataRoot, "mnemo.db"), "database");
    writeFileSync(join(dataRoot, "config.json"), "configuration");
    mkdirSync(join(outsideRoot, ".claude", "projects"), { recursive: true });
    writeFileSync(join(outsideRoot, ".claude", "projects", "raw.jsonl"), "<private>raw</private>");
    writeFileSync(join(outsideRoot, "outside.md"), "outside");
    mkdirSync(join(dataRoot, "memory", ".transactions", "tx-1"), { recursive: true });
    writeFileSync(join(dataRoot, "memory", ".transactions", "tx-1", "staged.md"), "internal");
  });

  afterEach(() => {
    db.close();
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  });

  test("reads Markdown documents from the dream diary and memory subtrees", async () => {
    const handlers = createDreamAgentToolHandlers({ db, dataRoot });
    expect(await handlers.readDoc("diary/2026-07-10.md")).toBe("shared promotion fact in diary");
    expect(await handlers.readDoc("memory/archive.md")).toBe("shared promotion fact in archive");
  });

  test("allows Read and Grep paths under diary and memory", async () => {
    const handlers = createDreamAgentToolHandlers({
      db,
      dataRoot,
    });
    const permissionOptions = {
      signal: new AbortController().signal,
      toolUseID: "tool-use",
    };
    const cases = [
      ["Read", { file_path: join(dataRoot, "diary", "2026-07-10.md") }],
      ["Read", { file_path: join(dataRoot, "memory", "archive.md") }],
      ["Grep", { pattern: "shared promotion fact", path: join(dataRoot, "diary") }],
      ["Grep", { pattern: "shared promotion fact", path: join(dataRoot, "memory", "archive.md") }],
      ["mcp__diary__read_doc", { path: "memory/archive.md" }],
      ["mcp__diary__commit", {}],
    ] as const;

    for (const [toolName, input] of cases) {
      expect(await handlers.canUseTool(toolName, input, permissionOptions)).toEqual({
        behavior: "allow",
        updatedInput: input,
      });
    }
  });

  test("allows validated dream rule read and write tools", async () => {
    const handlers = createDreamAgentToolHandlers({ db, dataRoot });
    const permissionOptions = {
      signal: new AbortController().signal,
      toolUseID: "tool-use",
    };
    const cases = [
      ["mcp__diary__list_rule_hits", { date: "2026-07-10" }],
      [
        "mcp__diary__read_turn_detail",
        { turn_ref: "S1/T1", opts: { cap: 1500 } },
      ],
      [
        "mcp__diary__propose_rule",
        {
          name: "bounded-command",
          claim: "运行长命令时必须设置 timeout。",
          rationale: "避免无界等待。",
          scope: "global",
          trigger_kind: "tool",
          trigger_spec: { kind: "tool", tool: "Bash", param_absent: "timeout" },
        },
      ],
      [
        "mcp__diary__submit_judgment",
        {
          rule_id: 1,
          source_event_id: 1,
          label: "helpful",
          rationale: "产生了正面作用。",
          adjustment: { action: "retain" },
        },
      ],
    ] as const;

    for (const [toolName, input] of cases) {
      expect(await handlers.canUseTool(toolName, input, permissionOptions)).toEqual({
        behavior: "allow",
        updatedInput: input,
      });
    }
  });

  test("allows Write/Edit inside the staging subtree and rejects them elsewhere", async () => {
    const stagingRoot = join(dataRoot, ".dream-staging", "2026-07-10");
    mkdirSync(join(stagingRoot, "memory"), { recursive: true });
    mkdirSync(join(stagingRoot, "diary"), { recursive: true });
    writeFileSync(join(stagingRoot, "memory", "user-profile.md"), "# User Profile\n");
    writeFileSync(join(stagingRoot, "diary", "2026-07-10.md"), "# 2026-07-10\n");
    const handlers = createDreamAgentToolHandlers({ db, dataRoot, stagingRoot });
    const permissionOptions = {
      signal: new AbortController().signal,
      toolUseID: "tool-use",
    };

    for (const toolName of ["Write", "Edit"] as const) {
      for (const file_path of [
        join(stagingRoot, "memory", "user-profile.md"),
        join(stagingRoot, "diary", "2026-07-10.md"),
      ]) {
        expect(
          await handlers.canUseTool(toolName, { file_path }, permissionOptions),
        ).toMatchObject({ behavior: "allow" });
      }

      // Live (read-only) subtrees and paths outside the data root are rejected.
      for (const file_path of [
        join(dataRoot, "memory", "archive.md"),
        join(dataRoot, "diary", "2026-07-10.md"),
        join(outsideRoot, "outside.md"),
      ]) {
        expect(
          await handlers.canUseTool(toolName, { file_path }, permissionOptions),
        ).toMatchObject({ behavior: "deny" });
      }

      // Missing file_path and non-Markdown staging paths are rejected too.
      expect(
        await handlers.canUseTool(toolName, {}, permissionOptions),
      ).toMatchObject({ behavior: "deny" });
    }
  });

  test("denies Write/Edit when the staging root escapes the data root via a symlink", async () => {
    // `.dream-staging` is a symlink to an outside directory; the `<date>` subdir
    // (a real directory beneath it) is not itself a symlink, so only the
    // root-within-dataRoot containment check catches the escape.
    const escapedStaging = join(outsideRoot, "escaped-staging");
    mkdirSync(join(escapedStaging, "2026-07-10", "memory"), { recursive: true });
    writeFileSync(
      join(escapedStaging, "2026-07-10", "memory", "user-profile.md"),
      "# User Profile\n",
    );
    symlinkSync(escapedStaging, join(dataRoot, ".dream-staging"));
    const stagingRoot = join(dataRoot, ".dream-staging", "2026-07-10");
    const handlers = createDreamAgentToolHandlers({ db, dataRoot, stagingRoot });
    const permissionOptions = {
      signal: new AbortController().signal,
      toolUseID: "tool-use",
    };

    for (const toolName of ["Write", "Edit"] as const) {
      expect(
        await handlers.canUseTool(
          toolName,
          { file_path: join(stagingRoot, "memory", "user-profile.md") },
          permissionOptions,
        ),
      ).toMatchObject({
        behavior: "deny",
        message: expect.stringContaining("escapes the data root"),
      });
    }
  });

  test("denies Write/Edit when no staging workspace is configured", async () => {
    const handlers = createDreamAgentToolHandlers({ db, dataRoot });
    const permissionOptions = {
      signal: new AbortController().signal,
      toolUseID: "tool-use",
    };
    expect(
      await handlers.canUseTool(
        "Write",
        { file_path: join(dataRoot, "memory", "archive.md") },
        permissionOptions,
      ),
    ).toMatchObject({ behavior: "deny" });
  });

  test("Grep returns promotion matches from archive and diary documents", async () => {
    const handlers = createDreamAgentToolHandlers({ db, dataRoot });
    const permissionOptions = {
      signal: new AbortController().signal,
      toolUseID: "tool-use",
    };
    const searchPaths = [
      join(dataRoot, "memory", "archive.md"),
      join(dataRoot, "diary"),
    ];
    const executable = join(
      process.cwd(),
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
      "vendor",
      "ripgrep",
      `${process.arch}-${process.platform}`,
      process.platform === "win32" ? "rg.exe" : "rg",
    );
    let matches = "";

    for (const path of searchPaths) {
      const input = { pattern: "shared promotion fact", path };
      expect(
        await handlers.canUseTool("Grep", input, permissionOptions),
      ).toMatchObject({ behavior: "allow" });
      const grep = spawnSync(
        executable,
        ["--with-filename", "--line-number", input.pattern, input.path],
        { encoding: "utf8" },
      );
      expect(grep.status).toBe(0);
      matches += grep.stdout.replaceAll("\\", "/");
    }

    expect(matches).toContain("memory/archive.md:1:shared promotion fact in archive");
    expect(matches).toContain("diary/2026-07-10.md:1:shared promotion fact in diary");
  });

  test("denies Read and Grep for raw projects, DB/config, and outside paths", async () => {
    const handlers = createDreamAgentToolHandlers({
      db,
      dataRoot,
    });
    const permissionOptions = {
      signal: new AbortController().signal,
      toolUseID: "tool-use",
    };
    const deniedPaths = [
      join(outsideRoot, ".claude", "projects"),
      join(dataRoot, "mnemo.db"),
      join(dataRoot, "config.json"),
      join(dataRoot, "persona", "user-profile.md"),
      join(outsideRoot, "outside.md"),
    ];

    for (const path of deniedPaths) {
      expect(await handlers.canUseTool("Read", { file_path: path }, permissionOptions)).toMatchObject({
        behavior: "deny",
        message: expect.stringContaining("outside"),
      });
      expect(await handlers.canUseTool("Grep", { pattern: "private", path }, permissionOptions)).toMatchObject({
        behavior: "deny",
        message: expect.stringContaining("outside"),
      });
    }
    expect(
      await handlers.canUseTool("Grep", { pattern: "too broad" }, permissionOptions),
    ).toMatchObject({ behavior: "deny" });
    expect(
      await handlers.canUseTool(
        "mcp__diary__read_doc",
        { path: "diary/../memory/archive.md" },
        permissionOptions,
      ),
    ).toMatchObject({ behavior: "deny", message: expect.stringContaining("outside") });
    expect(
      await handlers.canUseTool(
        "Read",
        { file_path: join(dataRoot, "memory", ".transactions", "tx-1", "staged.md") },
        permissionOptions,
      ),
    ).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("Transaction artifacts"),
    });
    expect(
      await handlers.canUseTool(
        "mcp__diary__commit",
        { date: "2026-07-10", outputPath: join(outsideRoot, "escape") },
        permissionOptions,
      ),
    ).toMatchObject({ behavior: "deny" });
  });

  test("denies Read and Grep symlink escapes", async () => {
    const outsideDirectory = join(outsideRoot, "raw");
    mkdirSync(outsideDirectory);
    writeFileSync(join(outsideDirectory, "secret.md"), "secret");
    symlinkSync(join(outsideDirectory, "secret.md"), join(dataRoot, "diary", "escaped.md"));
    symlinkSync(outsideDirectory, join(dataRoot, "memory", "escaped"));
    const handlers = createDreamAgentToolHandlers({
      db,
      dataRoot,
    });
    const permissionOptions = {
      signal: new AbortController().signal,
      toolUseID: "tool-use",
    };

    expect(
      await handlers.canUseTool(
        "Read",
        { file_path: join(dataRoot, "diary", "escaped.md") },
        permissionOptions,
      ),
    ).toMatchObject({ behavior: "deny", message: expect.stringContaining("symlink") });
    expect(
      await handlers.canUseTool(
        "Grep",
        { pattern: "secret", path: join(dataRoot, "memory", "escaped") },
        permissionOptions,
      ),
    ).toMatchObject({ behavior: "deny", message: expect.stringContaining("symlink") });
  });

  test("rejects paths outside document scope and database files", async () => {
    const handlers = createDreamAgentToolHandlers({ db, dataRoot });
    await expect(handlers.readDoc("../config.json")).rejects.toThrow("outside");
    await expect(handlers.readDoc("mnemo.db")).rejects.toThrow("outside");
    await expect(handlers.readDoc("diary/../config.md")).rejects.toThrow("outside");
    await expect(
      handlers.readDoc("memory/.transactions/tx-1/staged.md"),
    ).rejects.toThrow("Transaction artifacts");
  });

  test("rejects symlink roots and symlink targets", async () => {
    const target = join(dataRoot, "target.md");
    writeFileSync(target, "target");
    symlinkSync(target, join(dataRoot, "diary", "linked.md"));
    let handlers = createDreamAgentToolHandlers({ db, dataRoot });
    await expect(handlers.readDoc("diary/linked.md")).rejects.toThrow("symlink");

    rmSync(join(dataRoot, "memory"), { recursive: true });
    symlinkSync(join(dataRoot, "diary"), join(dataRoot, "memory"));
    handlers = createDreamAgentToolHandlers({ db, dataRoot });
    await expect(handlers.readDoc("memory/2026-07-10.md")).rejects.toThrow("symlink");
  });

  test("rejects oversized and invalid UTF-8 documents", async () => {
    writeFileSync(join(dataRoot, "diary", "large.md"), Buffer.alloc(AGENT_READ_DOC_MAX_BYTES + 1));
    writeFileSync(join(dataRoot, "diary", "invalid.md"), new Uint8Array([0xff]));
    const handlers = createDreamAgentToolHandlers({ db, dataRoot });
    await expect(handlers.readDoc("diary/large.md")).rejects.toThrow("exceeds");
    await expect(handlers.readDoc("diary/invalid.md")).rejects.toThrow("UTF-8");
  });
});
