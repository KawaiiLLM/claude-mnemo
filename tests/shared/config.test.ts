import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CONFIG,
  loadConfig,
  resolveConfigPath,
} from "../../src/shared/config";

describe("shared config", () => {
  test("resolveConfigPath points into ~/.claude-mnemo/config.json", () => {
    expect(resolveConfigPath("/tmp/home")).toBe("/tmp/home/.claude-mnemo/config.json");
  });

  test("loadConfig returns defaults when the file is missing", () => {
    expect(loadConfig("/definitely-missing")).toEqual(DEFAULT_CONFIG);
  });

  test("loadConfig merges partial overrides over defaults", async () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ mergeThresholdChars: 1500 }),
    );

    expect(loadConfig(home)).toEqual({
      ...DEFAULT_CONFIG,
      mergeThresholdChars: 1500,
    });
  });

  test("loadConfig falls back to defaults when the file is invalid", async () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    writeFileSync(`${home}/.claude-mnemo/config.json`, "{not-json");

    expect(loadConfig(home)).toEqual(DEFAULT_CONFIG);
  });
});
