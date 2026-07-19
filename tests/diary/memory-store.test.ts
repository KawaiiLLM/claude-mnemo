import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DreamMemoryStore,
  EMPTY_EXPERIENCE_DOCUMENT,
  EMPTY_PROFILE_DOCUMENT,
  MEMORY_DOCUMENT_TOKEN_LIMIT,
} from "../../src/diary/memory-store";
import { estimateDiaryTokens } from "../../src/diary/domain";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function night(date: string, suffix: string) {
  return {
    date,
    userProfile: `# Profile\n\n- profile ${suffix}\n`,
    experience: `# Experience\n\n- experience ${suffix}\n`,
    archive: `# Archive\n\n- archive ${suffix}\n`,
    diary: `# ${date}\n\n- diary ${suffix}\n`,
    diaryIndex: `# Diary Index\n\n- ${date}: ${suffix}\n`,
  };
}

describe("DreamMemoryStore", () => {
  test("publishes diary index entries recent-first", async () => {
    const dataRoot = createRoot("claude-mnemo-dream-index-order-");
    const store = new DreamMemoryStore(dataRoot);

    await store.commitNight({
      ...night("2026-07-10", "index order"),
      diaryIndex: [
        "# Diary Index",
        "",
        "- 2026-07-08: older",
        "- 2026-07-10: newest",
        "- 2026-07-09: middle",
        "",
      ].join("\n"),
    });

    expect(readFileSync(join(dataRoot, "diary", "INDEX.md"), "utf8")).toBe(
      [
        "# Diary Index",
        "",
        "- 2026-07-10: newest",
        "- 2026-07-09: middle",
        "- 2026-07-08: older",
        "",
      ].join("\n"),
    );
  });

  test("keeps the success watermark monotonic when an older failed day later succeeds", async () => {
    const dataRoot = createRoot("claude-mnemo-dream-marker-");
    const store = new DreamMemoryStore(dataRoot);

    await store.commitNight(night("2026-07-10", "newer"));
    await store.commitNight(night("2026-07-09", "late retry"));

    expect(await store.readLastSuccessfulDate()).toBe("2026-07-10");
    expect(readFileSync(join(dataRoot, "diary", "2026-07-09.md"), "utf8"))
      .toContain("late retry");
  });

  test("recovers every published document after a hard crash before the success marker", async () => {
    const dataRoot = createRoot("claude-mnemo-dream-crash-");
    const initialStore = new DreamMemoryStore(dataRoot);
    const prior = night("2026-07-10", "prior");
    await initialStore.commitNight(prior);
    const next = night("2026-07-11", "next");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        [
          'import { DreamMemoryStore } from "./src/diary/memory-store.ts";',
          `const store = new DreamMemoryStore(${JSON.stringify(dataRoot)}, {`,
          "  faultInjector(step) {",
          '    if (step === "before-success-marker") process.exit(73);',
          "  },",
          "});",
          `await store.commitNight(${JSON.stringify(next)});`,
        ].join("\n"),
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(73);

    // Any public read first recovers the durable transaction journal.
    const store = new DreamMemoryStore(dataRoot);

    expect(await store.readCurrentMemory()).toEqual({
      userProfile: prior.userProfile,
      experience: prior.experience,
      archive: prior.archive,
    });
    expect(readFileSync(join(dataRoot, "diary", "2026-07-10.md"), "utf8")).toBe(
      prior.diary,
    );
    expect(existsSync(join(dataRoot, "diary", "2026-07-11.md"))).toBe(false);
    expect(readFileSync(join(dataRoot, "diary", "INDEX.md"), "utf8")).toBe(
      prior.diaryIndex,
    );
    expect(await store.readLastSuccessfulDate()).toBe("2026-07-10");

    const failedSnapshot = (await store.listSnapshots()).find(
      (snapshot) => snapshot.date === "2026-07-11",
    );
    expect(failedSnapshot).toBeDefined();
    const verified = await store.verifySnapshot(failedSnapshot!.id);
    expect(verified.documents).toEqual({
      userProfile: prior.userProfile,
      experience: prior.experience,
      archive: prior.archive,
    });
  });

  test("does not size-gate hot-memory documents at commit (over-target publishes fine)", async () => {
    const dataRoot = createRoot("claude-mnemo-dream-limit-");
    const store = new DreamMemoryStore(dataRoot);
    const prior = night("2026-07-10", "prior");
    await store.commitNight(prior);
    const overTarget = `# Profile\n\n${"汉".repeat(4_000)}\n`;
    expect(estimateDiaryTokens(overTarget)).toBeGreaterThan(
      MEMORY_DOCUMENT_TOKEN_LIMIT,
    );

    await store.commitNight({
      ...night("2026-07-11", "over target"),
      userProfile: overTarget,
    });

    expect((await store.readCurrentMemory()).userProfile).toBe(overTarget);
    expect(await store.readLastSuccessfulDate()).toBe("2026-07-11");
  });

  test("lists and hash-verifies snapshots, then atomically restores one as current", async () => {
    const dataRoot = createRoot("claude-mnemo-dream-restore-");
    const store = new DreamMemoryStore(dataRoot);
    const first = night("2026-07-10", "first");
    const second = night("2026-07-11", "second");
    await store.commitNight(first);
    await store.commitNight(second);

    const snapshots = await store.listSnapshots();
    const preSecond = snapshots.find((snapshot) => snapshot.date === second.date);
    expect(preSecond).toBeDefined();
    expect((await store.verifySnapshot(preSecond!.id)).documents).toEqual({
      userProfile: first.userProfile,
      experience: first.experience,
      archive: first.archive,
    });

    await store.restoreSnapshot(preSecond!.id);

    expect(await store.readCurrentMemory()).toEqual({
      userProfile: first.userProfile,
      experience: first.experience,
      archive: first.archive,
    });
  });

  test("rejects a tampered snapshot instead of restoring it", async () => {
    const dataRoot = createRoot("claude-mnemo-dream-snapshot-hash-");
    const store = new DreamMemoryStore(dataRoot);
    await store.commitNight(night("2026-07-10", "current"));
    const snapshot = (await store.listSnapshots())[0]!;
    writeFileSync(
      join(dataRoot, "memory", "history", snapshot.id, "user-profile.md"),
      "# tampered\n",
    );

    await expect(store.verifySnapshot(snapshot.id)).rejects.toThrow("hash mismatch");
    await expect(store.restoreSnapshot(snapshot.id)).rejects.toThrow("hash mismatch");
  });

  test("migrates the published legacy generation without rewriting it", async () => {
    const dataRoot = createRoot("claude-mnemo-dream-migration-");
    const generationRoot = join(dataRoot, "persona", "generations", "3");
    mkdirSync(generationRoot, { recursive: true });
    const userProfile = "# Legacy Profile\n\n- exact profile bytes\n";
    const experience = `# Legacy Experience\n\n${"汉".repeat(4_000)}\n`;
    const manifest = `${JSON.stringify({
      generation: 3,
      operation_id: "legacy-three",
      user_profile_sha256: createHash("sha256").update(userProfile).digest("hex"),
      experience_sha256: createHash("sha256").update(experience).digest("hex"),
    }, null, 2)}\n`;
    writeFileSync(join(generationRoot, "manifest.json"), manifest);
    writeFileSync(join(generationRoot, "user-profile.md"), userProfile);
    writeFileSync(join(generationRoot, "experience.md"), experience);
    writeFileSync(join(dataRoot, "persona", "CURRENT"), manifest);

    const store = new DreamMemoryStore(dataRoot);
    expect(await store.migrateLegacyPersona()).toEqual({
      status: "migrated",
      generation: 3,
    });
    expect(await store.readCurrentMemory()).toEqual({
      userProfile,
      experience,
      archive: "# Memory Archive\n",
    });
    expect(existsSync(join(dataRoot, "persona", "CURRENT"))).toBe(false);
    expect(existsSync(join(dataRoot, "persona", "generations"))).toBe(false);
    expect(await store.requiresInitialFullFill()).toBe(false);
  });

  test("cold-starts with durable empty documents when no legacy publication exists", async () => {
    const dataRoot = createRoot("claude-mnemo-dream-cold-start-");
    const warnings: string[] = [];
    const store = new DreamMemoryStore(dataRoot, {
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    });

    expect(await store.migrateLegacyPersona()).toEqual({
      status: "empty",
      reason: "legacy-current-unavailable",
    });
    expect(await store.readCurrentMemory()).toEqual({
      userProfile: EMPTY_PROFILE_DOCUMENT,
      experience: EMPTY_EXPERIENCE_DOCUMENT,
      archive: "# Memory Archive\n",
    });
    expect(await store.requiresInitialFullFill()).toBe(true);
    expect(warnings).toHaveLength(1);

    await store.commitNight(night("2026-07-10", "first fill"));
    expect(await store.requiresInitialFullFill()).toBe(false);
  });

  test("refuses an unsafe legacy root instead of deleting through it", async () => {
    const dataRoot = createRoot("claude-mnemo-dream-unsafe-legacy-");
    const outsideRoot = createRoot("claude-mnemo-dream-unsafe-outside-");
    writeFileSync(join(outsideRoot, "sentinel"), "keep");
    symlinkSync(outsideRoot, join(dataRoot, "persona"));

    await expect(new DreamMemoryStore(dataRoot).migrateLegacyPersona())
      .rejects.toThrow("Legacy persona root must be a real directory");
    expect(readFileSync(join(outsideRoot, "sentinel"), "utf8")).toBe("keep");
  });

  test("keeps the configured newest snapshots plus one rollup per older month", async () => {
    const dataRoot = createRoot("claude-mnemo-dream-retention-");
    let now = Date.parse("2026-04-02T04:00:00.000Z");
    const store = new DreamMemoryStore(dataRoot, {
      now: () => new Date(now++),
      retention: { newest: 2, monthly: true },
    });
    expect(new DreamMemoryStore(dataRoot).retention).toEqual({
      newest: 30,
      monthly: true,
    });
    for (const date of [
      "2026-01-01",
      "2026-01-02",
      "2026-02-01",
      "2026-02-02",
      "2026-03-01",
      "2026-03-02",
    ]) {
      await store.commitNight(night(date, date));
    }

    const dates = (await store.listSnapshots()).map((snapshot) => snapshot.date);
    expect(dates).toEqual([
      "2026-03-02",
      "2026-03-01",
      "2026-02-02",
      "2026-01-02",
    ]);
  });
});
