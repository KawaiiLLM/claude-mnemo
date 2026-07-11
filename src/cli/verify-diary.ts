import { createDatabase } from "../db/database";
import { createDiaryStateStore } from "../db/diary-state";
import { initializeDatabase } from "../db/schema";
import { DiaryFileStore } from "../diary/file-store";
import { verifySettledDiaries } from "../diary/verify";
import { DATA_DIR } from "../shared/paths";

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a path`);
  }
  return value;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const db = createDatabase(optionValue(args, "--db"));
  try {
    initializeDatabase(db);
    const result = await verifySettledDiaries({
      stateStore: createDiaryStateStore(db),
      fileStore: new DiaryFileStore(
        optionValue(args, "--data-root") ?? DATA_DIR,
      ),
    });
    console.log(JSON.stringify(result, null, 2));
    return result.invalid.length === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
