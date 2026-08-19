import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CONFIG,
  DEFAULT_DREAM_AGENT_MODEL,
  DEFAULT_DREAM_AGENT_TIMEOUT_MS,
  DEFAULT_DREAM_AGENT_IDLE_WATCHDOG_MS,
  DEFAULT_NOTE_SETTLEMENT_MODEL,
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
      JSON.stringify({ hardExitTimeoutMs: 65_000 }),
    );

    expect(loadConfig(home)).toEqual({
      ...DEFAULT_CONFIG,
      hardExitTimeoutMs: 65_000,
    });
  });

  test("loadConfig falls back to defaults when the file is invalid", async () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    writeFileSync(`${home}/.claude-mnemo/config.json`, "{not-json");

    expect(loadConfig(home)).toEqual(DEFAULT_CONFIG);
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

  // Ticket 02 ([S15069/T1017]): settlement's window range, backfill cap and
  // model move into config — one home per number in shared/config.ts, with
  // db/note-settlement.ts and worker/note-settlement-dispatch.ts re-exporting
  // the defaults so every existing import path stays valid.

  test("note settlement window sizes default to 25/50/100 and clamp into their bounds", () => {
    expect(DEFAULT_CONFIG.noteSettlementThresholdTurns).toBe(25);
    expect(DEFAULT_CONFIG.noteSettlementCapTurns).toBe(50);
    expect(DEFAULT_CONFIG.noteSettlementBackfillMaxTurns).toBe(100);

    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    const warnings: string[] = [];

    // Threshold and cap clamp to the SAME 500 ceiling here, so the coherence
    // pass sees them equal and stays quiet — this case is about the plain
    // [min,max] clamp alone, not the cap/threshold reconciliation below.
    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({
        noteSettlementThresholdTurns: 5_000,
        noteSettlementCapTurns: 5_000,
        noteSettlementBackfillMaxTurns: 50_000,
      }),
    );
    expect(loadConfig(home, { warn: (message) => warnings.push(message) })).toMatchObject({
      noteSettlementThresholdTurns: 500,
      noteSettlementCapTurns: 500,
      noteSettlementBackfillMaxTurns: 10_000,
    });
    expect(warnings).toEqual([]);

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({
        noteSettlementThresholdTurns: 0,
        noteSettlementCapTurns: 0,
        noteSettlementBackfillMaxTurns: 0,
      }),
    );
    expect(loadConfig(home)).toMatchObject({
      noteSettlementThresholdTurns: 1,
      noteSettlementCapTurns: 1,
      noteSettlementBackfillMaxTurns: 1,
    });
  });

  test("junk threshold and backfill-cap values normalize per the plain clampInteger idiom, no warn", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    const warnings: string[] = [];

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({
        // A string number is not a number: falls back to the default whole,
        // same as every other clampInteger field (e.g. hardExitTimeoutMs) —
        // clampInteger itself never warns, so neither does this.
        noteSettlementThresholdTurns: "25",
        // A real negative integer clamps to the floor rather than falling
        // back to the default.
        noteSettlementBackfillMaxTurns: -5,
      }),
    );
    expect(loadConfig(home, { warn: (message) => warnings.push(message) })).toMatchObject({
      noteSettlementThresholdTurns: 25,
      // Untouched default; still >= the fallback threshold, so the
      // cap/threshold coherence pass below has nothing to reconcile here.
      noteSettlementCapTurns: 50,
      noteSettlementBackfillMaxTurns: 1,
    });
    expect(warnings).toEqual([]);
  });

  test("a cap clamped below its threshold is raised to match, with a warn naming both keys", () => {
    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    const warnings: string[] = [];

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({
        noteSettlementThresholdTurns: 40,
        noteSettlementCapTurns: 10,
      }),
    );
    expect(loadConfig(home, { warn: (message) => warnings.push(message) })).toMatchObject({
      noteSettlementThresholdTurns: 40,
      noteSettlementCapTurns: 40,
    });
    expect(warnings).toEqual([
      "[claude-mnemo] noteSettlementCapTurns (10) is below noteSettlementThresholdTurns (40); raising the cap to match.",
    ]);
  });

  test("noteSettlementModel defaults to claude-sonnet-5, accepts a literal pin, and warns while falling back for an unknown one", () => {
    expect(DEFAULT_NOTE_SETTLEMENT_MODEL).toBe("claude-sonnet-5");
    expect(DEFAULT_CONFIG.noteSettlementModel).toBe("claude-sonnet-5");

    const home = mkdtempSync(join(tmpdir(), "mnemo-config-"));
    mkdirSync(`${home}/.claude-mnemo`, { recursive: true });
    const warnings: string[] = [];

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ noteSettlementModel: "claude-haiku-4-5" }),
    );
    expect(
      loadConfig(home, { warn: (message) => warnings.push(message) }).noteSettlementModel,
    ).toBe("claude-haiku-4-5");
    expect(warnings).toEqual([]);

    writeFileSync(
      `${home}/.claude-mnemo/config.json`,
      JSON.stringify({ noteSettlementModel: "future-model-alias" }),
    );
    expect(
      loadConfig(home, { warn: (message) => warnings.push(message) }).noteSettlementModel,
    ).toBe(DEFAULT_NOTE_SETTLEMENT_MODEL);
    expect(warnings).toEqual([
      `[claude-mnemo] Invalid noteSettlementModel "future-model-alias"; using ${DEFAULT_NOTE_SETTLEMENT_MODEL}.`,
    ]);
  });
});
