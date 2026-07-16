import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DreamMemoryStore, type CommitNightInput } from "../../src/diary/memory-store";
import { createDreamCommitToolHandler } from "../../src/worker/dream-agent-tools";
import { seedDreamStaging, readDreamStaging } from "../../src/worker/dream-staging";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function stagedNight(overrides: Partial<CommitNightInput> = {}): CommitNightInput {
  return {
    date: "2026-07-10",
    userProfile: "# Profile\n\n- current\n",
    experience: "# Experience\n\n- current\n",
    archive: "# Archive\n",
    diary: "# 2026-07-10\n\n- event\n",
    diaryIndex: "# Diary Index\n\n- 2026-07-10: event\n",
    ...overrides,
  };
}

describe("dream commit tool", () => {
  test("payload-free commit reads the staging workspace and publishes one night", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-dream-tool-"));
    roots.push(dataRoot);
    const store = new DreamMemoryStore(dataRoot);
    const commit = createDreamCommitToolHandler(store, async () => stagedNight());

    const result = await commit({});

    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "committed",
      last_successful_date: "2026-07-10",
      snapshot_id: expect.any(String),
    });
    expect(await store.readLastSuccessfulDate()).toBe("2026-07-10");
  });

  test("commit reads documents seeded into and edited within staging", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-dream-tool-staging-"));
    roots.push(dataRoot);
    const store = new DreamMemoryStore(dataRoot);
    await seedDreamStaging({ dataRoot, date: "2026-07-10", store });

    const commit = createDreamCommitToolHandler(store, () =>
      readDreamStaging({ dataRoot, date: "2026-07-10" }),
    );
    await commit({});

    // Seeded staging is empty defaults; the commit publishes them verbatim.
    expect(await store.readCurrentMemory()).toEqual({
      userProfile: "# User Profile\n",
      experience: "# Experience\n",
      archive: "# Memory Archive\n",
    });
    expect(await store.readLastSuccessfulDate()).toBe("2026-07-10");
  });

  test("rejects any tool argument (commit is payload-free)", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-dream-tool-input-"));
    roots.push(dataRoot);
    const commit = createDreamCommitToolHandler(
      new DreamMemoryStore(dataRoot),
      async () => stagedNight(),
    );

    await expect(commit({ outputPath: "../escape" })).rejects.toThrow(
      "does not accept arguments",
    );
    await expect(commit({ diary: "# hijacked\n" })).rejects.toThrow(
      "does not accept arguments",
    );
  });

  test("commit fails closed when a seeded memory doc is missing at read time", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-dream-fail-closed-"));
    roots.push(dataRoot);
    const store = new DreamMemoryStore(dataRoot);
    // Establish a non-empty live memory layer so an erasure would be observable.
    await store.commitNight({
      date: "2026-07-09",
      userProfile: "# User Profile\n\n- durable trait [S1/T1]\n",
      experience: "# Experience\n\n- durable arc [S1/T1]\n",
      archive: "# Memory Archive\n",
      diary: "# 2026-07-09\n\n- prior\n",
      diaryIndex: "# Diary Index\n\n- 2026-07-09: prior\n",
    });

    const paths = await seedDreamStaging({ dataRoot, date: "2026-07-10", store });
    // A seeded memory doc vanishes before commit reads staging back.
    rmSync(paths.experience);
    const commit = createDreamCommitToolHandler(store, () =>
      readDreamStaging({ dataRoot, date: "2026-07-10" }),
    );

    await expect(commit({})).rejects.toThrow("missing at commit time");
    // No publish happened: the live memory layer and success marker are intact.
    expect(await store.readLastSuccessfulDate()).toBe("2026-07-09");
    expect((await store.readCurrentMemory()).experience).toContain("durable arc");
  });

  test("seed refuses to run when .dream-staging escapes the data root via a symlink", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-dream-escape-"));
    roots.push(dataRoot);
    const outside = mkdtempSync(join(tmpdir(), "claude-mnemo-dream-escape-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "keep.md"), "must survive");
    // A `.dream-staging` symlink pointing outside dataRoot would redirect the
    // destructive recursive rm; seeding must refuse rather than delete outside.
    symlinkSync(outside, join(dataRoot, ".dream-staging"));
    const store = new DreamMemoryStore(dataRoot);

    await expect(
      seedDreamStaging({ dataRoot, date: "2026-07-10", store }),
    ).rejects.toThrow("escapes the data root");
    expect(existsSync(join(outside, "keep.md"))).toBe(true);
  });
});
