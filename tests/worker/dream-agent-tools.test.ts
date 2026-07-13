import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DreamMemoryStore } from "../../src/diary/memory-store";
import { createDreamCommitToolHandler } from "../../src/worker/dream-agent-tools";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("dream commit tool", () => {
  test("exposes one path-free handler for the complete nightly transaction", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-dream-tool-"));
    roots.push(dataRoot);
    const store = new DreamMemoryStore(dataRoot);
    const commit = createDreamCommitToolHandler(store);

    const result = await commit({
      date: "2026-07-10",
      userProfile: "# Profile\n\n- current\n",
      experience: "# Experience\n\n- current\n",
      archive: "# Archive\n",
      diary: "# 2026-07-10\n\n- event\n",
      diaryIndex: "# Diary Index\n\n- 2026-07-10: event\n",
    });

    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "committed",
      last_successful_date: "2026-07-10",
      snapshot_id: expect.any(String),
    });
    expect(await store.readLastSuccessfulDate()).toBe("2026-07-10");
  });

  test("rejects missing, non-string, or path-bearing arguments", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-dream-tool-input-"));
    roots.push(dataRoot);
    const commit = createDreamCommitToolHandler(new DreamMemoryStore(dataRoot));
    const valid = {
      date: "2026-07-10",
      userProfile: "# Profile\n",
      experience: "# Experience\n",
      archive: "# Archive\n",
      diary: "# Diary\n",
      diaryIndex: "# Index\n",
    };

    await expect(commit({ ...valid, archive: 42 })).rejects.toThrow("archive");
    await expect(commit({ ...valid, outputPath: "../escape" })).rejects.toThrow(
      "unsupported",
    );
  });
});
