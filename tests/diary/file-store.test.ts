import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { DiaryFileStore } from "../../src/diary/file-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("DiaryFileStore", () => {
  test("commits canonical diary bytes at the dated path and reads them unchanged", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-diary-files-"));
    roots.push(dataRoot);
    const store = new DiaryFileStore(dataRoot);
    const canonicalBytes = new TextEncoder().encode(
      "---\ndate: 2026-07-10\n---\n\n今天完成了原子发布。\n",
    );

    await store.commitDiary("2026-07-10", canonicalBytes);

    expect(await store.readDiary("2026-07-10")).toEqual(canonicalBytes);
    expect(readFileSync(join(dataRoot, "diary", "2026-07-10.md"))).toEqual(
      canonicalBytes,
    );
  });

  test("rejects path traversal dates without reading or writing outside the diary directory", async () => {
    const parent = mkdtempSync(join(tmpdir(), "claude-mnemo-diary-safety-"));
    roots.push(parent);
    const dataRoot = join(parent, "data");
    mkdirSync(dataRoot);
    const escapedInsideDataRoot = join(dataRoot, "escape.md");
    const escapedOutsideDataRoot = join(parent, "escape.md");
    writeFileSync(escapedInsideDataRoot, "private sibling file");
    const store = new DiaryFileStore(dataRoot);

    await expect(store.readDiary("../escape")).rejects.toThrow();
    unlinkSync(escapedInsideDataRoot);
    await expect(
      store.commitDiary("../escape", new TextEncoder().encode("unsafe")),
    ).rejects.toThrow();

    expect(existsSync(escapedInsideDataRoot)).toBe(false);
    expect(existsSync(escapedOutsideDataRoot)).toBe(false);
  });

  test("reads a structurally valid diary only while its committed bytes match the expected hash", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-diary-validate-"));
    roots.push(dataRoot);
    const store = new DiaryFileStore(dataRoot);
    const canonicalBytes = new TextEncoder().encode(
      [
        "---",
        'date: "2026-07-10"',
        "format: 2",
        'sessions: ["S4580"]',
        'projects: ["/path/a"]',
        'watermark: "a3f9c2e18b04d7f6"',
        'index_hook: "钢琴节奏轴重设计定案"',
        "---",
        "## 工作",
        "- 完成了原子发布 [S4580/T1]",
        "## 人物",
        "- 偏好可验证的交付 [S4580/T1]",
        "## 反思",
        "- 先红后绿很有效 [S4580/T1]",

        "- 无",
        "",
      ].join("\n"),
    );
    const fileSha256 = createHash("sha256")
      .update(canonicalBytes)
      .digest("hex");
    const expectedState = {
      date: "2026-07-10",
      watermark: "a3f9c2e18b04d7f6",
      indexHook: "钢琴节奏轴重设计定案",
      fileSha256,
    };
    await store.commitDiary(expectedState.date, canonicalBytes);

    expect(await store.readValidatedDiary(expectedState)).toEqual(
      canonicalBytes,
    );

    writeFileSync(
      join(dataRoot, "diary", "2026-07-10.md"),
      new TextDecoder().decode(canonicalBytes).replace("- 无", "- 已被篡改"),
    );
    await expect(store.readValidatedDiary(expectedState)).rejects.toThrow();
  });

  test("ensures a canonical diary index from live day-state rows", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-diary-index-"));
    roots.push(dataRoot);
    const store = new DiaryFileStore(dataRoot);
    const rows = [
      { date: "2026-07-08", indexHook: "旧 hook" },
      { date: "2026-07-09", indexHook: null },
      { date: "2026-07-10", indexHook: "新 hook" },
    ];
    const canonicalBytes = new TextEncoder().encode(
      "# Diary Index\n- 2026-07-10：新 hook\n- 2026-07-08：旧 hook\n",
    );

    await store.ensureIndex(rows);

    expect(await store.readIndex()).toEqual(canonicalBytes);
    expect(await store.ensureIndex(rows)).toEqual(canonicalBytes);
    expect(await store.readIndex()).toEqual(canonicalBytes);
  });

  test("rejects a symlinked diary root before reading or writing its external target", async () => {
    const parent = mkdtempSync(join(tmpdir(), "claude-mnemo-diary-symlink-"));
    roots.push(parent);
    const dataRoot = join(parent, "data");
    const externalRoot = join(parent, "external");
    mkdirSync(dataRoot);
    mkdirSync(externalRoot);
    symlinkSync(externalRoot, join(dataRoot, "diary"));
    const externalDiaryPath = join(externalRoot, "2026-07-10.md");
    writeFileSync(externalDiaryPath, "external sentinel");
    const store = new DiaryFileStore(dataRoot);

    await expect(store.readDiary("2026-07-10")).rejects.toThrow();
    await expect(
      store.commitDiary(
        "2026-07-10",
        new TextEncoder().encode("must not escape"),
      ),
    ).rejects.toThrow();

    expect(readFileSync(externalDiaryPath, "utf8")).toBe("external sentinel");
  });

  test("rejects a dated diary symlink instead of reading its external target", async () => {
    const parent = mkdtempSync(join(tmpdir(), "claude-mnemo-diary-file-link-"));
    roots.push(parent);
    const dataRoot = join(parent, "data");
    const diaryRoot = join(dataRoot, "diary");
    mkdirSync(diaryRoot, { recursive: true });
    const externalDiaryPath = join(parent, "external-diary.md");
    writeFileSync(externalDiaryPath, "external diary secret");
    symlinkSync(externalDiaryPath, join(diaryRoot, "2026-07-10.md"));
    const store = new DiaryFileStore(dataRoot);

    await expect(store.readDiary("2026-07-10")).rejects.toThrow();

    expect(readFileSync(externalDiaryPath, "utf8")).toBe(
      "external diary secret",
    );
  });

  test("rejects INDEX access through a symlinked diary root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "claude-mnemo-index-root-link-"));
    roots.push(parent);
    const dataRoot = join(parent, "data");
    const externalRoot = join(parent, "external-index-root");
    mkdirSync(dataRoot);
    mkdirSync(externalRoot);
    const externalIndex = join(externalRoot, "INDEX.md");
    writeFileSync(externalIndex, "external index sentinel");
    symlinkSync(externalRoot, join(dataRoot, "diary"));
    const store = new DiaryFileStore(dataRoot);

    await expect(store.readIndex()).rejects.toThrow();
    await expect(
      store.ensureIndex([{ date: "2026-07-10", indexHook: "must not escape" }]),
    ).rejects.toThrow();

    expect(readFileSync(externalIndex, "utf8")).toBe("external index sentinel");
  });

  test("publishes and loads one complete persona generation through CURRENT", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-files-"));
    roots.push(dataRoot);
    const store = new DiaryFileStore(dataRoot);
    const manifest = {
      operation_id: "operation-1",
      op: "fold",
      generation: 1,
      source_diary_date: "2026-07-10",
      last_folded_date_after: "2026-07-10",
      folds_since_rebase_after: 1,
      consumed_pending_dates: [],
      partial_missing_dates_after: [],
    };
    const userProfile = "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 偏好证据充分的实现 [2026-07-10]\n";
    const experience = "## 项目\n## 通用\n- 我应先验证再总结 [2026-07-10]\n";

    await store.commitPersonaGeneration({
      generation: 1,
      manifest,
      userProfile,
      experience,
    });

    expect(await store.loadCurrentPersona()).toMatchObject({
      generation: 1,
      manifest,
      userProfile,
      experience,
    });
    const generationRoot = join(dataRoot, "persona", "generations", "1");
    expect(readFileSync(join(generationRoot, "user-profile.md"), "utf8")).toBe(
      userProfile,
    );
    expect(readFileSync(join(generationRoot, "experience.md"), "utf8")).toBe(experience);
    expect(
      JSON.parse(readFileSync(join(generationRoot, "manifest.json"), "utf8")),
    ).toMatchObject({
      ...manifest,
      user_profile_sha256: expect.any(String),
      experience_sha256: expect.any(String),
    });
    expect(JSON.parse(readFileSync(join(dataRoot, "persona", "CURRENT"), "utf8")))
      .toMatchObject({
        ...manifest,
        user_profile_sha256: expect.any(String),
        experience_sha256: expect.any(String),
      });
  });

  test("rejects tampering of either persona generation body", async () => {
    for (const file of ["user-profile.md", "experience.md"]) {
      const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-hash-"));
      roots.push(dataRoot);
      const store = new DiaryFileStore(dataRoot);
      await store.commitPersonaGeneration({
        generation: 1,
        manifest: { generation: 1 },
        userProfile: "profile",
        experience: "experience",
      });
      writeFileSync(join(dataRoot, "persona", "generations", "1", file), "tampered");
      await expect(store.loadCurrentPersona()).rejects.toThrow("hash mismatch");
      await expect(store.loadPersonaGeneration(1)).rejects.toThrow("hash mismatch");
    }
  });
});
