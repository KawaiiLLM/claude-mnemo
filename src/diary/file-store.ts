import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Read-only access needed by SessionStart memory injection. */
export class DiaryFileStore {
  constructor(readonly dataRoot: string) {}

  async readIndex(): Promise<Uint8Array> {
    const diaryRoot = join(this.dataRoot, "diary");
    try {
      const rootMetadata = await lstat(diaryRoot);
      if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
        throw new Error(`Diary root must be a real directory: ${diaryRoot}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const indexPath = join(diaryRoot, "INDEX.md");
    try {
      const indexMetadata = await lstat(indexPath);
      if (indexMetadata.isSymbolicLink() || !indexMetadata.isFile()) {
        throw new Error(`Diary index must be a regular file: ${indexPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return readFile(indexPath);
  }
}
