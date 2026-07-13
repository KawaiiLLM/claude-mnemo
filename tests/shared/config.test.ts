import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CONFIG,
  DEFAULT_DREAM_AGENT_MODEL,
  DEFAULT_DREAM_AGENT_TIMEOUT_MS,
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

  test("loads a known dream agent model and warns while falling back for an invalid id", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    const warnings: string[] = [];

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ dreamAgentModel: "claude-sonnet-5" }),
    );
    expect(loadConfig(home, { warn: (message) => warnings.push(message) }).dreamAgentModel)
      .toBe("claude-sonnet-5");
    expect(warnings).toEqual([]);

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ dreamAgentModel: "future-model-alias" }),
    );
    expect(loadConfig(home, { warn: (message) => warnings.push(message) }).dreamAgentModel)
      .toBe(DEFAULT_DREAM_AGENT_MODEL);
    expect(warnings).toEqual([
      `[claude-mnemo] Invalid dreamAgentModel "future-model-alias"; using ${DEFAULT_DREAM_AGENT_MODEL}.`,
    ]);
  });

  test("loads dream scheduling overrides and falls back with a warning for an invalid timezone", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    const warnings: string[] = [];

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({
        dreamAgentHour: 6,
        dreamAgentTimeZone: "America/New_York",
        dreamAgentBacklogLimit: 3,
      }),
    );
    expect(loadConfig(home, { warn: (message) => warnings.push(message) })).toMatchObject({
      dreamAgentHour: 6,
      dreamAgentTimeZone: "America/New_York",
      dreamAgentBacklogLimit: 3,
    });
    expect(warnings).toEqual([]);

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ dreamAgentTimeZone: "Mars/Olympus_Mons" }),
    );
    expect(
      loadConfig(home, { warn: (message) => warnings.push(message) })
        .dreamAgentTimeZone,
    ).toBe("Asia/Shanghai");
    expect(warnings).toEqual([
      '[claude-mnemo] Invalid dreamAgentTimeZone "Mars/Olympus_Mons"; using Asia/Shanghai.',
    ]);
  });

  test("dream scheduling defaults to 04:00 Asia/Shanghai with a seven-day cap", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      dreamAgentHour: 4,
      dreamAgentTimeZone: "Asia/Shanghai",
      dreamAgentBacklogLimit: 7,
    });
  });

  test("dream agent timeout defaults to thirty minutes and accepts an override", () => {
    expect(DEFAULT_DREAM_AGENT_TIMEOUT_MS).toBe(1_800_000);
    expect(DEFAULT_CONFIG.dreamAgentTimeoutMs).toBe(1_800_000);

    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ dreamAgentTimeoutMs: 2_400_000 }),
    );

    expect(loadConfig(home).dreamAgentTimeoutMs).toBe(2_400_000);
  });
});
