import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface WorktreeInfo {
  isWorktree: boolean;
  gitDirectory: string;
  parentRepositoryPath: string | null;
}

export function getWorktreeInfo(cwd: string): WorktreeInfo {
  const gitPath = join(cwd, ".git");

  if (!existsSync(gitPath)) {
    return {
      isWorktree: false,
      gitDirectory: gitPath,
      parentRepositoryPath: null,
    };
  }

  const gitFile = readFileSync(gitPath, "utf8").trim();

  if (!gitFile.startsWith("gitdir:")) {
    return {
      isWorktree: false,
      gitDirectory: gitPath,
      parentRepositoryPath: cwd,
    };
  }

  const gitDirectory = resolve(cwd, gitFile.replace(/^gitdir:\s*/, ""));
  const parentRepositoryPath = resolve(gitDirectory, "..", "..", "..");

  return {
    isWorktree: true,
    gitDirectory,
    parentRepositoryPath,
  };
}
