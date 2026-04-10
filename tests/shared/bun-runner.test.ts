import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";

import {
  collectHookStdinFromStream,
  isPluginDisabledInClaudeSettings,
  shouldBufferStdinForScript,
} from "../../plugin/scripts/bun-runner.js";

describe("bun-runner hook stdin handling", () => {
  test("buffers stdin only for hook-command scripts", () => {
    expect(shouldBufferStdinForScript("/plugin/scripts/hook-command.cjs")).toBe(
      true,
    );
    expect(shouldBufferStdinForScript("/plugin/scripts/mcp-server.cjs")).toBe(
      false,
    );
  });

  test("resolves once a complete hook JSON payload is available without waiting for EOF", async () => {
    const stdin = new PassThrough();
    Object.assign(stdin, { isTTY: false });

    const pending = collectHookStdinFromStream(stdin, { timeoutMs: 100 });
    stdin.write('{"event_name":"Stop"');

    setTimeout(() => {
      stdin.write("}");
    }, 10);

    const result = await pending;

    expect(result?.toString("utf8")).toBe('{"event_name":"Stop"}');
  });

  test("rejects incomplete hook JSON instead of forwarding a partial payload", async () => {
    const stdin = new PassThrough();
    Object.assign(stdin, { isTTY: false });

    const pending = collectHookStdinFromStream(stdin, { timeoutMs: 10 });
    stdin.write('{"event_name":"Stop"');

    await expect(pending).rejects.toThrow(
      "Timed out waiting for complete hook JSON on stdin",
    );
  });

  test("detects claude-mnemo disable flag in Claude settings", () => {
    const configDir = mkdtempSync(join(tmpdir(), "mnemo-bun-runner-"));
    try {
      writeFileSync(
        join(configDir, "settings.json"),
        JSON.stringify({
          enabledPlugins: {
            "claude-mnemo@zhaoqixuan": false,
          },
        }),
      );

      expect(
        isPluginDisabledInClaudeSettings(
          { CLAUDE_CONFIG_DIR: configDir },
        ),
      ).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("returns false when settings file is missing", () => {
    const configDir = mkdtempSync(join(tmpdir(), "mnemo-bun-runner-"));
    try {
      expect(
        isPluginDisabledInClaudeSettings({ CLAUDE_CONFIG_DIR: configDir }),
      ).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("returns false when another plugin is disabled", () => {
    const configDir = mkdtempSync(join(tmpdir(), "mnemo-bun-runner-"));
    try {
      writeFileSync(
        join(configDir, "settings.json"),
        JSON.stringify({
          enabledPlugins: {
            "claude-mem@thedotmack": false,
          },
        }),
      );

      expect(
        isPluginDisabledInClaudeSettings({ CLAUDE_CONFIG_DIR: configDir }),
      ).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("returns false when claude-mnemo is explicitly enabled", () => {
    const configDir = mkdtempSync(join(tmpdir(), "mnemo-bun-runner-"));
    try {
      writeFileSync(
        join(configDir, "settings.json"),
        JSON.stringify({
          enabledPlugins: {
            "claude-mnemo@zhaoqixuan": true,
          },
        }),
      );

      expect(
        isPluginDisabledInClaudeSettings({ CLAUDE_CONFIG_DIR: configDir }),
      ).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("returns false when settings.json is malformed", () => {
    const configDir = mkdtempSync(join(tmpdir(), "mnemo-bun-runner-"));
    try {
      writeFileSync(join(configDir, "settings.json"), "{not-json");

      expect(
        isPluginDisabledInClaudeSettings({ CLAUDE_CONFIG_DIR: configDir }),
      ).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
