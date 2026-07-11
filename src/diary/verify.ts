import type { DiaryStateStore } from "../db/diary-state";
import type { DiaryFileStore } from "./file-store";
import { validateAndMarkStale } from "./validate-and-mark-stale";

export interface VerifySettledDiariesOptions {
  stateStore: Pick<
    DiaryStateStore,
    "listSettledDays" | "markDayStaleAndEnqueue"
  >;
  fileStore: Pick<DiaryFileStore, "readValidatedDiary">;
}

export interface VerifySettledDiariesResult {
  checked: number;
  valid: number;
  invalid: string[];
}

export async function verifySettledDiaries(
  options: VerifySettledDiariesOptions,
): Promise<VerifySettledDiariesResult> {
  const days = options.stateStore.listSettledDays();
  const invalid: string[] = [];

  for (const day of days) {
    try {
      await validateAndMarkStale(options, day);
    } catch {
      invalid.push(day.date);
    }
  }

  return {
    checked: days.length,
    valid: days.length - invalid.length,
    invalid,
  };
}
