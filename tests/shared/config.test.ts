import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CONFIG,
  DEFAULT_DREAM_AGENT_MODEL,
  DEFAULT_DREAM_AGENT_TIMEOUT_MS,
  DEFAULT_DREAM_AGENT_IDLE_WATCHDOG_MS,
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

  test("SessionEnd tail defaults to sixty seconds and accepts an override", () => {
    expect(DEFAULT_CONFIG.sessionEndTailTimeoutMs).toBe(60_000);

    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ sessionEndTailTimeoutMs: 90_000 }),
    );

    expect(loadConfig(home).sessionEndTailTimeoutMs).toBe(90_000);
  });

  test("hard-exit backstop defaults to seventy seconds and accepts an override", () => {
    expect(DEFAULT_CONFIG.hardExitTimeoutMs).toBe(70_000);

    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ hardExitTimeoutMs: 80_000 }),
    );

    expect(loadConfig(home).hardExitTimeoutMs).toBe(80_000);
  });

  test("loadConfig clamps the hard-exit timeout into [1s, 5m]", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ hardExitTimeoutMs: 1 }),
    );
    expect(loadConfig(home).hardExitTimeoutMs).toBe(1_000);

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ hardExitTimeoutMs: 999_999 }),
    );
    expect(loadConfig(home).hardExitTimeoutMs).toBe(300_000);
  });

  test("extraction stall watchdog defaults to sixty seconds and accepts an override", () => {
    expect(DEFAULT_CONFIG.stallThresholdMs).toBe(60_000);

    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ stallThresholdMs: 90_000 }),
    );

    expect(loadConfig(home).stallThresholdMs).toBe(90_000);
  });

  test("loadConfig clamps the extraction stall threshold into [1s, 5m]", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ stallThresholdMs: 1 }),
    );
    expect(loadConfig(home).stallThresholdMs).toBe(1_000);

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ stallThresholdMs: 999_999 }),
    );
    expect(loadConfig(home).stallThresholdMs).toBe(300_000);
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

  test("loads tier aliases and a literal dream-agent model pin", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    const warnings: string[] = [];

    for (const model of ["opus", "sonnet", "haiku"]) {
      writeFileSync(
        `${home}/.claude-mnemo/config.json`,
        JSON.stringify({ dreamAgentModel: model }),
      );
      expect(loadConfig(home, { warn: (message) => warnings.push(message) }).dreamAgentModel)
        .toBe(model);
    }

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ dreamAgentModel: "claude-sonnet-5" }),
    );
    expect(loadConfig(home, { warn: (message) => warnings.push(message) }).dreamAgentModel)
      .toBe("claude-sonnet-5");
    expect(warnings).toEqual([]);
  });

  test("defaults to opus and warns while falling back for an invalid model", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    const warnings: string[] = [];

    expect(DEFAULT_DREAM_AGENT_MODEL).toBe("opus");

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

  test("dream scheduling defaults to 04:00 Asia/Shanghai and enqueues only the latest day", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      dreamAgentHour: 4,
      dreamAgentTimeZone: "Asia/Shanghai",
      dreamAgentBacklogLimit: 1,
    });
  });

  test("the dream agent is off by default and only a real boolean enables it", () => {
    expect(DEFAULT_CONFIG.dreamAgentEnabled).toBe(false);
    expect(loadConfig("/definitely-missing").dreamAgentEnabled).toBe(false);

    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ dreamAgentEnabled: true }),
    );
    expect(loadConfig(home).dreamAgentEnabled).toBe(true);

    // A hand-written truthy non-boolean must not switch the agent back on.
    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ dreamAgentEnabled: "true" }),
    );
    expect(loadConfig(home).dreamAgentEnabled).toBe(false);
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

  test("dream idle watchdog defaults to ten minutes, accepts an override, and clamps", () => {
    expect(DEFAULT_DREAM_AGENT_IDLE_WATCHDOG_MS).toBe(600_000);
    expect(DEFAULT_CONFIG.dreamAgentIdleWatchdogMs).toBe(600_000);

    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ dreamAgentIdleWatchdogMs: 900_000 }),
    );
    expect(loadConfig(home).dreamAgentIdleWatchdogMs).toBe(900_000);

    // Below the 30s floor clamps up; above the 1h ceiling clamps down.
    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ dreamAgentIdleWatchdogMs: 1_000 }),
    );
    expect(loadConfig(home).dreamAgentIdleWatchdogMs).toBe(30_000);

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ dreamAgentIdleWatchdogMs: 999_999_999 }),
    );
    expect(loadConfig(home).dreamAgentIdleWatchdogMs).toBe(3_600_000);
  });

  test("eraCutoffEpoch defaults to null and only accepts a positive whole epoch", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });

    // The default is what makes ticket 08's rendering work inert in production:
    // null means every turn stays on the legacy path.
    expect(DEFAULT_CONFIG.eraCutoffEpoch).toBeNull();

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ eraCutoffEpoch: 1_900_000_000 }),
    );
    expect(loadConfig(home).eraCutoffEpoch).toBe(1_900_000_000);

    // 0, a float, a string and null all read as "no era yet" — an epoch of 0
    // would silently put the WHOLE history on the new path.
    for (const value of [0, -1, 1.5, "1900000000", null]) {
      writeFileSync(
        `${home}/.claude-mnemo/config.json`,
        JSON.stringify({ eraCutoffEpoch: value }),
      );
      expect(loadConfig(home).eraCutoffEpoch).toBeNull();
    }
  });
});
