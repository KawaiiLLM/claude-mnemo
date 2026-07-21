import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  type CommitNightInput,
  type DreamMemoryStore,
} from "../diary/memory-store";

/**
 * Per-run staging workspace under the data root. The dream agent's Write/Edit
 * tools are scoped to this subtree; the payload-free commit reads the five
 * documents back from here instead of from tool arguments. Kept outside the
 * live `memory/` and `diary/` subtrees (leading dot) so it never leaks into the
 * agent's read/grep history scope and never becomes a commit target.
 *
 * The date-keyed (not run-unique) directory is safe because production drains
 * the dream queue serially: `server.ts` claims one item at a time via
 * `claimNextDiaryItem`, and the atomic claim prevents a date from being
 * processed twice concurrently, so two runs never share this directory.
 */
export const DREAM_STAGING_DIRNAME = ".dream-staging";

export interface DreamStagingPaths {
  /** Absolute root of this run's staging workspace. */
  root: string;
  userProfile: string;
  archive: string;
  diary: string;
  diaryIndex: string;
}

export function dreamStagingPaths(dataRoot: string, date: string): DreamStagingPaths {
  const root = join(dataRoot, DREAM_STAGING_DIRNAME, date);
  return {
    root,
    userProfile: join(root, "memory", "user-profile.md"),
    archive: join(root, "memory", "archive.md"),
    diary: join(root, "diary", `${date}.md`),
    diaryIndex: join(root, "diary", "INDEX.md"),
  };
}

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

/**
 * Confirms the staging root stays beneath dataRoot — lexically AND after
 * symlink resolution. The staging directory drives a destructive recursive
 * `rm` (seed + cleanup) and receives the agent's writes; if `.dream-staging`
 * (or the date subdir) were a symlink escaping dataRoot, all three would
 * operate outside dataRoot. This is the interposition point that closes that
 * escape, guarding both the destructive cleanup and the write-permission guard.
 */
export async function assertStagingRootWithinDataRoot(
  dataRoot: string,
  stagingRoot: string,
): Promise<void> {
  const resolvedDataRoot = resolve(dataRoot);
  const resolvedStaging = resolve(stagingRoot);
  if (!isWithin(resolvedDataRoot, resolvedStaging)) {
    throw new Error(`Dream staging root is outside the data root: ${stagingRoot}`);
  }

  // A missing dataRoot means nothing beneath it exists yet, so no escape is
  // possible; resolve what exists and check each present component stays in.
  const realDataRoot = await realpath(resolvedDataRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolvedDataRoot;
    throw error;
  });
  for (const path of [join(resolvedDataRoot, DREAM_STAGING_DIRNAME), resolvedStaging]) {
    let real: string;
    try {
      real = await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!isWithin(realDataRoot, real)) {
      throw new Error(
        `Dream staging root escapes the data root via a symlink: ${path}`,
      );
    }
  }
}

async function readOrDefault(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

/**
 * Reads a memory document that seeding always writes. A missing file at
 * commit-read time is an anomaly (the agent or filesystem removed a seeded
 * doc), NOT a legitimate new document, so it fails CLOSED: publishing an empty
 * scaffold here would pass validation and silently erase the live memory layer.
 */
async function readSeededMemoryDoc(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Staged memory document ${label} is missing at commit time; refusing to publish an empty document that would erase live memory: ${path}`,
      );
    }
    throw error;
  }
}

/**
 * Seeds the staging workspace with copies of the current effective memory
 * documents and the day's diary draft (empty scaffold when the day is new).
 * The agent edits these copies in place; the live documents stay untouched
 * until the atomic publish, so a mid-run watchdog kill leaves memory intact.
 */
export async function seedDreamStaging(options: {
  dataRoot: string;
  date: string;
  store: Pick<DreamMemoryStore, "readCurrentMemory">;
}): Promise<DreamStagingPaths> {
  const paths = dreamStagingPaths(options.dataRoot, options.date);
  await assertStagingRootWithinDataRoot(options.dataRoot, paths.root);
  await rm(paths.root, { recursive: true, force: true });
  await Promise.all([
    mkdir(join(paths.root, "memory"), { recursive: true }),
    mkdir(join(paths.root, "diary"), { recursive: true }),
  ]);

  const memory = await options.store.readCurrentMemory();
  const [diaryDraft, diaryIndex] = await Promise.all([
    readOrDefault(
      join(options.dataRoot, "diary", `${options.date}.md`),
      `# ${options.date}\n`,
    ),
    readOrDefault(join(options.dataRoot, "diary", "INDEX.md"), "# Diary Index\n"),
  ]);

  await Promise.all([
    writeFile(paths.userProfile, memory.userProfile),
    writeFile(paths.archive, memory.archive),
    writeFile(paths.diary, diaryDraft),
    writeFile(paths.diaryIndex, diaryIndex),
  ]);

  return paths;
}

/**
 * Reads the five documents the agent produced back out of the staging
 * workspace and assembles the CommitNightInput consumed by the unchanged
 * `commitNight` transaction. The three memory documents fail CLOSED (a missing
 * seeded file throws) so a commit can never silently erase live memory; the
 * diary day-file and INDEX keep a sensible default (a fresh day is legitimate).
 */
export async function readDreamStaging(options: {
  dataRoot: string;
  date: string;
}): Promise<CommitNightInput> {
  const paths = dreamStagingPaths(options.dataRoot, options.date);
  const [userProfile, archive, diary, diaryIndex] = await Promise.all([
    readSeededMemoryDoc(paths.userProfile, "user-profile.md"),
    readSeededMemoryDoc(paths.archive, "archive.md"),
    readOrDefault(paths.diary, `# ${options.date}\n`),
    readOrDefault(paths.diaryIndex, "# Diary Index\n"),
  ]);
  return { date: options.date, userProfile, archive, diary, diaryIndex };
}

export async function cleanupDreamStaging(
  dataRoot: string,
  date: string,
): Promise<void> {
  const paths = dreamStagingPaths(dataRoot, date);
  try {
    // Never let the destructive recursive rm follow a `.dream-staging` symlink
    // outside dataRoot; on any containment anomaly, refuse to remove anything.
    await assertStagingRootWithinDataRoot(dataRoot, paths.root);
  } catch {
    return;
  }
  await rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
}
