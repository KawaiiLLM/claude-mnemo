import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { createDiaryStateStore } from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";
import { compileDiaryDocument } from "../../src/diary/domain";
import { DiaryFileStore } from "../../src/diary/file-store";
import { verifySettledDiaries } from "../../src/diary/verify";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("verifySettledDiaries", () => {
  test("validates every settled diary and marks corrupt state stale", async () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-verify-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);

    for (const [date, hook] of [
      ["2026-07-09", "valid"],
      ["2026-07-10", "corrupt"],
    ] as const) {
      const watermark = `watermark-${date}`;
      const bytes = compileDiaryDocument({
        date,
        sessions: ["S1"],
        projects: ["/project"],
        watermark,
        indexHook: hook,
        body: [
          "## 工作",
          "- 已验证 [S1/T1]",
          "## 人物",
          "- 已验证人物信号 [S1/T1]",
          "## 反思",
          "- 已验证反思 [S1/T1]",
        ].join("\n"),
      });
      stateStore.enqueueDay({ date, enqueuedAtEpoch: 1 });
      await fileStore.commitDiary(date, bytes);
      stateStore.commitDayState({
        date,
        watermark,
        fileSha256: createHash("sha256").update(bytes).digest("hex"),
        indexHook: hook,
        settledAtEpoch: 2,
        pendingRebase: false,
      });
    }

    writeFileSync(join(dataRoot, "diary", "2026-07-10.md"), "tampered");

    const result = await verifySettledDiaries({ stateStore, fileStore });

    expect(result).toEqual({ checked: 2, valid: 1, invalid: ["2026-07-10"] });
    expect(stateStore.getDayState("2026-07-09")?.needsRegen).toBe(false);
    expect(stateStore.getDayState("2026-07-10")?.needsRegen).toBe(true);
    expect(stateStore.hasQueuedDay("2026-07-10")).toBe(true);
    db.close();
  });
});
