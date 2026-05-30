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

  test("loadConfig backfills new streaming knobs for legacy config files", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ mergeThresholdChars: 1500 }),
    );

    const config = loadConfig(home);
    expect(config.maxMiniTurnChars).toBe(24_000);
    expect(config.maxFlushAttempts).toBe(3);
  });

  test("loadConfig honors explicit streaming overrides", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ maxMiniTurnChars: 16_000, maxFlushAttempts: 5 }),
    );

    const config = loadConfig(home);
    expect(config.maxMiniTurnChars).toBe(16_000);
    expect(config.maxFlushAttempts).toBe(5);
  });

  test("loadConfig clamps streaming knobs to their floors", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ maxMiniTurnChars: 500, maxFlushAttempts: 0 }),
    );

    const config = loadConfig(home);
    expect(config.maxMiniTurnChars).toBe(10240);
    expect(config.maxFlushAttempts).toBe(1);
  });

  test("compactContextRatio defaults to 0.5", () => {
    expect(DEFAULT_CONFIG.compactContextRatio).toBe(0.5);
    expect(loadConfig("/definitely-missing").compactContextRatio).toBe(0.5);
  });

  test("loadConfig clamps compactContextRatio into [0.1, 0.95]", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ compactContextRatio: 5 }),
    );
    expect(loadConfig(home).compactContextRatio).toBe(0.95);

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ compactContextRatio: 0 }),
    );
    expect(loadConfig(home).compactContextRatio).toBe(0.1);
  });

  test("loadConfig honors an in-range compactContextRatio override", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ compactContextRatio: 0.7 }),
    );

    expect(loadConfig(home).compactContextRatio).toBe(0.7);
  });

  test("loadConfig falls back to defaults for non-finite numeric knobs", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    // Strings / junk must not become NaN (which would silently disable the
    // compact gate and clamp comparisons everywhere).
    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({
        compactContextRatio: "bad",
        maxMiniTurnChars: "nope",
        maxFlushAttempts: null,
      }),
    );

    const config = loadConfig(home);
    expect(config.compactContextRatio).toBe(DEFAULT_CONFIG.compactContextRatio);
    expect(config.maxMiniTurnChars).toBe(DEFAULT_CONFIG.maxMiniTurnChars);
    expect(config.maxFlushAttempts).toBe(DEFAULT_CONFIG.maxFlushAttempts);
    expect(Number.isFinite(config.compactContextRatio)).toBe(true);
  });
});
